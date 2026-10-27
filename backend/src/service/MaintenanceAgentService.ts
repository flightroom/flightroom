import { isValidObjectId, ObjectId, Schema } from "mongoose"
import { BusinessException, createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import BackendDeployment from "../models/BackendDeploymentModel"
import Backend from "../models/BackendModel"
import BuiltBackend, { IBuiltBackend } from "../models/BuiltBackendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent, { IMaintenanceAgent } from "../models/MaintenanceAgentModel"
import MaintenanceRun, { IMaintenanceRun, MaintenanceRunStatus } from "../models/MaintenanceRunModel"
import Project from "../models/ProjectModel"
import { BACKEND_SLUG, BACKEND_VERSION, isBackendTemplateType, parseRuntime } from "../types/BackendStack"
import { FrontendStackSource } from "../types/FrontendStack"
import { canonicalTimeZone, isValidSchedule, MaintenanceAgentDTO, MaintenanceAgentKind } from "../types/MaintenanceAgent"
import { toObjectId } from "../utils/mongooseUtils"
import ArgoCdService from "./ArgoCdService"
import { ensureRequestsWithinLimits, withManualVersion, withNormalizedReferences } from "./BackendService"
import BaseAuthorizedService, { ensureOnlyNewRepositoryLinked, ensureRepositoryLinkUnchanged } from "./BaseAuthorizedService"
import { resolveDomainId } from "./DomainService"
import { isDeployable } from "./gitops/applicationManifests"
import MarketService from "./MarketService"
import { ensureAttachableResources, withResourcesOutOfScope } from "./ResourceService"
import TemplateScaffoldService, { placeholderDomain } from "./TemplateScaffoldService"
import { ensureAttachableMaps } from "./VariableMapService"

/** The runs a maintenance agent keeps the history of */
const RUNS_SHOWN = 20

const ERROR_MAX_LENGTH = 500

const invalid = (code: string, message: string, statusCode?: number) => createBusinessException({ code, message, ...(statusCode ? { statusCode } : {}) })

/**
 * The slug names the repository folder, the CI registration URL and the values file in the GitOps repository,
 * where it sits next to those of the backends and the frontends: none of them may have it already.
 */
const ensureSlugFree = async (slug: string, projectId: Schema.Types.ObjectId) => {
    if (!BACKEND_SLUG.test(slug)) {
        throw invalid("MAINTENANCE_AGENT_SLUG_INVALID", `"${slug}" is not a valid slug: 2 to 50 lowercase letters, digits or dashes, not starting with a dash`)
    }
    const taken = (await MaintenanceAgent.exists({ slug, projectId })) || (await Backend.exists({ slug, projectId })) || (await Frontend.exists({ slug, projectId }))
    if (taken) {
        throw invalid("MAINTENANCE_AGENT_SLUG_TAKEN", `A maintenance agent, a backend or a frontend with slug "${slug}" already exists in this project`, 409)
    }
}

/** The schedule, the time zone and the kind as they are stored: blank is none, anything the cluster would refuse is refused here */
export const withNormalizedRunning = <T extends Pick<MaintenanceAgentDTO, "kind" | "schedule" | "timeZone">>(fields: T): T => {
    const normalized = { ...fields }
    if (normalized.kind !== undefined && !Object.values(MaintenanceAgentKind).includes(normalized.kind)) {
        throw invalid("MAINTENANCE_AGENT_INVALID", `The kind is either ${Object.values(MaintenanceAgentKind).join(" or ")}`)
    }
    if (normalized.schedule !== undefined) {
        const schedule = typeof normalized.schedule === "string" ? normalized.schedule.trim() : ""
        if (schedule && !isValidSchedule(schedule)) {
            throw invalid("MAINTENANCE_AGENT_SCHEDULE_INVALID", `"${schedule}" is not a cron expression: five fields (minute hour day month weekday) or a macro such as @daily`)
        }
        normalized.schedule = schedule || null
    }
    if (normalized.timeZone !== undefined) {
        const timeZone = typeof normalized.timeZone === "string" ? normalized.timeZone.trim() : ""
        const canonical = timeZone ? canonicalTimeZone(timeZone) : undefined
        if (timeZone && !canonical) {
            throw invalid("MAINTENANCE_AGENT_TIMEZONE_INVALID", `"${timeZone}" is not a time zone: use an IANA name such as Europe/Rome`)
        }
        normalized.timeZone = canonical ?? null
    }
    return normalized
}

const uniqueIds = (ids: unknown): string[] | undefined => {
    if (ids === undefined) return undefined
    if (!Array.isArray(ids)) throw invalid("MAINTENANCE_AGENT_TARGET_INVALID", "The backends and the frontends it maintains are lists of ids")
    return [...new Set(ids.map(String))]
}

export class MaintenanceAgentService extends BaseAuthorizedService {
    async getById(id: string | ObjectId): Promise<IMaintenanceAgent | null> {
        const agent = await MaintenanceAgent.findById(toObjectId(id))
        if (!agent) {
            return null
        }
        await this.ensureAccessToDomainMember(agent)
        return agent
    }

    private async getExisting(id: string | ObjectId): Promise<IMaintenanceAgent> {
        const agent = await this.getById(id)
        if (!agent) {
            throw new EntityNotFoundError(String(id))
        }
        return agent
    }

    async getByProjectId(projectId: string | Schema.Types.ObjectId): Promise<IMaintenanceAgent[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        return await MaintenanceAgent.find({ projectId: projectIdObj, ...(await this.domainScopeFilter(projectIdObj)) }).sort({ name: 1 })
    }

    /**
     * The backends and the frontends it maintains, each of the project and, for a domain-scoped member, in their
     * domains: an agent of theirs must not reach into the containers of another domain. Those it maintains already
     * stay, and those out of their reach are put back: their console never lists them, so it cannot send them.
     */
    private async withCheckedTargets<T extends Pick<MaintenanceAgentDTO, "backendIds" | "frontendIds">>(fields: T, projectId: Schema.Types.ObjectId, existing?: IMaintenanceAgent): Promise<T> {
        const checked = { ...fields }
        const scope = await this.getDomainScope(projectId)
        for (const [field, model] of [
            ["backendIds", Backend],
            ["frontendIds", Frontend]
        ] as const) {
            const ids = uniqueIds(checked[field])
            if (ids === undefined) continue
            const kept = new Set((existing?.[field] ?? []).map(String))
            if (scope && kept.size > 0) {
                const hidden = await (model as typeof Backend).find({ _id: { $in: [...kept].map(toObjectId) }, domainId: { $nin: scope.map(toObjectId) } }, { _id: 1 })
                for (const target of hidden) if (!ids.includes(String(target._id))) ids.push(String(target._id))
            }
            const added = ids.filter(id => !kept.has(id))
            checked[field] = ids
            if (added.length === 0) continue
            const targets = await (model as typeof Backend).find({ _id: { $in: added.map(toObjectId) }, projectId }, { domainId: 1 })
            if (targets.length !== added.length) {
                throw invalid("MAINTENANCE_AGENT_TARGET_INVALID", `Some of the ${field === "backendIds" ? "backends" : "frontends"} it maintains are not of this project`)
            }
            for (const target of targets) await this.ensureInDomainScope(projectId, target.domainId)
        }
        return checked
    }

    async create(dto: MaintenanceAgentDTO, projectId: string | Schema.Types.ObjectId): Promise<IMaintenanceAgent> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)

        const slug = (dto.slug ?? "").trim().toLowerCase()
        // Nothing of what the console or its runs set: the project comes from the request, the last run from Play
        const { id: _id, _id: _mongoId, projectId: _projectId, lastRun: _lastRun, ...fields } = { ...dto, slug } as MaintenanceAgentDTO & { _id?: unknown; projectId?: unknown; lastRun?: unknown }
        const agent = await this.withCheckedTargets(withNormalizedRunning(await withNormalizedReferences(withManualVersion(fields), projectIdObj, undefined, { resources: true })), projectIdObj)
        if (agent.domainId !== undefined) {
            agent.domainId = await resolveDomainId(agent.domainId, projectIdObj)
        }
        // As for a backend: a domain-scoped member creates only inside their domains
        await this.ensureInDomainScope(projectIdObj, agent.domainId)
        const scope = await this.getDomainScope(projectIdObj)
        await ensureAttachableMaps(scope, projectIdObj, agent)
        await ensureAttachableResources(scope, projectIdObj, agent)
        ensureOnlyNewRepositoryLinked(scope, agent.codeRepository)
        ensureRequestsWithinLimits(agent, undefined, "MAINTENANCE_AGENT_INVALID")

        // Both before the repository is created: a refused save would leave an orphan repository behind
        await ensureSlugFree(slug, projectIdObj)
        try {
            await new MaintenanceAgent({ ...agent, projectId: projectIdObj }).validate()
        } catch (error) {
            throw invalid("MAINTENANCE_AGENT_INVALID", (error as Error).message)
        }

        if (agent.codeRepository?.enabled) {
            const codeRepository = await CodeRepository.findById(agent.codeRepository.codeRepositoryId)
            // A connection of another project would lend this one its access token
            if (!codeRepository || String(codeRepository.projectId) !== String(projectIdObj)) {
                throw new EntityNotFoundError(String(agent.codeRepository.codeRepositoryId))
            }

            const createData = agent.codeRepository.createData
            if (createData) {
                await this.ensureNotViewer(projectIdObj, { code: "REPOSITORY_CREATE_FORBIDDEN", message: "A viewer cannot create a code repository" })
                // Scaffolded from the templates of the backends: an agent is a container built the same way
                const template = createData.template ? await new MarketService().getSingle(createData.template) : null
                if (createData.template && !template) {
                    throw invalid("TEMPLATE_NOT_FOUND", `There is no template "${createData.template}"`)
                }
                if (template && !isBackendTemplateType(template.type)) {
                    throw invalid("FRONTEND_TEMPLATE_NOT_ALLOWED", `"${template.slug}" is a frontend template: a maintenance agent is made from a backend one`)
                }

                await new TemplateScaffoldService(this.user).createRepository(codeRepository, agent.codeRepository, slug, template, {
                    placeholders: { "%serviceSlug%": slug, "%domain%": placeholderDomain() }
                })

                if (template) {
                    const defaults = template.backendDefaults
                    if (defaults) {
                        agent.port ??= defaults.port
                        agent.livenessPath ??= defaults.livenessPath
                        agent.readinessPath ??= defaults.readinessPath
                    }
                    agent.template = template.slug
                    agent.stack = { runtime: parseRuntime(template.framework), framework: template.framework, source: FrontendStackSource.TEMPLATE }
                }

                agent.codeRepository.createData = undefined
            }
        }

        return await MaintenanceAgent.create({ ...agent, projectId: projectIdObj } as unknown as IMaintenanceAgent)
    }

    async update(id: string | ObjectId, updates: MaintenanceAgentDTO): Promise<IMaintenanceAgent | null> {
        const agent = await this.getExisting(id)

        // The slug is in the registration URL its CI calls and names its values file: fixed, as for a backend
        const {
            id: _id,
            _id: _mongoId,
            projectId: _projectId,
            slug: _slug,
            lastRun: _lastRun,
            ...fields
        } = updates as Partial<MaintenanceAgentDTO> & { _id?: unknown; projectId?: unknown; lastRun?: unknown }
        const scope = await this.getDomainScope(agent.projectId)
        const withHidden = await withResourcesOutOfScope(scope, agent.projectId, fields, agent)
        const allowed = await this.withCheckedTargets(
            withNormalizedRunning(await withNormalizedReferences(withManualVersion(withHidden), agent.projectId, agent, { resources: true })),
            agent.projectId,
            agent
        )
        if (allowed.domainId !== undefined) {
            allowed.domainId = await resolveDomainId(allowed.domainId, agent.projectId)
            await this.ensureInDomainScope(agent.projectId, allowed.domainId)
        }
        await ensureAttachableMaps(scope, agent.projectId, allowed, agent)
        await ensureAttachableResources(scope, agent.projectId, allowed, agent)
        ensureRequestsWithinLimits(allowed, agent, "MAINTENANCE_AGENT_INVALID")
        if (ensureRepositoryLinkUnchanged(scope, allowed.codeRepository, agent.codeRepository)) delete allowed.codeRepository
        if (allowed.codeRepository) {
            allowed.codeRepository = { ...allowed.codeRepository, createData: undefined }
            if (allowed.codeRepository.enabled || allowed.codeRepository.codeRepositoryId) {
                const codeRepository = await CodeRepository.findById(allowed.codeRepository.codeRepositoryId)
                if (!codeRepository || String(codeRepository.projectId) !== String(agent.projectId)) {
                    throw new EntityNotFoundError(String(allowed.codeRepository.codeRepositoryId))
                }
            }
        }
        try {
            return await MaintenanceAgent.findByIdAndUpdate(agent._id, allowed, { new: true, runValidators: true })
        } catch (error) {
            if ((error as { name?: string }).name === "ValidationError") throw invalid("MAINTENANCE_AGENT_INVALID", (error as Error).message)
            throw error
        }
    }

    async delete(id: string | ObjectId): Promise<IMaintenanceAgent | null> {
        const agent = await this.getExisting(id)
        await BuiltBackend.deleteMany({ backendId: agent._id })
        await BackendDeployment.deleteMany({ backendId: agent._id })
        await MaintenanceRun.deleteMany({ agentId: agent._id })
        return await MaintenanceAgent.findByIdAndDelete(agent._id)
    }

    /** Registered versions, newest first: its CI registers them as a backend's, see registerVersionWithPermissionCheck */
    async getVersionsById(id: string): Promise<IBuiltBackend[]> {
        const agent = await this.getExisting(id)
        return await BuiltBackend.find({ backendId: agent._id }).sort({ createdAt: -1 })
    }

    /** Tags the repository with `version`: the tag starts the pipeline that builds and pushes the image */
    async build(id: string, version: string, branch?: string): Promise<void> {
        if (typeof version !== "string" || !BACKEND_VERSION.test(version)) {
            throw invalid("BACKEND_VERSION_INVALID", "The version may hold only letters, digits, dots, dashes and underscores (at most 128)")
        }
        const agent = await this.getExisting(id)
        await this.ensureNotViewer(agent.projectId, { code: "BACKEND_BUILD_FORBIDDEN", message: "A viewer cannot create a version of a maintenance agent" })
        await new TemplateScaffoldService(this.user).createTag(agent.codeRepository, agent.projectId, version, branch)
    }

    /** The runs started with Play, newest first */
    async getRuns(id: string): Promise<IMaintenanceRun[]> {
        const agent = await this.getExisting(id)
        return await MaintenanceRun.find({ agentId: agent._id }).sort({ createdAt: -1 }).limit(RUNS_SHOWN)
    }

    /**
     * Play: runs the agent now in `environmentId`, as its schedule would, by having Argo CD create a Job from its
     * CronJob there. What Argo CD answers is kept as a run, a refusal included, so the history says why nothing ran;
     * a project with no Argo CD to ask is refused outright.
     */
    async run(id: string, environmentId: string): Promise<IMaintenanceRun> {
        const agent = await this.getExisting(id)
        await this.ensureNotViewer(agent.projectId, { code: "MAINTENANCE_AGENT_RUN_FORBIDDEN", message: "A viewer cannot run a maintenance agent" })
        if (typeof environmentId !== "string" || !isValidObjectId(environmentId)) {
            throw invalid("MAINTENANCE_AGENT_INVALID", "Choose the environment to run it in")
        }
        const environment = await Environment.findOne({ _id: toObjectId(environmentId), projectId: agent.projectId })
        if (!environment) {
            throw new EntityNotFoundError(environmentId)
        }
        const project = await Project.findById(agent.projectId, { containerRegistry: 1 })
        if (!isDeployable(agent, project?.containerRegistry)) {
            throw invalid("MAINTENANCE_AGENT_NOT_DEPLOYED", `"${agent.name}" has no version to run yet: build one, then deploy ${environment.slug}`, 409)
        }

        let error: string | undefined
        try {
            await new ArgoCdService(this.user).createJobFromCronJob(agent.projectId, agent.slug, environment)
        } catch (failure) {
            if (failure instanceof BusinessException && failure.code === "ARGOCD_NOT_CONFIGURED") throw failure
            error = ((failure as Error).message ?? String(failure)).slice(0, ERROR_MAX_LENGTH)
        }

        const at = new Date()
        const run = await MaintenanceRun.create({
            projectId: agent.projectId,
            agentId: agent._id,
            environmentId: environment._id,
            status: error ? MaintenanceRunStatus.FAILED : MaintenanceRunStatus.STARTED,
            ...(error ? { error } : {}),
            // An API key has no person behind it: its synthetic id is not a user
            ...(this.user && !this.user.apiKeyId ? { userId: this.user._id } : {})
        })
        await MaintenanceAgent.updateOne({ _id: agent._id }, { $set: { lastRun: { at, environmentId: environment._id, ok: !error, ...(error ? { error } : {}) } } })
        return run
    }
}

export default MaintenanceAgentService
