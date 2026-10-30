import fs from "fs-extra"
import * as git from "isomorphic-git"
import http from "isomorphic-git/http/node"
import { fastify } from ".."
import AzureDevOpsClient from "../client/AzureDevOpsClient"
import GithubClient from "../client/GithubClient"
import GitlabClient from "../client/GitlabClient"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ApiKeyRole } from "../models/ApiKeyModel"
import CodeRepository, { CodeRepositoryProvider, CodeRepositoryType, ICodeRepository } from "../models/CodeRepositoryModel"
import { ICodeRepositoryFrontend } from "../models/FrontendModel"
import { IMarket } from "../models/MarketModel"
import FrontendDTO from "../types/FrontendDTO"
import { createSystemDeployKey } from "./ApiKeyService"
import BaseAuthorizedService from "./BaseAuthorizedService"
import CodeManagementService from "./CodeManagementService"
import { azureDevOpsVariableGroupName, deployKeyExpiry, deploySecretName } from "./CodeRepositoryService"
import { federationName } from "./FederationConfigService"
import { PipelineProvider } from "./pipelineTemplateLayout"
import { toErrorMessage } from "./RepositoryFileService"
import { isRepositoryNameTakenError } from "./RepositoryRenameService"
import { copyPipeline, fetchPipelineTemplates, PipelineTemplates } from "./templateScaffold/pipelineTemplates"
import { downloadAndExtractZip, flattenTemplate, replaceFederationNameInConfigs, replacePlaceholdersInDirectory } from "./templateScaffold/templateFiles"
import { explainMissingCommit, findCommit, pushTag, TagTarget, tagCommit, tagExists } from "./templateScaffold/templateTags"

// The scaffolder's surface stays importable from here: its callers and tests (and the mocks of this module) use this path.
export type { PipelineTemplates } from "./templateScaffold/pipelineTemplates"
export { placeholderDomain } from "./templateScaffold/pipelineTemplates"
export { replaceFederationName } from "./templateScaffold/templateFiles"
export type { TagTarget } from "./templateScaffold/templateTags"
export { TagLookupError } from "./templateScaffold/templateTags"

/** The repository part of a frontend or backend DTO, filled in once the repository exists */
export type CodeRepositoryTarget = FrontendDTO["codeRepository"]

export interface ScaffoldOptions {
    /**
     * Replaced in every text file of the scaffolded tree before the initial commit. Frontends
     * leave it out: their placeholders live only in the pipeline overlay, replaced on its own.
     */
    placeholders?: Record<string, string>
    /**
     * Slug of the frontend being scaffolded: the federation name in its webpack config becomes
     * `federationName(slug)`, the name a host configured by the console looks the remote up by.
     */
    frontendSlug?: string
    /**
     * False for a repository no pipeline of the console builds, as the GitOps one: on GitHub it gets no
     * deploy secret, so no deploy key is issued for it.
     */
    deploySecret?: boolean
}

/** Where a template goes once downloaded: the new, empty repository it is cloned from, and how its initial commit is pushed */
interface TemplateRemote {
    provider: CodeRepositoryProvider
    accessToken: string
    clone: Parameters<CodeManagementService["cloneRepository"]>[0]
    /** Pushes `main`, creating it on the remote if missing */
    push: (dir: string, codeManagementService: CodeManagementService) => Promise<unknown>
}

/** Pushes `main` of `dir` onto the remote with isomorphic-git, forced: the remote repository has just been created */
const pushMain = (dir: string, onAuth: git.AuthCallback) =>
    git.push({
        fs,
        http,
        dir,
        remote: "origin",
        ref: "main",
        remoteRef: "main",
        headers: { "User-Agent": "flightroom" },
        onAuth,
        force: true
    })

/**
 * Creates code repositories from marketplace templates and tags their releases, for whatever is
 * built from one: frontends and backends go through exactly the same steps.
 */
