import { fastify } from "../.."
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import AiChangeJob, { IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AiChangeStatus, IAiChangeFile, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import { IFrontend } from "../../models/FrontendModel"
import Project from "../../models/ProjectModel"
import UserProject, { RoleInProject } from "../../models/UserProjectModel"
import { withRepositoryLock } from "../../utils/repositoryLock"
import { slugify } from "../../utils/slugUtils"
import { isProtectedPath } from "../../utils/workspacePaths"
import AiModelService from "../AiModelService"
import BaseAuthorizedService from "../BaseAuthorizedService"
import { LlmConfiguration } from "../llm"
import { toErrorMessage } from "../RepositoryFileService"
import { isPushRefused } from "../workspace/GitWorkingCopy"
import RepositoryWorkspaceService, { OpenedWorkspace } from "../workspace/RepositoryWorkspaceService"
import { componentIdOf, componentOf, findComponent, findComponents, RepositoryComponentRef } from "../workspace/repositoryComponent"

/** Proposals nobody approves or discards are removed after this, and so are finished jobs. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A job that has not written anything for this long died with its process. */
export const STALE_AFTER_MS = 20 * 60 * 1000
/** Apply waits for a busy working copy only this long. */
const APPLY_LOCK_WAIT_MS = 30_000
/** Content kept for the diff of a file; beyond it the original is not stored (the document has a 16 MB cap). */
const MAX_STORED_ORIGINAL_BYTES = 300_000

const ACTIVE_STATUSES = [AiChangeStatus.PENDING, AiChangeStatus.RUNNING, AiChangeStatus.APPLYING]

/**
 * What gets logged of an error. Never the error object itself: an axios error carries the request
 * config, headers included, and with them the provider token.
 */
export const loggable = (error: unknown) => ({ message: toErrorMessage(error), status: (error as { response?: { status?: number } })?.response?.status })

/** A stale job is reported as failed; an apply that died goes back to the proposal, which is still valid. */
export const staleOutcome = (request: Pick<IAiChangeRequest, "status" | "updatedAt">) =>
    ACTIVE_STATUSES.includes(request.status) && Date.now() - request.updatedAt.getTime() > STALE_AFTER_MS
        ? request.status === AiChangeStatus.APPLYING
            ? AiChangeStatus.PROPOSED
            : AiChangeStatus.FAILED
        : undefined

export const storable = (content: string | undefined) => (content !== undefined && !content.includes("\0") && Buffer.byteLength(content) <= MAX_STORED_ORIGINAL_BYTES ? content : undefined)

export const followUpRunning = (message: string) => createBusinessException({ code: "AI_JOB_FOLLOW_UP_RUNNING", message, statusCode: 409 })

/** A proposal a running follow-up is refining cannot be applied: the follow-up is about to replace it. */
export const ensureNotBeingRefined = async (request: Pick<IAiChangeRequest, "_id">) => {
    const child = await AiChangeRequest.exists({
        parentId: request._id,
        status: { $in: [AiChangeStatus.PENDING, AiChangeStatus.RUNNING] },
        updatedAt: { $gt: new Date(Date.now() - STALE_AFTER_MS) }
    })
    if (child) throw followUpRunning("A follow-up is refining this proposal: wait for it to finish")
}

export const firstLine = (text: string, max: number) => {
    const line = text.trim().split("\n")[0].trim()
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const timestamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)

/** How far back the messages of a conversation are looked up for its pull request. */
const MAX_CONVERSATION_LENGTH = 50

/** How many words of the request a branch name keeps. */
const BRANCH_NAME_WORDS = 6
/** Words that say nothing about a request, left out of its branch name. */
const FILLER_WORDS = new Set(
    (
        "a an the of to in on at by for from with and or is are be it this that these those please can could you i we me my our want would like should " +
        "il lo la l i gli le un uno una d di a da in con su per tra fra e ed o del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle " +
        "nel nello nella nei negli nelle sul sullo sulla sui sugli sulle che non mi ci si ti vorrei puoi potresti fai favore"
    ).split(" ")
)

/**
 * The feature branch of a conversation on one repository, named after what was asked so it reads in
 * the provider's branch list: "Aggiungi il bottone di logout nella navbar" on `cart` becomes
 * `ai/cart/aggiungi-bottone-logout-navbar-20261024-101500`.
 */
export const branchName = (slug: string, prompt = "") => {
    const words = slugify(prompt.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
        .split("-")
        .filter(word => word && !FILLER_WORDS.has(word))
        .slice(0, BRANCH_NAME_WORDS)
    return `ai/${slug}/${[...words, timestamp()].join("-")}`
}

/** Who a commit is by: the user who asked for the change, or applied it. */
export const authorOf = (user: { name?: string; surname?: string; email: string }) => ({ name: [user.name, user.surname].filter(Boolean).join(" ") || user.email, email: user.email })

export const commitMessage = (title: string, summary?: string) => `${title}\n\n${summary ?? ""}`.trim()

export const toCommitFiles = (files: IAiChangeFile[]) => files.map(file => ({ path: file.path, action: file.action, content: file.proposedContent }))

/**
 * What was asked in the conversation that led to a proposal, oldest first: a follow-up ("also translate
 * it") alone would make a poor pull request title.
 */
export const conversationPrompts = async (request: IAiChangeRequest): Promise<string[]> => {
    const prompts = [request.prompt]
    let parentId = request.parentId
    while (parentId && prompts.length < MAX_CONVERSATION_LENGTH) {
        const parent = await AiChangeRequest.findById(parentId, { prompt: 1, parentId: 1 })
        if (!parent) break
        prompts.unshift(parent.prompt)
        parentId = parent.parentId
    }
    return prompts
}

/** Applied work is kept, and so is the conversation that led to it: its jobs and its requests on this repository no longer expire. */
const keepConversation = async (request: IAiChangeRequest) => {
    const job = request.jobId ? await AiChangeJob.findById(request.jobId, { rootJobId: 1 }) : null
    if (!job) return
    const jobIds = (await AiChangeJob.find({ rootJobId: job.rootJobId }, { _id: 1 })).map(candidate => candidate._id)
    await AiChangeJob.updateMany({ _id: { $in: jobIds } }, { $unset: { expiresAt: 1 } })
    const owner = request.backendId ? { backendId: request.backendId } : { frontendId: request.frontendId }
    await AiChangeRequest.updateMany({ jobId: { $in: jobIds }, ...owner }, { $unset: { expiresAt: 1 } })
}

/** Who a listener acts as: the user whose call ended the job, or none for a sweep of the server. */
export interface AiJobListenerContext {
    user: ConstructorParameters<typeof BaseAuthorizedService>[0]
    config: LlmConfiguration
}

type AiJobEndedListener = (job: Pick<IAiChangeJob, "_id" | "missionId">, context: AiJobListenerContext) => Promise<void>
type AiCapCheckListener = (projectId: string, context: AiJobListenerContext) => Promise<void>

/**
 * What runs around the jobs without the job service knowing it: the missions register here, so the
 * job service never imports the mission service that imports it. Keyed by name: a module loaded twice
 * replaces its listener instead of adding a second one.
 */
const jobEndedListeners = new Map<string, AiJobEndedListener>()
const capCheckListeners = new Map<string, AiCapCheckListener>()

/** Called once a job is over, however it ended. */
export const onAiJobEnded = (name: string, listener: AiJobEndedListener) => void jobEndedListeners.set(name, listener)

/** Called before a project refused for its cap of AI work is counted again: what ended unnoticed frees its place. */
export const onBeforeAiCapCheck = (name: string, listener: AiCapCheckListener) => void capCheckListeners.set(name, listener)

/** Tells every listener, one after the other; a listener that fails is logged and the others still run. */
export const aiJobEnded = async (job: Pick<IAiChangeJob, "_id" | "missionId">, context: AiJobListenerContext) => {
    for (const [name, listener] of jobEndedListeners) {
        await listener(job, context).catch(error => fastify.log.error({ error: loggable(error), aiJobId: String(job._id), listener: name }, "AI job listener failed"))
    }
}

export const beforeAiCapCheck = async (projectId: string, context: AiJobListenerContext) => {
    for (const [name, listener] of capCheckListeners) {
        await listener(projectId, context).catch(error => fastify.log.error({ error: loggable(error), projectId, listener: name }, "AI cap listener failed"))
    }
}

/** Others' jobs, missions and proposals can be read, not acted upon. */
export const notOwner = () => createBusinessException({ code: "AI_JOB_NOT_OWNER", message: "Only the user who started it, or an organization administrator, can act on it", statusCode: 403 })

/** What the AI change services share: who may change a project, and how a claimed proposal becomes a pull request. */
export abstract class AiChangeBaseService extends BaseAuthorizedService {
    constructor(
        user: ConstructorParameters<typeof BaseAuthorizedService>[0],
        protected readonly config: LlmConfiguration
    ) {
        super(user)
    }

    /** Where the AI a request runs on is chosen, among those the project may use. */
    protected aiModels() {
        return new AiModelService(this.user, this.config)
    }

    /**
     * Writing to a repository is a change to the project: a VIEWER may look at the proposals but
     * neither ask for one nor apply it. Organization administrators reach every project.
     */
    async ensureCanChangeProject(projectId: IFrontend["projectId"]) {
        await this.ensureAccessToProject(projectId)
        const user = this.getUser()
        if (!user) throw createBusinessException({ code: "AI_CHANGE_FORBIDDEN", message: "Not allowed", statusCode: 403 })
        const membership = await UserProject.findOne({ userId: user._id, projectId, invitationToken: null })
        if (membership?.role !== RoleInProject.VIEWER) return
        const project = await Project.findById(projectId, { organizationId: 1 })
        if (project && (await this.isOrganizationAdmin(project.organizationId))) return
        throw createBusinessException({ code: "AI_CHANGE_FORBIDDEN", message: "A viewer cannot change the code of a frontend or a backend", statusCode: 403 })
    }

    /** Organization administrators of each project, read once per service: views ask it for every job they show. */
    private readonly organizationAdmin = new Map<string, Promise<boolean>>()

    private isAdminOfProject(projectId: IFrontend["projectId"]): Promise<boolean> {
        const key = String(projectId)
        let admin = this.organizationAdmin.get(key)
        if (!admin) {
            admin = Project.findById(projectId, { organizationId: 1 }).then(project => (project ? this.isOrganizationAdmin(project.organizationId) : false))
            this.organizationAdmin.set(key, admin)
        }
        return admin
    }

    /** Whether the caller may act on a job, a mission or a proposal: the user who started it, or an organization administrator. */
    protected async canAct(owned: { userId: unknown; projectId: IFrontend["projectId"] }): Promise<boolean> {
        const user = this.getUser()
        if (!user) return false
        if (String(owned.userId) === String(user._id)) return true
        return this.isAdminOfProject(owned.projectId)
    }

    /** Refuses others what writes on a job, a mission or a proposal they did not start: they may look at it only. */
    protected async ensureCanAct(owned: { userId: unknown; projectId: IFrontend["projectId"] }) {
        if (!(await this.canAct(owned))) throw notOwner()
    }

    /**
     * As {@link ensureRepositoryInDomainScope} for the repositories of the components `refs` names, read
     * only for a domain-scoped member: what was proposed on a repository shared since with another domain
     * must not reach it either.
     */
    protected async ensureRepositoriesInDomainScope(projectId: IFrontend["projectId"], refs: RepositoryComponentRef[]) {
        if (!(await this.getDomainScope(projectId))) return
        for (const component of await findComponents(refs)) await this.ensureRepositoryInDomainScope(component, component.codeRepository)
    }

    /** The files of a proposal that will be committed, refused when none is left or one cannot be. */
    protected filesToCommit(request: IAiChangeRequest): IAiChangeFile[] {
        const files = request.files
        if (files.length === 0) {
            throw createBusinessException({ code: "AI_CHANGE_NOTHING_TO_APPLY", message: "No file left to commit", statusCode: 400 })
        }
        const invalid = files.find(file => isProtectedPath(file.path) || (file.action !== "delete" && file.proposedContent === undefined))
        if (invalid) {
            throw createBusinessException({ code: "AI_CHANGE_INVALID_FILE", message: `"${invalid.path}" cannot be committed`, statusCode: 422 })
        }
        return files
    }

    /**
     * Resets the working copy to the latest base and checks every file is still what the agent saw: a
     * file changed on the remote since would otherwise be silently overwritten. Returns the base's head.
     */
    private async latestBase(workspaceService: RepositoryWorkspaceService, workspace: OpenedWorkspace, request: IAiChangeRequest, files: IAiChangeFile[]): Promise<string> {
        const head = await workspaceService.prepare(workspace, request.baseBranch)
        const conflicts: string[] = []
        for (const file of files) {
            const current = await workspace.workingCopy.blobOid(head, file.path)
            if (current !== file.baseBlobOid) conflicts.push(file.path)
        }
        if (conflicts.length) {
            throw createBusinessException({
                code: "AI_CHANGE_CONFLICT",
                message: `These files changed on ${request.baseBranch} after the proposal: ${conflicts.join(", ")}. Ask for the change again.`,
                details: { conflicts },
                statusCode: 409
            })
        }
        return head
    }

    /**
     * Brings the files of a request already claimed (APPLYING) onto its base branch. The request ends
     * APPLIED, or back to PROPOSED with the error, which is thrown.
     *
     * When the base has not moved since the proposal, the base fast-forwards to the very commit of the
     * feature branch, so a pull request opened from it reads merged. Otherwise the files are committed
     * again on top of the latest base. The push is never forced: a protected base turns it down, and
     * the user opens a pull request instead.
     */
    protected async applyClaimed(request: IAiChangeRequest, files: IAiChangeFile[]): Promise<IAiChangeRequest> {
        const component = await findComponent(componentOf(request))
        const user = this.getUser()!
        try {
            if (!component) throw new EntityNotFoundError(componentIdOf(request))
            const workspaceService = new RepositoryWorkspaceService(this.user)
            const workspace = await workspaceService.open(component)
            const prompts = await conversationPrompts(request)

            const result = await withRepositoryLock(
                workspace.workingCopy.dir,
                async () => {
                    const head = await this.latestBase(workspaceService, workspace, request, files)
                    let commit: string
                    try {
                        if (request.commit && head === request.baseCommit && (await workspace.workingCopy.hasCommit(request.commit))) {
                            await workspace.workingCopy.pushCommit(request.commit, request.baseBranch)
                            commit = request.commit
                        } else {
                            commit = await workspace.workingCopy.commitAndPush({
                                branch: request.branch ?? branchName(component.slug, prompts[0]),
                                pushTo: request.baseBranch,
                                message: commitMessage(firstLine(prompts[0], 72), request.summary),
                                author: authorOf(user),
                                files: toCommitFiles(files)
                            })
                        }
                    } catch (error) {
                        if (!isPushRefused(error)) throw error
                        throw createBusinessException({
                            code: "AI_CHANGE_PUSH_REFUSED",
                            message: `${request.baseBranch} refused the push (${toErrorMessage(error)}): if it is protected, open a pull request instead`,
                            statusCode: 409
                        })
                    }
                    // Its work is on the base now. One with a pull request is left to it: deleting it would close the pull request on some providers.
                    if (request.branch && request.commit && !request.pullRequestUrl) {
                        await workspace.workingCopy
                            .deleteRemoteBranch(request.branch)
                            .catch(error => fastify.log.warn({ error: loggable(error), aiChangeId: String(request._id) }, "Could not delete the branch of an applied change"))
                    }
                    return { commit }
                },
                { waitMs: APPLY_LOCK_WAIT_MS }
            )

            const applied = await AiChangeRequest.findByIdAndUpdate(
                request._id,
                { status: AiChangeStatus.APPLIED, ...result, $unset: { expiresAt: 1, pushError: 1 }, $push: { events: { at: new Date(), kind: "info", message: "applied" } } },
                { new: true }
            )
            // The push is done: failing to keep the history must not turn the request back into a proposal.
            await keepConversation(request).catch(error => fastify.log.warn({ error: loggable(error), aiChangeId: String(request._id) }, "Could not keep the AI conversation"))
            return applied!
        } catch (error) {
            await AiChangeRequest.updateOne({ _id: request._id }, { status: AiChangeStatus.PROPOSED, error: toErrorMessage(error) })
            throw error
        }
    }

    /**
     * Opens a pull request from the feature branch of a proposal onto its base, for a review in the
     * repository before it reaches the base. The proposal stays open: a follow-up force-pushes the
     * branch, so the pull request follows it. A proposal whose push failed is pushed first, from the
     * latest base. A provider refusing the pull request leaves its error on the request, which is returned.
     * `related` lists the other repositories of the same job, one per line.
     */
    protected async openPullRequestFor(request: IAiChangeRequest, files: IAiChangeFile[], related: string[] = []): Promise<IAiChangeRequest> {
        const component = await findComponent(componentOf(request))
        if (!component) throw new EntityNotFoundError(componentIdOf(request))
        const user = this.getUser()!
        const workspaceService = new RepositoryWorkspaceService(this.user)
        const workspace = await workspaceService.open(component)
        const prompts = await conversationPrompts(request)
        const title = firstLine(prompts[0], 72)

        let branch = request.branch
        if (!branch || !request.commit) {
            const pushed = await withRepositoryLock(
                workspace.workingCopy.dir,
                async () => {
                    await this.latestBase(workspaceService, workspace, request, files)
                    const name = request.branch ?? branchName(component.slug, prompts[0])
                    const commit = await workspace.workingCopy.commitAndPush({ branch: name, message: commitMessage(title, request.summary), author: authorOf(user), files: toCommitFiles(files) })
                    return { branch: name, commit }
                },
                { waitMs: APPLY_LOCK_WAIT_MS }
            )
            await AiChangeRequest.updateOne({ _id: request._id }, { ...pushed, $unset: { pushError: 1 } })
            branch = pushed.branch
        }

        try {
            const pullRequestUrl = await workspaceService.openPullRequest(workspace.target, {
                sourceBranch: branch,
                targetBranch: request.baseBranch,
                title,
                description: [
                    request.summary,
                    related.length ? `Part of a change across ${related.length + 1} repositories:\n${related.map(line => `- ${line}`).join("\n")}` : undefined,
                    `---\nRequested in Flightroom by ${user.email}:\n\n${prompts.map(prompt => `> ${prompt.split("\n").join("\n> ")}`).join("\n\n")}`
                ]
                    .filter(Boolean)
                    .join("\n\n")
            })
            const opened = await AiChangeRequest.findByIdAndUpdate(request._id, { pullRequestUrl, $unset: { pullRequestError: 1 } }, { new: true })
            // A follow-up started meanwhile pushes the same branch: it carries the pull request on, or applying it would delete the branch under it.
            const owner = request.backendId ? { backendId: request.backendId } : { frontendId: request.frontendId }
            await AiChangeRequest.updateMany(
                {
                    conversationId: request.conversationId,
                    ...owner,
                    branch,
                    status: { $in: [AiChangeStatus.PENDING, AiChangeStatus.RUNNING, AiChangeStatus.PROPOSED] },
                    pullRequestUrl: { $exists: false }
                },
                { pullRequestUrl }
            )
            return opened!
        } catch (error) {
            // The branch is pushed: the change is not lost, the user can open the pull request by hand.
            fastify.log.warn({ error: loggable(error), aiChangeId: String(request._id) }, "Could not open the pull request")
            return (await AiChangeRequest.findByIdAndUpdate(request._id, { pullRequestError: toErrorMessage(error) }, { new: true }))!
        }
    }

    /** Deletes the feature branch of a discarded proposal, unless a pull request is open on it. Best effort: a branch left behind harms nobody. */
    protected async dropBranch(request: IAiChangeRequest): Promise<void> {
        if (!request.branch || !request.commit || request.pullRequestUrl) return
        const component = await findComponent(componentOf(request))
        if (!component) return
        const workspace = await new RepositoryWorkspaceService(this.user).open(component)
        await workspace.workingCopy.deleteRemoteBranch(request.branch)
    }
}
