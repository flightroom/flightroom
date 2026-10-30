import { Types } from "mongoose"
import { fastify } from "../.."
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import AiChangeJob, { AiJobScope, AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AiChangeStatus, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import AiMission, { AiMissionMode, AiMissionStatus, IAiMission, IAiMissionRepository } from "../../models/AiMissionModel"
import User, { IUser } from "../../models/UserModel"
import { isValidRefName } from "../../utils/gitRefUtils"
import { toObjectId } from "../../utils/mongooseUtils"
import { ensureWithinTokenLimit } from "../AiUsageService"
import { domainScopeForbidden, isInDomainScope } from "../BaseAuthorizedService"
import { LlmConfiguration, LlmEffort, LlmUsage } from "../llm"
import { toErrorMessage } from "../RepositoryFileService"
import { componentIdOf, componentsOfJob, findComponents, RepositoryComponent, RepositoryComponentKind, RepositoryComponentRef } from "../workspace/repositoryComponent"
import AiChangeJobService from "./AiChangeJobService"
import { AiChangeBaseService, loggable, onAiJobEnded, onBeforeAiCapCheck, PROPOSAL_TTL_MS, STALE_AFTER_MS, staleOutcome } from "./aiChangeShared"
import { ACTIVE_JOB_STATUSES } from "./aiJobRecords"

/** Repositories of a batch: as many as one job may work on, so a `global` batch is one job. */
export const MISSION_BATCH_SIZE = 10
/** Repositories one mission may cover: each is minutes of paid model time. */
const MAX_REPOSITORIES_PER_MISSION = 200
const DEFAULT_CONCURRENCY = 3
const LISTED_MISSIONS = 50
/** Missions a domain-scoped member's list reads at most: those out of their scope are dropped after reading. */
const MAX_SCANNED_MISSIONS = 200
const NOT_STARTED_ERROR = "The job could not be started"

/** What a mission view reads of each request: no file contents, no progress. */
const REQUEST_SUMMARY = { jobId: 1, frontendId: 1, backendId: 1, status: 1, "files.path": 1, branch: 1, pullRequestUrl: 1, error: 1, updatedAt: 1 } as const

export interface AiMissionCreateInput {
    prompt: string
    mode: AiMissionMode
    /** Every frontend and backend of the project with a repository: exactly one of this and the ids. */
    all?: boolean
    frontendIds?: string[]
    backendIds?: string[]
    /** In `perRepository` mode, the jobs active at once: 3 when left out. */
    concurrency?: number
    effort?: LlmEffort
    baseBranch?: string
    aiModelId?: string
}

export interface AiMissionRepositoryView {
    kind: RepositoryComponentKind
    id: string
    name: string
    domainId?: string
    batch: number
    /**
     * Unset while queued. The latest job of the conversation on this repository: a follow-up asked on the
     * mission's job replaces it here, as its proposal replaces the job's.
     */
    jobId?: string
    /** Only once the job exists: unset while it is being started, or when it could not be (`error` says why). */
    jobStatus?: AiJobStatus
    requestStatus?: AiChangeStatus
    filesChanged?: number
    branch?: string
    pullRequestUrl?: string
    error?: string
}

export interface AiMissionView {
    _id: string
    projectId: string
    userId: string
    userName?: string
    prompt: string
    mode: AiMissionMode
    concurrency: number
    baseBranch?: string
    status: AiMissionStatus
    currentBatch: number
    batchCount: number
    repositories: AiMissionRepositoryView[]
    /** `queued` includes the jobs created and not started yet; `applying` those being pushed, apart from the proposals still to apply. */
    counts: { queued: number; running: number; proposed: number; applying: number; applied: number; failed: number; noChanges: number }
    usage: LlmUsage
    /** Whether the caller may stop or apply it: who started it, or an organization administrator. Others only read it. */
    canAct: boolean
    createdAt: Date
    updatedAt: Date
}

/** A frontend or a backend a mission may be started on. */
export interface AiMissionRepositoryOption {
    kind: RepositoryComponentKind
    id: string
    name: string
    domainId?: string
}

/** Where a repository of the current batch stands, for advancing the mission. */
type RepositoryState = "queued" | "active" | "done" | "failed"

const expiry = () => new Date(Date.now() + PROPOSAL_TTL_MS)

const tooMany = () =>
    createBusinessException({
        code: "AI_MISSION_TOO_MANY_REPOSITORIES",
        message: `A mission works on at most ${MAX_REPOSITORIES_PER_MISSION} repositories: select the frontends and backends to change`,
        statusCode: 400
    })

const notRunning = () => createBusinessException({ code: "AI_MISSION_NOT_RUNNING", message: "The mission is not running anymore", statusCode: 409 })

const refOf = (entry: Pick<IAiMissionRepository, "kind" | "id">): RepositoryComponentRef => ({ kind: entry.kind, id: String(entry.id) })

const uniqueRefs = (refs: RepositoryComponentRef[]) => refs.filter((ref, index, all) => all.findIndex(other => other.id === ref.id) === index)

/** Claimed so long ago that the job, never created, will not be: the process starting it died. */
const claimExpired = (jobId: IAiMissionRepository["jobId"]) => Date.now() - new Types.ObjectId(String(jobId)).getTimestamp().getTime() > STALE_AFTER_MS

type JobSummary = Pick<IAiChangeJob, "_id" | "status" | "error" | "usage" | "rootJobId" | "frontendIds" | "backendIds" | "createdAt">
type RequestSummary = Pick<IAiChangeRequest, "jobId" | "frontendId" | "backendId" | "status" | "files" | "branch" | "pullRequestUrl" | "error" | "updatedAt">

/** What a view reads of the jobs of a mission, its follow-ups included. */
const JOB_SUMMARY = { status: 1, error: 1, usage: 1, rootJobId: 1, frontendIds: 1, backendIds: 1, createdAt: 1 } as const

const statusOf = (request: RequestSummary) => staleOutcome(request) ?? request.status

/** The job and request a repository of the mission stands at. */
interface Resolved {
    job?: JobSummary
    request?: RequestSummary
}

/**
 * Where a repository of the mission stands: the latest job of the conversation its job started (follow-ups
 * included) that works on it, as long as its request is still alive. A follow-up that failed, or was stopped,
 * leaves the proposal it refined open: that one is still where the repository stands. `jobs` newest first.
 */
const resolve = (entry: IAiMissionRepository, jobs: JobSummary[], requests: RequestSummary[]): Resolved => {
    if (!entry.jobId) return {}
    const id = String(entry.id)
    const covering = jobs.filter(job => String(job.rootJobId) === String(entry.jobId) && componentsOfJob(job).some(ref => ref.id === id))
    const withRequests = covering.flatMap(job => {
        const request = requests.find(candidate => String(candidate.jobId) === String(job._id) && componentIdOf(candidate) === id)
        return request ? [{ job, request }] : []
    })
    return withRequests.find(({ request }) => statusOf(request) !== AiChangeStatus.FAILED && statusOf(request) !== AiChangeStatus.DISCARDED) ?? withRequests[0] ?? { job: covering[0] }
}

const toRepositoryView = (entry: IAiMissionRepository, { job, request }: Resolved, components: Map<string, Pick<RepositoryComponent, "name" | "domainId">>): AiMissionRepositoryView => {
    const id = String(entry.id)
    const component = components.get(id)
    const view: AiMissionRepositoryView = { kind: entry.kind, id, name: component?.name ?? "", domainId: component?.domainId ? String(component.domainId) : undefined, batch: entry.batch }
    if (!entry.jobId) return view
    // Claimed and not created yet: about to start, unless that never happened.
    const notStarted = !job && (entry.error !== undefined || claimExpired(entry.jobId))
    return {
        ...view,
        jobId: String(job?._id ?? entry.jobId),
        jobStatus: job?.status,
        requestStatus: request ? statusOf(request) : undefined,
        filesChanged: request ? (request.files ?? []).length : undefined,
        branch: request?.branch,
        pullRequestUrl: request?.pullRequestUrl,
        error: entry.error ?? request?.error ?? (job?.status === AiJobStatus.FAILED ? job.error : undefined) ?? (notStarted ? NOT_STARTED_ERROR : undefined)
    }
}

/**
 * The one count a repository is in. A proposal discarded after its job finished, or expired, leaves nothing
 * to apply: it counts as no changes, as a job that changed nothing. A job created and not started yet is queued.
 */
const countOf = (repository: AiMissionRepositoryView): keyof AiMissionView["counts"] => {
    if (!repository.jobStatus) return repository.error ? "failed" : "queued"
    if (repository.requestStatus === AiChangeStatus.APPLIED) return "applied"
    if (repository.requestStatus === AiChangeStatus.APPLYING) return "applying"
    if (repository.requestStatus === AiChangeStatus.PROPOSED) return repository.filesChanged ? "proposed" : "noChanges"
    if (repository.jobStatus === AiJobStatus.FAILED || repository.requestStatus === AiChangeStatus.FAILED) return "failed"
    if (repository.jobStatus === AiJobStatus.DONE) return "noChanges"
    if (repository.jobStatus === AiJobStatus.PENDING) return "queued"
    return "running"
}

/**
 * Keeps the jobs of a mission, and their requests, until `expiresAt`: a mission's jobs must not expire while it runs,
 * and go 7 days after it ends. Only those expiring before `dueBefore`: those kept for good (applied) have no expiry, and keep none.
 */
const extendExpiry = async (missionId: IAiMission["_id"], expiresAt: Date, dueBefore = expiresAt) => {
    const jobIds = (await AiChangeJob.find({ missionId }, { _id: 1 })).map(job => job._id)
    if (jobIds.length === 0) return
    const due = { expiresAt: { $lt: dueBefore } }
    await AiChangeJob.updateMany({ _id: { $in: jobIds }, ...due }, { expiresAt })
    await AiChangeRequest.updateMany({ jobId: { $in: jobIds }, ...due }, { expiresAt })
}

const emptyPrompt = () => createBusinessException({ code: "AI_MISSION_EMPTY_PROMPT", message: "Write what the agents should do", statusCode: 400 })

/**
 * Missions: one prompt over many repositories of a project, run as jobs batch after batch.
 *
 * The repositories are split into batches of {@link MISSION_BATCH_SIZE}; a batch starts once every job of
 * the one before is over. In `global` mode a batch is one job on all its repositories, in `perRepository`
 * mode a job per repository, at most `concurrency` of them at once. A mission runs nothing itself:
 * {@link advance} starts its jobs, whenever one of them ends and whenever the mission is read.
 */
export class AiMissionService extends AiChangeBaseService {
    private jobs(user = this.user) {
        return new AiChangeJobService(user, this.config)
    }

    /** Checks the mission as a job on its repositories would be, then starts its first jobs. */
    async create(projectId: string, input: AiMissionCreateInput): Promise<AiMissionView> {
        const prompt = input.prompt?.trim() ?? ""
        if (!prompt) throw emptyPrompt()
        const baseBranch = input.baseBranch?.trim()
        if (baseBranch && !isValidRefName(baseBranch)) {
            throw createBusinessException({ code: "AI_MISSION_INVALID_BRANCH", message: "The target branch is not a valid git branch name", statusCode: 400 })
        }
        await this.ensureCanChangeProject(toObjectId(projectId))
        const aiModel = await this.aiModels().resolveForProject(projectId, input.aiModelId)
        const refs: RepositoryComponentRef[] = [
            ...[...new Set(input.frontendIds ?? [])].map(id => ({ kind: "frontend" as const, id })),
            ...[...new Set(input.backendIds ?? [])].map(id => ({ kind: "backend" as const, id }))
        ]
        if ((input.all === true) === refs.length > 0) {
            throw createBusinessException({ code: "AI_MISSION_INVALID_SELECTION", message: "Choose either every repository or some frontends and backends", statusCode: 400 })
        }
        // A domain-scoped member works on their domains only: never on every repository of the project
        if (input.all) await this.ensureWholeProject(projectId)
        if (refs.length > MAX_REPOSITORIES_PER_MISSION) throw tooMany()
        const jobs = this.jobs()
        const components = (input.all ? await jobs.repositoriesOf(projectId) : await jobs.selectedRepositories(projectId, refs)).filter(
            (component, index, all) => all.findIndex(other => other.kind === component.kind && String(other._id) === String(component._id)) === index
        )
        if (components.length === 0) {
            throw createBusinessException({ code: "AI_JOB_NO_REPOSITORIES", message: "No frontend or backend of the project has a code repository connected", statusCode: 422 })
        }
        if (components.length > MAX_REPOSITORIES_PER_MISSION) throw tooMany()
        for (const component of components) await this.ensureRepositoryInDomainScope(component, component.codeRepository)
        await ensureWithinTokenLimit(projectId, this.getUser()!._id)
        // A mission stuck on a dead job is moved on first when it would hold the last place: see the listener below.
        await jobs.ensureRoomForJob(toObjectId(projectId))

        const mission = await AiMission.create({
            projectId: toObjectId(projectId),
            userId: this.getUser()!._id,
            prompt,
            mode: input.mode,
            all: input.all === true,
            concurrency: input.concurrency ?? DEFAULT_CONCURRENCY,
            effort: input.effort,
            baseBranch: baseBranch || undefined,
            aiModelId: aiModel.settings.id,
            repositories: components.map((component, index) => ({ kind: component.kind, id: component._id, batch: Math.floor(index / MISSION_BATCH_SIZE) })),
            batchCount: Math.ceil(components.length / MISSION_BATCH_SIZE),
            status: AiMissionStatus.RUNNING
        })
        fastify.log.info({ audit: "ai_mission_started", userId: String(this.getUser()!._id), projectId, missionId: String(mission._id), repositories: components.length }, "AI mission started")
        await this.advance(String(mission._id))
        return (await this.views([(await AiMission.findById(mission._id)) ?? mission]))[0]
    }

    /**
     * Moves the mission on: starts the queued repositories of the current batch there is room for, moves to
     * the next batch once every job of this one is over, and ends the mission after the last. Safe to call
     * at any time and from anywhere at once: each start is claimed first, on the mission as it was read.
     */
    async advance(missionId: string): Promise<void> {
        // Each round starts jobs, moves to the next batch or ends the mission: bounded by what there is to do.
        for (let round = 0; round <= 2 * MAX_REPOSITORIES_PER_MISSION; round++) {
            const mission = await AiMission.findById(missionId)
            if (mission?.status !== AiMissionStatus.RUNNING) return
            const entries = mission.repositories.filter(entry => entry.batch === mission.currentBatch)
            const states = await this.statesOf(entries)
            const current = { _id: mission._id, status: AiMissionStatus.RUNNING, currentBatch: mission.currentBatch }

            if (states.every(state => state === "done" || state === "failed")) {
                if (mission.currentBatch + 1 < mission.batchCount) {
                    await AiMission.updateOne(current, { currentBatch: mission.currentBatch + 1 })
                    continue
                }
                const anyDone = await AiChangeJob.exists({ missionId: mission._id, status: AiJobStatus.DONE })
                const expiresAt = expiry()
                await AiMission.updateOne(current, { status: anyDone ? AiMissionStatus.DONE : AiMissionStatus.FAILED, expiresAt })
                // Its jobs go with it, from its end: those that finished early would otherwise go before it.
                await extendExpiry(mission._id, expiresAt)
                return
            }

            const queued = entries.filter((_, index) => states[index] === "queued")
            const active = states.filter(state => state === "active").length
            // A global batch is one job on all its repositories, claimed together.
            const groups = mission.mode === "global" ? (queued.length ? [queued] : []) : queued.slice(0, Math.max(0, mission.concurrency - active)).map(entry => [entry])
            let claims = mission.claims
            let notStarted = false
            for (const group of groups) {
                const jobId = new Types.ObjectId()
                const claimed = await AiMission.findOneAndUpdate(
                    { ...current, claims },
                    { $set: { "repositories.$[entry].jobId": jobId }, $inc: { claims: group.length } },
                    // Only the queued entries of this batch: a repository listed twice, or claimed meanwhile, is never claimed again.
                    { arrayFilters: [{ "entry.id": { $in: group.map(entry => entry.id) }, "entry.batch": mission.currentBatch, "entry.jobId": { $exists: false } }] }
                )
                // Another advance claimed meanwhile, or the mission was stopped: whoever did carries on.
                if (!claimed) return
                claims += group.length
                if (!(await this.startJob(mission, group, jobId))) notStarted = true
            }
            // A repository that could not start leaves its place free: the next one takes it, or the batch ends.
            if (!notStarted) return
        }
    }

    /** Where each repository of a batch stands. A job whose process died is failed on the way, as reading it would. */
    private async statesOf(entries: IAiMissionRepository[]): Promise<RepositoryState[]> {
        const jobIds = [...new Set(entries.flatMap(entry => (entry.jobId ? [String(entry.jobId)] : [])))]
        const jobService = this.jobs()
        const jobs = jobIds.length
            ? await Promise.all((await AiChangeJob.find({ _id: { $in: jobIds.map(id => toObjectId(id)) } }, { events: 0, transcript: 0 })).map(job => jobService.failIfStale(job)))
            : []
        return entries.map(entry => {
            if (!entry.jobId) return "queued"
            const job = jobs.find(candidate => String(candidate._id) === String(entry.jobId))
            if (job) return ACTIVE_JOB_STATUSES.includes(job.status) ? "active" : job.status === AiJobStatus.DONE ? "done" : "failed"
            // Claimed, not created yet: being started, unless that never happened.
            return entry.error !== undefined || claimExpired(entry.jobId) ? "failed" : "active"
        })
    }

    /**
     * Starts the job claimed for some repositories, as the user who started the mission whoever's call moved
     * it on: the job and its commits are theirs. A job that cannot start fails those repositories only.
     */
    private async startJob(mission: IAiMission, entries: IAiMissionRepository[], jobId: Types.ObjectId): Promise<boolean> {
        const owner = await User.findById(mission.userId)
        try {
            if (!owner) throw new Error("The user who started the mission no longer exists")
            const scope: AiJobScope = mission.all && mission.mode === "global" && mission.batchCount === 1 ? "global" : "selection"
            await this.jobs(owner as IUser).startForMission(mission, entries.map(refOf), jobId as unknown as IAiChangeJob["_id"], scope)
        } catch (error) {
            fastify.log.warn({ error: loggable(error), aiMissionId: String(mission._id), aiJobId: String(jobId) }, "AI mission could not start a job")
            await AiMission.updateOne({ _id: mission._id }, { $set: { "repositories.$[entry].error": toErrorMessage(error) } }, { arrayFilters: [{ "entry.jobId": jobId }] })
            return false
        }
        // Stopped while the job was being created: the stop could not see it yet.
        if ((await AiMission.findById(mission._id, { status: 1 }))?.status === AiMissionStatus.STOPPED) {
            await this.jobs(owner as IUser)
                .stop(String(jobId))
                .catch(() => undefined)
        }
        return true
    }

    /** Moves on every running mission of the project: one waiting for a job that died, or for a restart, gets going again. */
    async advanceRunning(projectId: string) {
        for (const mission of await AiMission.find({ projectId: toObjectId(projectId), status: AiMissionStatus.RUNNING }, { _id: 1 })) {
            await this.advance(String(mission._id)).catch(error => fastify.log.error({ error: loggable(error), aiMissionId: String(mission._id) }, "AI mission could not advance"))
        }
    }

    private async getMission(id: string): Promise<IAiMission> {
        const mission = await AiMission.findById(id)
        if (!mission) throw new EntityNotFoundError(id)
        await this.ensureAccessToProject(mission.projectId)
        if ((await this.inDomainScope(mission.projectId, [mission])).length === 0) throw domainScopeForbidden()
        return mission
    }

    /** The missions a domain-scoped member may see: those on frontends and backends they all see, never one on the whole project. */
    private async inDomainScope(projectId: IAiMission["projectId"], missions: IAiMission[]): Promise<IAiMission[]> {
        const scope = await this.getDomainScope(projectId)
        if (!scope || missions.length === 0) return missions
        const components = await findComponents(uniqueRefs(missions.flatMap(mission => mission.repositories.map(refOf))), { domainId: 1 })
        const visible = new Set(components.filter(component => isInDomainScope(scope, component.domainId)).map(component => String(component._id)))
        return missions.filter(mission => !mission.all && mission.repositories.every(entry => visible.has(String(entry.id))))
    }

    /** One mission and where each of its repositories stands. */
    async get(id: string): Promise<AiMissionView> {
        const mission = await this.getMission(id)
        if (mission.status !== AiMissionStatus.RUNNING) return (await this.views([mission]))[0]
        await this.advance(String(mission._id)).catch(error => fastify.log.error({ error: loggable(error), aiMissionId: id }, "AI mission could not advance"))
        return (await this.views([(await AiMission.findById(mission._id)) ?? mission]))[0]
    }

    /** The latest missions of the project, everyone's, newest first; `active` keeps the running ones. */
    async list(projectId: string, active = false): Promise<AiMissionView[]> {
        await this.ensureAccessToProject(toObjectId(projectId))
        await this.advanceRunning(projectId)
        const filter = { projectId: toObjectId(projectId), ...(active ? { status: AiMissionStatus.RUNNING } : {}) }
        const scoped = Boolean(await this.getDomainScope(projectId))
        const missions = await AiMission.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .limit(scoped ? MAX_SCANNED_MISSIONS : LISTED_MISSIONS)
        return this.views((await this.inDomainScope(toObjectId(projectId), missions)).slice(0, LISTED_MISSIONS))
    }

    /** Stops the mission: its active jobs are stopped, its queued repositories never start. */
    async stop(id: string): Promise<AiMissionView> {
        const mission = await this.getMission(id)
        await this.ensureCanChangeProject(mission.projectId)
        await this.ensureCanAct(mission)
        const stopped = await AiMission.findOneAndUpdate(
            { _id: mission._id, status: AiMissionStatus.RUNNING },
            { status: AiMissionStatus.STOPPED, stoppedAt: new Date(), expiresAt: expiry() },
            { new: true }
        )
        if (!stopped) throw notRunning()
        const jobs = this.jobs()
        for (const job of await AiChangeJob.find({ missionId: mission._id, status: { $in: ACTIVE_JOB_STATUSES } }, { _id: 1 })) {
            // Each on its own: one that ended, or started pushing, meanwhile is left to finish, and one that fails does not keep the others running.
            await jobs.stop(String(job._id)).catch(error => {
                if ((error as { code?: string }).code !== "AI_JOB_NOT_RUNNING")
                    fastify.log.warn({ error: loggable(error), aiMissionId: id, aiJobId: String(job._id) }, "AI mission could not stop a job")
            })
        }
        await extendExpiry(mission._id, stopped.expiresAt ?? expiry()).catch(error =>
            fastify.log.warn({ error: loggable(error), aiMissionId: id }, "AI mission could not stamp the expiry of its jobs")
        )
        fastify.log.info({ audit: "ai_mission_stopped", userId: String(this.getUser()!._id), projectId: String(mission.projectId), missionId: id }, "AI mission stopped")
        return (await this.views([(await AiMission.findById(mission._id)) ?? stopped]))[0]
    }

    /**
     * Applies the proposals of every finished job of the mission, as each job's apply does: they are
     * claimed before answering and brought onto their base branches in the background.
     */
    async apply(id: string): Promise<AiMissionView> {
        const mission = await this.getMission(id)
        await this.ensureCanChangeProject(mission.projectId)
        await this.ensureCanAct(mission)
        const { jobs, requests } = await this.jobsOf([mission])
        // The job each repository stands at, follow-ups included, in the order the repositories are shown.
        const order: string[] = []
        for (const entry of mission.repositories) {
            const { job, request } = resolve(entry, jobs, requests)
            if (job?.status !== AiJobStatus.DONE || !request || statusOf(request) !== AiChangeStatus.PROPOSED || !request.files?.length) continue
            if (!order.includes(String(job._id))) order.push(String(job._id))
        }
        if (order.length === 0) {
            throw createBusinessException({ code: "AI_CHANGE_NOT_PROPOSED", message: "No proposal of this mission is left to apply", statusCode: 409 })
        }
        const jobService = this.jobs()
        for (const jobId of order) {
            // A job whose proposals cannot be claimed (one is being refined) keeps them: the others are applied anyway.
            await jobService.apply(jobId).catch(error => fastify.log.warn({ error: loggable(error), aiMissionId: id, aiJobId: jobId }, "AI mission could not apply a job"))
        }
        return (await this.views([mission]))[0]
    }

    /** The frontends and backends the caller may start a mission on, and whether on every one of the project at once. */
    async repositories(projectId: string): Promise<{ all: boolean; repositories: AiMissionRepositoryOption[] }> {
        await this.ensureAccessToProject(toObjectId(projectId))
        const scope = await this.getDomainScope(projectId)
        const components = (await this.jobs().repositoriesOf(projectId)).filter(component => isInDomainScope(scope, component.domainId))
        return {
            all: !scope,
            repositories: components.map(component => ({
                kind: component.kind,
                id: String(component._id),
                name: component.name,
                domainId: component.domainId ? String(component.domainId) : undefined
            }))
        }
    }

    /** Every job the missions started, with their follow-ups, newest first, and their requests. */
    private async jobsOf(missions: IAiMission[]): Promise<{ jobs: JobSummary[]; requests: RequestSummary[] }> {
        const claimed = [...new Set(missions.flatMap(mission => mission.repositories.flatMap(entry => (entry.jobId ? [String(entry.jobId)] : []))))].map(id => toObjectId(id))
        if (claimed.length === 0) return { jobs: [], requests: [] }
        // A mission's jobs are each the first of their conversation: their follow-ups share it.
        const jobs: JobSummary[] = await AiChangeJob.find({ rootJobId: { $in: claimed } }, JOB_SUMMARY)
        jobs.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) || String(b._id).localeCompare(String(a._id)))
        // Typed by hand: the inferred projection type knows nothing of `files.path`.
        const requests = jobs.length ? await (AiChangeRequest.find({ jobId: { $in: jobs.map(job => job._id) } }, REQUEST_SUMMARY) as unknown as Promise<RequestSummary[]>) : []
        return { jobs, requests }
    }

    private async views(missions: IAiMission[]): Promise<AiMissionView[]> {
        if (missions.length === 0) return []
        const [{ jobs, requests }, components, users, canAct] = await Promise.all([
            this.jobsOf(missions),
            findComponents(uniqueRefs(missions.flatMap(mission => mission.repositories.map(refOf))), { name: 1, domainId: 1 }),
            User.find({ _id: { $in: [...new Set(missions.map(mission => String(mission.userId)))].map(id => toObjectId(id)) } }, { name: 1, surname: 1 }),
            Promise.all(missions.map(mission => this.canAct(mission)))
        ])
        const componentsById = new Map(components.map(component => [String(component._id), component]))
        return missions.map((mission, index) => {
            const repositories = mission.repositories.map(entry => toRepositoryView(entry, resolve(entry, jobs, requests), componentsById))
            const counts = { queued: 0, running: 0, proposed: 0, applying: 0, applied: 0, failed: 0, noChanges: 0 }
            for (const repository of repositories) counts[countOf(repository)]++
            const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
            // Every job of the mission once, follow-ups included: a global job is shared by its repositories.
            const claimed = new Set(mission.repositories.flatMap(entry => (entry.jobId ? [String(entry.jobId)] : [])))
            for (const job of jobs.filter(candidate => claimed.has(String(candidate.rootJobId)))) {
                usage.inputTokens += job.usage?.inputTokens ?? 0
                usage.cachedInputTokens += job.usage?.cachedInputTokens ?? 0
                usage.outputTokens += job.usage?.outputTokens ?? 0
            }
            const user = users.find(candidate => String(candidate._id) === String(mission.userId))
            return {
                _id: String(mission._id),
                projectId: String(mission.projectId),
                userId: String(mission.userId),
                userName: [user?.name, user?.surname].filter(Boolean).join(" ") || undefined,
                prompt: mission.prompt,
                mode: mission.mode,
                concurrency: mission.concurrency,
                baseBranch: mission.baseBranch,
                status: mission.status,
                currentBatch: mission.currentBatch,
                batchCount: mission.batchCount,
                repositories,
                counts,
                usage,
                canAct: canAct[index],
                createdAt: mission.createdAt,
                updatedAt: mission.updatedAt
            }
        })
    }
}