export class TemplateScaffoldService extends BaseAuthorizedService {
    /**
     * Creates `target.createData` at the provider of the connection, injects the deploy secret on
     * GitHub and pushes the template, then writes what the provider answered back into `target`.
     */
    async createRepository(codeRepository: ICodeRepository, target: CodeRepositoryTarget, slug: string, template: IMarket | null, options?: ScaffoldOptions): Promise<void> {
        // Before anything exists at the provider: pipeline templates that cannot be read leave no repository behind
        const pipelines = target.createData && template?.type && template.compiler ? await this.fetchPipelineTemplates(codeRepository) : undefined
        try {
            await this.createAtProvider(codeRepository, target, slug, template, options, pipelines)
        } catch (error) {
            // Often one left behind by an attempt that failed after it: the console says so instead of a provider error
            if (!isRepositoryNameTakenError(error)) throw error
            const name = target.createData?.name
            throw createBusinessException({ code: "REPOSITORY_NAME_TAKEN", message: `A repository named "${name}" already exists at the provider`, statusCode: 409 })
        } finally {
            if (pipelines) await fs.remove(pipelines.dir).catch(() => undefined)
        }
    }

    private async createAtProvider(
        codeRepository: ICodeRepository,
        target: CodeRepositoryTarget,
        slug: string,
        template: IMarket | null,
        options?: ScaffoldOptions,
        pipelines?: PipelineTemplates
    ): Promise<void> {
        const createData = target.createData
        if (!createData) return

        if (codeRepository.provider === CodeRepositoryProvider.AZURE_DEV_OPS) {
            if (!codeRepository.azureData) {
                throw new Error("Azure data is not set")
            }

            const azureDevOpsClient = new AzureDevOpsClient()
            const createdRepository = await azureDevOpsClient.createRepository(codeRepository.accessToken, codeRepository.azureData.organization, codeRepository.azureData.projectId, createData.name)
            target.repositoryId = createdRepository.id
            target.name = createdRepository.name
            target.cloneUrlHttps = createdRepository.remoteUrl
            target.cloneUrlSsh = createdRepository.sshUrl
            if (template) {
                await this.injectTemplateAzureDevOps(slug, codeRepository.accessToken, createdRepository.name, codeRepository, "azure_dev_ops", template, options, pipelines)
                await this.createPipelineAzureDevOps(createdRepository.name, codeRepository)
            } else if (options?.deploySecret !== false) {
                // Without a template the repository starts empty: its pipeline is there already, waiting for the
                // azure-pipelines.yml the team pushes. One Azure refuses leaves the repository standing all the same
                await this.createPipelineAzureDevOps(createdRepository.name, codeRepository).catch(error =>
                    fastify.log.warn(`⚠️ No pipeline for the empty repository ${createdRepository.name}: ${toErrorMessage(error)}`)
                )
            }
        } else if (codeRepository.provider === CodeRepositoryProvider.GITLAB) {
            if (!codeRepository.gitlabData?.url) {
                throw new Error("Gitlab url is not set")
            }
            const gitlabClient = new GitlabClient(codeRepository.gitlabData?.url, codeRepository.accessToken)
            // In the connection's own group when none is picked: its deploy variable lives there
            const createdRepository = await gitlabClient.createRepository({
                name: createData.name,
                namespace_id: target.gitlab?.groupId ?? codeRepository.gitlabData?.groupId,
                visibility: createData.private ? "private" : "public"
            })
            // The template goes where GitLab put the repository, never to a path rebuilt from the
            // input: a group path that does not match the group id would force-push onto another repository
            const fullPath = createdRepository.path_with_namespace
            const separator = fullPath.lastIndexOf("/")
            target.name = createdRepository.name
            target.repositoryId = createdRepository.id + ""
            target.cloneUrlHttps = createdRepository.http_url_to_repo
            target.cloneUrlSsh = createdRepository.ssh_url_to_repo
            if (template) {
                await this.injectTemplateGitlab(
                    slug,
                    codeRepository.accessToken,
                    codeRepository.gitlabData?.url,
                    fullPath.slice(separator + 1),
                    fullPath.slice(0, separator),
                    codeRepository,
                    "gitlab",
                    template,
                    options,
                    pipelines
                )
            }
        } else if (codeRepository.provider === CodeRepositoryProvider.GITHUB) {
            const githubClient = new GithubClient()
            const createdRepository = await githubClient.createRepository(
                {
                    name: createData.name,
                    private: createData.private,
                    visibility: createData.private ? "private" : "public"
                },
                codeRepository.accessToken,
                codeRepository.githubData?.organizationId
            )
            target.repositoryId = createdRepository.id + ""
            target.name = createdRepository.name
            target.cloneUrlHttps = createdRepository.clone_url
            target.cloneUrlSsh = createdRepository.ssh_url
            // Now will inject api key
            if (options?.deploySecret !== false) await this.gitHubInjectApiKey(codeRepository, slug, target.name)
            // Now will inject the template
            if (template) {
                await this.injectTemplateGithub(slug, codeRepository.accessToken, createdRepository.clone_url, "github", template, options, pipelines)
            }
        }
    }

