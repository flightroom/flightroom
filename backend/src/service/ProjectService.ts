import { ClientSession, DeleteResult, ObjectId, Schema, Types } from "mongoose"
import { fastify } from ".."
import { BusinessException, createBusinessException } from "../errors/BusinessException"
import CustomError from "../errors/CustomError"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import ApiKey from "../models/ApiKeyModel"
import BackendDeployment from "../models/BackendDeploymentModel"
import Backend from "../models/BackendModel"
import BuiltBackend from "../models/BuiltBackendModel"
import BuiltFrontend from "../models/BuiltFrontendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Database from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import DeploymentToCanaryUsers from "../models/DeploymentsToCanaryUsersModel"
import Domain from "../models/DomainModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { IFrontend } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import MaintenanceRun from "../models/MaintenanceRunModel"
import Organization from "../models/OrganizationModel"
import Project, { IProject, IProjectPipelines } from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import Storage from "../models/StorageModel"
import UserProject, { RoleInProject } from "../models/UserProjectModel"
import { ConfigMap, Secret } from "../models/VariableMapModel"
import { CONTAINER_REGISTRY } from "../types/BackendStack"
import { designSystemOf, effectiveDesignSystem, IDesignSystem, redactDesignSystem } from "../types/DesignSystem"
import { CERTIFICATE_ISSUER, DOMAIN_NAME, isListenerPort } from "../types/Exposure"
import { FrontendFramework } from "../types/FrontendStack"
import { BackendTechnology, IProjectTechnologies } from "../types/ProjectTechnology"
import { toObjectId } from "../utils/mongooseUtils"
import { runInTransaction } from "../utils/runInTransaction"
import { slugify } from "../utils/slugUtils"
import BaseAuthorizedService, { domainScopeForbidden, isInDomainScope } from "./BaseAuthorizedService"
import CodeRepositoryImportService from "./CodeRepositoryImportService"
import CodeRepositoryService from "./CodeRepositoryService"
import GitOpsService, { GitOpsSettingsInput } from "./GitOpsService"
import UserProjectService from "./UserProjectService"
import { prepareProjectCleanup } from "./workspace/workspaceCleanup"

export interface ProjectCreateInput {
    /** The organization the project is created in. A project always belongs to exactly one. */
    organizationId: string
    name: string
    /** Left out, it is derived from the name with the same helper the organization uses. */
    slug?: string
    description?: string
    isActive?: boolean
}

export interface ProjectUpdateInput {
    name?: string
    description?: string | null
    /** `null` removes it, like the description. */
    context?: string | null
    isActive?: boolean
    /** Turning it on commits every config map and secret to the repository: refused when that push fails */
    gitOps?: GitOpsSettingsInput
    /** Replaced as a whole, `null` removes it: the next deploy of each environment takes its Gateway away */
    exposure?: { domain: string; certificateIssuer?: string | null; httpPort?: number | null; httpsPort?: number | null } | null
    /** Replaced as a whole, `null` goes back to the official template-pipelines */
    pipelines?: PipelineTemplatesInput | null
    /** e.g. `ghcr.io/acme`; `null` or blank removes it, and an application with no image of its own is left out of the deploy again */
    containerRegistry?: string | null
    /**
     * The default technologies, side by side: `null` removes both, a side `null` removes that one only and a
     * side left out stays as it is.
     */
    technologies?: { frontend?: string | null; backend?: string | null } | null
    /** The default design system of the frontends, replaced as a whole: `null` removes it */
    designSystem?: IDesignSystem | null
}

/** The repository of the pipeline templates as the settings screen names it: by the provider id, the backend resolves the rest */
export interface PipelineTemplatesInput {
    codeRepositoryId: string
    repositoryId: string
    /** A branch or a tag; the default branch of the repository when empty */
    ref?: string | null
}

/** What git takes as a branch or a tag name, without the forms it refuses: `..`, a leading dash, a trailing slash or `.lock` */
const GIT_REF = /^(?!-)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,255}$/

