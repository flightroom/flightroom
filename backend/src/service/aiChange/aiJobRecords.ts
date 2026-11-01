import { UpdateQuery } from "mongoose"
import { fastify } from "../.."
import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AI_CHANGE_MAX_EVENTS, AiChangeStatus, IAiChangeEvent, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import { IProject } from "../../models/ProjectModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { redactSecrets } from "../../utils/redactSecrets"
import { calculateAiUsageCost, recordAiUsage } from "../AiUsageService"
import { LlmClient, LlmUsage } from "../llm"
import { toErrorMessage } from "../RepositoryFileService"
import { loggable, PROPOSAL_TTL_MS, STALE_AFTER_MS } from "./aiChangeShared"
import { JobProposal } from "./aiJobWorkingCopies"
import { maskedEnd } from "./commandOutput"

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
 * With `endsLiveOutput`, the same write unsets what the script printed while it ran, which its "output" event now holds.
 */
export const logJobEvent = async (jobId: string, kind: IAiChangeEvent["kind"], message: string, endsLiveOutput = false) => {
    const shown = kind === "text" || kind === "thinking" || kind === "output" ? redactSecrets(message) : message
    const jobUpdate = endsLiveOutput ? { ...event(kind, shown), $unset: { liveOutput: 1 } } : event(kind, shown)
    // Written side by side: one line per event the agent sends, the job and its requests do not wait on each other.
    await Promise.all([AiChangeJob.updateOne({ _id: toObjectId(jobId) }, jobUpdate), AiChangeRequest.updateMany({ jobId: toObjectId(jobId) }, event(kind, shown))])
}

/** Characters of a running script's output kept on the job: the end, where it is at. */
const LIVE_OUTPUT_CHARS = 4_000
/** Characters read before masking: a secret starting before the shown end is still recognised whole. */
const LIVE_READ_CHARS = 2 * LIVE_OUTPUT_CHARS
/** How often what a running script printed is written: the pages poll every few seconds, not at each line. */
const LIVE_OUTPUT_EVERY_MS = 2_000

/**
 * What the script or the command the agent is running prints, shown on the job while it runs: an install can take
 * minutes before its "output" event. Only on the job: a request of a job is followed through its conversation.
 * Masked whole, then cut, as that event is; unset once the next event is logged.
 */
export class LiveJobOutput {
    private text = ""
    /** Whether the start of the output was dropped from `text`: the line it falls in is not shown. */
    private cut = false
    private timer?: NodeJS.Timeout
    private shown = false
    private writing: Promise<void> = Promise.resolve()
    /** The write waiting for the one in flight: a newer one takes its place, a slow database does not pile them up. */
    private next?: UpdateQuery<IAiChangeJob>

    constructor(private readonly jobId: string) {}

    add(chunk: string) {
        const text = this.text + chunk
        this.cut ||= text.length > LIVE_READ_CHARS
        this.text = text.slice(-LIVE_READ_CHARS)
        this.timer ??= setTimeout(() => {
            this.timer = undefined
            this.write(maskedEnd(this.text, LIVE_OUTPUT_CHARS, this.cut).text)
        }, LIVE_OUTPUT_EVERY_MS)
    }

    /**
     * Before the next event: stops showing what the script prints, its "output" event holds it from now on. Tells
     * whether the job still shows some, for that event's own write to unset it. Never throws.
     */
    async stop() {
        clearTimeout(this.timer)
        this.timer = undefined
        this.text = ""
        this.cut = false
        this.next = undefined
        await this.writing
        const shown = this.shown
        this.shown = false
        return shown
    }

    /** When the run ends, no event follows to unset what the job shows: unset here. Never throws. */
    async end() {
        if (!(await this.stop())) return
        this.write(undefined)
        await this.writing
    }

    /** One write after the other: an unset never lands before the write it follows. */
    private write(text: string | undefined) {
        this.shown = text !== undefined
        const queued = this.next !== undefined
        this.next = text === undefined ? { $unset: { liveOutput: 1 } } : { $set: { liveOutput: text } }
        if (queued) return
        this.writing = this.writing
            .then(() => {
                const update = this.next
                this.next = undefined
                return update && AiChangeJob.updateOne({ _id: toObjectId(this.jobId) }, update)
            })
            .then(
                () => undefined,
                error => fastify.log.warn({ error: loggable(error), aiJobId: this.jobId }, "AI job live output not written")
            )
    }
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
            // A job of a mission is counted apart: it runs on its own, nobody asked for each of its rounds.
            source: job.missionId ? "mission" : "agent",
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
    const failed = await AiChangeJob.findOneAndUpdate(
        { _id: job._id, status: job.status },
        { status: AiJobStatus.FAILED, error, finishedAt: job.updatedAt, expiresAt: expiry() },
        { returnDocument: "after" }
    )
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