    /**
     * Stores a deploy API key as a secret of the GitHub repository, so its pipeline can call back. Reached
     * through createRepository only, whose callers checked the access to the component and its domain.
     */
    async gitHubInjectApiKey(codeRepository: ICodeRepository, slug: string, repositoryName?: string) {
        if (codeRepository.provider !== CodeRepositoryProvider.GITHUB) return
        if (codeRepository.githubData?.type === CodeRepositoryType.ORGANIZATION) return
        if (!repositoryName) return

        const githubClient = new GithubClient()

        const exists = await githubClient.checkRepositorySecretExists({
            accessToken: codeRepository.accessToken,
            repositoryName,
            secretName: deploySecretName
        })

        if (exists) {
            return
        }

        // A system action, not one of the user: a domain-scoped member creating the repository of a component of
        // theirs must not leave it at the provider without its deploy secret (see createSystemDeployKey)
        const apiKey = await createSystemDeployKey(codeRepository.projectId.toString(), {
            name: "MFE_ORCHESTRATOR_DEPLOY_SECRET - Github - " + slug,
            role: ApiKeyRole.MANAGER,
            expiresAt: deployKeyExpiry()
        })

        await githubClient.upsertRepositorySecret({
            accessToken: codeRepository.accessToken,
            userName: codeRepository.githubData?.userName,
            repositoryName,
            secretName: deploySecretName,
            value: apiKey.apiKey
        })
    }

    async injectTemplateGitlab(
        slug: string,
        accessToken: string,
        baseUrl: string,
        repositoryName: string,
        repositoryGroup: string,
        codeRepository: ICodeRepository,
        repositoryType: PipelineProvider,
        template: IMarket,
        options?: ScaffoldOptions,
        pipelines?: PipelineTemplates
    ) {
        const templateUrl = template.zipUrl
        if (!templateUrl) {
            throw new Error("Template url is not set")
        }

        if (!codeRepository.gitlabData) {
            throw new Error("Gitlab data is not set")
        }

        const path = repositoryGroup || codeRepository.gitlabData.groupPath

        const baseUrlReal = baseUrl.replaceAll("https://", "").replaceAll("http://", "")
        const repoUrl = "https://oauth2:" + accessToken + "@" + baseUrlReal + "/" + path + "/" + repositoryName + ".git"
        const onAuth = () => ({ username: "oauth2", password: accessToken })

        await this.pushTemplate(
            {
                provider: CodeRepositoryProvider.GITLAB,
                accessToken,
                clone: { repositoryUrl: repoUrl, initializeInCaseOfEmptyRepo: true, onAuth },
                push: dir => pushMain(dir, onAuth)
            },
            templateUrl,
            slug,
            repositoryType,
            template,
            options,
            pipelines
        )
    }

    async injectTemplateAzureDevOps(
        slug: string,
        accessToken: string,
        repositoryName: string,
        codeRepository: ICodeRepository,
        repositoryType: PipelineProvider,
        template: IMarket,
        options?: ScaffoldOptions,
        pipelines?: PipelineTemplates
    ) {
        const templateUrl = template.zipUrl
        if (!templateUrl) {
            throw new Error("Template url is not set")
        }
        if (!codeRepository.azureData) {
            throw new Error("Azure data is not set")
        }

        const repoUrl = "https://root:" + accessToken + "@dev.azure.com/" + codeRepository.azureData.organization + "/" + codeRepository.azureData.projectId + "/_git/" + repositoryName

        await this.pushTemplate(
            {
                provider: CodeRepositoryProvider.AZURE_DEV_OPS,
                accessToken,
                clone: { repositoryUrl: repoUrl, initializeInCaseOfEmptyRepo: true },
                push: dir => pushMain(dir, () => ({ username: accessToken, password: "x-oauth-basic" }))
            },
            templateUrl,
            slug,
            repositoryType,
            template,
            options,
            pipelines
        )
    }

