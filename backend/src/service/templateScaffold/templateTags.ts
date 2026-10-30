import axios from "axios"
import AzureDevOpsClient, { AzureBranchNotFoundError } from "../../client/AzureDevOpsClient"
import GithubClient from "../../client/GithubClient"
import GitlabClient from "../../client/GitlabClient"
import { BusinessException } from "../../errors/BusinessException"
import { CodeRepositoryProvider, ICodeRepository } from "../../models/CodeRepositoryModel"
import { ICodeRepositoryFrontend } from "../../models/FrontendModel"

/** A linked repository ready to be tagged: its connection, checked against the project, and the commit the ref points to */
export interface TagTarget {
    codeRepository: ICodeRepository
    link: ICodeRepositoryFrontend
    ref: string
    commit: string
}

/**
 * The ref of a tag that cannot be resolved because the branch, or the whole repository, is not there: a 404
 * the console translates by its code (BUILD_REF_NOT_FOUND, BUILD_REPOSITORY_NOT_FOUND). `reason` is what a
 * domain build reports for the repository.
 */
export class TagLookupError extends BusinessException {
    constructor(
        readonly reason: "REF_NOT_FOUND" | "REPOSITORY_NOT_FOUND",
        message: string
    ) {
        super({ code: reason === "REF_NOT_FOUND" ? "BUILD_REF_NOT_FOUND" : "BUILD_REPOSITORY_NOT_FOUND", message, statusCode: 404 })
    }
}

const gitlabClientFor = (codeRepository: ICodeRepository) => new GitlabClient(codeRepository.gitlabData?.url || "", codeRepository.accessToken)

/** The commit `branchName` points to, undefined for a provider without tags */
export const findCommit = async (codeRepository: ICodeRepository, link: ICodeRepositoryFrontend, branchName: string): Promise<string | undefined> => {
    if (codeRepository.provider === CodeRepositoryProvider.GITHUB) {
        return new GithubClient().getBranchCommitSha(codeRepository.accessToken, link.name, branchName, codeRepository.githubData?.organizationId, codeRepository.githubData?.userName)
    } else if (codeRepository.provider === CodeRepositoryProvider.GITLAB) {
        return gitlabClientFor(codeRepository).getBranchCommitSha(link.repositoryId, branchName)
    } else if (codeRepository.provider === CodeRepositoryProvider.AZURE_DEV_OPS) {
        if (!codeRepository.azureData) {
            throw new Error("Azure DevOps data not found")
        }
        return new AzureDevOpsClient().getBranchCommitId(codeRepository.accessToken, codeRepository.azureData.organization, codeRepository.azureData.projectId, link.repositoryId, branchName)
    }
    return undefined
}

const readRepository = async (codeRepository: ICodeRepository, link: ICodeRepositoryFrontend): Promise<void> => {
    if (codeRepository.provider === CodeRepositoryProvider.GITHUB) {
        await new GithubClient().getRepository({
            accessToken: codeRepository.accessToken,
            orgName: codeRepository.githubData?.organizationId,
            userName: codeRepository.githubData?.userName,
            repositoryName: link.name
        })
    } else if (codeRepository.provider === CodeRepositoryProvider.GITLAB) {
        await gitlabClientFor(codeRepository).getProject(link.repositoryId)
    } else if (codeRepository.provider === CodeRepositoryProvider.AZURE_DEV_OPS && codeRepository.azureData) {
        await new AzureDevOpsClient().getRepository(codeRepository.accessToken, codeRepository.azureData.organization, codeRepository.azureData.projectId, link.repositoryId)
    }
}

/**
 * A branch lookup the provider refused for want of something: the repository is read to tell a missing
 * branch from a repository that is gone, renamed or out of reach of the token (providers answer 404 for
 * both). Any other failure, or one the repository read does not explain, is passed on as it came.
 */
export const explainMissingCommit = async (error: unknown, codeRepository: ICodeRepository, link: ICodeRepositoryFrontend, branchName: string): Promise<unknown> => {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const branchMissing = error instanceof AzureBranchNotFoundError || status === 404
    if (!branchMissing && status !== 401 && status !== 403) return error
    try {
        await readRepository(codeRepository, link)
    } catch (repositoryError) {
        const repositoryStatus = axios.isAxiosError(repositoryError) ? repositoryError.response?.status : undefined
        if (repositoryStatus === 401 || repositoryStatus === 403 || repositoryStatus === 404) {
            return new TagLookupError("REPOSITORY_NOT_FOUND", `The repository ${link.name} was not found, or the token of the connection cannot reach it`)
        }
        return error
    }
    return branchMissing ? new TagLookupError("REF_NOT_FOUND", `The branch ${branchName} was not found in the repository ${link.name}`) : error
}

/** Whether the repository of `target` already has the tag `version`: creating it again would fail at the provider */
export const tagExists = async ({ codeRepository, link }: TagTarget, version: string): Promise<boolean> => {
    if (codeRepository.provider === CodeRepositoryProvider.GITHUB) {
        return new GithubClient().tagExists(codeRepository.accessToken, link.name, version, codeRepository.githubData?.organizationId, codeRepository.githubData?.userName)
    } else if (codeRepository.provider === CodeRepositoryProvider.GITLAB) {
        return gitlabClientFor(codeRepository).tagExists(link.repositoryId, version)
    } else if (codeRepository.provider === CodeRepositoryProvider.AZURE_DEV_OPS && codeRepository.azureData) {
        return new AzureDevOpsClient().tagExists(codeRepository.accessToken, codeRepository.azureData.organization, codeRepository.azureData.projectId, link.repositoryId, version)
    }
    return false
}

/** The commit the tag `version` points to in the repository of `target`, undefined without the tag */
export const tagCommit = async ({ codeRepository, link }: TagTarget, version: string): Promise<string | undefined> => {
    if (codeRepository.provider === CodeRepositoryProvider.GITHUB) {
        return new GithubClient().getTagCommitSha(codeRepository.accessToken, link.name, version, codeRepository.githubData?.organizationId, codeRepository.githubData?.userName)
    } else if (codeRepository.provider === CodeRepositoryProvider.GITLAB) {
        return gitlabClientFor(codeRepository).getTagCommitSha(link.repositoryId, version)
    } else if (codeRepository.provider === CodeRepositoryProvider.AZURE_DEV_OPS && codeRepository.azureData) {
        return new AzureDevOpsClient().getTagCommitId(codeRepository.accessToken, codeRepository.azureData.organization, codeRepository.azureData.projectId, link.repositoryId, version)
    }
    return undefined
}

/** Creates the tag `version` on the commit of `target` */
export const pushTag = async ({ codeRepository, link, commit }: TagTarget, version: string): Promise<void> => {
    if (codeRepository.provider === CodeRepositoryProvider.GITHUB) {
        return await new GithubClient().createTag(codeRepository.accessToken, link.name, version, commit, codeRepository.githubData?.organizationId, codeRepository.githubData?.userName)
    } else if (codeRepository.provider === CodeRepositoryProvider.GITLAB) {
        return await gitlabClientFor(codeRepository).createTag(link.repositoryId, version, commit)
    } else if (codeRepository.provider === CodeRepositoryProvider.AZURE_DEV_OPS && codeRepository.azureData) {
        return await new AzureDevOpsClient().createTag(codeRepository.accessToken, codeRepository.azureData.organization, codeRepository.azureData.projectId, link.repositoryId, version, commit)
    }
}
