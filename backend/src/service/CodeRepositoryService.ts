import { ClientSession, DeleteResult, Types } from "mongoose"
import { fastify } from ".."
import AzureDevOpsClient, { RepositoryData } from "../client/AzureDevOpsClient"
import GithubClient from "../client/GithubClient"
import GitLabClient from "../client/GitlabClient"
import { BusinessException, createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import CodeRepository, { CodeRepositoryProvider, CodeRepositoryType, ICodeRepository, ICodeRepositoryPipelines } from "../models/CodeRepositoryModel"
import Project from "../models/ProjectModel"
import CreateAzureDevOpsRepositoryDTO from "../types/CreateAzureDevOpsRepositoryDTO"
import CreateGitlabRepositoryDto from "../types/CreateGitlabRepositoryDTO"
import UpdateGithubDTO from "../types/UpdateGithubDTO"
import { toObjectId } from "../utils/mongooseUtils"
import { runInTransaction } from "../utils/runInTransaction"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import BaseAuthorizedService from "./BaseAuthorizedService"
import CodeRepositoryImportService from "./CodeRepositoryImportService"
import { initializePipelineTemplates, PipelineTemplatesInput, parsePipelinesInput } from "./codeRepository/connectionPipelines"
import { injectAzureDevOpsDeploySecret, injectGithubDeploySecret, injectGitlabDeploySecret } from "./codeRepository/deploySecrets"
import { invalidProvider, listBranches, listRepositories, UnifiedBranch } from "./codeRepository/providerListings"
import GitOpsService from "./GitOpsService"

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

export interface CodeRepositoryUpdateInput {
    name?: string
    provider?: CodeRepositoryProvider
    accessToken?: string
    refreshToken?: string
    isActive?: boolean
}

export class CodeRepositoryService extends BaseAuthorizedService {
    async getBranches(codeRepositoryId: string, repositoryId: string): Promise<UnifiedBranch[]> {
        const repository = await this.findById(codeRepositoryId)
        if (!repository) {
            throw new EntityNotFoundError(codeRepositoryId)
        }
        return listBranches(repository, repositoryId)
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
        return initializePipelineTemplates(this.user, connection, pipelines)
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
        const { ref, path } = parsePipelinesInput(input)

        const importService = new CodeRepositoryImportService(this.user)
        const repository = (await importService.fetchRepositories(this, connection)).find(candidate => candidate.repositoryId === input.repositoryId)
        if (!repository) {
            throw createBusinessException({ code: "PIPELINES_REPOSITORY_INVALID", message: `The connection "${connection.name}" cannot reach the repository ${input.repositoryId}` })
        }
        return { codeRepository: importService.buildFrontendCodeRepository(connection, repository), ...(ref ? { ref } : {}), ...(path ? { path } : {}) }
    }

    async injectSecretsToDeployOnGitlabRaw(repository: ICodeRepository, session?: ClientSession) {
        return injectGitlabDeploySecret(this.user, repository, session)
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
            throw invalidProvider("Repository provider is not GitHub")
        }

        repository.name = body.name
        repository.githubData = {
            type: body.type,
            organizationId: body.organizationId,
            userName: body.userName
        }

        const repositoryFromDb = await repository.save({ session })

        await injectGithubDeploySecret(this.user, repositoryFromDb, session)

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
        await injectAzureDevOpsDeploySecret(this.user, out, session)
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
            throw invalidProvider("Repository provider is not GitLab")
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
        await injectAzureDevOpsDeploySecret(this.user, out, session)
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
            throw invalidProvider("Repository provider is not GitLab")
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

    /** The connection `repositoryId`, refused unless it is one of `provider` */
    private async findOfProvider(repositoryId: string, provider: CodeRepositoryProvider, message: string): Promise<ICodeRepository> {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        if (repository.provider !== provider) {
            throw invalidProvider(message)
        }
        return repository
    }

    async getAzureRepositories(repositoryId: string, projectId: string): Promise<RepositoryData[]> {
        const repository = await this.findOfProvider(repositoryId, CodeRepositoryProvider.AZURE_DEV_OPS, "Repository provider is not Azure DevOps")
        return (await new AzureDevOpsClient().getRepositories(repository.accessToken, repository?.name, projectId))?.value
    }

    async getAzureProjects(repositoryId: string): Promise<unknown> {
        const repository = await this.findOfProvider(repositoryId, CodeRepositoryProvider.AZURE_DEV_OPS, "Repository provider is not Azure DevOps")
        return new AzureDevOpsClient().getProjects(repository.accessToken, repository?.name)
    }

    async getGithubOrganizations(repositoryId: string): Promise<unknown> {
        const repository = await this.findOfProvider(repositoryId, CodeRepositoryProvider.GITHUB, "Repository provider is not GitHub")
        return new GithubClient().getUserOrganizations(repository.accessToken)
    }

    async getGithubUser(repositoryId: string): Promise<unknown> {
        const repository = await this.findOfProvider(repositoryId, CodeRepositoryProvider.GITHUB, "Repository provider is not GitHub")
        return new GithubClient().getUser(repository.accessToken)
    }

    async getGitlabGroups(codeRepositoryId: string, selectOnlyChilds: boolean = true): Promise<unknown> {
        const repository = await this.findOfProvider(codeRepositoryId, CodeRepositoryProvider.GITLAB, "Repository provider is not GitLab")
        if (!repository.gitlabData?.url) {
            throw invalidProvider("Repository provider is not GitLab")
        }
        const groups = await new GitLabClient(repository.gitlabData.url, repository.accessToken).getGroups()
        if (selectOnlyChilds && repository.gitlabData.groupPath) {
            const startsWith = repository.gitlabData.groupPath
            return groups.filter(group => group.full_path.startsWith(startsWith))
        }
        return groups
    }

    async getGitlabPaths(repositoryId: string, groupId: number): Promise<unknown> {
        const repository = await this.findOfProvider(repositoryId, CodeRepositoryProvider.GITLAB, "Repository provider is not GitLab")
        if (!repository.gitlabData?.url || !repository.gitlabData?.groupPath) {
            throw invalidProvider("Repository provider is not GitLab")
        }
        return new GitLabClient(repository.gitlabData.url, repository.accessToken).getRepositoryPathsByGroupId(repository.gitlabData.groupPath)
    }

    async getGitlabRepositories(repositoryId: string, groupId: number): Promise<unknown> {
        const repository = await this.findOfProvider(repositoryId, CodeRepositoryProvider.GITLAB, "Repository provider is not GitLab")
        if (!repository.gitlabData?.url) {
            throw invalidProvider("Repository provider is not GitLab")
        }
        return new GitLabClient(repository.gitlabData.url, repository.accessToken).getRepositoriesByGroupId(groupId)
    }

    async getRepositories(repositoryId: string, groupPath?: string, groupId?: number) {
        const repository = await this.findById(repositoryId)
        if (!repository) {
            throw new EntityNotFoundError(repositoryId)
        }
        return listRepositories(repository, groupId)
    }
}

export default CodeRepositoryService