    async createPipelineAzureDevOps(repositoryName: string, codeRepository: ICodeRepository) {
        if (!codeRepository.azureData) {
            throw new Error("Azure data is not set")
        }

        const accessToken = codeRepository.accessToken
        const azureDevOpsClient = new AzureDevOpsClient()

        try {
            // Get repository details to obtain the repository ID
            const repository = await azureDevOpsClient.getRepository(accessToken, codeRepository.azureData.organization, codeRepository.azureData.projectId, repositoryName)

            // Create the pipeline
            const pipeline = await azureDevOpsClient.createPipeline(
                accessToken,
                codeRepository.azureData.organization,
                codeRepository.azureData.projectId,
                repository.id,
                `${repositoryName}`,
                "azure-pipelines.yml",
                "/"
            )

            fastify.log.info(`✅ Pipeline created successfully: ${pipeline.name} (ID: ${pipeline.id})`)
            fastify.log.info(`🔗 Pipeline URL: ${pipeline._links.web.href}`)

            // Its first run would otherwise wait for someone to permit the group of the deploy key. Not fatal:
            // the pipeline is there, and permitting it by hand still works
            try {
                const authorized = await azureDevOpsClient.authorizePipelineVariableGroup(
                    accessToken,
                    codeRepository.azureData.organization,
                    codeRepository.azureData.projectId,
                    azureDevOpsVariableGroupName,
                    pipeline.id
                )
                if (!authorized) fastify.log.warn(`⚠️ No variable group ${azureDevOpsVariableGroupName} to authorize pipeline ${pipeline.name} on`)
            } catch (error) {
                fastify.log.warn(`⚠️ Pipeline ${pipeline.name} could not be authorized on ${azureDevOpsVariableGroupName}: ${toErrorMessage(error)}`)
            }

            return pipeline
        } catch (error: unknown) {
            fastify.log.error(`❌ Failed to create pipeline for repository ${repositoryName}:` + error)
            throw new Error(`Failed to create Azure DevOps pipeline: ${error}`)
        }
    }

    async injectTemplateGithub(slug: string, githubToken: string, repoUrl: string, repositoryType: PipelineProvider, template: IMarket, options?: ScaffoldOptions, pipelines?: PipelineTemplates) {
        const templateUrl = template.zipUrl
        if (!templateUrl) {
            throw new Error("Template url is not set")
        }

        await this.pushTemplate(
            {
                provider: CodeRepositoryProvider.GITHUB,
                accessToken: githubToken,
                clone: { repositoryUrl: repoUrl, initializeInCaseOfEmptyRepo: true },
                push: (_dir, codeManagementService) => codeManagementService.pushRepository({ branch: "main" })
            },
            templateUrl,
            slug,
            repositoryType,
            template,
            options,
            pipelines
        )
    }

    /**
     * Downloads the template, clones the new repository into it, lays the pipeline and the placeholders over it
     * and pushes it as the initial commit of `main`. A failed push is logged, never thrown: the repository exists.
     */
    private async pushTemplate(
        remote: TemplateRemote,
        templateUrl: string,
        slug: string,
        repositoryType: PipelineProvider,
        template: IMarket,
        options?: ScaffoldOptions,
        pipelines?: PipelineTemplates
    ): Promise<void> {
        // Download + unzip template
        const tempDir = await this.downloadZip("template", templateUrl)

        const codeManagementService = new CodeManagementService(remote.provider, remote.accessToken, tempDir)
        await codeManagementService.cloneRepository(remote.clone)

        await flattenTemplate(tempDir)

        await this.copyPipeline(tempDir, pipelines, template, repositoryType, slug)

        if (options?.placeholders) {
            await replacePlaceholdersInDirectory(tempDir, options.placeholders)
        }

        if (options?.frontendSlug) {
            await replaceFederationNameInConfigs(tempDir, federationName(options.frontendSlug))
        }

        // Stage + commit
        try {
            await git.branch({
                fs,
                dir: tempDir,
                ref: "main",
                checkout: true,
                force: true
            })
            await git.add({ fs, dir: tempDir, filepath: "." })
            await git.commit({
                fs,
                dir: tempDir,
                message: "Initial commit",
                author: {
                    name: "Flightroom Bot",
                    email: "bot@flightroom.dev"
                }
            })

            await remote.push(tempDir, codeManagementService)

            console.log("✅ Repo is ready and pushed!")
        } catch (e) {
            console.error("‼️ Error pushing to remote: ", e)
            const remotes = await git.listRemotes({ fs, dir: tempDir })
            // A remote URL can carry the access token: never written to the log
            console.log(
                "🔍 Known remotes:",
                remotes.map(remote => ({ ...remote, url: remote.url.replace(/\/\/[^/@]*@/, "//***@") }))
            )

            const branches = await git.listBranches({ fs, dir: tempDir })
            console.log("🔍 Local branches:", branches)

            const remoteBranches = await git.listBranches({ fs, dir: tempDir, remote: "origin" }).catch(() => [])
            console.log("🔍 Remote branches:", remoteBranches)
        } finally {
            await fs.remove(tempDir).catch(() => undefined)
        }
    }