/** The exposure to store, trimmed and in lowercase: refused with a 400 rather than by the model with a 500 */
const exposureOf = (input: unknown): { domain: string; certificateIssuer?: string; httpPort?: number; httpsPort?: number } => {
    const { domain, certificateIssuer, httpPort, httpsPort } = (input ?? {}) as { domain?: unknown; certificateIssuer?: unknown; httpPort?: unknown; httpsPort?: unknown }
    const normalized = typeof domain === "string" ? domain.trim().toLowerCase() : ""
    const issuer = typeof certificateIssuer === "string" ? certificateIssuer.trim() : ""
    if (
        !DOMAIN_NAME.test(normalized) ||
        (certificateIssuer != null && typeof certificateIssuer !== "string") ||
        (issuer && !CERTIFICATE_ISSUER.test(issuer)) ||
        (httpPort != null && !isListenerPort(httpPort)) ||
        (httpsPort != null && !isListenerPort(httpsPort))
    ) {
        throw createBusinessException({
            code: "PROJECT_EXPOSURE_INVALID",
            message: "The exposure needs a lowercase domain of at least two labels, e.g. example.com, if any the name of a ClusterIssuer and, if any, ports between 1 and 65535",
            statusCode: 400
        })
    }
    return {
        domain: normalized,
        ...(issuer ? { certificateIssuer: issuer } : {}),
        ...(httpPort != null ? { httpPort: httpPort as number } : {}),
        ...(httpsPort != null ? { httpsPort: httpsPort as number } : {})
    }
}

/** The container registry to store, trimmed and without a trailing slash: refused with a 400 rather than by the model with a 500 */
const containerRegistryOf = (input: unknown): string => {
    const registry = typeof input === "string" ? input.trim().replace(/\/+$/, "") : ""
    if (!CONTAINER_REGISTRY.test(registry)) {
        throw createBusinessException({
            code: "PROJECT_CONTAINER_REGISTRY_INVALID",
            message: "The container registry is a host, with a port and a namespace if any, without scheme, e.g. ghcr.io/acme or registry.example.com:5000",
            statusCode: 400
        })
    }
    return registry
}

const TECHNOLOGIES: Record<keyof IProjectTechnologies, string[]> = { frontend: Object.values(FrontendFramework), backend: Object.values(BackendTechnology) }

/**
 * What to write and unset of the technologies, by dotted path so that a side left out keeps its value:
 * refused with a 400 rather than by the model with a 500.
 */
const technologiesOf = (input: unknown): { set: Record<string, string>; unset: Record<string, 1> } => {
    const invalid = () =>
        createBusinessException({
            code: "PROJECT_TECHNOLOGIES_INVALID",
            message: `The frontend technology is one of ${TECHNOLOGIES.frontend.join(", ")} and the backend one of ${TECHNOLOGIES.backend.join(", ")}`,
            statusCode: 400
        })
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid()
    const set: Record<string, string> = {}
    const unset: Record<string, 1> = {}
    for (const side of ["frontend", "backend"] as const) {
        const value = (input as Record<string, unknown>)[side]
        if (value === null) unset[`technologies.${side}`] = 1
        else if (value !== undefined) {
            if (typeof value !== "string" || !TECHNOLOGIES[side].includes(value)) throw invalid()
            set[`technologies.${side}`] = value
        }
    }
    return { set, unset }
}

interface ContextEntry {
    id: string
    slug: string
    name: string
    context: string
}

/** The level a design system is set at: the most specific one that has it wins */
export type DesignSystemSource = "frontend" | "project" | "organization"

/**
 * What the team wrote for AI agents in one project: the shared context and the one of each domain, frontend and backend that has it.
 * Every design system is the one that applies, with the level it comes from.
 */
export interface ProjectContextDTO {
    /** The technologies and the design system of the frontends come along: an agent creating a frontend or a backend starts from them. */
    project: {
        id: string
        name: string
        context?: string
        technologies?: IProjectTechnologies
        /** Its own, else the organization's */
        designSystem?: IDesignSystem
        designSystemSource?: Exclude<DesignSystemSource, "frontend">
    }
    domains: ContextEntry[]
    frontends: ContextEntry[]
    backends: ContextEntry[]
    /** With a frontend focus: the design system its UI is built with, its own, else the project's, else the organization's, whether it has a context or not */
    designSystem?: IDesignSystem
    designSystemSource?: DesignSystemSource
}

/**
 * The design system of the frontends of a project: its own, else the one of its organization, read only when
 * the project has none. Not redacted: whoever hands it to an AI does.
 */
