import { UpdateQuery } from "mongoose"
import { fastify } from "../.."
import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AI_CHANGE_MAX_EVENTS, AiChangeStatus, IAiChangeEvent, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import { IProject } from "../../models/ProjectModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { calculateAiUsageCost, recordAiUsage } from "../AiUsageService"
import { redactSecrets } from "../assistant/assistantTools"
import { LlmClient, LlmUsage } from "../llm"
import { toErrorMessage } from "../RepositoryFileService"
import { loggable, PROPOSAL_TTL_MS, STALE_AFTER_MS } from "./aiChangeShared"
import { JobProposal } from "./aiJobWorkingCopies"

export const ACTIVE_JOB_STATUSES = [AiJobStatus.PENDING, AiJobStatus.RUNNING]
/** The requests of a job its agent has not finished with yet. */
export const UNFINISHED_REQUEST_STATUSES = [AiChangeStatus.PENDING, AiChangeStatus.RUNNING]

/** An `updatedAt` filter keeping what was heard of lately: what is older died with its process. */
export const fresh = () => ({ $gt: new Date(Date.now() - STALE_AFTER_MS) })

export const isStale = (job: Pick<IAiChangeJob, "status" | "updatedAt">) => ACTIVE_JOB_STATUSES.includes(job.status) && Date.now() - job.updatedAt.getTime() > STALE_AFTER_MS

export const expiry = () => new Date(Date.now() + PROPOSAL_TTL_MS)

export const event = (kind: IAiChangeEvent["kind"], message: string) => ({ $push: { events: { $each: [{ at: new Date(), kind, message }], $slice: -AI_CHANGE_MAX_EVENTS } } })

/**
 * One progress line, on the job and on each of its requests: the page of every repository stays live.
 * What the model said or thought, and what a script printed, can repeat a secret: masked, as in the assistant's saved answers.
 */
export const logJobEvent = async (jobId: string, kind: IAiChangeEvent["kind"], message: string) => {
    const shown = kind === "text" || kind === "thinking" || kind === "output" ? redactSecrets(message) : message
    // Written side by side: one line per event the agent sends, the job and its requests do not wait on each other.
    await Promise.all([AiChangeJob.updateOne({ _id: toObjectId(jobId) }, event(kind, shown)), AiChangeRequest.updateMany({ jobId: toObjectId(jobId) }, event(kind, shown))])
}

/**
 * The usage is the job's: every request of it carries the same total. Also added to the ledger, which outlives
 * the job: a job nobody applies is removed after a week, what it spent still counts.
 */
export const addJobUsage = async (job: IAiChangeJob, project: IProject, client: LlmClient, usage: LlmUsage) => {
    let cost: Awaited<ReturnType<typeof calculateAiUsageCost>>
    try {
        cost = await calculateAiUsageCost(job.aiModelId, usage)
    } catch (error) {
        fastify.log.error({ error: loggable(error), aiJobId: String(job._id), aiModelId: job.aiModelId }, "AI job interaction cost could not be calculated")
    }
    const usageIncrement: Record<string, number> = { "usage.inputTokens": usage.inputTokens, "usage.cachedInputTokens": usage.cachedInputTokens, "usage.outputTokens": usage.outputTokens }
    if (cost) usageIncrement["usage.cost"] = cost.amount
    const increment = { $inc: usageIncrement }
    const currency = cost ? { $set: { "usage.currency": cost.currency } } : {}
    // One after the other: a failed job write leaves the requests and the ledger untouched, so the totals stay in step.
    await AiChangeJob.updateOne({ _id: job._id }, { ...increment, ...currency })
    await AiChangeRequest.updateMany({ jobId: job._id }, { ...increment, ...currency })
    try {
        await recordAiUsage({
            organizationId: project.organizationId,
            projectId: job.projectId,
            userId: job.userId,
            source: "agent",
            jobId: job._id,
            domainId: job.domainId,
            frontendIds: job.frontendIds,
            backendIds: job.backendIds,
            aiModelId: job.aiModelId,
            provider: client.provider,
            effort: job.effort,
            cost: cost?.amount,
            currency: cost?.currency,
            ...usage
        })
    } catch (error) {
        fastify.log.error({ error: loggable(error), aiJobId: String(job._id) }, "AI job usage not recorded")
    }
}

/** Fails a job still active, its requests first: the console stops polling once the job has ended. */
export const failJob = async (jobId: string, error: string) => {
    await AiChangeRequest.updateMany({ jobId: toObjectId(jobId), status: { $in: UNFINISHED_REQUEST_STATUSES } }, { status: AiChangeStatus.FAILED, error, expiresAt: expiry() })
    await AiChangeJob.updateOne({ _id: toObjectId(jobId), status: { $in: ACTIVE_JOB_STATUSES } }, { status: AiJobStatus.FAILED, error, finishedAt: new Date(), expiresAt: expiry() })
}

/** A job whose process died is reported as failed, and so are its requests still waiting for it. */
export const failIfStale = async <T extends Pick<IAiChangeJob, "_id" | "status" | "updatedAt">>(job: T): Promise<T | IAiChangeJob> => {
    if (!isStale(job)) return job
    const error = "The job stopped without finishing"
    // It ended when it was last heard of, not when somebody noticed.
    const failed = await AiChangeJob.findOneAndUpdate({ _id: job._id, status: job.status }, { status: AiJobStatus.FAILED, error, finishedAt: job.updatedAt, expiresAt: expiry() }, { new: true })
    await AiChangeRequest.updateMany({ jobId: job._id, status: { $in: UNFINISHED_REQUEST_STATUSES } }, { status: AiChangeStatus.FAILED, error, expiresAt: expiry() })
    return failed ?? job
}

/** A proposal refined by a newer one is discarded: only the latest of a chain can be applied. */
const supersede = async (parentId: IAiChangeRequest["_id"]) => {
    await AiChangeRequest.updateOne({ _id: parentId, status: AiChangeStatus.PROPOSED }, { status: AiChangeStatus.DISCARDED, ...event("info", "superseded") })
}

/**
 * Saves each proposal on its request, the one it refines discarded. Guarded: a request of a job already
 * declared dead must not come back to life. Proposals already saved can be reviewed when a later one cannot
 * be: the ones left behind fail, and the error said of the job is returned.
 */
export const saveProposals = async (jobId: IAiChangeJob["_id"], proposals: JobProposal[], updateOf: (proposal: JobProposal) => UpdateQuery<IAiChangeRequest>): Promise<string | undefined> => {
    let saved = 0
    try {
        for (const proposal of proposals) {
            const { request } = proposal.repository
            const proposed = await AiChangeRequest.findOneAndUpdate({ _id: request._id, status: AiChangeStatus.RUNNING }, updateOf(proposal))
            if (!proposed) continue
            saved++
            if (request.parentId) await supersede(request.parentId)
        }
        return undefined
    } catch (error) {
        if (saved === 0) throw error
        const partial = `Only ${saved} of ${proposals.length} proposals could be saved: ${toErrorMessage(error)}`
        fastify.log.warn({ error: loggable(error), aiJobId: String(jobId) }, "AI job saved part of its proposals")
        await AiChangeRequest.updateMany({ jobId, status: { $in: UNFINISHED_REQUEST_STATUSES } }, { status: AiChangeStatus.FAILED, error: partial, expiresAt: expiry() })
        return partial
    }
}
