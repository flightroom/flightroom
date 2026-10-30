import fs from "node:fs/promises"
import path from "node:path"
import { fastify } from "../.."
import AiChangeRequest, { IAiChangeFile, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import { isUnproposablePath, resolveInsideWorkingCopy } from "../../utils/workspacePaths"
import { toErrorMessage } from "../RepositoryFileService"
import { OpenedWorkspace } from "../workspace/RepositoryWorkspaceService"
import { RepositoryComponent } from "../workspace/repositoryComponent"
import { AI_CHANGE_LIMITS } from "./aiChangeAgent"
import { authorOf, branchName, commitMessage, conversationPrompts, firstLine, loggable, storable, toCommitFiles } from "./aiChangeShared"

/** A repository of a running job: its request and its prepared working copy. */
export interface RunningRepository {
    request: IAiChangeRequest
    component: RepositoryComponent
    workspace: OpenedWorkspace
    baseCommit?: string
    /** The files of the parent request, written on the working copy before the agent starts. */
    previousFiles?: IAiChangeFile[]
    /** The pull request description of the parent request: kept when the agent only answers. */
    previousSummary?: string
    /** The commit of the parent request on the feature branch, when made on the same base: still the proposal if the agent only answers. */
    previousCommit?: string
}

/** What the agent left in one repository. */
export interface JobProposal {
    repository: RunningRepository
    files: IAiChangeFile[]
}

/** Whether a working copy holds exactly the files a follow-up started from: the agent changed nothing of its own. */
export const sameFiles = (previous: IAiChangeFile[], files: IAiChangeFile[]) =>
    files.length === previous.length &&
    files.every(file => previous.some(candidate => candidate.path === file.path && candidate.action === file.action && candidate.proposedContent === file.proposedContent))

/**
 * Writes the files each parent request proposed onto the working copy of a follow-up. Every file
 * must still be what the parent saw on the base branch: otherwise the job fails rather than
 * silently overwriting what was pushed since.
 */
export const restorePrevious = async (repositories: RunningRepository[]) => {
    // Read at once: each is a request of its own, and the first one missing is still the one reported.
    const following = repositories.filter(repository => repository.request.parentId)
    const found = await Promise.all(following.map(repository => AiChangeRequest.findById(repository.request.parentId)))
    const parents = new Map<RunningRepository, IAiChangeRequest>()
    const conflicts: string[] = []
    for (const [index, repository] of following.entries()) {
        const parent = found[index]
        if (!parent) throw new Error(`The previous proposal for ${repository.component.name} no longer exists`)
        parents.set(repository, parent)
        repository.previousFiles = parent.files
        repository.previousSummary = parent.summary
        repository.previousCommit = parent.baseCommit === repository.baseCommit ? parent.commit : undefined
        for (const file of parent.files) {
            if ((await repository.workspace.workingCopy.blobOid(repository.baseCommit!, file.path)) !== file.baseBlobOid) conflicts.push(`${repository.component.slug}/${file.path}`)
        }
    }
    if (conflicts.length) {
        throw new Error(`These files changed on the base branch after the previous proposal: ${conflicts.join(", ")}. Start a new request instead of a follow-up.`)
    }

    for (const [repository, parent] of parents) {
        const dir = repository.workspace.workingCopy.dir
        for (const file of parent.files) {
            const { absolute, relative } = await resolveInsideWorkingCopy(dir, file.path)
            if (isUnproposablePath(relative)) throw new Error(`The previous proposal changes a protected file: ${repository.component.slug}/${relative}`)
            if (file.action === "delete") {
                await fs.rm(absolute, { force: true })
                continue
            }
            if (file.proposedContent === undefined) throw new Error(`The previous proposal lost the content of ${repository.component.slug}/${relative}`)
            await fs.mkdir(path.dirname(absolute), { recursive: true })
            await fs.writeFile(absolute, file.proposedContent, "utf8")
        }
    }
}

/** The files the agent changed on the working copy of a repository, as they are proposed. */
export const changedFiles = async (repository: RunningRepository): Promise<IAiChangeFile[]> => {
    const workingCopy = repository.workspace.workingCopy
    const files: IAiChangeFile[] = []
    for (const change of await workingCopy.changes()) {
        // The toolbox refuses these already; checked again on what actually changed on disk.
        if (isUnproposablePath(change.path)) throw new Error(`The agent changed a protected file: ${repository.component.slug}/${change.path}`)
        files.push({
            path: change.path,
            action: change.action,
            baseBlobOid: change.baseBlobOid,
            originalContent: change.action === "create" ? undefined : storable(await workingCopy.readHeadFile(change.path)),
            proposedContent: change.action === "delete" ? undefined : await workingCopy.readWorkingFile(change.path)
        })
    }
    // Also checked on disk: the proposal of a follow-up adds up to its parent's.
    if (files.length > AI_CHANGE_LIMITS.maxChangedFiles) {
        throw new Error(`The proposal for ${repository.component.name} changes ${files.length} files, more than the ${AI_CHANGE_LIMITS.maxChangedFiles} allowed in one repository`)
    }
    return files
}

/** Where a proposal stands on its feature branch once pushed, or why it is not. */
export type PushedProposal = { branch?: string; commit?: string; pushError?: string }

/**
 * Pushes a proposal on its feature branch, forced, from the base the agent started on: it can be
 * looked at in the repository, and a pull request opened from it follows every follow-up. A push
 * that fails leaves the proposal as it is: applying it, or opening its pull request, pushes it again.
 */
export const pushProposal = async ({ repository, files }: JobProposal, summary: string | undefined, author: Parameters<typeof authorOf>[0]): Promise<PushedProposal> => {
    if (files.length === 0) return {}
    const branch = repository.request.branch ?? branchName(repository.request.prompt)
    // The agent only answered: the branch already holds this very proposal, pushing it again would only run the CI again.
    if (repository.previousCommit && sameFiles(repository.previousFiles ?? [], files)) return { branch, commit: repository.previousCommit }
    try {
        const prompts = await conversationPrompts(repository.request)
        const commit = await repository.workspace.workingCopy.commitAndPush({
            branch,
            message: commitMessage(firstLine(prompts[0], 72), summary),
            author: authorOf(author),
            files: toCommitFiles(files)
        })
        return { branch, commit }
    } catch (error) {
        fastify.log.warn({ error: loggable(error), aiChangeId: String(repository.request._id) }, "Could not push the proposal on its branch")
        return { branch, pushError: toErrorMessage(error) }
    }
}
