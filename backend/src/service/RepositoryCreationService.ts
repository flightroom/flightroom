import { Types } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import CodeRepository, { ICodeRepository } from "../models/CodeRepositoryModel"
import Frontend, { IFrontend } from "../models/FrontendModel"
import { IMarket } from "../models/MarketModel"
import Project from "../models/ProjectModel"
import Service, { IService } from "../models/ServiceModel"
import { FrontendStackSource, parseCompiler, parseFramework } from "../types/FrontendStack"
import { IProjectTechnologies, parseBackendTechnology } from "../types/ProjectTechnology"
import { isServiceTemplateType, parseRuntime } from "../types/ServiceStack"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService from "./BaseAuthorizedService"
import { DEFAULT_ENTRY_POINT, withEntryPoint } from "./FrontendService"
import MarketService from "./MarketService"
import { isValidRepositoryName } from "./RepositoryRenameService"
import TemplateScaffoldService, { CodeRepositoryTarget, placeholderDomain } from "./TemplateScaffoldService"
import { RepositoryComponentKind } from "./workspace/repositoryComponent"

export interface CreateRepositoryInput {
    /** The connection of the project the repository is created with. */
    codeRepositoryId: string
    repositoryName: string
    /** Slug of the template to scaffold; the member's own, then the default of its kind, when left out. */
    template?: string
    private?: boolean
    /** GitLab only: the group to create it in, the connection's own when left out. */
    gitlab?: { groupId?: number }
}

/** The template a repository created by the console starts from when none is picked: a Vite React remote, a Fastify service. */
export const DEFAULT_TEMPLATE_SLUGS: Record<RepositoryComponentKind, string> = { frontend: "vite-remote-react", service: "service-node-fastify" }

/** What a repository name ends with, so the frontend and the backend of the same slug never clash: `checkout-fe`, `orders-be`. */
export const REPOSITORY_NAME_SUFFIXES: Record<RepositoryComponentKind, string> = { frontend: "-fe", service: "-be" }

/** Whether a template scaffolds that kind: a service template builds a Docker image, which nothing can load as a frontend. */
export const isTemplateOfKind = (template: Pick<IMarket, "type" | "comingSoon">, kind: RepositoryComponentKind) => !template.comingSoon && isServiceTemplateType(template.type) === (kind === "service")

/** Whether a template is built with the technology the project picked for its kind; never when it picked none. */
export const matchesProjectTechnology = (template: Pick<IMarket, "framework">, kind: RepositoryComponentKind, technologies?: IProjectTechnologies): boolean => {
    const chosen = kind === "frontend" ? technologies?.frontend : technologies?.backend
    return Boolean(chosen) && (kind === "frontend" ? parseFramework(template.framework) : parseBackendTechnology(template.framework)) === chosen
}

/**
 * The default template of a kind among the available ones: by slug, otherwise the first remote for a frontend, the
 * first of the kind for a service. Picked among the ones matching the technologies of the project first, so that a
 * Vue project starts from a Vue remote; among all of them when none does.
 */
export const defaultTemplateOf = <T extends Pick<IMarket, "slug" | "type" | "comingSoon" | "framework">>(
    templates: T[],
    kind: RepositoryComponentKind,
    technologies?: IProjectTechnologies
): T | undefined => {
    const ofKind = templates.filter(template => isTemplateOfKind(template, kind))
    const pick = (candidates: T[]) =>
        candidates.find(template => template.slug === DEFAULT_TEMPLATE_SLUGS[kind]) ??
        (kind === "frontend" ? candidates.find(template => template.type?.trim().toLowerCase() === "remote") : undefined) ??
        candidates[0]
    return pick(ofKind.filter(template => matchesProjectTechnology(template, kind, technologies))) ?? pick(ofKind)
}

const alreadyLinked = (kind: RepositoryComponentKind) => createBusinessException({ code: "REPOSITORY_ALREADY_LINKED", message: `The ${kind} already has a code repository linked`, statusCode: 409 })

/** Saved only while no repository is linked: two creations at once must not both link theirs. */
const NOT_LINKED = { "codeRepository.enabled": { $ne: true } }

/** What a frontend and a service share of what creating their repository reads. */
type Member = Pick<IFrontend, "projectId" | "slug" | "codeRepository" | "domainId"> & { template?: string }

/**
 * Creates the code repository of a frontend or a service that has none yet, scaffolded from a
 * template, as creating one with a new repository does. The domain AI workspace offers it when no
 * member of the domain has a repository for the agent to work on.
 */
