import { AnyKeys, ObjectId, PipelineStage, Schema, Types } from "mongoose"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import AiUsage, { AI_USAGE_SOURCES, AiUsageSource, IAiUsage } from "../models/AiUsageModel"
import Domain from "../models/DomainModel"
import Frontend from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import Service from "../models/ServiceModel"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService from "./BaseAuthorizedService"
import { LlmEffort, LlmProvider, LlmUsage, NO_USAGE } from "./llm/types"

type Id = string | ObjectId | Schema.Types.ObjectId | Types.ObjectId

/** The periods the console sums the tokens over: the last 30 or 90 days, the current calendar month, or everything recorded. */
export type AiUsagePeriod = "30d" | "month" | "90d" | "all"

export const AI_USAGE_PERIODS: readonly AiUsagePeriod[] = ["30d", "month", "90d", "all"]

const DAY_MS = 24 * 60 * 60 * 1000

/** The first instant counted, or undefined for everything. The month starts at midnight UTC, as the dates are stored. */
export const periodStart = (period: AiUsagePeriod, now = new Date()): Date | undefined => {
    if (period === "30d") return new Date(now.getTime() - 30 * DAY_MS)
    if (period === "90d") return new Date(now.getTime() - 90 * DAY_MS)
    if (period === "month") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    return undefined
}

export interface AiUsageSummary {
    period: AiUsagePeriod
    /** The first instant counted: missing for `all`. */
    since?: Date
    total: LlmUsage
}

export interface ProjectAiUsageSummary extends AiUsageSummary {
    bySource: Record<AiUsageSource, LlmUsage>
}

export interface ProjectAiUsage extends LlmUsage {
    projectId: string
    /** Missing for a project deleted since: its usage still counts for the organization. */
    name?: string
}

export interface OrganizationAiUsageSummary extends AiUsageSummary {
    /** Most tokens first. */
    byProject: ProjectAiUsage[]
}

/** What a caller records: the organization is read from the project when the caller does not hold it. */
export interface AiUsageEntry extends LlmUsage {
    projectId: Id
    organizationId?: Id
    userId?: Id
    source: AiUsageSource
    jobId?: Id
    domainId?: Id
    frontendIds?: Id[]
    serviceIds?: Id[]
    aiModelId?: string
    provider?: LlmProvider
    effort?: LlmEffort
}

/**
 * Adds one amount of tokens to the ledger. Nothing is recorded for a round that spent none. The callers catch what
 * this throws: a usage that cannot be recorded must never stop a job or an answer.
 */
export const recordAiUsage = async (entry: AiUsageEntry): Promise<void> => {
    if (!entry.inputTokens && !entry.cachedInputTokens && !entry.outputTokens) return
    const organizationId = entry.organizationId ?? (await Project.findById(toObjectId(String(entry.projectId)), { organizationId: 1 }).lean())?.organizationId
    if (!organizationId) throw new EntityNotFoundError(String(entry.projectId), `No organization for the project ${String(entry.projectId)}`)
    // The ids come as strings or ObjectIds, whichever the caller holds: the model casts them.
    const document: AnyKeys<IAiUsage> = { ...entry, organizationId }
    await AiUsage.create(document)
}

/**
 * An id the aggregation can match on: unlike a query, a pipeline casts nothing. Already valid here: the routes check
 * the pattern, and the domain, the repository or the project is read with it first.
 */
const objectId = (id: Id): Types.ObjectId => new Types.ObjectId(String(id))

const matchOf = (filter: Record<string, unknown>, period: AiUsagePeriod): PipelineStage.Match => {
    const since = periodStart(period)
    return { $match: since ? { ...filter, createdAt: { $gte: since } } : filter }
}

/** The three sums of a `$group`, each token weighed by `weight` (1, or the share of a repository). */
const sums = (weight: unknown = 1) => ({
    inputTokens: { $sum: weight === 1 ? "$inputTokens" : { $multiply: ["$inputTokens", weight] } },
    cachedInputTokens: { $sum: weight === 1 ? "$cachedInputTokens" : { $multiply: ["$cachedInputTokens", weight] } },
    outputTokens: { $sum: weight === 1 ? "$outputTokens" : { $multiply: ["$outputTokens", weight] } }
})

/** A job on N repositories counts 1/N of its tokens for each of them: summed over the documents, then rounded once. */
const REPOSITORY_SHARE = {
    $divide: [1, { $max: [1, { $add: [{ $size: { $ifNull: ["$frontendIds", []] } }, { $size: { $ifNull: ["$serviceIds", []] } }] }] }]
}

type Totals = Partial<LlmUsage> & { _id?: unknown }