export const projectDesignSystemOf = async (
    project: Pick<IProject, "designSystem" | "organizationId">
): Promise<{ designSystem?: IDesignSystem; source?: Exclude<DesignSystemSource, "frontend"> }> => {
    if (project.designSystem?.packageName) return { designSystem: project.designSystem, source: "project" }
    const organization = await Organization.findById(project.organizationId, { designSystem: 1 })
    const designSystem = effectiveDesignSystem(organization?.designSystem)
    return designSystem ? { designSystem, source: "organization" } : {}
}

/**
 * The piece of work a context is read for. A frontend or a backend reads its own context and
 * the one of its domain; a domain reads its own and the one of each of its frontends and backends.
 * The project context always comes along.
 */
export type ContextFocus = { frontendId: string } | { backendId: string } | { domainId: string }

/** Which domains, frontends and backends a focus reads the context of: a list left out is read for none. */
interface ContextFilters {
    domains?: Record<string, unknown>
    frontends?: Record<string, unknown>
    backends?: Record<string, unknown>
    /** The frontend of a frontend focus */
    frontend?: Pick<IFrontend, "designSystem">
}

const toContextEntry = (item: { _id: unknown; slug: string; name: string; context?: string }): ContextEntry => ({
    id: String(item._id),
    slug: item.slug,
    name: item.name,
    context: item.context as string
})

/**
 * A project as the switcher lists it, with the domains the user is confined to there: none for a member
 * of the whole project. `domainScoped` tells a scope left over nothing by deleted domains from the whole project.
 * `role` is the one the user acts with: an administrator of the organization acts as an owner, whatever their membership.
 */
export type ProjectOfUser = IProject & { domainIds: string[]; domainScoped: boolean; role?: RoleInProject }

export interface ProjectSummaryDTO {
    project: IProject
    count: {
        environments: number
        users: number
        frontends: number
        apiKeys: number
        storages: number
        databases: number
        codeRepositories: number
    }
}

export class ProjectService extends BaseAuthorizedService {
    userProjectService = new UserProjectService()

    /**
     * The projects the user can open, optionally narrowed to one organization.
     *
     * Two ways in, and they are not the same thing: an explicit membership on the project, or
     * administering the organization that owns it. The second is what keeps a project reachable when
     * its members leave, and it is why this cannot be a single lookup from UserProject any more.
     */
    async findMine(userId: ObjectId, organizationId?: string | Schema.Types.ObjectId): Promise<ProjectOfUser[]> {
        try {
            // A pending invitation is not a membership yet: it must be accepted first, otherwise the
            // project would show up in the switcher as if it were already the user's.
            const memberships = await UserProject.find({ userId: toObjectId(userId), invitationToken: null }, { projectId: 1, role: 1, domainScoped: 1, domainIds: 1 }).lean()
            const administeredOrganizations = await this.getAdministeredOrganizationIds()

            const reachable: Record<string, unknown>[] = [{ _id: { $in: memberships.map(membership => membership.projectId) } }]
            if (administeredOrganizations.length > 0) {
                reachable.push({ organizationId: { $in: administeredOrganizations } })
            }

            const filter: Record<string, unknown> = { $or: reachable }
            if (organizationId) {
                filter.organizationId = toObjectId(organizationId)
            }

            // The scope comes with the membership read above; owning the project or administering the
            // organization overrides it, as it does on every check
            const administered = new Set(administeredOrganizations.map(String))
            const scopes = new Map(
                memberships
                    .filter(membership => membership.domainScoped && membership.role !== RoleInProject.OWNER)
                    .map(membership => [String(membership.projectId), (membership.domainIds ?? []).map(String)])
            )
            const roles = new Map(memberships.map(membership => [String(membership.projectId), membership.role]))
            const projects = await Project.find(filter).sort({ name: 1 })
            return projects.map(project => {
                const isAdministered = administered.has(String(project.organizationId))
                const scope = isAdministered ? undefined : scopes.get(String(project._id))
                const fields = typeof project.toJSON === "function" ? project.toJSON() : project
                // The console hides what the role cannot do; every write is still checked on the server
                const role = isAdministered ? RoleInProject.OWNER : roles.get(String(project._id))
                return { ...fields, domainIds: scope ?? [], domainScoped: Boolean(scope), role } as unknown as ProjectOfUser
            })
        } catch (error) {
            if (error instanceof BusinessException) throw error

            throw createBusinessException({
                code: "PROJECT_FETCH_ERROR",
                message: "Failed to fetch projects",
                details: {
                    error: error instanceof Error ? error.message : "Unknown error"
                },
                statusCode: 500
            })
        }
    }