export class RepositoryCreationService extends BaseAuthorizedService {
    async createFrontendRepository(frontendId: string, input: CreateRepositoryInput): Promise<IFrontend | null> {
        const frontend = Types.ObjectId.isValid(frontendId) ? await Frontend.findById(toObjectId(frontendId)) : null
        if (!frontend) throw new EntityNotFoundError(frontendId)
        const { connection, template, target } = await this.prepare(frontend, "frontend", input)

        await new TemplateScaffoldService(this.user).createRepository(connection, target, frontend.slug, template, { frontendSlug: frontend.slug })
        target.createData = undefined

        // As on create, the template is the stack the repository starts with: kept only where nothing is known yet
        const set: Record<string, unknown> = { codeRepository: target }
        if (!frontend.template) set.template = template.slug
        if (!frontend.stack?.framework) {
            set.stack = { framework: parseFramework(template.framework), compiler: parseCompiler(template.compiler), source: FrontendStackSource.TEMPLATE }
        }
        // Served by what the template builds, unless an entry point other than the platform default was chosen
        if (frontend.host) {
            const chosen = frontend.host.entryPoint === DEFAULT_ENTRY_POINT ? undefined : frontend.host.entryPoint
            const { entryPoint } = withEntryPoint({ type: frontend.host.type, entryPoint: chosen }, template.entryPoint)
            if (entryPoint && entryPoint !== frontend.host.entryPoint) set["host.entryPoint"] = entryPoint
        }
        // Linked meanwhile by another request: the repository just created stays at the provider, unlinked
        const saved = await Frontend.findOneAndUpdate({ _id: frontend._id, ...NOT_LINKED }, set, { new: true })
        if (!saved) throw alreadyLinked("frontend")
        return saved
    }

    async createServiceRepository(serviceId: string, input: CreateRepositoryInput): Promise<IService | null> {
        const service = Types.ObjectId.isValid(serviceId) ? await Service.findById(toObjectId(serviceId)) : null
        if (!service) throw new EntityNotFoundError(serviceId)
        const { connection, template, target } = await this.prepare(service, "service", input)

        await new TemplateScaffoldService(this.user).createRepository(connection, target, service.slug, template, {
            placeholders: { "%serviceSlug%": service.slug, "%domain%": placeholderDomain() }
        })
        target.createData = undefined

        const set: Record<string, unknown> = { codeRepository: target }
        if (!service.template) set.template = template.slug
        if (!service.stack?.framework) set.stack = { runtime: parseRuntime(template.framework), framework: template.framework, source: FrontendStackSource.TEMPLATE }
        // Linked meanwhile by another request: the repository just created stays at the provider, unlinked
        const saved = await Service.findOneAndUpdate({ _id: service._id, ...NOT_LINKED }, set, { new: true })
        if (!saved) throw alreadyLinked("service")
        return saved
    }

    /** Everything checked before anything is created at the provider: a refusal after it would leave an orphan repository behind. */
    private async prepare(member: Member, kind: RepositoryComponentKind, input: CreateRepositoryInput): Promise<{ connection: ICodeRepository; template: IMarket; target: CodeRepositoryTarget }> {
        await this.ensureAccessToDomainMember(member)
        await this.ensureNotViewer(member.projectId, { code: "REPOSITORY_CREATE_FORBIDDEN", message: "A viewer cannot create a code repository" })
        if (member.codeRepository?.enabled) throw alreadyLinked(kind)

        const name = typeof input?.repositoryName === "string" ? input.repositoryName.trim() : ""
        if (!isValidRepositoryName(name)) {
            throw createBusinessException({
                code: "INVALID_REPOSITORY_NAME",
                message: "A repository name takes letters, digits, '.', '_' and '-' (up to 100), starts with a letter or a digit, cannot end with '.' and cannot end with '.git' or '.atom'"
            })
        }

        const connectionId = typeof input.codeRepositoryId === "string" && Types.ObjectId.isValid(input.codeRepositoryId) ? input.codeRepositoryId : undefined
        const connection = connectionId ? await CodeRepository.findById(toObjectId(connectionId)) : null
        // A connection of another project would lend this one its access token
        if (!connection || String(connection.projectId) !== String(member.projectId)) {
            throw new EntityNotFoundError(String(input.codeRepositoryId))
        }

        const template = await this.templateFor(kind, (typeof input.template === "string" && input.template.trim()) || member.template, member.projectId)
        const groupId = input.gitlab?.groupId
        return {
            connection,
            template,
            target: {
                enabled: true,
                codeRepositoryId: String(connection._id),
                repositoryId: "",
                gitlab: Number.isInteger(groupId) ? { groupId } : undefined,
                createData: { name, private: input.private === true, template: template.slug }
            }
        }
    }

    /** The template asked for, or the default of the kind for the project's technologies; one of the other kind is refused, as on create. */
    private async templateFor(kind: RepositoryComponentKind, slug: string | undefined, projectId: Member["projectId"]): Promise<IMarket> {
        const market = new MarketService()
        const technologies = slug ? undefined : (await Project.findById(projectId, { technologies: 1 }))?.technologies
        const template = slug ? await market.getSingle(slug) : (defaultTemplateOf(await market.getAll(), kind, technologies) ?? null)
        if (!template) {
            throw createBusinessException({ code: "TEMPLATE_NOT_FOUND", message: slug ? `There is no template "${slug}"` : `There is no ${kind} template` })
        }
        if (!isTemplateOfKind(template, kind)) {
            throw kind === "service"
                ? createBusinessException({ code: "FRONTEND_TEMPLATE_NOT_ALLOWED", message: `"${template.slug}" is a frontend template: a service cannot be scaffolded from it` })
                : createBusinessException({ code: "SERVICE_TEMPLATE_NOT_ALLOWED", message: `"${template.slug}" is a backend service template: a frontend cannot be scaffolded from it` })
        }
        return template
    }
}

export default RepositoryCreationService