    /**
     * The pipeline templates a repository scaffolded through `codeRepository` gets: the repository picked on that
     * connection, cloned at its ref and read from its folder, or the official template-pipelines. A repository picked
     * that cannot be read is refused, never replaced by the official one: the connection asked for its own pipelines.
     */
    async fetchPipelineTemplates(codeRepository: ICodeRepository): Promise<PipelineTemplates> {
        return fetchPipelineTemplates(this.user, codeRepository, (prefix, url) => this.downloadZip(prefix, url))
    }

    /** Copies the pipeline of `provider` into the template in `tempDir` (see {@link copyPipeline}); left out, `pipelines` are the official ones */
    private copyPipeline(tempDir: string, pipelines: PipelineTemplates | undefined, template: IMarket, provider: PipelineProvider, slug: string): Promise<void> {
        return copyPipeline(tempDir, pipelines, template, provider, slug, (prefix, url) => this.downloadZip(prefix, url))
    }

    async downloadZip(prefixDirectory: string, urlToDownload: string): Promise<string> {
        return downloadAndExtractZip(prefixDirectory, urlToDownload)
    }

    /**
     * Replaces each placeholder with its value in every text file under `directory`. The `.git`
     * folder is never entered, and binary files (any NUL byte) are left alone.
     */
    async replacePlaceholdersInDirectory(directory: string, placeholders: Record<string, string>): Promise<void> {
        return replacePlaceholdersInDirectory(directory, placeholders)
    }

    /**
     * Tags `ref` (main by default) of the linked repository with `version`: the tag is what starts
     * the release pipeline. Nothing happens when no repository is linked. The connection must belong
     * to `projectId`, the project of what is built: one of another project would lend it its token.
     */
    async createTag(link: ICodeRepositoryFrontend | undefined, projectId: unknown, version: string, ref?: string): Promise<void> {
        const target = await this.resolveTagTarget(link, projectId, ref)
        if (target) {
            await this.pushTag(target, version)
        }
    }

    /**
     * What {@link createTag} checks before it tags: the connection of the project, the domain scope and the
     * commit `ref` (main by default) points to. Undefined when there is nothing to tag: no repository linked,
     * or a provider without tags. Writes nothing, so a whole domain is checked before any of its tags is made.
     */
    async resolveTagTarget(link: ICodeRepositoryFrontend | undefined, projectId: unknown, ref?: string): Promise<TagTarget | undefined> {
        if (!link?.enabled) return undefined

        const codeRepository = await CodeRepository.findById(link.codeRepositoryId)
        if (!codeRepository || String(codeRepository.projectId) !== String(projectId)) {
            throw new EntityNotFoundError(String(link.codeRepositoryId))
        }
        // The tag is named after the version alone, and it starts the pipeline of the whole repository: on one
        // shared with a component of another domain it releases that one too. The caller has checked the
        // component being built, so only the other links to the repository are looked at.
        await this.ensureRepositoryInDomainScope({ projectId: codeRepository.projectId }, link, codeRepository.provider)

        const branchName = ref || "main"
        let commit: string | undefined
        try {
            commit = await findCommit(codeRepository, link, branchName)
        } catch (error) {
            throw await explainMissingCommit(error, codeRepository, link, branchName)
        }
        return commit === undefined ? undefined : { codeRepository, link, ref: branchName, commit }
    }

    /** Whether the repository of `target` already has the tag `version`: creating it again would fail at the provider */
    async tagExists(target: TagTarget, version: string): Promise<boolean> {
        return tagExists(target, version)
    }

    /** The commit the tag `version` points to in the repository of `target`, undefined without the tag */
    async tagCommit(target: TagTarget, version: string): Promise<string | undefined> {
        return tagCommit(target, version)
    }

    /** Creates the tag `version` on the commit {@link resolveTagTarget} found */
    async pushTag(target: TagTarget, version: string): Promise<void> {
        return pushTag(target, version)
    }
}

export default TemplateScaffoldService
