import fs from "node:fs/promises"
import { Types } from "mongoose"
import { fastify } from "../.."
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import AiChangeJob, { AiJobScope, AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AiChangeStatus, IAiChangeFile, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import AiMission, { AiMissionStatus, IAiMission } from "../../models/AiMissionModel"
import Domain, { IDomain } from "../../models/DomainModel"
import Project, { IProject } from "../../models/ProjectModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { ResolvedAiModel } from "../AiModelService"
import { ensureWithinTokenLimit } from "../AiUsageService"
import { addUsage, aiProviderError, LlmClient, LlmEffort, LlmImage, LlmUsage, NO_USAGE, resolveEffort } from "../llm"
import { toErrorMessage } from "../RepositoryFileService"
import { resourceIdsInScope } from "../ResourceService"
import RepositoryWorkspaceService from "../workspace/RepositoryWorkspaceService"
import { componentIdOf, componentOf, componentsOfJob, findComponents, ownerFields, RepositoryComponent, RepositoryComponentRef } from "../workspace/repositoryComponent"
import { runAiChangeAgent } from "./aiChangeAgent"
import { AiChangeJobQueryService, noRepositories, sameComponent } from "./aiChangeJobQueries"
import { AI_CHANGE_DEFAULT_EFFORT } from "./aiChangeLimits"
import { aiJobEnded, beforeAiCapCheck, branchName, branchTopic, ensureNotBeingRefined, followUpRunning, loggable } from "./aiChangeShared"
import { agentInputOf } from "./aiJobAgentInput"
import { notifyAiJobEnded } from "./aiJobNotices"
import { ACTIVE_JOB_STATUSES, addJobUsage, event, expiry, failJob, fresh, logJobEvent, saveProposals, UNFINISHED_REQUEST_STATUSES } from "./aiJobRecords"
import { AiJobView, JOB_LISTED, WITHOUT_CONTENTS } from "./aiJobViews"
import { changedFiles, JobProposal, PushedProposal, pushProposal, RunningRepository, restorePrevious, sameFiles } from "./aiJobWorkingCopies"

/** Repositories one job may work on: each is a clone and a share of the model's context. */
const MAX_REPOSITORIES_PER_JOB = 10
/** Jobs running or queued at once in one project: each one is minutes of paid model time. A running mission counts as one. */
const MAX_ACTIVE_JOBS_PER_PROJECT = 5

export interface AiJobCreateInput {
    prompt: string
    scope: AiJobScope
    /** The domain whose frontends and backends a `domain` job works on. */
    domainId?: string
    frontendIds?: string[]
    backendIds?: string[]
    /** The branch each repository starts from, by frontend or backend id: its default branch when left out. */
    baseBranches?: Record<string, string>
    /** How hard the agent reasons: `high` when left out. */
    effort?: LlmEffort
    /** The AI the agent runs on, one the project may use: the project's default when left out. */
    aiModelId?: string
    /** Images the user attached to the prompt, shown to the model with it. */
    images?: LlmImage[]
}

export interface AiJobFollowUpInput {
    prompt: string
    /** The repositories of the parent job to refine; all those still proposed when both are left out. */
    frontendIds?: string[]
    backendIds?: string[]
    /** How hard the agent reasons: the parent's effort when left out. */
    effort?: LlmEffort
    /** The AI the agent runs on: the parent's when left out and the project may still use it, else the project's default. */
    aiModelId?: string
    /** Images the user attached to the prompt, shown to the model with it. */
    images?: LlmImage[]
}

/** A repository the job is about to work on. */
interface JobRepository {
    component: RepositoryComponent
    baseBranch: string
    /** The request of the parent job on the same repository, for a follow-up. */
    parentId?: IAiChangeRequest["_id"]
    /** A follow-up goes on on its parent's feature branch, and with its pull request. */
    branch?: string
    pullRequestUrl?: string
}

const tooMany = () =>
    createBusinessException({
        code: "AI_JOB_TOO_MANY_REPOSITORIES",
        message: `A job works on at most ${MAX_REPOSITORIES_PER_JOB} repositories: select the frontends and backends to change`,
        statusCode: 422
    })

const notDone = () => createBusinessException({ code: "AI_JOB_NOT_DONE", message: "The job has not finished yet", statusCode: 409 })

const notRunning = () => createBusinessException({ code: "AI_JOB_NOT_RUNNING", message: "The agent is not working on this job anymore", statusCode: 409 })

const STOPPED_ERROR = "Stopped by the user before the agent finished"

const notClosed = () => createBusinessException({ code: "AI_JOB_NOT_CLOSED", message: "Only a conversation that failed or was discarded can be deleted", statusCode: 409 })

/**
 * The agents running in this process, by job: a stop aborts the model call under way at once. A job
 * running on another replica stops at its next round instead, when it reads its status.
 */
const runningAgents = new Map<string, AbortController>()

/**
 * AI agent jobs on one or more repositories of a project.
 *
 * One agent sees every repository of the job at once, so a change can span them (an API and its
 * callers); its output is still one proposal per repository, an {@link IAiChangeRequest} reviewed
 * and applied on its own. A follow-up is a child job that starts from the proposals of its parent
 * and replaces them once it proposes. How jobs are read is {@link AiChangeJobQueryService}'s.
 */
export class AiChangeJobService extends AiChangeJobQueryService {
    /** A domain of the project. */
    private async domainOf(projectId: string, domainId?: string): Promise<IDomain> {
        const domain = domainId ? await Domain.findOne({ _id: toObjectId(domainId), projectId: toObjectId(projectId) }) : null
        if (!domain) throw new EntityNotFoundError(domainId ?? "domain")
        return domain
    }

    private async selectRepositories(projectId: string, input: AiJobCreateInput, domain?: IDomain): Promise<RepositoryComponent[]> {
        const available = await this.repositoriesOf(projectId)
        if (domain) {
            const members = available.filter(component => component.domainId && String(component.domainId) === String(domain._id))
            if (members.length === 0) throw noRepositories(`No frontend or backend of the domain ${domain.name} has a code repository connected`)
            if (members.length > MAX_REPOSITORIES_PER_JOB) throw tooMany()
            return members
        }
        if (input.scope === "global") {
            if (available.length === 0) throw noRepositories("No frontend or backend of the project has a code repository connected")
            if (available.length > MAX_REPOSITORIES_PER_JOB) throw tooMany()
            return available
        }

        const refs: RepositoryComponentRef[] = [
            ...[...new Set(input.frontendIds ?? [])].map(id => ({ kind: "frontend" as const, id })),
            ...[...new Set(input.backendIds ?? [])].map(id => ({ kind: "backend" as const, id }))
        ]
        if (refs.length === 0) throw noRepositories("Select at least one frontend or backend")
        if (refs.length > MAX_REPOSITORIES_PER_JOB) throw tooMany()
        return this.selectedRepositories(projectId, refs, available)
    }

    /** Each repository with the branch it starts from: the one picked for it, else its default branch. */
    private async withBaseBranches(components: RepositoryComponent[], baseBranches?: Record<string, string>): Promise<JobRepository[]> {
        const workspaceService = new RepositoryWorkspaceService(this.user)
        // Opened even when a branch is picked: it is what refuses a repository connection of another project.
        return Promise.all(
            components.map(async component => {
                const { defaultBranch } = await workspaceService.open(component)
                return { component, baseBranch: baseBranches?.[String(component._id)]?.trim() || defaultBranch }
            })
        )
    }

    /**
     * Starts a job on every frontend and backend of the project with a repository, on those of
     * one domain (its frontend and its backend at once), or on the selected ones.
     */
    async create(projectId: string, input: AiJobCreateInput): Promise<AiJobView> {
        await this.ensureCanChangeProject(toObjectId(projectId))
        const aiModel = await this.aiModels().resolveForProject(projectId, input.aiModelId)
        // A domain-scoped member works on their domains only: never on every repository of the project
        if (input.scope === "global") await this.ensureWholeProject(projectId)
        const domain = input.scope === "domain" ? await this.domainOf(projectId, input.domainId) : undefined
        if (domain) await this.ensureInDomainScope(projectId, domain._id)
        const components = await this.selectRepositories(projectId, input, domain)
        for (const component of components) await this.ensureRepositoryInDomainScope(component, component.codeRepository)

        const repositories = await this.withBaseBranches(components, input.baseBranches)
        const { job } = await this.start(
            { projectId: toObjectId(projectId), prompt: input.prompt, images: input.images, scope: input.scope, domainId: domain?._id, repositories, effort: input.effort },
            aiModel
        )
        return this.view(job, true)
    }

    /**
     * Starts the job of a mission on some of its repositories, under the id the mission claimed for it.
     * Checked again as when the mission was created: the repositories, or the user's rights, may have changed since.
     */
    async startForMission(mission: IAiMission, refs: RepositoryComponentRef[], jobId: IAiChangeJob["_id"], scope: AiJobScope): Promise<void> {
        const projectId = String(mission.projectId)
        await this.ensureCanChangeProject(mission.projectId)
        const aiModel = await this.aiModels().resolveForProject(projectId, mission.aiModelId)
        const components = await this.selectedRepositories(projectId, refs)
        for (const component of components) await this.ensureRepositoryInDomainScope(component, component.codeRepository)
        const baseBranch = mission.baseBranch?.trim()
        const baseBranches = baseBranch ? Object.fromEntries(components.map(component => [String(component._id), baseBranch])) : undefined
        const repositories = await this.withBaseBranches(components, baseBranches)
        await this.start({ projectId: mission.projectId, prompt: mission.prompt, scope, repositories, effort: mission.effort, missionId: mission._id, jobId }, aiModel)
    }

    /** Jobs and running missions taking a place among the project's active AI work: a mission's own jobs take none. */
    private async activeWork(projectId: IAiChangeJob["projectId"]): Promise<number> {
        const [jobs, missions] = await Promise.all([
            AiChangeJob.countDocuments({ projectId, missionId: { $exists: false }, status: { $in: ACTIVE_JOB_STATUSES }, updatedAt: fresh() }),
            AiMission.countDocuments({ projectId, status: AiMissionStatus.RUNNING })
        ])
        return jobs + missions
    }

    /**
     * Refuses another job, or mission, once the project has as many at work as it may: a running mission counts as one, its own jobs do not.
     * Before refusing, what may have ended unnoticed (a mission whose last job died with a restart) is moved on, and counted again.
     */
    async ensureRoomForJob(projectId: IAiChangeJob["projectId"]) {
        if ((await this.activeWork(projectId)) < MAX_ACTIVE_JOBS_PER_PROJECT) return
        await beforeAiCapCheck(String(projectId), { user: this.user, config: this.config })
        if ((await this.activeWork(projectId)) >= MAX_ACTIVE_JOBS_PER_PROJECT) {
            throw createBusinessException({ code: "AI_CHANGE_TOO_MANY", message: `At most ${MAX_ACTIVE_JOBS_PER_PROJECT} AI jobs can run at once in a project`, statusCode: 429 })
        }
    }

    /**
     * A child job refining the proposals of a finished one, on all its repositories still proposed
     * or on some of them. Each new request starts from the files of the request it refines.
     */
    async followUp(jobId: string, input: AiJobFollowUpInput): Promise<AiJobView> {
        const parent = await this.getJob(jobId)
        await this.ensureCanChangeProject(parent.projectId)
        await this.ensureCanAct(parent)
        // The transcript keeps no provider's own data, so a follow-up may run on another AI than its parent.
        const aiModel = await this.aiModels().resolveForProject(parent.projectId, input.aiModelId, parent.aiModelId)
        if (parent.status !== AiJobStatus.DONE) throw notDone()
        // Two follow-ups of the same job would both start from its proposals, and the second to finish would win.
        const runningChild = await AiChangeJob.exists({ parentJobId: parent._id, status: { $in: ACTIVE_JOB_STATUSES }, updatedAt: fresh() })
        if (runningChild) throw followUpRunning("A follow-up of this job is still running: wait for it to finish")

        const parentRequests = await AiChangeRequest.find({ jobId: parent._id }, WITHOUT_CONTENTS)
        const requestOf = (componentId: string) => parentRequests.find(request => componentIdOf(request) === componentId)
        const parentRefs = componentsOfJob(parent)
        const requested = [...new Set([...(input.frontendIds ?? []), ...(input.backendIds ?? [])])]
        const ids = requested.length ? requested : parentRefs.map(ref => ref.id).filter(id => requestOf(id)?.status === AiChangeStatus.PROPOSED)
        if (ids.length === 0) {
            throw createBusinessException({ code: "AI_CHANGE_NOT_PROPOSED", message: "No proposal of this job is left to refine", statusCode: 409 })
        }

        const components = await findComponents(parentRefs.filter(ref => ids.includes(ref.id)))
        const repositories: JobRepository[] = ids.map(id => {
            const component = components.find(candidate => String(candidate._id) === id)
            if (!component) throw noRepositories(`${id} is not a repository of this job`)
            // An applied or discarded proposal is not on the working copy anymore: there is nothing to refine.
            const request = requestOf(id)
            if (request?.status !== AiChangeStatus.PROPOSED) {
                throw createBusinessException({ code: "AI_CHANGE_NOT_PROPOSED", message: `The proposal for ${component.name} is not waiting for approval anymore`, statusCode: 409 })
            }
            return { component, baseBranch: request.baseBranch, parentId: request._id, branch: request.branch, pullRequestUrl: request.pullRequestUrl }
        })
        // A follow-up pushes to the repositories it refines as a new job would, whoever started the parent
        for (const { component } of repositories) await this.ensureRepositoryInDomainScope(component, component.codeRepository)

        const scope = repositories.length === parentRefs.length ? parent.scope : "selection"
        // A follow-up of a mission's job stays the mission's: the mission shows and applies its proposal, and it takes no place of its own.
        const { job } = await this.start(
            {
                projectId: parent.projectId,
                prompt: input.prompt,
                images: input.images,
                scope,
                domainId: parent.domainId,
                repositories,
                parentJob: parent,
                effort: input.effort,
                missionId: parent.missionId
            },
            aiModel
        )
        return this.view(job, true)
    }

    /**
     * Creates the job and one PENDING request per repository, then runs the agent in the background.
     * Callers have checked that the user may change the project.
     */
    async start(
        input: {
            projectId: IAiChangeJob["projectId"]
            prompt: string
            images?: LlmImage[]
            scope: AiJobScope
            domainId?: IAiChangeJob["domainId"] | IDomain["_id"]
            repositories: JobRepository[]
            parentJob?: IAiChangeJob
            /** Left out: the parent's for a follow-up, else `high`. */
            effort?: LlmEffort
            /** A mission's job: the mission took the place among the active jobs when it started. */
            missionId?: IAiMission["_id"]
            /** The id a mission claimed for the job. */
            jobId?: IAiChangeJob["_id"]
        },
        { settings, client }: ResolvedAiModel
    ): Promise<{ job: IAiChangeJob; requests: IAiChangeRequest[] }> {
        if (!input.missionId) await this.ensureRoomForJob(input.projectId)

        const userId = this.getUser()!._id
        // Every job of a mission too: the member's limit can run out while the mission goes on.
        await ensureWithinTokenLimit(input.projectId, userId)
        // A follow-up keeps the branch and the title of what it refines: the model only names a new one.
        const topic = !input.missionId && input.repositories.some(repository => !repository.branch) ? await branchTopic(client, input.prompt) : {}
        // Named before it is created: the first job of a chain is its own root.
        const jobId = input.jobId ?? (new Types.ObjectId() as unknown as IAiChangeJob["_id"])
        const queued = () => [{ at: new Date(), kind: "info" as const, message: "queued" }]
        // A follow-up goes on as hard as its parent went, unless the user chose otherwise; never above the AI's cap.
        const effort = resolveEffort(settings, input.effort ?? input.parentJob?.effort, AI_CHANGE_DEFAULT_EFFORT)
        const job = await AiChangeJob.create({
            _id: jobId,
            projectId: input.projectId,
            userId,
            parentJobId: input.parentJob?._id,
            rootJobId: input.parentJob?.rootJobId ?? jobId,
            missionId: input.missionId,
            prompt: input.prompt,
            images: input.images?.length ? input.images : undefined,
            title: topic.title,
            scope: input.scope,
            domainId: input.domainId,
            effort,
            aiModelId: settings.id,
            frontendIds: input.repositories.filter(({ component }) => component.kind === "frontend").map(({ component }) => component._id),
            backendIds: input.repositories.filter(({ component }) => component.kind === "backend").map(({ component }) => component._id),
            status: AiJobStatus.PENDING,
            events: queued()
        })
        const requests = await Promise.all(
            input.repositories.map(repository =>
                AiChangeRequest.create({
                    projectId: input.projectId,
                    ...ownerFields(repository.component),
                    userId,
                    jobId,
                    jobRepositoryCount: input.repositories.length,
                    effort,
                    aiModelId: settings.id,
                    parentId: repository.parentId,
                    conversationId: input.parentJob?.rootJobId ?? jobId,
                    prompt: input.prompt,
                    title: topic.title,
                    baseBranch: repository.baseBranch,
                    ...(!input.missionId ? { branch: repository.branch ?? branchName(input.prompt, topic.branch) } : {}),
                    pullRequestUrl: repository.pullRequestUrl,
                    status: AiChangeStatus.PENDING,
                    events: queued()
                })
            )
        )

        // Detached on purpose: the agent takes minutes, the console follows it by polling.
        this.process(String(jobId), client).catch(error => fastify.log.error({ error: loggable(error), aiJobId: String(jobId) }, "AI job crashed"))
        return { job, requests }
    }

    /**
     * The job: clone its own working copies, write the proposals a follow-up starts from, let the agent
     * work, store what changed in each repository, delete the copies.
     */
    private async process(jobId: string, client: LlmClient): Promise<void> {
        // The only read of the images: the agent sends them with the request.
        const job = await AiChangeJob.findById(jobId, "+images")
        if (!job) return
        let usage: LlmUsage = NO_USAGE
        try {
            const project = await Project.findById(job.projectId)
            if (!project) throw new Error("The project no longer exists")
            // A domain deleted since leaves its members as they are: the job goes on without its description and context.
            const domain = job.domainId ? await Domain.findById(job.domainId) : null
            const requests = await AiChangeRequest.find({ jobId: job._id })
            const refs = componentsOfJob(job)
            const components = await findComponents(refs)
            // A job on single frontends or backends still follows the context of the domains they are in.
            const memberDomainIds = domain ? [] : [...new Set(components.flatMap(component => (component.domainId ? [String(component.domainId)] : [])))]
            const memberDomains = memberDomainIds.length ? await Domain.find({ _id: { $in: memberDomainIds.map(id => toObjectId(id)) }, projectId: job.projectId }).sort({ name: 1 }) : []
            const workspaceService = new RepositoryWorkspaceService(this.user)
            const repositories: RunningRepository[] = []
            for (const ref of refs) {
                const component = components.find(sameComponent(ref))
                const request = requests.find(candidate => componentIdOf(candidate) === ref.id)
                if (!component || !request) throw new Error(`A ${ref.kind} of the job no longer exists`)
                // A copy of its own: jobs on the same repository work side by side, and their proposals meet only when applied.
                repositories.push({ request, component, workspace: await workspaceService.open(component, jobId) })
            }

            await this.work(job, project, domain, memberDomains, repositories, workspaceService, client, delta => {
                usage = addUsage(usage, delta)
            })
        } catch (error) {
            fastify.log.warn({ error: loggable(error), aiJobId: jobId }, "AI job failed")
            await failJob(jobId, toErrorMessage(error))
        } finally {
            fastify.log.info({ audit: "ai_job_usage", userId: String(job.userId), projectId: String(job.projectId), jobId, effort: job.effort, aiModelId: job.aiModelId, ...usage }, "AI job usage")
            // A mission starts its next repositories as soon as one of its jobs is over. Listeners log their own failures.
            void aiJobEnded(job, { user: this.user, config: this.config })
            // Whoever started it hears of it by email when they are no longer at the console.
            void notifyAiJobEnded(job._id).catch(error => fastify.log.warn({ error: loggable(error), aiJobId: jobId }, "AI job email not sent"))
        }
    }

    /** Runs on the job's own working copies, deleted however it ends. */
    private async work(
        job: IAiChangeJob,
        project: IProject,
        domain: IDomain | null,
        memberDomains: IDomain[],
        repositories: RunningRepository[],
        workspaceService: RepositoryWorkspaceService,
        client: LlmClient,
        onUsage: (usage: LlmUsage) => void
    ): Promise<void> {
        const jobId = String(job._id)
        // A job declared dead, failed or stopped while the agent works stops at the next round instead of spending on.
        const abort = new AbortController()
        runningAgents.set(jobId, abort)
        try {
            // Guarded: a job declared dead (or stopped) while it waited for the locks stays dead.
            if (!(await AiChangeJob.findOneAndUpdate({ _id: job._id, status: AiJobStatus.PENDING }, { status: AiJobStatus.RUNNING, startedAt: new Date() }))) return
            await AiChangeRequest.updateMany({ jobId: job._id, status: AiChangeStatus.PENDING }, { status: AiChangeStatus.RUNNING })
            await logJobEvent(jobId, "info", "preparing")
            for (const repository of repositories) {
                repository.baseCommit = await workspaceService.prepare(repository.workspace, repository.request.baseBranch)
                await AiChangeRequest.updateOne({ _id: repository.request._id }, { baseCommit: repository.baseCommit })
            }
            if (repositories.some(repository => repository.request.parentId)) {
                await logJobEvent(jobId, "info", "applying-previous")
                await restorePrevious(repositories)
            }
            await logJobEvent(jobId, "info", "working")

            // The job runs as whoever started it: a domain-scoped member's agent sees the resources they may read, no more
            const scope = await this.getDomainScope(job.projectId)
            const visibleResources = scope ? await resourceIdsInScope(job.projectId, scope) : undefined
            const input = await agentInputOf(job, project, domain, memberDomains, repositories, visibleResources)
            // The agent may stop midway, the provider failing or its answer cut off: what it wrote until then is still proposed.
            let stopped: string | undefined
            const result = await runAiChangeAgent(
                client,
                input,
                {
                    onEvent: (kind, message) => logJobEvent(jobId, kind, message),
                    onUsage: async usage => {
                        onUsage(usage)
                        await addJobUsage(job, project, client, usage)
                        const current = await AiChangeJob.findById(job._id, { status: 1 })
                        if (current?.status !== AiJobStatus.RUNNING) abort.abort()
                    }
                },
                abort.signal
            ).catch(error => {
                // Aborted, the job was declared dead: nothing of it is saved.
                if (abort.signal.aborted) throw error
                // The provider's own message stays in the log: it may quote what the endpoint answered.
                stopped = aiProviderError(error).message
                fastify.log.warn({ error: loggable(error), aiJobId: jobId }, "AI job agent stopped before finishing")
                return undefined
            })

            // Stopped by a user meanwhile: nothing of it is saved nor pushed.
            if (abort.signal.aborted) return
            if (result?.stopReason === "refusal") throw new Error("The model declined this request")
            if (result?.stopReason === "max_tokens") stopped = "The agent's answer was cut off: try a smaller request or a lower effort"

            const proposals: JobProposal[] = []
            for (const repository of repositories) proposals.push({ repository, files: await changedFiles(repository) })

            const anyChange = proposals.some(proposal => proposal.files.length > 0)
            // Nothing written but the parent's files: a proposal would only discard the parent.
            if (stopped && proposals.every(({ repository, files }) => sameFiles(repository.previousFiles ?? [], files))) throw new Error(stopped)
            const incomplete = stopped
                ? `The agent stopped before finishing, so this proposal is incomplete: review it, or ask a follow-up to finish it. Reason: ${stopped}`
                : result?.stopReason === "max_rounds"
                  ? "The agent ran out of steps: the proposal may be incomplete"
                  : undefined
            const summary = result?.summary || undefined
            // An answer without a change of its own is no pull request description: the proposal keeps its parent's.
            const answered = (repository: RunningRepository, files: IAiChangeFile[]) =>
                result?.stopReason === "end_turn" && repository.previousFiles !== undefined && sameFiles(repository.previousFiles, files)
            const summaryOf = ({ repository, files }: JobProposal) => (answered(repository, files) ? repository.previousSummary : summary)
            // Pushed before they are saved: a proposal shows up with its branch already there.
            // Not for a job declared dead meanwhile: none of its proposals will be saved, the branch must keep the one that is.
            const alive = (await AiChangeJob.findById(job._id, { status: 1 }))?.status === AiJobStatus.RUNNING
            if (anyChange && alive) await logJobEvent(jobId, "info", "pushing")
            const pushed = new Map<RunningRepository, PushedProposal>()
            if (alive && !job.missionId) for (const proposal of proposals) pushed.set(proposal.repository, await pushProposal(proposal, summaryOf(proposal), this.getUser()!))
            // Requests first: the console stops polling once the job is done.
            const partial = await saveProposals(job._id, proposals, proposal => ({
                status: AiChangeStatus.PROPOSED,
                files: proposal.files,
                summary: summaryOf(proposal),
                ...pushed.get(proposal.repository),
                error: incomplete,
                expiresAt: expiry(),
                ...event("info", proposal.files.length ? "proposed" : "no-changes")
            }))
            // Guarded: a job get() already declared dead must not come back to life.
            await AiChangeJob.updateOne(
                { _id: job._id, status: AiJobStatus.RUNNING },
                {
                    status: AiJobStatus.DONE,
                    finishedAt: new Date(),
                    summary,
                    transcript: result?.transcript,
                    error: partial ?? incomplete,
                    expiresAt: expiry(),
                    ...event("info", anyChange ? "proposed" : "no-changes")
                }
            )
            if (job.missionId && anyChange) {
                await this.apply(jobId).catch(error => fastify.log.error({ error: loggable(error), aiJobId: jobId }, "AI mission could not push its changes"))
            }
        } finally {
            runningAgents.delete(jobId)
            for (const repository of repositories) await fs.rm(repository.workspace.workingCopy.dir, { recursive: true, force: true }).catch(() => undefined)
        }
    }

    /**
     * Brings every proposal of a finished job onto its base branch in the background, one after the
     * other. Every proposal is claimed (APPLYING) before answering, so a second click finds
     * nothing left; each then ends APPLIED, or back to PROPOSED with its error.
     */
    async apply(jobId: string): Promise<AiJobView> {
        const job = await this.getJob(jobId)
        await this.ensureCanChangeProject(job.projectId)
        await this.ensureCanAct(job)
        if (job.status !== AiJobStatus.DONE) throw notDone()

        const requests = await AiChangeRequest.find({ jobId: job._id })
        const order = componentsOfJob(job).map(ref => ref.id)
        requests.sort((a, b) => order.indexOf(componentIdOf(a)) - order.indexOf(componentIdOf(b)))
        const candidates = requests.filter(request => request.status === AiChangeStatus.PROPOSED && request.files.length > 0)
        // Checked side by side: each refuses with the same error.
        await Promise.all(candidates.map(request => ensureNotBeingRefined(request)))
        await this.ensureRepositoriesInDomainScope(job.projectId, candidates.map(componentOf))

        const claimed: { request: IAiChangeRequest; files: IAiChangeFile[] }[] = []
        for (const request of candidates) {
            let files: IAiChangeFile[]
            try {
                files = this.filesToCommit(request)
            } catch (error) {
                await AiChangeRequest.updateOne({ _id: request._id, status: AiChangeStatus.PROPOSED }, { error: toErrorMessage(error) })
                continue
            }
            // The status flip is the guard against a double click: only one apply leaves PROPOSED.
            if (await AiChangeRequest.findOneAndUpdate({ _id: request._id, status: AiChangeStatus.PROPOSED }, { status: AiChangeStatus.APPLYING, $unset: { error: 1 } }))
                claimed.push({ request, files })
        }

        if (claimed.length) {
            await AiChangeJob.updateOne({ _id: job._id }, event("info", "applying"))
            // Detached on purpose: a push per repository takes a while, the console follows it by polling.
            this.applyAll(claimed).catch(error => fastify.log.error({ error: loggable(error), aiJobId: jobId }, "AI job apply crashed"))
        }
        return this.view((await AiChangeJob.findById(job._id)) ?? job, true)
    }

    /**
     * Stops the agent of a job still queued or at work: nothing it did is kept, and its requests are
     * discarded. A follow-up stopped leaves the proposal it refined open, as it was. Refused once the
     * agent is done and its proposals are being pushed: they are about to be saved.
     */
    async stop(jobId: string): Promise<AiJobView> {
        const job = await this.getJob(jobId)
        await this.ensureCanChangeProject(job.projectId)
        await this.ensureCanAct(job)
        const stopped = await AiChangeJob.findOneAndUpdate(
            { _id: job._id, status: { $in: ACTIVE_JOB_STATUSES }, "events.message": { $ne: "pushing" } },
            { status: AiJobStatus.FAILED, error: STOPPED_ERROR, stoppedAt: new Date(), finishedAt: new Date(), expiresAt: expiry(), ...event("info", "stopped") },
            { new: true }
        )
        if (!stopped) throw notRunning()
        await AiChangeRequest.updateMany(
            { jobId: job._id, status: { $in: UNFINISHED_REQUEST_STATUSES } },
            { status: AiChangeStatus.DISCARDED, error: STOPPED_ERROR, expiresAt: expiry(), ...event("info", "stopped") }
        )
        runningAgents.get(jobId)?.abort()
        fastify.log.info({ audit: "ai_job_stopped", userId: String(this.getUser()!._id), projectId: String(job.projectId), jobId }, "AI job stopped")
        return this.view(stopped, true)
    }

    /**
     * Deletes the conversation the job belongs to, every job of its chain, once nothing of it is left to
     * review or was applied: it failed, or was discarded. Logically only: the jobs and their requests stay,
     * out of the lists, and the tokens they spent stay counted.
     */
    async remove(jobId: string): Promise<void> {
        const job = await this.getJob(jobId)
        await this.ensureCanChangeProject(job.projectId)
        await this.ensureCanAct(job)
        const chain = await Promise.all((await AiChangeJob.find({ rootJobId: job.rootJobId, projectId: job.projectId }, JOB_LISTED)).map(candidate => this.failIfStale(candidate)))
        const open = await AiChangeRequest.exists({ jobId: { $in: chain.map(candidate => candidate._id) }, status: { $nin: [AiChangeStatus.FAILED, AiChangeStatus.DISCARDED] } })
        if (open || chain.some(candidate => ACTIVE_JOB_STATUSES.includes(candidate.status))) throw notClosed()
        await AiChangeJob.updateMany({ rootJobId: job.rootJobId, projectId: job.projectId, deletedAt: { $exists: false } }, { deletedAt: new Date(), deletedBy: this.getUser()!._id })
        fastify.log.info({ audit: "ai_job_deleted", userId: String(this.getUser()!._id), projectId: String(job.projectId), jobId: String(job.rootJobId) }, "AI conversation deleted")
    }

    private async applyAll(claimed: { request: IAiChangeRequest; files: IAiChangeFile[] }[]) {
        for (const { request, files } of claimed) {
            try {
                await this.applyClaimed(request, files)
            } catch (error) {
                // Kept on the request, back to a proposal: the others are applied anyway.
                fastify.log.warn({ error: loggable(error), aiChangeId: String(request._id) }, "AI job could not apply a proposal")
            }
        }
    }
}

export default AiChangeJobService
