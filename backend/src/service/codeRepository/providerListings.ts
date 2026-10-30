import AzureDevOpsClient, { AzureDevOpsBranch } from "../../client/AzureDevOpsClient"
import GithubClient, { GithubBranch } from "../../client/GithubClient"
import GitLabClient, { GitLabBranch } from "../../client/GitlabClient"
import { BusinessException } from "../../errors/BusinessException"
import { CodeRepositoryProvider, CodeRepositoryType, ICodeRepository } from "../../models/CodeRepositoryModel"

/** A connection asked for something its provider, or what is configured of it, cannot give */
export const invalidProvider = (message: string) =>
    new BusinessException({
        code: "INVALID_PROVIDER",
        message,
        statusCode: 400
    })

export interface UnifiedBranch {
    default?: boolean
    branch: string
    commitSha: string
    commitUrl: string
    author: string | null
    authorEmail: string | null
    authorAvatar: string | null
}

const mapAzureBranch = (azureBranch: AzureDevOpsBranch) => ({
    default: azureBranch.name === "main" || azureBranch.name === "master",
    branch: azureBranch.name.replace("refs/heads/", ""), // "refs/heads/main" -> "main"
    commitSha: azureBranch.objectId, // "objectId"
    commitUrl: azureBranch.url, // l'url alla ref
    author: azureBranch.creator?.displayName,
    authorEmail: azureBranch.creator?.uniqueName,
    authorAvatar: azureBranch.creator?._links?.avatar?.href
})

const mapGithubBranch = (githubBranch: GithubBranch) => ({
    default: githubBranch.name === "main" || githubBranch.name === "master",
    branch: githubBranch.name,
    commitSha: githubBranch.commit?.sha,
    commitUrl: githubBranch.commit?.url,
    author: null, // GitHub branches API non porta info autore
    authorEmail: null,
    authorAvatar: null
})

const mapGitlabBranch = (gitlabBranch: GitLabBranch): UnifiedBranch => ({
    default: gitlabBranch.default,
    branch: gitlabBranch.name,
    commitSha: gitlabBranch.commit?.id,
    commitUrl: gitlabBranch.commit?.web_url,
    author: gitlabBranch.commit?.author_name,
    authorEmail: gitlabBranch.commit?.author_email,
    authorAvatar: null // GitLab branches API non fornisce avatar direttamente
})

/** The branches of the repository `repositoryId` reached through the connection `repository`, the same shape on every provider */
export const listBranches = async (repository: ICodeRepository, repositoryId: string): Promise<UnifiedBranch[]> => {
    if (repository.provider === CodeRepositoryProvider.GITHUB) {
        return new GithubClient()
            .getBranches(repository.accessToken, repositoryId, repository.githubData?.organizationId, repository.githubData?.userName)
            .then(branches => branches.map(mapGithubBranch))
    } else if (repository.provider === CodeRepositoryProvider.AZURE_DEV_OPS) {
        if (!repository.azureData) {
            throw invalidProvider("Repository provider is not Azure DevOps")
        }

        return new AzureDevOpsClient().getBranches(repository.accessToken, repository.azureData.organization, repository.azureData.projectId, repositoryId).then(dto => dto.value.map(mapAzureBranch))
    } else if (repository.provider === CodeRepositoryProvider.GITLAB) {
        if (!repository.gitlabData) {
            throw invalidProvider("Repository provider is not GitLab")
        }

        return new GitLabClient(repository.gitlabData.url, repository.accessToken).getBranches(encodeURI(repositoryId)).then(branches => branches.map(mapGitlabBranch))
    }

    return []
}

/** The repositories the connection `repository` reaches: its organization or user on GitHub, the group `groupId` (its own by default) on GitLab, its project on Azure DevOps */
export const listRepositories = async (repository: ICodeRepository, groupId?: number) => {
    if (repository.provider === CodeRepositoryProvider.GITHUB) {
        if (!repository.githubData?.type) {
            throw invalidProvider("Repository provider is not GitHub")
        }
        return new GithubClient().getRepositories(repository.accessToken, repository.githubData?.type === CodeRepositoryType.ORGANIZATION ? repository.githubData.organizationId : undefined)
    }
    if (repository.provider === CodeRepositoryProvider.GITLAB) {
        if (!repository.gitlabData?.groupPath) {
            throw invalidProvider("Repository provider is not GitLab")
        }
        return new GitLabClient(repository.gitlabData?.url, repository.accessToken).getRepositoriesByGroupId(groupId || repository.gitlabData?.groupId)
    }
    if (repository.provider === CodeRepositoryProvider.AZURE_DEV_OPS) {
        if (!repository.azureData?.organization || !repository.azureData?.projectId) {
            throw invalidProvider("Repository provider is not Azure DevOps")
        }
        return (await new AzureDevOpsClient().getRepositories(repository.accessToken, repository.azureData?.organization, repository.azureData?.projectId))?.value
    }
}