    async findById(id: string | Schema.Types.ObjectId, session?: ClientSession): Promise<IProject | null> {
        const projectIdObj = toObjectId(id)
        await this.ensureAccessToProject(projectIdObj, session)
        try {
            return await Project.findById(projectIdObj, {}, session)
        } catch (error) {
            if (error instanceof BusinessException) throw error

            throw createBusinessException({
                code: "PROJECT_FETCH_ERROR",
                message: "Failed to fetch project",
                details: {
                    error: error instanceof Error ? error.message : "Unknown error"
                },
                statusCode: 500
            })
        }
    }

    async getSummary(projectId: string): Promise<ProjectSummaryDTO> {
        const projectIdObj = toObjectId(projectId)
        const project = await this.findById(projectIdObj)
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }
        return {
            project,
            count: {
                environments: await Environment.countDocuments({ projectId: projectIdObj }),
                users: await UserProject.countDocuments({ projectId: projectIdObj }),
                frontends: await Frontend.countDocuments({ projectId: projectIdObj, ...(await this.domainScopeFilter(projectIdObj)) }),
                apiKeys: await ApiKey.countDocuments({ projectId: projectIdObj }),
                storages: await Storage.countDocuments({ projectId: projectIdObj }),
                databases: await Database.countDocuments({ projectId: projectIdObj }),
                codeRepositories: await CodeRepository.countDocuments({ projectId: projectIdObj })
            }
        }
    }

    /** The contexts of the whole project, or only the ones a piece of work needs when a focus is given. */
    async getContext(projectId: string, focus?: ContextFocus): Promise<ProjectContextDTO> {
        const projectIdObj = toObjectId(projectId)
        const project = await this.findById(projectIdObj)
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }
        const filters = await this.contextFilters(projectIdObj, focus)
        const withContext = { projectId: projectIdObj, context: { $nin: [null, ""] } }
        const fields = { slug: 1, name: 1, context: 1 }
        const [domains, frontends, backends] = await Promise.all([
            filters.domains ? Domain.find({ ...filters.domains, ...withContext }, fields).sort({ slug: 1 }) : [],
            filters.frontends ? Frontend.find({ ...filters.frontends, ...withContext }, fields).sort({ slug: 1 }) : [],
            filters.backends ? Backend.find({ ...filters.backends, ...withContext }, fields).sort({ slug: 1 }) : []
        ])
        const { frontend, backend } = project.technologies ?? {}
        const projectDesignSystem = await projectDesignSystemOf(project)
        const ownDesignSystem = filters.frontend?.designSystem?.packageName ? filters.frontend.designSystem : undefined
        // Read by agents only: the credentials of the npmrc never come along
        return {
            project: {
                id: project._id.toString(),
                name: project.name,
                context: project.context || undefined,
                technologies: frontend || backend ? { ...(frontend ? { frontend } : {}), ...(backend ? { backend } : {}) } : undefined,
                designSystem: redactDesignSystem(projectDesignSystem.designSystem),
                designSystemSource: projectDesignSystem.source
            },
            domains: domains.map(toContextEntry),
            frontends: frontends.map(toContextEntry),
            backends: backends.map(toContextEntry),
            designSystem: filters.frontend ? redactDesignSystem(effectiveDesignSystem(ownDesignSystem, projectDesignSystem.designSystem)) : undefined,
            designSystemSource: filters.frontend ? (ownDesignSystem ? "frontend" : projectDesignSystem.source) : undefined
        }
    }

    /**
     * The .npmrc of the design system the project's frontends build with, or one frontend's, whole: credentials
     * included. Only `design_system_npmrc_get` hands it out, for the user to install the package on their machine.
     */
    async getDesignSystemNpmrc(projectId: string, frontendId?: string): Promise<{ packageName: string; source: DesignSystemSource; npmrc: string }> {
        const projectIdObj = toObjectId(projectId)
        const project = await this.findById(projectIdObj)
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }
        const { frontend } = frontendId ? await this.contextFilters(projectIdObj, { frontendId }) : {}
        const projectDesignSystem = await projectDesignSystemOf(project)
        const own = frontend?.designSystem?.packageName ? frontend.designSystem : undefined
        const designSystem = own ?? projectDesignSystem.designSystem
        const source = own ? "frontend" : projectDesignSystem.source
        if (!designSystem?.npmrc || !source) {
            throw createBusinessException({
                code: "DESIGN_SYSTEM_NPMRC_MISSING",
                message: designSystem ? `The design system ${designSystem.packageName} has no .npmrc` : "No design system applies here",
                statusCode: 404
            })
        }
        return { packageName: designSystem.packageName, source, npmrc: designSystem.npmrc }
    }

    /**
     * A focus outside the project is refused as not found: a context never reaches across projects. A
     * domain-scoped member reads the contexts of their domains and of what is in them only, and is
     * refused a focus outside them.
     */
    private async contextFilters(projectId: Schema.Types.ObjectId, focus?: ContextFocus): Promise<ContextFilters> {
        const scope = await this.getDomainScope(projectId)
        if (!focus) {
            const members = await this.domainScopeFilter(projectId)
            return { domains: await this.domainScopeFilter(projectId, "_id"), frontends: members, backends: members }
        }
        const domainOf = (domainId?: unknown) => (domainId ? { _id: domainId } : undefined)
        const ensureInScope = (domainId: unknown) => {
            if (!isInDomainScope(scope, domainId)) throw domainScopeForbidden()
        }
        if ("domainId" in focus) {
            const domain = await Domain.findOne({ _id: toObjectId(focus.domainId), projectId }, { _id: 1 })
            if (!domain) throw new EntityNotFoundError(focus.domainId)
            ensureInScope(domain._id)
            return { domains: { _id: domain._id }, frontends: { domainId: domain._id }, backends: { domainId: domain._id } }
        }
        if ("frontendId" in focus) {
            const frontend = await Frontend.findOne({ _id: toObjectId(focus.frontendId), projectId }, { domainId: 1, designSystem: 1 })
            if (!frontend) throw new EntityNotFoundError(focus.frontendId)
            ensureInScope(frontend.domainId)
            return { domains: domainOf(frontend.domainId), frontends: { _id: frontend._id }, frontend }
        }
        const backend = await Backend.findOne({ _id: toObjectId(focus.backendId), projectId }, { domainId: 1 })
        if (!backend) throw new EntityNotFoundError(focus.backendId)
        ensureInScope(backend.domainId)
        return { domains: domainOf(backend.domainId), backends: { _id: backend._id } }
    }

    async create(projectData: ProjectCreateInput, creatorUserId: ObjectId): Promise<IProject> {
        // Outside the transaction on purpose: the check reads, and a failing authorization should not
        // be the reason a transaction is opened at all.
        await this.ensureCanCreateProjectsIn(projectData.organizationId)
        return runInTransaction(async session => this.createRaw(projectData, creatorUserId, session))
    }

    /**
     * Only whoever administers the organization may open a project in it.
     *
     * A plain member reaches the projects they were invited to and nothing else, so letting them
     * create one would be the one way for them to add something to a tenant they only visit.
     */
    private async ensureCanCreateProjectsIn(organizationId?: string): Promise<void> {
        if (!organizationId) {
            throw createBusinessException({
                code: "ORGANIZATION_REQUIRED",
                message: "A project must be created inside an organization",
                statusCode: 400
            })
        }
        await this.ensureOrganizationAdmin(organizationId)
    }

    async createRaw(projectData: ProjectCreateInput, creatorUserId: ObjectId, session?: ClientSession): Promise<IProject> {
        try {
            const project = new Project({
                organizationId: toObjectId(projectData.organizationId),
                name: projectData.name,
                slug: projectData.slug?.trim() || slugify(projectData.name),
                description: projectData.description,
                isActive: projectData.isActive ?? true
            })

            const savedProject = await project.save({ session })

            fastify.log.info("Project created with ID:" + savedProject._id)

            await this.userProjectService.addUserToProject(creatorUserId, savedProject._id, RoleInProject.OWNER, session)

            return savedProject
        } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === 11000) {
                // Duplicate key error
                throw createBusinessException({
                    code: "DUPLICATE_PROJECT",
                    message: "A project with this name already exists",
                    statusCode: 409
                })
            }

            const errorMessage = error instanceof Error ? error.message : String(error)
            throw createBusinessException({
                code: "PROJECT_CREATION_ERROR",
                message: "Failed to create project",
                details: { error: errorMessage },
                statusCode: 500
            })
        }
    }

    async update(projectId: string, projectData: ProjectUpdateInput): Promise<IProject | null> {
        await this.ensureAccessToProject(projectId)
        // The settings, the shared context and the GitOps repository are the whole project's
        await this.ensureWholeProject(projectId)
        try {
            if (!Types.ObjectId.isValid(projectId)) {
                throw createBusinessException({
                    code: "INVALID_ID",
                    message: "Invalid project ID format",
                    statusCode: 400
                })
            }

            // One field at a time rather than a spread of the request body. The route carries no
            // schema, so a spread would write whatever the caller decides to send: `slug` included,
            // and that one is part of the path already uploaded bundles live under
            // (`<slug>-<id>/<frontend>/<version>`). Moving it would orphan every deployed file.
            // biome-ignore lint/suspicious/noExplicitAny: updateData needs to support MongoDB update operators dynamically
            const updateData: any = {}
            if (projectData.name !== undefined) {
                updateData.name = projectData.name
            }
            if (projectData.isActive !== undefined) {
                updateData.isActive = projectData.isActive
            }
            if (projectData.gitOps !== undefined) {
                updateData.gitOps = await new GitOpsService(this.user).resolveSettings(projectId, projectData.gitOps)
            }
            if (projectData.pipelines !== undefined) {
                const pipelines = await this.resolvePipelines(projectId, projectData.pipelines)
                if (pipelines) updateData.pipelines = pipelines
                else updateData.$unset = { ...updateData.$unset, pipelines: 1 }
            }
            if (projectData.exposure === null) {
                updateData.$unset = { ...updateData.$unset, exposure: 1 }
            } else if (projectData.exposure !== undefined) {
                updateData.exposure = exposureOf(projectData.exposure)
            }
            const { containerRegistry } = projectData
            if (containerRegistry === null || (typeof containerRegistry === "string" && !containerRegistry.trim())) {
                updateData.$unset = { ...updateData.$unset, containerRegistry: 1 }
            } else if (containerRegistry !== undefined) {
                updateData.containerRegistry = containerRegistryOf(containerRegistry)
            }
            if (projectData.technologies === null) {
                updateData.$unset = { ...updateData.$unset, technologies: 1 }
            } else if (projectData.technologies !== undefined) {
                const { set, unset } = technologiesOf(projectData.technologies)
                Object.assign(updateData, set)
                if (Object.keys(unset).length > 0) updateData.$unset = { ...updateData.$unset, ...unset }
            }
            if (projectData.designSystem === null) {
                updateData.$unset = { ...updateData.$unset, designSystem: 1 }
            } else if (projectData.designSystem !== undefined) {
                updateData.designSystem = designSystemOf(projectData.designSystem)
            }
            for (const field of ["description", "context"] as const) {
                if (projectData[field] === null) {
                    updateData.$unset = { ...updateData.$unset, [field]: 1 }
                } else if (projectData[field] !== undefined) {
                    updateData[field] = projectData[field]
                }
            }

            const updated = await Project.findByIdAndUpdate(projectId, updateData, {
                new: true,
                runValidators: true
            })

            if (!updated) {
                throw createBusinessException({
                    code: "PROJECT_NOT_FOUND",
                    message: "Project not found",
                    statusCode: 404
                })
            }

            return updated
        } catch (error) {
            // A not found, or a GitOps refusal, keeps its own status and code
            if (error instanceof CustomError) throw error

            throw createBusinessException({
                code: "PROJECT_UPDATE_ERROR",
                message: "Failed to update project",
                details: {
                    error: error instanceof Error ? error.message : "Unknown error"
                },
                statusCode: 500
            })
        }
    }

    /**
     * The pipeline templates to store from what the screen sent, none for the official ones. Owners only, as for
     * GitOps: every repository scaffolded in the project runs what they pick. The repository must be reachable
     * through one of the connections of the project: one of another project would lend this one its access token.
     */
    private async resolvePipelines(projectId: string, input: PipelineTemplatesInput | null): Promise<IProjectPipelines | undefined> {
        const projectIdObj = toObjectId(projectId)
        const project = await Project.findById(projectIdObj, { organizationId: 1 })
        if (!project) throw new ProjectNotFoundError(projectId)
        await new GitOpsService(this.user).ensureOwner(projectIdObj, project.organizationId, {
            code: "PIPELINES_OWNER_REQUIRED",
            message: "Only an owner of the project can change where its pipeline templates come from"
        })
        if (input === null) return undefined

        if (!Types.ObjectId.isValid(input?.codeRepositoryId) || typeof input.repositoryId !== "string" || !input.repositoryId) {
            throw createBusinessException({ code: "PIPELINES_REPOSITORY_REQUIRED", message: "Pick the connection and the repository of the pipeline templates" })
        }
        const ref = typeof input.ref === "string" ? input.ref.trim() : ""
        if ((input.ref != null && typeof input.ref !== "string") || (ref && !GIT_REF.test(ref))) {
            throw createBusinessException({ code: "PIPELINES_REF_INVALID", message: "The ref of the pipeline templates must be the name of a branch or a tag" })
        }

        const codeRepository = await CodeRepository.findOne({ _id: toObjectId(input.codeRepositoryId), projectId: projectIdObj, isActive: true })
        if (!codeRepository) {
            throw createBusinessException({ code: "PIPELINES_REPOSITORY_INVALID", message: "The code repository connection is not one of this project" })
        }
        const importService = new CodeRepositoryImportService(this.user)
        const repository = (await importService.fetchRepositories(new CodeRepositoryService(this.user), codeRepository)).find(candidate => candidate.repositoryId === input.repositoryId)
        if (!repository) {
            throw createBusinessException({ code: "PIPELINES_REPOSITORY_INVALID", message: `The connection "${codeRepository.name}" cannot reach the repository ${input.repositoryId}` })
        }
        return { codeRepository: importService.buildFrontendCodeRepository(codeRepository, repository), ...(ref ? { ref } : {}) }
    }

    async delete(projectId: string): Promise<DeleteResult> {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)
        const cleanup = await prepareProjectCleanup(projectId)
        const result = await runInTransaction(session => this.deleteRaw(projectId, session))
        await cleanup()
        return result
    }

    async deleteRaw(projectId: string, session?: ClientSession): Promise<DeleteResult> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj, session)
        await UserProject.deleteMany({ projectId: projectIdObj }, session)
        await ApiKey.deleteMany({ projectId: projectIdObj }, session)
        await Storage.deleteMany({ projectId: projectIdObj }, session)
        await Database.deleteMany({ projectId: projectIdObj }, { session })
        await CodeRepository.deleteMany({ projectId: projectIdObj }, session)

        const frontends = await Frontend.find({ projectId: projectIdObj }, {}, { session })
        const mfeIds = frontends.map(mfe => mfe._id)
        await BuiltFrontend.deleteMany({ frontendId: { $in: mfeIds } }, session)

        const backends = await Backend.find({ projectId: projectIdObj }, { _id: 1 }, { session })
        await BuiltBackend.deleteMany({ backendId: { $in: backends.map(backend => backend._id) } }, session)
        await BackendDeployment.deleteMany({ backendId: { $in: backends.map(backend => backend._id) } }, { session })

        // The versions and deploys an agent's CI registers are kept as a backend's, under its id
        const agents = await MaintenanceAgent.find({ projectId: projectIdObj }, { _id: 1 }, { session })
        await BuiltBackend.deleteMany({ backendId: { $in: agents.map(agent => agent._id) } }, { session })
        await BackendDeployment.deleteMany({ backendId: { $in: agents.map(agent => agent._id) } }, { session })
        await MaintenanceRun.deleteMany({ projectId: projectIdObj }, { session })
        await MaintenanceAgent.deleteMany({ projectId: projectIdObj }, { session })

        const deployments = await Deployment.find({ projectId: projectIdObj }, {}, { session })
        const deploymentsIds = deployments.map(deployment => deployment._id)
        await DeploymentToCanaryUsers.deleteMany({ deploymentId: { $in: deploymentsIds } }, session)

        const environments = await Environment.find({ projectId: projectIdObj }, {}, { session })
        const environmentIds = environments.map(environment => environment._id)
        await Deployment.deleteMany({ environmentId: { $in: environmentIds } }, session)

        await Deployment.deleteMany({ projectId: projectIdObj }, session)
        await Frontend.deleteMany({ projectId: projectIdObj }, session)
        await Backend.deleteMany({ projectId: projectIdObj }, session)
        await ConfigMap.deleteMany({ projectId: projectIdObj }, { session })
        await Secret.deleteMany({ projectId: projectIdObj }, { session })
        await Resource.deleteMany({ projectId: projectIdObj }, { session })
        await Domain.deleteMany({ projectId: projectIdObj }, { session })
        await Environment.deleteMany({ projectId: projectIdObj }, session)

        return await Project.deleteOne({ _id: projectIdObj }, session)
    }
}

export default ProjectService
