import { AnyKeys, ObjectId, PipelineStage, Schema, Types } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import AiModel, { AiCurrency } from "../models/AiModelModel"
import AiUsage, { AI_USAGE_SOURCES, AiUsageSource, IAiUsage } from "../models/AiUsageModel"
import Backend from "../models/BackendModel"
import Domain from "../models/DomainModel"
import Frontend from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import User from "../models/UserModel"
import { ORGANIZATION_ADMIN_ROLES } from "../models/UserOrganizationModel"
import UserProject, { RoleInProject } from "../models/UserProjectModel"
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

/** The periods a member's usage is summed by: a calendar day, an ISO week (Monday first) or a calendar month. */
export type AiUsageGranularity = "day" | "week" | "month"

export const AI_USAGE_GRANULARITIES: readonly AiUsageGranularity[] = ["day", "week", "month"]

/** The key of each period, in the time zone asked: 2026-10-23, 2026-W43, 2026-10. In string order, they are in time order. */
const PERIOD_FORMATS: Record<AiUsageGranularity, string> = { day: "%Y-%m-%d", week: "%G-W%V", month: "%Y-%m" }

/** The days a daily series may span: a year, leap day included. Weeks and months have no limit. */
export const MAX_DAILY_SPAN_DAYS = 366

export const AI_USAGE_RANGE_INVALID = "AI_USAGE_RANGE_INVALID"

export interface MemberAiUsageQuery {
    /** The first and the last day counted, both included, as YYYY-MM-DD in `timeZone`. */
    from: string
    to: string
    granularity: AiUsageGranularity
    /** An IANA time zone, e.g. Europe/Rome: where the days begin. UTC when left out, as the dates are stored. */
    timeZone?: string
}

/** Who the usage is asked of: by id, or by the email they sign in with. */
export type MemberRef = { userId: string; email?: undefined } | { userId?: undefined; email: string }

export interface MemberAiUsage extends Required<MemberAiUsageQuery> {
    projectId: string
    userId: string
    total: LlmUsage
    /** Only the periods with some usage, oldest first. */
    series: (LlmUsage & { period: string })[]
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
    backendIds?: Id[]
    aiModelId?: string
    provider?: LlmProvider
    effort?: LlmEffort
    cost?: number
    currency?: AiCurrency
    /** Kept for entries written before selecting a currency was supported. */
    costUsd?: number
}

export interface AiUsageCost {
    amount: number
    currency: AiCurrency
}

/** Cost in the configured currency; absent rates (including the system AI) stay unpriced. */
export const calculateAiUsageCost = async (aiModelId: string | undefined, usage: LlmUsage): Promise<AiUsageCost | undefined> => {
    if (!aiModelId || !/^[a-f\d]{24}$/i.test(aiModelId)) return undefined
    const model = await AiModel.findById(aiModelId, { tokenCosts: 1 }).lean()
    const costs = model?.tokenCosts
    if (!costs || ![costs.input, costs.cachedInput, costs.output].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000)) {
        return undefined
    }
    const regularInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens)
    return {
        amount: Number(((regularInputTokens * costs.input + usage.cachedInputTokens * costs.cachedInput + usage.outputTokens * costs.output) / 1_000_000).toFixed(12)),
        currency: costs.currency ?? "USD"
    }
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
    $divide: [1, { $max: [1, { $add: [{ $size: { $ifNull: ["$frontendIds", []] } }, { $size: { $ifNull: ["$backendIds", []] } }] }] }]
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

/** The pipeline of the total of a domain, a frontend or a backend: exported for the tests, which have no MongoDB. */
export const componentPipeline = (field: "domainId" | "frontendIds" | "backendIds", id: Id, period: AiUsagePeriod): PipelineStage[] => [
    matchOf({ [field]: objectId(id) }, period),
    // The domain the job was asked from counts all of it; a repository its share.
    { $group: { _id: null, ...sums(field === "domainId" ? 1 : REPOSITORY_SHARE) } }
]

export const projectPipeline = (projectId: Id, period: AiUsagePeriod): PipelineStage[] => [matchOf({ projectId: objectId(projectId) }, period), { $group: { _id: "$source", ...sums() } }]

