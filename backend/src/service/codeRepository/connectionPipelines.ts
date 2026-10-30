import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fastify } from "../.."
import { BusinessException, createBusinessException } from "../../errors/BusinessException"
import { CodeRepositoryProvider, ICodeRepository, ICodeRepositoryPipelines } from "../../models/CodeRepositoryModel"
import { AuthorizedPrincipal } from "../BaseAuthorizedService"
import MarketService from "../MarketService"
import { EMPTY_PIPELINES, PipelineProvider, pipelineTemplateFolders } from "../pipelineTemplateLayout"
import { RepositoryFileService, repositoryNameFor, toErrorMessage } from "../RepositoryFileService"
import { GitWorkingCopy, isPushRefused, ORCHESTRATOR_COMMITTER } from "../workspace/GitWorkingCopy"
import RepositoryWorkspaceService, { cloneUrlFor, gitCredentialsFor } from "../workspace/RepositoryWorkspaceService"

/** The repository of the pipeline templates as the screen names it: by the provider id, reached through the connection itself */
export interface PipelineTemplatesInput {
    repositoryId: string
    /** A branch or a tag; the default branch of the repository when empty */
    ref?: string | null
    /** The folder of the repository the layout starts from; its root when empty */
    path?: string | null
}

/** The pipelines a connection's repositories are scaffolded with, by its provider */
const PIPELINE_PROVIDERS: Record<CodeRepositoryProvider, PipelineProvider> = {
    [CodeRepositoryProvider.GITHUB]: "github",
    [CodeRepositoryProvider.GITLAB]: "gitlab",
    [CodeRepositoryProvider.AZURE_DEV_OPS]: "azure_dev_ops"
}

/** What git takes as a branch or a tag name, without the forms it refuses: `..`, a leading dash, a trailing slash or `.lock` */
const GIT_REF = /^(?!-)(?!.*\.\.)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,255}$/

/** A relative folder, slashes between names: no `.` nor `..`, nothing that could step out of the clone */
const PIPELINES_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** The ref and the folder of the pipeline templates the screen sent, trimmed, each empty when left out; refused when malformed */
export const parsePipelinesInput = (input: PipelineTemplatesInput): { ref: string; path: string } => {
    if (typeof input?.repositoryId !== "string" || !input.repositoryId) {
        throw createBusinessException({ code: "PIPELINES_REPOSITORY_REQUIRED", message: "Pick the repository of the pipeline templates" })
    }
    const ref = typeof input.ref === "string" ? input.ref.trim() : ""
    if ((input.ref != null && typeof input.ref !== "string") || (ref && !GIT_REF.test(ref))) {
        throw createBusinessException({ code: "PIPELINES_REF_INVALID", message: "The ref of the pipeline templates must be the name of a branch or a tag" })
    }
    // `/ci/templates/` and `ci/templates` are the same folder
    const path = typeof input.path === "string" ? input.path.trim().replace(/^\/+|\/+$/g, "") : ""
    if ((input.path != null && typeof input.path !== "string") || path.length > 255 || (path && !PIPELINES_PATH.test(path))) {
        throw createBusinessException({ code: "PIPELINES_PATH_INVALID", message: "The folder of the pipeline templates must be a relative path, such as ci/templates, without . or .." })
    }
    return { ref, path }
}

/**
 * Writes into the repository of `pipelines` one empty pipeline of the provider of `connection` in every folder a
 * scaffold looks in, under its folder. A pipeline already there is left as it is: one commit with the rest, pushed
 * onto the ref, never forced. Signed by `user`, or by the orchestrator for an API key.
 */
export const initializePipelineTemplates = async (
    user: AuthorizedPrincipal | undefined,
    connection: ICodeRepository,
    pipelines: ICodeRepositoryPipelines
): Promise<{ created: string[]; skipped: number }> => {
    const provider = PIPELINE_PROVIDERS[connection.provider]
    const { file, existing } = EMPTY_PIPELINES[provider]

    const link = pipelines.codeRepository
    const repositoryName = repositoryNameFor(link, connection)
    const target = { component: { codeRepository: link }, codeRepository: connection, repositoryName }
    const failed = (reason: string) =>
        createBusinessException({
            code: "PIPELINES_INITIALIZE_FAILED",
            message: `Nothing was written to ${repositoryName} (${reason})`,
            statusCode: 502,
            details: { repository: repositoryName, reason }
        })

    // Checked before the clone, as for the scaffolds: isomorphic-git holds the whole packfile in memory. Asked while
    // the catalog is read, whose failure still comes first
    const sizeRead = new RepositoryWorkspaceService(user).providerSizeBytes(target)
    sizeRead.catch(() => undefined)
    // The catalog as the templates library shows it: one coming soon cannot be scaffolded yet
    const templates = (await new MarketService(user).getAll()).filter(template => !template.comingSoon)
    const folders = pipelineTemplateFolders(templates)
    const reported = await sizeRead
    if (reported !== undefined && reported > fastify.config.REPOSITORIES_MAX_SIZE_MB * 1024 * 1024) {
        throw failed(`it is bigger than ${fastify.config.REPOSITORIES_MAX_SIZE_MB} MB`)
    }

    const workingCopy = new GitWorkingCopy(await fs.mkdtemp(path.join(tmpdir(), "template-pipelines-")), cloneUrlFor(target), gitCredentialsFor(connection))
    try {
        const fileService = new RepositoryFileService(user)
        const branch = pipelines.ref ?? (await fileService.getDefaultBranch(target))
        // A repository without commits has no branch at all, its default one included: its first commit is this one
        const onRemote = await workingCopy.hasRemoteBranch(branch)
        const empty = !onRemote && (!pipelines.ref || !(await workingCopy.hasRemoteBranch(await fileService.getDefaultBranch(target))))
        // A tag, or a branch not there: nothing is pushed anywhere else than the ref picked
        if (!onRemote && !empty) throw failed(`${branch} is not one of its branches`)
        if (!empty) await workingCopy.prepare(branch)

        const files: { path: string; content: string }[] = []
        let skipped = 0
        for (const folder of folders) {
            const root = pipelines.path ? `${pipelines.path}/${folder}` : folder
            const found = !empty && (await fs.lstat(path.join(workingCopy.dir, root, existing)).catch(() => undefined))
            if (found) skipped++
            else files.push({ path: `${root}/${file}`, content: `# Pipeline for ${folder}: to be completed\n` })
        }
        if (files.length === 0) return { created: [], skipped }

        // An API key has no person behind it: the orchestrator signs
        const author = !user || user.apiKeyId ? ORCHESTRATOR_COMMITTER : { name: [user.name, user.surname].filter(Boolean).join(" ") || user.email, email: user.email }
        const message = "chore: initialize the pipeline templates"
        if (empty) await workingCopy.initialize({ branch, message, author, files })
        else await workingCopy.commitAndPush({ branch: "flightroom-pipelines", pushTo: branch, message, author, files: files.map(created => ({ ...created, action: "create" as const })) })
        return { created: files.map(created => created.path), skipped }
    } catch (error) {
        if (error instanceof BusinessException) throw error
        fastify.log.error({ error: toErrorMessage(error), repository: repositoryName }, "Pipeline templates initialization failed")
        throw failed(isPushRefused(error) ? `the push was refused: ${toErrorMessage(error)}` : toErrorMessage(error))
    } finally {
        await fs.rm(workingCopy.dir, { recursive: true, force: true })
    }
}
