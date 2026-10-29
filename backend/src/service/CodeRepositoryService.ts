import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClientSession, DeleteResult, Types } from "mongoose"
import { fastify } from ".."
import AzureDevOpsClient, { AzureDevOpsBranch, RepositoryData } from "../client/AzureDevOpsClient"
import GithubClient, { GithubBranch } from "../client/GithubClient"
import GitLabClient, { GitLabBranch } from "../client/GitlabClient"
import { BusinessException, createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import { ApiKeyRole } from "../models/ApiKeyModel"
import CodeRepository, { CodeRepositoryProvider, CodeRepositoryType, ICodeRepository, ICodeRepositoryPipelines } from "../models/CodeRepositoryModel"
import Project from "../models/ProjectModel"
import CreateAzureDevOpsRepositoryDTO from "../types/CreateAzureDevOpsRepositoryDTO"
import CreateGitlabRepositoryDto from "../types/CreateGitlabRepositoryDTO"
import UpdateGithubDTO from "../types/UpdateGithubDTO"
import { toObjectId } from "../utils/mongooseUtils"
import { runInTransaction } from "../utils/runInTransaction"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import { ApiKeyService } from "./ApiKeyService"
import BaseAuthorizedService from "./BaseAuthorizedService"
import CodeRepositoryImportService from "./CodeRepositoryImportService"
import GitOpsService from "./GitOpsService"
import MarketService from "./MarketService"
import { EMPTY_PIPELINES, PipelineProvider, pipelineTemplateFolders } from "./pipelineTemplateLayout"
import { RepositoryFileService, repositoryNameFor, toErrorMessage } from "./RepositoryFileService"
import { GitWorkingCopy, isPushRefused, ORCHESTRATOR_COMMITTER } from "./workspace/GitWorkingCopy"
import RepositoryWorkspaceService, { cloneUrlFor, gitCredentialsFor } from "./workspace/RepositoryWorkspaceService"

/**
 * The value only if the user actually typed one. The edit screens submit the token field back exactly
 * as it was handed to them, and what they were handed is the placeholder, never the token.
 */
const retypedSecret = (value?: string): string | undefined => (value && value !== SECRET_PLACEHOLDER ? value : undefined)

/** Whether two GitLab URLs name the same instance: only a trailing slash may tell them apart. */
const sameGitlabUrl = (stored: string | undefined, requested: string | undefined) => !!stored && stored.replace(/\/+$/, "") === requested?.replace(/\/+$/, "")

const storedTokenElsewhere = () =>
    new BusinessException({
        code: "ACCESS_TOKEN_REQUIRED",
        message: "The stored access token is used only with the URL it was saved for: type it again to use another one",
        statusCode: 400
    })

export const deploySecretName = "FLIGHTROOM_API_KEY"

/**
 * How long a deploy key the platform creates for itself stays valid.
 *
 * Spelled out unit by unit on purpose: this was `3600 * 1000 * 365` in four places, which
 * is 365 *hours* — the keys expired after fifteen days while every page said a year.
 */
export const deployKeyLifetimeMs = 365 * 24 * 60 * 60 * 1000

export const deployKeyExpiry = () => new Date(Date.now() + deployKeyLifetimeMs)
export const azureDevOpsVariableGroupName = "MFE_ORCHESTRATOR_SECRETS"

export interface CodeRepositoryCreateInput {
    name: string
    provider: CodeRepositoryProvider
    accessToken: string
    refreshToken?: string
}

export interface CodeRepositoryUpdateInput {
    name?: string
    provider?: CodeRepositoryProvider
    accessToken?: string
    refreshToken?: string
    isActive?: boolean
}

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

export interface UnifiedBranch {
    default?: boolean
    branch: string
    commitSha: string
    commitUrl: string
    author: string | null
    authorEmail: string | null
    authorAvatar: string | null
}

export class CodeRepositoryService extends BaseAuthorizedService {
    mapAzureBranch(azureBranch: AzureDevOpsBranch) {
        return {
            default: azureBranch.name === "main" || azureBranch.name === "master",
            branch: azureBranch.name.replace("refs/heads/", ""), // "refs/heads/main" -> "main"
            commitSha: azureBranch.objectId, // "objectId"
            commitUrl: azureBranch.url, // l'url alla ref
            author: azureBranch.creator?.displayName,
            authorEmail: azureBranch.creator?.uniqueName,
            authorAvatar: azureBranch.creator?._links?.avatar?.href
        }
    }

    mapGithubBranch(githubBranch: GithubBranch) {
        return {
            default: githubBranch.name === "main" || githubBranch.name === "master",
            branch: githubBranch.name,
            commitSha: githubBranch.commit?.sha,
            commitUrl: githubBranch.commit?.url,
            author: null, // GitHub branches API non porta info autore
            authorEmail: null,
            authorAvatar: null
        }
    }

    mapGitlabBranch(gitlabBranch: GitLabBranch): UnifiedBranch {
        return {
            default: gitlabBranch.default,
            branch: gitlabBranch.name,
            commitSha: gitlabBranch.commit?.id,
            commitUrl: gitlabBranch.commit?.web_url,
            author: gitlabBranch.commit?.author_name,
            authorEmail: gitlabBranch.commit?.author_email,
            authorAvatar: null // GitLab branches API non fornisce avatar direttamente
        }
    }

    async getBranches(codeRepositoryId: string, repositoryId: string): Promise<UnifiedBranch[]> {
        const repository = await this.findById(codeRepositoryId)
        if (!repository) {
            throw new EntityNotFoundError(codeRepositoryId)
        }

        if (repository.provider === CodeRepositoryProvider.GITHUB) {
            return new GithubClient()
                .getBranches(repository.accessToken, repositoryId, repository.githubData?.organizationId, repository.githubData?.userName)
                .then(branches => branches.map(this.mapGithubBranch))
        } else if (repository.provider === CodeRepositoryProvider.AZURE_DEV_OPS) {
            if (!repository.azureData) {
                throw new BusinessException({
                    code: "INVALID_PROVIDER",
                    message: "Repository provider is not Azure DevOps",
                    statusCode: 400
                })
            }

            return new AzureDevOpsClient()
                .getBranches(repository.accessToken, repository.azureData.organization, repository.azureData.projectId, repositoryId)
                .then(dto => dto.value.map(this.mapAzureBranch))
        } else if (repository.provider === CodeRepositoryProvider.GITLAB) {
            if (!repository.gitlabData) {
                throw new BusinessException({
                    code: "INVALID_PROVIDER",
                    message: "Repository provider is not GitLab",
                    statusCode: 400
                })
            }

            return new GitLabClient(repository.gitlabData.url, repository.accessToken).getBranches(encodeURI(repositoryId)).then(branches => branches.map(this.mapGitlabBranch.bind(this)))
        }

        return []
    }

    async isRepositoryNameAvailable(repositoryId: string, name: string, groupPath?: string, groupId?: number): Promise<boolean> {
        const repositories = await this.getRepositories(repositoryId, groupPath, groupId)
        if (!repositories) {
            return false
        }
        return !repositories.some(repository => repository.name === name)
    }

    /**
     * The token to authenticate a call with: the one just typed in, or the one already stored when the
     * form sent the placeholder back — which is what the edit screens do, since the API never hands
     * them the real token to begin with.
     *
     * The stored token is lent only to those who manage the connection, and only towards what it was
     * stored for: `storedFor` tells whether the target the request names is that one. Without it, any
     * member could name a host of theirs and receive the token.
     */
    private async resolveAccessToken(pat: string | undefined, repositoryId: string | undefined, storedFor: (repository: ICodeRepository) => boolean): Promise<string> {
        const typed = retypedSecret(pat)
        if (typed) return typed

        if (!repositoryId) {
            throw new BusinessException({
                code: "MISSING_ACCESS_TOKEN",
                message: "No access token was provided and no repository to take the stored one from",
                statusCode: 400
            })
        }

        const repository = await this.findForWrite(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (!storedFor(repository)) {
            throw storedTokenElsewhere()
        }

        return repository.accessToken
    }

    async getByProjectId(projectId: string): Promise<ICodeRepository[]> {
        await this.ensureAccessToProject(projectId)
        console.log(projectId, toObjectId(projectId))
        return await CodeRepository.find({ projectId: toObjectId(projectId), isActive: true }).sort({
            name: 1
        })
    }

    async findById(repositoryId: string, session?: ClientSession): Promise<ICodeRepository | null> {
        const repository = await CodeRepository.findOne(
            {
                _id: toObjectId(repositoryId)
            },
            {},
            { session }
        )

        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }

        await this.ensureAccessToProject(repository.projectId)

        return repository
    }

    /**
     * A connection about to be changed: the connections lend their token to every frontend and
     * backend of the project, so only those reaching the whole project manage them.
     */
    private async findForWrite(repositoryId: string, session?: ClientSession): Promise<ICodeRepository | null> {
        const repository = await this.findById(repositoryId, session)
        if (repository) {
            await this.ensureWholeProject(repository.projectId)
        }
        return repository
    }

    async makeDefault(repositoryId: string) {
        const repository = await this.findForWrite(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }

        if (repository.default) return

        repository.default = true
        await repository.save()

        // Scoped to the project: unscoped, making one repository the default cleared the flag on
        // every other project's repositories too, a write reaching outside the caller's project.
        await CodeRepository.updateMany({ _id: { $ne: toObjectId(repositoryId) }, projectId: repository.projectId }, { default: false })
    }

    /**
     * Where the pipelines of the repositories scaffolded through the connection come from: `null` goes back to the
     * official template-pipelines. Owners only, as for GitOps: every repository scaffolded through it runs what they
     * pick. The templates repository is one the connection itself reaches.
     */
    async setPipelines(codeRepositoryId: string, input: PipelineTemplatesInput | null): Promise<ICodeRepository> {
        const connection = await this.findForPipelines(codeRepositoryId)
        const pipelines = input === null ? undefined : await this.resolvePipelines(connection, input)
        const updated = await CodeRepository.findOneAndUpdate({ _id: connection._id }, pipelines ? { pipelines } : { $unset: { pipelines: 1 } }, { new: true })
        if (!updated) throw new EntityNotFoundError(codeRepositoryId)
        return updated
    }

    /**
     * Writes into the repository `input` names, without saving it on the connection, one empty pipeline of the connection's
     * provider in every folder a scaffold looks in (`<type>/<compiler>` of the catalog, `<type>/<language>`), under its
     * folder. A pipeline already there is left as it is: one commit with the rest, pushed onto the ref, never forced.
     */
    async initializePipelines(codeRepositoryId: string, input: PipelineTemplatesInput): Promise<{ created: string[]; skipped: number }> {
        const connection = await this.findForPipelines(codeRepositoryId)
        const pipelines = await this.resolvePipelines(connection, input)
        const provider = PIPELINE_PROVIDERS[connection.provider]
        const { file, existing } = EMPTY_PIPELINES[provider]
        // The catalog as the templates library shows it: one coming soon cannot be scaffolded yet
        const templates = (await new MarketService(this.user).getAll()).filter(template => !template.comingSoon)
        const folders = pipelineTemplateFolders(templates)

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

        // Checked before the clone, as for the scaffolds: isomorphic-git holds the whole packfile in memory
        const reported = await new RepositoryWorkspaceService(this.user).providerSizeBytes(target)
        if (reported !== undefined && reported > fastify.config.REPOSITORIES_MAX_SIZE_MB * 1024 * 1024) {
            throw failed(`it is bigger than ${fastify.config.REPOSITORIES_MAX_SIZE_MB} MB`)
        }

        const workingCopy = new GitWorkingCopy(await fs.mkdtemp(path.join(tmpdir(), "template-pipelines-")), cloneUrlFor(target), gitCredentialsFor(connection))
        try {
            const fileService = new RepositoryFileService(this.user)
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

            const user = this.getUser()
            // An API key has no person behind it: the orchestrator signs
            const author = !user || this.user?.apiKeyId ? ORCHESTRATOR_COMMITTER : { name: [user.name, user.surname].filter(Boolean).join(" ") || user.email, email: user.email }
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

    /** A connection whose pipeline templates are about to change: owners only, as for GitOps, since every repository scaffolded through it runs them */
    private async findForPipelines(codeRepositoryId: string): Promise<ICodeRepository> {
        const connection = await this.findForWrite(codeRepositoryId)
        if (!connection) throw new EntityNotFoundError(codeRepositoryId)
        const project = await Project.findById(connection.projectId, { organizationId: 1 })
        if (!project) throw new ProjectNotFoundError(String(connection.projectId))
        await new GitOpsService(this.user).ensureOwner(connection.projectId, project.organizationId, {
            code: "PIPELINES_OWNER_REQUIRED",
            message: "Only an owner of the project can change where the pipeline templates of its connections come from"
        })
        return connection
    }

    /** The pipeline templates to store from what the screen sent */
    private async resolvePipelines(connection: ICodeRepository, input: PipelineTemplatesInput): Promise<ICodeRepositoryPipelines> {
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

        const importService = new CodeRepositoryImportService(this.user)
        const repository = (await importService.fetchRepositories(this, connection)).find(candidate => candidate.repositoryId === input.repositoryId)
        if (!repository) {
            throw createBusinessException({ code: "PIPELINES_REPOSITORY_INVALID", message: `The connection "${connection.name}" cannot reach the repository ${input.repositoryId}` })
        }
        return { codeRepository: importService.buildFrontendCodeRepository(connection, repository), ...(ref ? { ref } : {}), ...(path ? { path } : {}) }
    }

    async injectSecretsToDeployOnGitlabRaw(repository: ICodeRepository, session?: ClientSession) {
        if (repository.provider !== CodeRepositoryProvider.GITLAB) return
        if (!repository.gitlabData?.groupId) return

        const gitlabClient = new GitLabClient(repository.gitlabData.url, repository.accessToken)

        const exists = await gitlabClient.checkGroupSecretExists({
            groupId: repository.gitlabData.groupId,
            secretName: deploySecretName
        })

        if (exists) return

        const apiKey = await new ApiKeyService(this.user).createRaw(
            repository.projectId.toString(),
            {
                name: "MFE_ORCHESTRATOR_DEPLOY_SECRET - GitLab - " + repository.name,
                role: ApiKeyRole.MANAGER,
                expiresAt: deployKeyExpiry()
            },
            session
        )

        await gitlabClient.addGroupSecret({
            groupId: repository.gitlabData.groupId,
            secretName: deploySecretName,
            secretValue: apiKey.apiKey
        })
    }

    async injectSecretsToDeployOnGithubRaw(repository: ICodeRepository, session?: ClientSession) {
        if (repository.provider !== CodeRepositoryProvider.GITHUB) return
        if (!repository.githubData?.organizationId) return

        const githubClient = new GithubClient()

        const exists = await githubClient.checkOrganizationSecretExists({
            accessToken: repository.accessToken,
            orgName: repository.githubData.organizationId,
            secretName: deploySecretName
        })

        if (exists) return

        const apiKey = await new ApiKeyService(this.user).createRaw(
            repository.projectId.toString(),
            {
                name: "MFE_ORCHESTRATOR_DEPLOY_SECRET - Github - " + repository.name,
                role: ApiKeyRole.MANAGER,
                expiresAt: deployKeyExpiry()
            },
            session
        )

        await githubClient.upsertOrganizationSecret({
            accessToken: repository.accessToken,
            orgName: repository.githubData.organizationId,
            secretName: deploySecretName,
            visibility: "all",
            value: apiKey.apiKey
        })
    }

    async injectSecretsToDeployOnAzureDevOpsRaw(repository: ICodeRepository, session?: ClientSession) {
        if (repository.provider !== CodeRepositoryProvider.AZURE_DEV_OPS) return
        if (!repository.azureData?.organization || !repository.azureData?.projectId) return

        const azureDevOpsClient = new AzureDevOpsClient()

        const exists = await azureDevOpsClient.checkOrganizationSecretExists({
            accessToken: repository.accessToken,
            organization: repository.azureData.organization,
            projectId: repository.azureData.projectId,
            variableGroupName: azureDevOpsVariableGroupName,
            secretName: deploySecretName
        })

        if (exists) return

        const apiKey = await new ApiKeyService(this.user).createRaw(
            repository.projectId.toString(),
            {
                name: "MFE_ORCHESTRATOR_DEPLOY_SECRET - Azure DevOps - " + repository.name,
                role: ApiKeyRole.MANAGER,
                expiresAt: deployKeyExpiry()
            },
            session
        )

        await azureDevOpsClient.upsertOrganizationSecret({
            accessToken: repository.accessToken,
            organization: repository.azureData.organization,
            projectId: repository.azureData.projectId,
            projectName: repository.azureData.projectName,
            secretName: deploySecretName,
            value: apiKey.apiKey,
            variableGroupName: azureDevOpsVariableGroupName,
            variableGroupDescription: "Flightroom Deploy Secret"
        })
    }

    async create(projectId: string, repositoryData: CodeRepositoryCreateInput): Promise<ICodeRepository> {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)

        try {
            const repository = new CodeRepository({
                name: repositoryData.name,
                provider: repositoryData.provider,
                accessToken: repositoryData.accessToken,
                refreshToken: repositoryData.refreshToken,
                projectId: new Types.ObjectId(projectId),
                isActive: true
            })

            return repository.save()
        } catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === 11000) {
                throw createBusinessException({
                    code: "DUPLICATE_REPOSITORY",
                    message: "A repository with this provider and name already exists",
                    statusCode: 409
                })
            }

            const errorMessage = error instanceof Error ? error.message : String(error)
            throw createBusinessException({
                code: "REPOSITORY_CREATION_ERROR",
                message: "Failed to create repository",
                details: { error: errorMessage },
                statusCode: 500
            })
        }
    }

    async update(repositoryId: string, repositoryData: CodeRepositoryUpdateInput): Promise<ICodeRepository | null> {
        await this.findForWrite(repositoryId)

        try {
            const updated = await CodeRepository.findOneAndUpdate({ _id: toObjectId(repositoryId) }, repositoryData, { new: true, runValidators: true })

            if (!updated) {
                throw new EntityNotFoundError(repositoryId)
            }

            return updated
        } catch (error) {
            if (error instanceof BusinessException || error instanceof EntityNotFoundError) {
                throw error
            }

            throw createBusinessException({
                code: "REPOSITORY_UPDATE_ERROR",
                message: "Failed to update repository",
                details: {
                    error: error instanceof Error ? error.message : "Unknown error"
                },
                statusCode: 500
            })
        }
    }

    async updateGithub(repositoryId: string, body: UpdateGithubDTO): Promise<ICodeRepository | null> {
        return runInTransaction(async session => this.updateGithubRaw(repositoryId, body, session))
    }

    async updateGithubRaw(repositoryId: string, body: UpdateGithubDTO, session?: ClientSession): Promise<ICodeRepository | null> {
        const repository = await this.findForWrite(repositoryId, session)

        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }

        if (repository.provider !== CodeRepositoryProvider.GITHUB) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitHub",
                statusCode: 400
            })
        }

        repository.name = body.name
        repository.githubData = {
            type: body.type,
            organizationId: body.organizationId,
            userName: body.userName
        }

        const repositoryFromDb = await repository.save({ session })

        await this.injectSecretsToDeployOnGithubRaw(repositoryFromDb, session)

        return repositoryFromDb
    }

    async delete(repositoryId: string): Promise<DeleteResult> {
        const repository = await this.findForWrite(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }

        return await CodeRepository.deleteOne({ _id: toObjectId(repositoryId) })
    }

    async activate(repositoryId: string): Promise<ICodeRepository | null> {
        return await this.update(repositoryId, { isActive: true })
    }

    async deactivate(repositoryId: string): Promise<ICodeRepository | null> {
        return await this.update(repositoryId, { isActive: false })
    }

    /**
     * Revoca il grant GitHub così che il prossimo authorize mostri sempre la
     * pagina di autorizzazione. Con repositoryId revoca solo quella connessione,
     * altrimenti tutte le connessioni GitHub del progetto (best effort).
     */
    async revokeGithubGrant(projectId: string, repositoryId?: string): Promise<void> {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)

        let repositories: ICodeRepository[]
        if (repositoryId) {
            const repository = await this.findById(repositoryId)
            if (!repository) {
                throw new EntityNotFoundError(repositoryId)
            }
            repositories = [repository]
        } else {
            repositories = await CodeRepository.find({ projectId: toObjectId(projectId), provider: CodeRepositoryProvider.GITHUB })
        }

        const githubClient = new GithubClient()
        const tokens = [...new Set(repositories.filter(repository => repository.provider === CodeRepositoryProvider.GITHUB && repository.accessToken).map(repository => repository.accessToken))]

        await Promise.all(tokens.map(token => githubClient.revokeApplicationGrant(fastify.config.CODE_REPOSITORY_GITHUB_CLIENT_ID, fastify.config.CODE_REPOSITORY_GITHUB_CLIENT_SECRET, token)))
    }

    async addRepositoryGithub(code: string, state: string, projectId: string, codeRepositoryId: string) {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)
        const githubClient = new GithubClient()
        const responseGithub = await githubClient.getAccessToken({
            client_id: fastify.config.CODE_REPOSITORY_GITHUB_CLIENT_ID,
            client_secret: fastify.config.CODE_REPOSITORY_GITHUB_CLIENT_SECRET,
            code
        })

        if (codeRepositoryId) {
            return await this.update(codeRepositoryId, {
                accessToken: responseGithub.access_token
            })
        } else {
            const userGithub = await githubClient.getUser(responseGithub.access_token)
            const repository = new CodeRepository({
                name: userGithub.name,
                provider: CodeRepositoryProvider.GITHUB,
                accessToken: responseGithub.access_token,
                projectId: new Types.ObjectId(projectId),
                isActive: true,
                githubData: {
                    type: CodeRepositoryType.PERSONAL,
                    userName: userGithub.login
                }
            })

            return await repository.save()
        }
    }

    async addRepositoryAzure(body: CreateAzureDevOpsRepositoryDTO, projectId: string) {
        return runInTransaction(async session => this.addRepositoryAzureRaw(body, projectId, session))
    }

    async addRepositoryAzureRaw(body: CreateAzureDevOpsRepositoryDTO, projectId: string, session?: ClientSession) {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)

        const repository = new CodeRepository({
            name: body.name,
            provider: CodeRepositoryProvider.AZURE_DEV_OPS,
            accessToken: body.pat,
            projectId: new Types.ObjectId(projectId),
            azureData: {
                organization: body.organization,
                projectId: body.projectId,
                projectName: body.projectName
            },
            githubData: undefined,
            gitlabData: undefined,
            isActive: true
        })

        const out = await repository.save({ session })
        await this.injectSecretsToDeployOnAzureDevOpsRaw(out, session)
        return out
    }

    async editRepositoryAzureDevOps(body: CreateAzureDevOpsRepositoryDTO, repositoryId: string) {
        return runInTransaction(async session => this.editRepositoryAzureDevOpsRaw(body, repositoryId, session))
    }

    async editRepositoryAzureDevOpsRaw(body: CreateAzureDevOpsRepositoryDTO, repositoryId: string, session?: ClientSession) {
        const repository = await this.findForWrite(repositoryId, session)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.AZURE_DEV_OPS) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitLab",
                statusCode: 400
            })
        }

        repository.name = body.name
        repository.accessToken = retypedSecret(body.pat) ?? repository.accessToken
        repository.gitlabData = undefined
        repository.githubData = undefined
        repository.azureData = {
            organization: body.organization,
            projectId: body.projectId,
            projectName: body.projectName
        }
        const out = await repository.save({ session })
        await this.injectSecretsToDeployOnAzureDevOpsRaw(out, session)
        return out
    }

    async testConnectionAzure(organization: string, pat: string, repositoryId?: string) {
        const client = new AzureDevOpsClient()
        // The organization may change on the edit screen: the host stays Azure DevOps, so the token stays with it
        const token = await this.resolveAccessToken(pat, repositoryId, repository => repository.provider === CodeRepositoryProvider.AZURE_DEV_OPS)
        const projects = await client.getProjects(token, organization)
        // Saving the connection writes the deploy key into a variable group: a token without that
        // scope still lists the projects, so it is tried here rather than failing only on save.
        // A scope applies to the whole token, so any project of the organization tells.
        if (projects.value[0]) {
            await client.getVariableGroups(token, organization, projects.value[0].id)
        }
        return projects
    }

    async addRepositoryGitlab(body: CreateGitlabRepositoryDto, projectId: string) {
        return runInTransaction(async session => this.addRepositoryGitlabRaw(body, projectId, session))
    }

    async addRepositoryGitlabRaw(body: CreateGitlabRepositoryDto, projectId: string, session?: ClientSession) {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)

        const repository = new CodeRepository({
            name: body.name,
            provider: CodeRepositoryProvider.GITLAB,
            accessToken: body.pat,
            projectId: new Types.ObjectId(projectId),
            isActive: true,
            gitlabData: {
                url: body.url,
                groupId: body.groupId,
                groupPath: body.groupPath
            },
            githubData: undefined,
            azureData: undefined
        })

        const out = await repository.save({ session })
        await this.injectSecretsToDeployOnGitlabRaw(out, session)
        return out
    }

    async editRepositoryGitlab(body: CreateGitlabRepositoryDto, repositoryId: string) {
        return runInTransaction(async session => this.editRepositoryGitlabRaw(body, repositoryId, session))
    }

    async editRepositoryGitlabRaw(body: CreateGitlabRepositoryDto, repositoryId: string, session?: ClientSession) {
        const repository = await this.findForWrite(repositoryId, session)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.GITLAB) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitLab",
                statusCode: 400
            })
        }

        const typed = retypedSecret(body.pat)
        // Saving pushes the deploy key with the token to the URL: a new one takes the token typed again
        if (!typed && !sameGitlabUrl(repository.gitlabData?.url, body.url)) {
            throw storedTokenElsewhere()
        }

        repository.name = body.name
        repository.accessToken = typed ?? repository.accessToken
        repository.gitlabData = {
            url: body.url,
            groupId: body.groupId,
            groupPath: body.groupPath
        }
        repository.githubData = undefined
        repository.azureData = undefined
        const out = await repository.save({ session })
        await this.injectSecretsToDeployOnGitlabRaw(out, session)
        return out
    }

    async testConnectionGitlab(url: string, pat: string, repositoryId?: string) {
        const token = await this.resolveAccessToken(pat, repositoryId, repository => repository.provider === CodeRepositoryProvider.GITLAB && sameGitlabUrl(repository.gitlabData?.url, url))
        return new GitLabClient(url, token).getGroups()
    }

    async getAzureRepositories(repositoryId: string, projectId: string): Promise<RepositoryData[]> {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.AZURE_DEV_OPS) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not Azure DevOps",
                statusCode: 400
            })
        }
        return (await new AzureDevOpsClient().getRepositories(repository.accessToken, repository?.name, projectId))?.value
    }

    async getAzureProjects(repositoryId: string): Promise<unknown> {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.AZURE_DEV_OPS) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not Azure DevOps",
                statusCode: 400
            })
        }
        return new AzureDevOpsClient().getProjects(repository.accessToken, repository?.name)
    }

    async getGithubOrganizations(repositoryId: string): Promise<unknown> {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.GITHUB) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitHub",
                statusCode: 400
            })
        }

        return new GithubClient().getUserOrganizations(repository.accessToken)
    }

    async getGithubUser(repositoryId: string): Promise<unknown> {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.GITHUB) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitHub",
                statusCode: 400
            })
        }
        return new GithubClient().getUser(repository.accessToken)
    }

    async getGitlabGroups(codeRepositoryId: string, selectOnlyChilds: boolean = true): Promise<unknown> {
        const repository = await this.findById(codeRepositoryId)
        if (!repository) {
            throw new EntityNotFoundError(codeRepositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.GITLAB || !repository.gitlabData?.url) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitLab",
                statusCode: 400
            })
        }
        const groups = await new GitLabClient(repository.gitlabData?.url, repository.accessToken).getGroups()
        if (selectOnlyChilds && repository.gitlabData?.groupPath) {
            const startsWith = repository.gitlabData?.groupPath
            return groups.filter(group => group.full_path.startsWith(startsWith))
        }
        return groups
    }

    async getGitlabPaths(repositoryId: string, groupId: number): Promise<unknown> {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.GITLAB || !repository.gitlabData?.url || !repository.gitlabData?.groupPath) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitLab",
                statusCode: 400
            })
        }
        return new GitLabClient(repository.gitlabData?.url, repository.accessToken).getRepositoryPathsByGroupId(repository.gitlabData?.groupPath)
    }

    async getGitlabRepositories(repositoryId: string, groupId: number): Promise<unknown> {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== CodeRepositoryProvider.GITLAB || !repository.gitlabData?.url) {
            throw new BusinessException({
                code: "INVALID_PROVIDER",
                message: "Repository provider is not GitLab",
                statusCode: 400
            })
        }
        return new GitLabClient(repository.gitlabData?.url, repository.accessToken).getRepositoriesByGroupId(groupId)
    }

    async getRepositories(repositoryId: string, groupPath?: string, groupId?: number) {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider === CodeRepositoryProvider.GITHUB) {
            if (!repository.githubData?.type) {
                throw new BusinessException({
                    code: "INVALID_PROVIDER",
                    message: "Repository provider is not GitHub",
                    statusCode: 400
                })
            }
            return new GithubClient().getRepositories(repository.accessToken, repository.githubData?.type === CodeRepositoryType.ORGANIZATION ? repository.githubData.organizationId : undefined)
        }
        if (repository.provider === CodeRepositoryProvider.GITLAB) {
            if (!repository.gitlabData?.groupPath) {
                throw new BusinessException({
                    code: "INVALID_PROVIDER",
                    message: "Repository provider is not GitLab",
                    statusCode: 400
                })
            }
            return new GitLabClient(repository.gitlabData?.url, repository.accessToken).getRepositoriesByGroupId(groupId || repository.gitlabData?.groupId)
        }
        if (repository.provider === CodeRepositoryProvider.AZURE_DEV_OPS) {
            if (!repository.azureData?.organization || !repository.azureData?.projectId) {
                throw new BusinessException({
                    code: "INVALID_PROVIDER",
                    message: "Repository provider is not Azure DevOps",
                    statusCode: 400
                })
            }
            return (await new AzureDevOpsClient().getRepositories(repository.accessToken, repository.azureData?.organization, repository.azureData?.projectId))?.value
        }
    }
}

export default CodeRepositoryService
