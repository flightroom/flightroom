import fs from "fs-extra"
import * as git from "isomorphic-git"
import http from "isomorphic-git/http/node"
import { tmpdir } from "os"
import path, { join } from "path"
import { fastify } from "../.."
import { createBusinessException } from "../../errors/BusinessException"
import CodeRepository, { ICodeRepository } from "../../models/CodeRepositoryModel"
import { IMarket } from "../../models/MarketModel"
import { isBackendTemplateType, parseRuntime } from "../../types/BackendStack"
import { AuthorizedPrincipal } from "../BaseAuthorizedService"
import { isFolderName, LANGUAGE_FOLDERS, PipelineProvider, ROOT_PIPELINE_FILES } from "../pipelineTemplateLayout"
import { repositoryNameFor, toErrorMessage } from "../RepositoryFileService"
import RepositoryWorkspaceService, { cloneUrlFor, gitCredentialsFor } from "../workspace/RepositoryWorkspaceService"
import { hasRegularFile, isInside, removeSymlinks, replacePlaceholdersInDirectory, replacePlaceholdersInFile } from "./templateFiles"

/** Downloads a zip and extracts it into a new temporary folder, which it returns */
export type ZipDownloader = (prefix: string, url: string) => Promise<string>

const pipelinesUrl = "https://github.com/mfe-orchestrator/template-pipelines/archive/refs/heads/main.zip"

/**
 * The language a template is written in, as a folder of the pipeline templates: what a connection's own
 * repository can hold one pipeline per, for every template of that language. A backend's comes from its
 * framework, every frontend template is javascript.
 */
const pipelineLanguage = (template: IMarket): string | undefined => {
    if (isBackendTemplateType(template.type)) {
        const runtime = parseRuntime(template.framework)
        return runtime && LANGUAGE_FOLDERS[runtime]
    }
    return template.type === "host" || template.type === "remote" ? "javascript" : undefined
}

/** The pipeline templates of one scaffold, on disk: the repository picked on the connection, or the official template-pipelines */
export interface PipelineTemplates {
    /** The folder `<type>/<compiler>/...` is looked up in */
    root: string
    /** Deleted once the repository is pushed */
    dir: string
    /** Where they come from, for the log */
    source: string
    /**
     * True for the official ones, which hold one folder per provider under each `<type>/<compiler>`. The repository
     * of a connection serves that connection's provider only, so each of its folders is the root of the new repository:
     * `.github/`, `.gitlab-ci.yml` or `azure-pipelines.yml`.
     */
    byProvider: boolean
}

const pipelineSourceUnavailable = (repository: string, reason: string, ref?: string) =>
    createBusinessException({
        code: "PIPELINE_SOURCE_UNAVAILABLE",
        message: `Nothing was created: the pipeline templates could not be read from ${repository}${ref ? ` at ${ref}` : ""} (${reason}). Fix them, or go back to the official ones, in the pipeline templates of the code repository connection`,
        statusCode: 502,
        details: { repository, reason }
    })

/** What `%domain%` becomes in a scaffolded repository: the console its CI talks back to */
export const placeholderDomain = () => process.env.BACKEND_URL || "https://console.flightroom.dev"

/**
 * The placeholders of a pipeline copied from the pipeline templates, the same on every provider. Both slugs
 * are the slug of what is scaffolded, so one pipeline can serve frontends and backends alike.
 */
const pipelinePlaceholders = (slug: string): Record<string, string> => ({ "%microfrontendSlug%": slug, "%serviceSlug%": slug, "%domain%": placeholderDomain() })

/**
 * The pipeline templates a repository scaffolded through `codeRepository` gets: the repository picked on that
 * connection, cloned at its ref and read from its folder, or the official template-pipelines. A repository picked
 * that cannot be read is refused, never replaced by the official one: the connection asked for its own pipelines.
 */
export const fetchPipelineTemplates = async (user: AuthorizedPrincipal | undefined, codeRepository: ICodeRepository, download: ZipDownloader): Promise<PipelineTemplates> => {
    // Read again: the connection handed in may have been loaded without them
    const pipelines = (await CodeRepository.findById(codeRepository._id, { pipelines: 1 }))?.pipelines
    const link = pipelines?.codeRepository
    if (!link) return officialPipelineTemplates(download)

    const ref = pipelines.ref || undefined
    // Through an active connection of the same project only: one of another project would lend this one its access token
    const connection = await CodeRepository.findOne({ _id: link.codeRepositoryId, projectId: codeRepository.projectId, isActive: true })
    const repositoryName = connection ? repositoryNameFor(link, connection) : link.name
    if (!connection) throw pipelineSourceUnavailable(repositoryName, "its connection no longer exists", ref)
    // Checked before the clone, as for a working copy: isomorphic-git holds the whole packfile in memory
    const maxBytes = fastify.config.REPOSITORIES_MAX_SIZE_MB * 1024 * 1024
    const reported = await new RepositoryWorkspaceService(user).providerSizeBytes({ codeRepository: connection, repositoryName })
    if (reported !== undefined && reported > maxBytes) {
        throw pipelineSourceUnavailable(repositoryName, `it is bigger than ${fastify.config.REPOSITORIES_MAX_SIZE_MB} MB`, ref)
    }

    const dir = await fs.mkdtemp(join(tmpdir(), "template-pipelines-"))
    try {
        await git.clone({
            fs,
            http,
            dir,
            url: cloneUrlFor({ component: { codeRepository: link }, codeRepository: connection, repositoryName }),
            ref,
            singleBranch: true,
            depth: 1,
            onAuth: () => gitCredentialsFor(connection),
            headers: { "User-Agent": "flightroom" },
            // Never read from the cloned config: the token would go to whatever host it names
            corsProxy: ""
        })
        await removeSymlinks(dir)
    } catch (error) {
        await fs.remove(dir).catch(() => undefined)
        throw pipelineSourceUnavailable(repositoryName, toErrorMessage(error), ref)
    }
    // The layout starts from the folder picked, its root when none: a folder missing is refused like a ref missing
    const folder = pipelines.path || undefined
    const root = folder ? join(dir, folder) : dir
    if (folder && !((await isInside(dir, root)) && (await fs.lstat(root)).isDirectory())) {
        await fs.remove(dir).catch(() => undefined)
        throw pipelineSourceUnavailable(repositoryName, `it has no folder ${folder}`, ref)
    }
    return { root, dir, source: `${repositoryName}${ref ? `@${ref}` : ""}${folder ? `:${folder}` : ""}`, byProvider: false }
}