/**
 * Moves on every running mission once, as nobody's job will after a restart, and keeps their jobs from expiring
 * while they run. Run by the server, as nobody: each job starts as the user who started its mission.
 */
export const sweepRunningMissions = async (config: LlmConfiguration) => {
    const service = new AiMissionService(undefined, config)
    // Pushed out only once half their time is gone: a sweep every few minutes writes nothing most of the time.
    const dueBefore = new Date(Date.now() + PROPOSAL_TTL_MS / 2)
    for (const mission of await AiMission.find({ status: AiMissionStatus.RUNNING }, { _id: 1 })) {
        await service.advance(String(mission._id)).catch(error => fastify.log.error({ error: loggable(error), aiMissionId: String(mission._id) }, "AI mission could not advance"))
        await extendExpiry(mission._id, expiry(), dueBefore).catch(error => fastify.log.warn({ error: loggable(error), aiMissionId: String(mission._id) }, "AI mission could not keep its jobs"))
    }
}

// A mission starts its next repositories as soon as one of its jobs is over, whoever's call ended it.
onAiJobEnded("aiMissions", async (job, { user, config }) => {
    if (job.missionId) await new AiMissionService(user, config).advance(String(job.missionId))
})

// A mission stuck on a dead job would hold its place among the project's active work: moved on before refusing.
onBeforeAiCapCheck("aiMissions", (projectId, { user, config }) => new AiMissionService(user, config).advanceRunning(projectId))

export default AiMissionService