export const organizationPipeline = (organizationId: Id, period: AiUsagePeriod): PipelineStage[] => [
    matchOf({ organizationId: objectId(organizationId) }, period),
    { $group: { _id: "$projectId", ...sums() } }
]

/** A member's usage in the project between two days, summed by period: exported for the tests, which have no MongoDB. */
export const memberSeriesPipeline = (projectId: Id, userId: Id, { from, to, granularity, timeZone = "UTC" }: MemberAiUsageQuery): PipelineStage[] => {
    const local = (format: string) => ({ $dateToString: { date: "$createdAt", format, timezone: timeZone } })
    return [
        // A day more on each side, whatever the zone, for the index to narrow on: the next stage cuts on the local days.
        { $match: { projectId: objectId(projectId), userId: objectId(userId), createdAt: { $gte: new Date(Date.parse(from) - DAY_MS), $lt: new Date(Date.parse(to) + 2 * DAY_MS) } } },
        { $match: { $expr: { $and: [{ $gte: [local("%Y-%m-%d"), from] }, { $lte: [local("%Y-%m-%d"), to] }] } } },
        { $group: { _id: local(PERIOD_FORMATS[granularity]), ...sums() } },
        { $sort: { _id: 1 } }
    ]
}

const ensureValidRange = ({ from, to, granularity }: MemberAiUsageQuery) => {
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1
    if (days < 1) throw createBusinessException({ code: AI_USAGE_RANGE_INVALID, message: `The last day (${to}) comes before the first (${from})`, statusCode: 400 })
    if (granularity === "day" && days > MAX_DAILY_SPAN_DAYS) {
        throw createBusinessException({ code: AI_USAGE_RANGE_INVALID, message: `A daily series spans at most ${MAX_DAILY_SPAN_DAYS} days: ask by week or month, or a shorter range`, statusCode: 400 })
    }
}

export const AI_TOKEN_LIMIT_REACHED = "AI_TOKEN_LIMIT_REACHED"

/** What members spent in the project this calendar month, input and output tokens together: exported for the tests. */
export const membersMonthPipeline = (projectId: Id, userIds: Id[]): PipelineStage[] => [
    matchOf({ projectId: objectId(projectId), userId: { $in: userIds.map(objectId) } }, "month"),
    { $group: { _id: "$userId", tokens: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } }
]

/** The tokens each of `userIds` spent in the project this calendar month, by user id: none spent, none listed. */
export const tokensSpentThisMonth = async (projectId: Id, userIds: Id[]): Promise<Map<string, number>> => {
    if (userIds.length === 0) return new Map()
    const groups = await AiUsage.aggregate<{ _id: unknown; tokens: number }>(membersMonthPipeline(projectId, userIds))
    return new Map(groups.map(group => [String(group._id), group.tokens]))
}

/**
 * What members spent in the project this calendar month in money, by currency: only the priced usage counts, an entry
 * of before the currency was chosen in USD. Exported for the tests.
 */
export const membersMonthCostPipeline = (projectId: Id, userIds: Id[]): PipelineStage[] => [
    matchOf({ projectId: objectId(projectId), userId: { $in: userIds.map(objectId) }, $or: [{ cost: { $type: "number" } }, { costUsd: { $type: "number" } }] }, "month"),
    { $group: { _id: { userId: "$userId", currency: { $ifNull: ["$currency", "USD"] } }, amount: { $sum: { $ifNull: ["$cost", "$costUsd"] } } } }
]

/** The money each of `userIds` spent in the project this calendar month, one amount per currency, by user id: none priced, none listed. */
export const costsSpentThisMonth = async (projectId: Id, userIds: Id[]): Promise<Map<string, AiUsageCost[]>> => {
    if (userIds.length === 0) return new Map()
    const groups = await AiUsage.aggregate<{ _id: { userId: unknown; currency: AiCurrency }; amount: number }>(membersMonthCostPipeline(projectId, userIds))
    const costs = new Map<string, AiUsageCost[]>()
    for (const { _id, amount } of groups) {
        const userId = String(_id.userId)
        costs.set(userId, [...(costs.get(userId) ?? []), { amount: Number(amount.toFixed(12)), currency: _id.currency }])
    }
    return costs
}