/** The official template-pipelines, downloaded, refused like the ones of a connection when they cannot be */
const officialPipelineTemplates = async (download: ZipDownloader): Promise<PipelineTemplates> => {
    let dir: string | undefined
    try {
        dir = await download("template-pipelines", pipelinesUrl)
        await removeSymlinks(dir)
        return { root: join(dir, "template-pipelines-main"), dir, source: "template-pipelines", byProvider: true }
    } catch (error) {
        if (dir) await fs.remove(dir).catch(() => undefined)
        throw pipelineSourceUnavailable("template-pipelines", toErrorMessage(error))
    }
}

/**
 * Copies the pipeline of `provider` from `pipelines` into the template in `tempDir`, then replaces the
 * placeholders of a pipeline in what it copied. The first folder found wins:
 * `<type>/<compiler>/<template slug>`, then `<type>/<compiler>`, then `<type>/<language>` (e.g. `service/java`,
 * one pipeline for every Java backend), each followed by `/<provider>` in the official ones only: the repository
 * of a connection holds there what goes at the root of the new repository. When the source has none, the template keeps the pipeline it ships with; a GitHub folder counts only with a file under
 * `workflows/`. On GitHub the template's own workflows go first, so that two release workflows named
 * differently never run side by side; the rest of its `.github` stays. Nothing outside the source is ever
 * copied, whatever symlink it holds. Left out, `pipelines` are the official ones, downloaded here.
 */
export const copyPipeline = async (tempDir: string, pipelines: PipelineTemplates | undefined, template: IMarket, provider: PipelineProvider, slug: string, download: ZipDownloader): Promise<void> => {
    if (!isFolderName(template.type) || !isFolderName(template.compiler)) {
        fastify.log.warn("⚠️ Template type or compiler not specified, or not a folder name: skipping pipeline setup")
        return
    }
    const source = pipelines ?? (await officialPipelineTemplates(download))
    try {
        const base = join(source.root, template.type, template.compiler)
        const language = pipelineLanguage(template)
        const leaf = (folder: string) => (source.byProvider ? join(folder, provider) : folder)
        const folders = [...(isFolderName(template.slug) ? [leaf(join(base, template.slug))] : []), leaf(base), ...(language ? [leaf(join(source.root, template.type, language))] : [])]
        const file = provider === "github" ? undefined : ROOT_PIPELINE_FILES[provider]
        // What becomes `.github` of the new repository: the provider folder itself in the official ones
        const githubOf = (folder: string) => (source.byProvider ? folder : join(folder, ".github"))
        const isUsable = async (folder: string) => {
            if (!(await isInside(source.root, folder))) return false
            if (!file) return (await isInside(source.root, githubOf(folder))) && hasRegularFile(join(githubOf(folder), "workflows"))
            const isFile = (await fs.lstat(join(folder, file)).catch(() => undefined))?.isFile() === true
            return isFile && (await isInside(source.root, join(folder, file)))
        }

        let found: string | undefined
        for (const folder of folders) {
            if (await isUsable(folder)) {
                found = folder
                break
            }
        }
        if (!found) {
            fastify.log.warn(`⚠️ No ${provider} pipeline for ${template.type}/${template.compiler} in ${source.source}: the template keeps its own`)
            return
        }

        if (file) {
            const pipelineFile = join(tempDir, file)
            await fs.copyFile(join(found, file), pipelineFile)
            await replacePlaceholdersInFile(pipelineFile, pipelinePlaceholders(slug))
        } else {
            const githubDir = join(tempDir, ".github")
            await fs.remove(join(githubDir, "workflows"))
            await fs.copy(githubOf(found), githubDir, { overwrite: true, filter: async item => !(await fs.lstat(item)).isSymbolicLink() })
            await replacePlaceholdersInDirectory(githubDir, pipelinePlaceholders(slug))
        }
        fastify.log.info(`✅ Pipeline files copied from ${path.relative(source.root, found)} of ${source.source}`)
    } finally {
        // Downloaded here, deleted here: the ones of the caller are deleted by the caller
        if (!pipelines) await fs.remove(source.dir).catch(() => undefined)
    }
}
