import { ClientSession } from "mongoose"
import AzureDevOpsClient from "../../client/AzureDevOpsClient"
import GithubClient from "../../client/GithubClient"
import GitLabClient from "../../client/GitlabClient"
import { ApiKeyRole } from "../../models/ApiKeyModel"
import { CodeRepositoryProvider, ICodeRepository } from "../../models/CodeRepositoryModel"
import { ApiKeyService } from "../ApiKeyService"
import { AuthorizedPrincipal } from "../BaseAuthorizedService"

export const deploySecretName = "FLIGHTROOM_API_KEY"

/**
 * How long a deploy key the platform creates for itself stays valid.
 *
 * Spelled out unit by unit on purpose: this was `3600 * 1000 * 365` in four places, which
 * is 365 *hours* — the keys expired after fifteen days while every page said a year.
 */
const deployKeyLifetimeMs = 365 * 24 * 60 * 60 * 1000

export const deployKeyExpiry = () => new Date(Date.now() + deployKeyLifetimeMs)
export const azureDevOpsVariableGroupName = "MFE_ORCHESTRATOR_SECRETS"

/** A new deploy key of the project of `repository`, named after the provider and the connection, for its pipelines to call back with */
const issueDeployKey = (user: AuthorizedPrincipal | undefined, repository: ICodeRepository, providerName: string, session?: ClientSession) =>
    new ApiKeyService(user).createRaw(
        repository.projectId.toString(),
        {
            name: `MFE_ORCHESTRATOR_DEPLOY_SECRET - ${providerName} - ${repository.name}`,
            role: ApiKeyRole.MANAGER,
            expiresAt: deployKeyExpiry()
        },
        session
    )

/** Stores a deploy key as a variable of the GitLab group of the connection, unless the group has one already */
export const injectGitlabDeploySecret = async (user: AuthorizedPrincipal | undefined, repository: ICodeRepository, session?: ClientSession) => {
    if (repository.provider !== CodeRepositoryProvider.GITLAB) return
    if (!repository.gitlabData?.groupId) return

    const gitlabClient = new GitLabClient(repository.gitlabData.url, repository.accessToken)

    const exists = await gitlabClient.checkGroupSecretExists({
        groupId: repository.gitlabData.groupId,
        secretName: deploySecretName
    })

    if (exists) return

    const apiKey = await issueDeployKey(user, repository, "GitLab", session)

    await gitlabClient.addGroupSecret({
        groupId: repository.gitlabData.groupId,
        secretName: deploySecretName,
        secretValue: apiKey.apiKey
    })
}

/** Stores a deploy key as a secret of the GitHub organization of the connection, unless it has one already */
export const injectGithubDeploySecret = async (user: AuthorizedPrincipal | undefined, repository: ICodeRepository, session?: ClientSession) => {
    if (repository.provider !== CodeRepositoryProvider.GITHUB) return
    if (!repository.githubData?.organizationId) return

    const githubClient = new GithubClient()

    const exists = await githubClient.checkOrganizationSecretExists({
        accessToken: repository.accessToken,
        orgName: repository.githubData.organizationId,
        secretName: deploySecretName
    })

    if (exists) return

    const apiKey = await issueDeployKey(user, repository, "Github", session)

    await githubClient.upsertOrganizationSecret({
        accessToken: repository.accessToken,
        orgName: repository.githubData.organizationId,
        secretName: deploySecretName,
        visibility: "all",
        value: apiKey.apiKey
    })
}

/** Stores a deploy key in the variable group of the Azure DevOps project of the connection, unless the group has one already */
export const injectAzureDevOpsDeploySecret = async (user: AuthorizedPrincipal | undefined, repository: ICodeRepository, session?: ClientSession) => {
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

    const apiKey = await issueDeployKey(user, repository, "Azure DevOps", session)

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