/**
 * Refuses an answer or a job to a member who spent their monthly limit in the project. Who has no limit, or no
 * membership (an organization administrator outside the project), is not counted. Checked before the work starts:
 * an answer or a job already running ends, and may go past the limit.
 */
export const ensureWithinTokenLimit = async (projectId: Id, userId: Id): Promise<void> => {
    const membership = await UserProject.findOne({ projectId: toObjectId(String(projectId)), userId: toObjectId(String(userId)), invitationToken: null }, { aiTokenLimit: 1 })
    const limit = membership?.aiTokenLimit
    if (limit === undefined || limit === null) return
    const spent = (await tokensSpentThisMonth(projectId, [userId])).get(String(userId)) ?? 0
    if (spent >= limit) {
        throw createBusinessException({
            code: AI_TOKEN_LIMIT_REACHED,
            message: `The monthly limit of ${limit} AI tokens in this project is spent: it starts again next month`,
            statusCode: 429
        })
    }
}

/**
 * The AI tokens spent, by Edit with AI jobs and the assistant, at each level the console shows them: a domain, a
 * frontend or a backend (the jobs only, the assistant working on no repository), a project, an organization.
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

    async forBackend(backendId: string, period: AiUsagePeriod): Promise<AiUsageSummary> {
        const backend = await Backend.findById(toObjectId(backendId), { projectId: 1, domainId: 1 })
        if (!backend) throw new EntityNotFoundError(backendId)
        await this.ensureAccessToBackend(backend)
        return this.summary(componentPipeline("backendIds", backendId, period), period)
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

    /**
     * What one person spent in the project between two days, by day, week or month. Theirs to see, and the owners' of
     * the project and the administrators' of its organization, who set the members' monthly limits. Anyone else is
     * refused before the person is looked up: the answer must not tell whether an email exists.
     */
    async forMember(projectId: string, member: MemberRef, query: MemberAiUsageQuery): Promise<MemberAiUsage> {
        ensureValidRange(query)
        await this.ensureAccessToProject(projectId)
        const caller = this.getUser()
        const self = member.email === undefined ? member.userId === String(caller?._id) : member.email.toLowerCase() === caller?.email
        if (!self && !(await this.managesProject(projectId))) {
            throw createBusinessException({ code: "PROJECT_OWNER_REQUIRED", message: "Only an owner of the project sees the AI usage of the other members", statusCode: 403 })
        }
        const userId = member.userId ?? String((await User.findOne({ email: member.email.toLowerCase() }, { _id: 1 }).lean())?._id ?? "")
        if (!userId) throw new EntityNotFoundError(member.email!, `No user signs in with ${member.email}`)
        const groups = await AiUsage.aggregate<Totals>(memberSeriesPipeline(projectId, userId, query))
        const series = groups.map(group => ({ period: String(group._id), ...rounded(group) }))
        return { projectId, userId, from: query.from, to: query.to, granularity: query.granularity, timeZone: query.timeZone ?? "UTC", total: added(series), series }
    }

    /** An owner of the whole project, or an administrator of its organization: they act there as owners. An API key is neither. */
    private async managesProject(projectId: string): Promise<boolean> {
        const caller = this.user
        if (!caller || caller.apiKeyId) return false
        const membership = await UserProject.findOne({ userId: toObjectId(String(caller._id)), projectId: toObjectId(projectId), invitationToken: null }, { role: 1, domainScoped: 1 }).lean()
        if (membership?.role === RoleInProject.OWNER && !membership.domainScoped) return true
        const project = await Project.findById(toObjectId(projectId), { organizationId: 1 }).lean()
        const role = project && (await this.findRoleInOrganization(project.organizationId))
        return Boolean(role && ORGANIZATION_ADMIN_ROLES.includes(role))
    }

    private async summary(pipeline: PipelineStage[], period: AiUsagePeriod): Promise<AiUsageSummary> {
        const [totals] = await AiUsage.aggregate<Totals>(pipeline)
        return { period, since: periodStart(period), total: rounded(totals) }
    }
}