const rounded = (totals?: Totals): LlmUsage => ({
    inputTokens: Math.round(totals?.inputTokens ?? 0),
    cachedInputTokens: Math.round(totals?.cachedInputTokens ?? 0),
    outputTokens: Math.round(totals?.outputTokens ?? 0)
})

const added = (usages: LlmUsage[]): LlmUsage =>
    usages.reduce(
        (sum, usage) => ({
            inputTokens: sum.inputTokens + usage.inputTokens,
            cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
            outputTokens: sum.outputTokens + usage.outputTokens
        }),
        NO_USAGE
    )

const tokensOf = (usage: LlmUsage) => usage.inputTokens + usage.outputTokens

/** The pipeline of the total of a domain, a frontend or a service: exported for the tests, which have no MongoDB. */
export const componentPipeline = (field: "domainId" | "frontendIds" | "serviceIds", id: Id, period: AiUsagePeriod): PipelineStage[] => [
    matchOf({ [field]: objectId(id) }, period),
    // The domain the job was asked from counts all of it; a repository its share.
    { $group: { _id: null, ...sums(field === "domainId" ? 1 : REPOSITORY_SHARE) } }
]

export const projectPipeline = (projectId: Id, period: AiUsagePeriod): PipelineStage[] => [matchOf({ projectId: objectId(projectId) }, period), { $group: { _id: "$source", ...sums() } }]

export const organizationPipeline = (organizationId: Id, period: AiUsagePeriod): PipelineStage[] => [
    matchOf({ organizationId: objectId(organizationId) }, period),
    { $group: { _id: "$projectId", ...sums() } }
]

/**
 * The AI tokens spent, by Edit with AI jobs and the assistant, at each level the console shows them: a domain, a
 * frontend or a service (the jobs only, the assistant working on no repository), a project, an organization.
 * Whoever sees the domain, the repository or the project sees its usage; the organization's, which names every
 * project, is for its administrators, who decide which AIs the projects use.
 */
export default class AiUsageService extends BaseAuthorizedService {
    async forDomain(domainId: string, period: AiUsagePeriod): Promise<AiUsageSummary> {
        const domain = await Domain.findById(toObjectId(domainId), { projectId: 1 })
        if (!domain) throw new EntityNotFoundError(domainId)
        await this.ensureAccessToProject(domain.projectId)
        await this.ensureInDomainScope(domain.projectId, domain._id)
        return this.summary(componentPipeline("domainId", domainId, period), period)
    }

    async forFrontend(frontendId: string, period: AiUsagePeriod): Promise<AiUsageSummary> {
        const frontend = await Frontend.findById(toObjectId(frontendId), { projectId: 1, domainId: 1 })
        if (!frontend) throw new EntityNotFoundError(frontendId)
        await this.ensureAccessToFrontend(frontend)
        return this.summary(componentPipeline("frontendIds", frontendId, period), period)
    }

    async forService(serviceId: string, period: AiUsagePeriod): Promise<AiUsageSummary> {
        const service = await Service.findById(toObjectId(serviceId), { projectId: 1, domainId: 1 })
        if (!service) throw new EntityNotFoundError(serviceId)
        await this.ensureAccessToService(service)
        return this.summary(componentPipeline("serviceIds", serviceId, period), period)
    }

    /** The whole project: a member confined to some domains sees only theirs. */
    async forProject(projectId: string, period: AiUsagePeriod): Promise<ProjectAiUsageSummary> {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)
        const groups = await AiUsage.aggregate<Totals>(projectPipeline(projectId, period))
        const bySource = Object.fromEntries(AI_USAGE_SOURCES.map(source => [source, rounded(groups.find(group => group._id === source))])) as Record<AiUsageSource, LlmUsage>
        return { period, since: periodStart(period), total: added(Object.values(bySource)), bySource }
    }

    async forOrganization(organizationId: string, period: AiUsagePeriod): Promise<OrganizationAiUsageSummary> {
        await this.ensureOrganizationAdmin(organizationId)
        const groups = await AiUsage.aggregate<Totals>(organizationPipeline(organizationId, period))
        const projects = groups.length ? await Project.find({ _id: { $in: groups.map(group => toObjectId(String(group._id))) } }, { name: 1 }).lean() : []
        const names = new Map(projects.map(project => [String(project._id), project.name]))
        const byProject = groups.map(group => ({ projectId: String(group._id), name: names.get(String(group._id)), ...rounded(group) })).sort((a, b) => tokensOf(b) - tokensOf(a))
        return { period, since: periodStart(period), total: added(byProject.map(rounded)), byProject }
    }

    private async summary(pipeline: PipelineStage[], period: AiUsagePeriod): Promise<AiUsageSummary> {
        const [totals] = await AiUsage.aggregate<Totals>(pipeline)
        return { period, since: periodStart(period), total: rounded(totals) }
    }
}
