import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios"
import { createBusinessException } from "../errors/BusinessException"
import { BuildJobLogDTO, MAX_FAILED_JOB_LOG_BYTES, MAX_FAILED_JOBS } from "../types/BuildStatusDTO"

/** Code of the error raised when the token cannot reach the variable groups the deploy key is kept in */
export const AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED = "AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED"
export const AZURE_DEVOPS_TAG_REFUSED = "AZURE_DEVOPS_TAG_REFUSED"

/** Safety net so a continuation token that never ends cannot turn a listing into an endless loop */
const maxContinuationPages = 50

/** One ref of an update of the refs, e.g. `updateStatus: "createTagPermissionRequired"` when `success` is false */
interface AzureDevOpsRefUpdateResult {
    name: string
    success: boolean
    updateStatus?: string
    customMessage?: string
}

export interface AzureAccessTokenResponse {
    access_token: string
    token_type: string
    expires_in: number
    refresh_token: string
    scope: string
    error?: string
    error_description?: string
}

export interface AzureAccessTokenRequest {
    client_id: string
    client_secret: string
    code: string
    redirect_uri: string
    grant_type: string
}

export interface AzureUser {
    subjectId: string
    descriptor: string
    publicAlias: string
    emailAddress: string
    coreRevision: number
    timeStamp: string
    id: string
    revision: number
    url: string
    displayName: string
    uniqueName: string
    imageUrl: string
    isAadIdentity: boolean
    isContainer: boolean
    isDeletedInOrigin: boolean
    profileUrl: string
    directoryAlias: string
    domain: string
    principalName: string
    mailAddress: string
}

export interface AzureOrganization {
    accountId: string
    accountName: string
    accountUri: string
    properties: Record<string, unknown>
}

export interface AzureDevOpsProject {
    id: string
    name: string
    url: string
    state: string
    revision: number
    visibility: string
    lastUpdateTime: string
    description?: string // opzionale perché non tutte le voci hanno description
}

export interface AzureDevOpsProjectsResponse {
    count: number
    value: AzureDevOpsProject[]
}

export interface RepositoryData {
    id: string
    name: string
    url: string
    project: {
        id: string
        name: string
        url: string
    }
    defaultBranch: string
    size: number
    remoteUrl: string
    sshUrl: string
    webUrl: string
    isDisabled: boolean
    isInMaintenance: boolean
}

export interface GetRepositoryDTO {
    count: number
    value: RepositoryData[]
}

export interface AzureDevOpsItem {
    objectId: string
    path: string
    content?: string
}

export interface AzurePushFileEditRequest {
    branchName: string
    baseCommitId: string
    filePath: string
    content: string
    comment: string
    /** "edit" replaces an existing file, "add" creates it. Defaults to "edit". */
    changeType?: "edit" | "add"
}

export interface AzureDevOpsBranch {
    name: string
    objectId: string
    creator: {
        displayName: string
        uniqueName: string
        _links: {
            avatar: { href: string }
        }
    }
    url: string
}

/** The repository answered, without the branch: told apart from a repository the token cannot reach */
export class AzureBranchNotFoundError extends Error {
    constructor(branchName: string) {
        super(`Branch ${branchName} not found`)
        this.name = "AzureBranchNotFoundError"
    }
}

export interface AzureDevOpsBranchDTO {
    count: number
    value: AzureDevOpsBranch[]
}

export interface AzureDevOpsPipeline {
    id: number
    name: string
    folder: string
    revision: number
    _links: {
        self: { href: string }
        web: { href: string }
    }
    url: string
}

export interface CreatePipelineRequest {
    name: string
    folder?: string
    configuration: {
        type: "yaml"
        path: string
        repository: {
            id: string
            type: "azureReposGit"
        }
    }
}

export interface AzureVariableGroup {
    id: number
    name: string
    description?: string
    type: string
    variables: Record<string, { value: string; isSecret?: boolean }>
}

export interface AzureVariableGroupsResponse {
    count: number
    value: AzureVariableGroup[]
}

export interface CheckOrganizationSecretExistsParams {
    accessToken: string
    organization: string
    projectId: string
    secretName: string
    variableGroupName: string
}

export interface UpsertOrganizationSecretParams {
    accessToken: string
    organization: string
    projectId: string
    projectName: string
    secretName: string
    value: string
    variableGroupName: string
    variableGroupDescription: string
}

export interface AzureDevOpsBuild {
    id: number
    buildNumber?: string
    /** none | notStarted | inProgress | completed | cancelling | postponed */
    status?: string
    /** Only meaningful once `status` is `completed`. */
    result?: string
    /** Fully qualified ref, e.g. `refs/tags/1.2.0`. */
    sourceBranch?: string
    sourceVersion?: string
    queueTime?: string
    startTime?: string
    finishTime?: string
    definition?: { name?: string }
    requestedFor?: { displayName?: string }
    _links?: { web?: { href?: string } }
}

export interface AzureDevOpsBuildsResponse {
    count: number
    value: AzureDevOpsBuild[]
}

class AzureDevOpsClient {
    /**
     * Every request of the client. Azure DevOps answers a token it does not take, expired or short of a scope,
     * with 203 and the HTML of its sign-in page rather than with 401, and axios takes any 2xx for a success:
     * a 203, or an HTML page where an API answer was expected, is turned into the 401 a refused token gets,
     * so that the callers handle both alike. A plain-text answer, such as a log, is not HTML and passes.
     *
     * Any `text/html` answer is taken for the sign-in page, whatever the endpoint: a method that downloads the
     * raw content of an item, an HTML file of a repository say, must ask for `$format=json` (as getFileContent
     * does) or an Accept that is not HTML, or call axios on its own, or that file reads as a refused token.
     */
    private async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
        const response = await axios.request<T>(config)
        const contentType = String(response.headers?.["content-type"] ?? "")
        if (response.status === 203 || contentType.includes("text/html")) {
            const message = "Azure DevOps answered with its sign-in page: the token is invalid, expired or lacks a scope"
            // The sign-in page is left out: callers pass the data of the answer on as the reason
            throw new AxiosError(message, AxiosError.ERR_BAD_RESPONSE, response.config, response.request, { ...response, status: 401, statusText: "Unauthorized", data: { message } })
        }
        return response
    }

    /**
     * Every page of a listing: Azure DevOps cuts some listings into pages, the projects at 100 each, and tells
     * that more follow with the `x-ms-continuationtoken` header, to be sent back as `continuationToken`.
     */
    private async listAllPages<T>(
        config: AxiosRequestConfig,
        send: (config: AxiosRequestConfig) => Promise<AxiosResponse<{ value?: T[] }>> = pageConfig => this.request(pageConfig)
    ): Promise<{ count: number; value: T[] }> {
        const value: T[] = []
        let continuationToken: string | undefined

        for (let page = 1; page <= maxContinuationPages; page++) {
            const response = await send(continuationToken ? { ...config, params: { ...config.params, continuationToken } } : config)
            value.push(...(response.data?.value ?? []))

            const next = response.headers?.["x-ms-continuationtoken"]
            if (!next) break
            continuationToken = String(next)
        }

        return { count: value.length, value }
    }

    // Ottieni l'ID utente dal profilo
    async getUserId(token: string) {
        const response = await this.request<{ id: string }>({
            url: "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.3",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })
        return response.data.id // userId
    }

    // Ottieni tutte le orgs dell'utente
    async getOrganizations(token: string) {
        const userId = await this.getUserId(token)
        const url = `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${userId}&api-version=7.1-preview.1`

        const response = await this.request<{ value: AzureOrganization[] }>({
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })
        return response.data.value // array di orgs
    }

    async getProjects(token: string, organization: string): Promise<AzureDevOpsProjectsResponse> {
        const url = `https://dev.azure.com/${organization}/_apis/projects?api-version=7.1-preview.4`
        return this.listAllPages<AzureDevOpsProject>({
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })
    }

    async getRepositories(token: string, organization: string, project: string): Promise<GetRepositoryDTO> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories?api-version=7.1-preview.1`
        const response = await this.request<GetRepositoryDTO>({
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })
        return response.data
    }

    async createRepository(token: string, organization: string, project: string, repositoryName: string): Promise<RepositoryData> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories?api-version=7.1-preview.1`
        const body = {
            name: repositoryName,
            project: {
                id: project
            }
        }

        const response = await this.request<RepositoryData>({
            method: "POST",
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            data: body
        })

        return response.data
    }

    async getRepository(token: string, organization: string, project: string, repositoryName: string) {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryName}?api-version=7.1-preview.1`
        const response = await this.request<RepositoryData>({
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })

        return response.data
    }

    async renameRepository(token: string, organization: string, project: string, repositoryId: string, newName: string): Promise<RepositoryData> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}?api-version=7.1-preview.1`
        const response = await this.request<RepositoryData>({
            method: "PATCH",
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            data: { name: newName }
        })

        return response.data
    }

    async getBranches(token: string, organization: string, project: string, repositoryName: string): Promise<AzureDevOpsBranchDTO> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryName}/refs?filter=heads/&api-version=7.1-preview.1`
        const response = await this.request<AzureDevOpsBranchDTO>({
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })
        return response.data
    }

    /**
     * The most recent builds produced from a repository, newest queued first.
     *
     * `repositoryType=TfsGit` is mandatory whenever `repositoryId` is passed: Azure
     * rejects the filter otherwise, since the same id can belong to a GitHub or
     * Bitbucket connection.
     */
    async getBuilds(token: string, organization: string, project: string, repositoryId: string, top: number): Promise<AzureDevOpsBuild[]> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/build/builds?repositoryId=${encodeURIComponent(repositoryId)}&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=${top}&api-version=7.1`
        const response = await this.request<AzureDevOpsBuildsResponse>({
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })

        return response.data?.value || []
    }

    /**
     * Plain-text logs of the failed tasks of a build of the repository `repositoryId`.
     *
     * A build id is unique across the whole Azure DevOps project, not per repository: the build is read
     * first, and one of another repository is refused, or any number would read the builds of the others.
     * Azure keeps one log per timeline record: the timeline says which records failed and which log each one wrote.
     * The logs come back in task order; only when every log failed is the failure of the first task passed on.
     */
    async getFailedJobLogs(token: string, organization: string, project: string, repositoryId: string, buildId: string): Promise<BuildJobLogDTO[]> {
        const headers = { Authorization: `Bearer ${token}` }
        const baseUrl = `https://dev.azure.com/${organization}/${project}/_apis/build/builds/${encodeURIComponent(buildId)}`

        const build = await this.request<{ repository?: { id?: string } }>({ url: `${baseUrl}?api-version=7.1`, headers })
        if (build.data?.repository?.id !== repositoryId) {
            throw new Error(`Build ${buildId} is not a build of this repository`)
        }

        const timeline = await this.request<{ records?: { name: string; type: string; result?: string; log?: { id: number } }[] }>({
            url: `${baseUrl}/timeline?api-version=7.1`,
            headers
        })
        const failedRecords = (timeline.data?.records || []).filter(record => record.type === "Task" && record.result === "failed" && record.log?.id !== undefined).slice(0, MAX_FAILED_JOBS)

        // A log that cannot be read, or is too large, is left out rather than losing the others
        const results = await Promise.allSettled(
            failedRecords.map(async record => {
                const log = await this.request<string>({
                    url: `${baseUrl}/logs/${record.log?.id}?api-version=7.1`,
                    headers: { ...headers, Accept: "text/plain" },
                    responseType: "text",
                    maxContentLength: MAX_FAILED_JOB_LOG_BYTES
                })
                return { name: record.name, log: log.data }
            })
        )

        results.forEach((result, index) => {
            // The name and the message only: the error carries the request, token included
            if (result.status === "rejected")
                console.warn(`Could not download the log of the failed task ${failedRecords[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        })

        const logs = results.flatMap(result => (result.status === "fulfilled" ? [result.value] : []))
        const firstFailure = results.find(result => result.status === "rejected")
        if (logs.length === 0 && firstFailure) throw firstFailure.reason
        return logs
    }

    async getBranchCommitId(token: string, organization: string, project: string, repositoryName: string, branchName: string): Promise<string> {
        const response = await this.request<AzureDevOpsBranchDTO>({
            url: `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryName}/refs`,
            params: { filter: `heads/${branchName}`, "api-version": "7.1-preview.1" },
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })

        // The filter matches every branch that starts with the name: release finds release-2 too
        const branch = (response.data.value ?? []).find(ref => ref.name === `refs/heads/${branchName}`)
        if (!branch) {
            throw new AzureBranchNotFoundError(branchName)
        }

        return branch.objectId
    }

    async createPipeline(
        token: string,
        organization: string,
        project: string,
        repositoryId: string,
        pipelineName: string,
        yamlPath: string = "azure-pipelines.yml",
        folder: string = "/"
    ): Promise<AzureDevOpsPipeline> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/pipelines?api-version=7.1-preview.1`

        const body: CreatePipelineRequest = {
            name: pipelineName,
            folder: folder,
            configuration: {
                type: "yaml",
                path: yamlPath,
                repository: {
                    id: repositoryId,
                    type: "azureReposGit"
                }
            }
        }

        const response = await this.request<AzureDevOpsPipeline>({
            method: "POST",
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            data: body
        })

        return response.data
    }

    /**
     * Lets the pipeline `pipelineId` use the variable group `variableGroupName`: a YAML pipeline naming a group
     * it is not authorized for stops at its first run until someone permits it by hand. Only that pipeline, not
     * every pipeline of the project: the group holds the deploy key. False when the project has no such group.
     */
    async authorizePipelineVariableGroup(token: string, organization: string, projectId: string, variableGroupName: string, pipelineId: number): Promise<boolean> {
        const groups = await this.getVariableGroups(token, organization, projectId)
        const variableGroup = groups.value.find(g => g.name === variableGroupName)
        if (!variableGroup) return false

        await this.request({
            method: "PATCH",
            url: `https://dev.azure.com/${organization}/${projectId}/_apis/pipelines/pipelinePermissions/variablegroup/${variableGroup.id}?api-version=7.1-preview.1`,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            data: { pipelines: [{ id: pipelineId, authorized: true }] }
        })
        return true
    }

    /**
     * Get all variable groups for a project
     */
    async getVariableGroups(token: string, organization: string, projectId: string): Promise<AzureVariableGroupsResponse> {
        const url = `https://dev.azure.com/${organization}/${projectId}/_apis/distributedtask/variablegroups?api-version=7.1-preview.2`
        return this.listAllPages<AzureVariableGroup>(
            {
                url,
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                }
            },
            pageConfig => this.variableGroupsRequest(pageConfig)
        )
    }

    /**
     * Azure answers 401 (or 403) when the token lacks the Variable Groups scope, even though it
     * reaches the projects: told apart here, or the user only sees a bare "status code 401".
     */
    private async variableGroupsRequest<T>(config: AxiosRequestConfig) {
        try {
            return await this.request<T>(config)
        } catch (error) {
            if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
                throw createBusinessException({
                    code: AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED,
                    message: "The personal access token cannot manage the project's variable groups: it needs the Variable Groups (Read, create & manage) scope"
                })
            }
            throw error
        }
    }

    /**
     * Check if a secret exists in the organization's variable group
     */
    async checkOrganizationSecretExists({ accessToken, organization, projectId, secretName, variableGroupName }: CheckOrganizationSecretExistsParams): Promise<boolean> {
        const variableGroup = await this.getVariableGroups(accessToken, organization, projectId)
        const existingGroup = variableGroup.value.find(g => g.name === variableGroupName)

        if (existingGroup) {
            return secretName in existingGroup.variables
        }

        return false
    }

    /**
     * Create or update a secret in the organization's variable group
     */
    async upsertOrganizationSecret({
        accessToken,
        organization,
        projectId,
        projectName,
        secretName,
        value,
        variableGroupName,
        variableGroupDescription
    }: UpsertOrganizationSecretParams): Promise<void> {
        // Get or create the variable group
        const groups = await this.getVariableGroups(accessToken, organization, projectId)
        const variableGroup = groups.value.find(g => g.name === variableGroupName)

        if (!variableGroup) {
            // Create new variable group with the secret
            await this.variableGroupsRequest<AzureVariableGroup>({
                method: "POST",
                url: `https://dev.azure.com/${organization}/${projectId}/_apis/distributedtask/variablegroups?api-version=7.1`,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                },
                data: {
                    name: variableGroupName,
                    description: variableGroupDescription,
                    type: "Vsts",
                    variables: {
                        [secretName]: {
                            value,
                            isSecret: true
                        }
                    },
                    variableGroupProjectReferences: [
                        {
                            name: variableGroupName,
                            projectReference: {
                                id: projectId,
                                name: projectName
                            }
                        }
                    ],
                    providerData: {
                        isShared: false,
                        isAuthorizationRequired: false
                    }
                }
            })
            return
        }

        // Update the existing variable group with the new secret
        await this.variableGroupsRequest({
            method: "PUT",
            url: `https://dev.azure.com/${organization}/${projectId}/_apis/distributedtask/variablegroups/${variableGroup.id}?api-version=7.1-preview.2`,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            data: {
                ...variableGroup,
                variables: {
                    ...variableGroup.variables,
                    [secretName]: {
                        value: value,
                        isSecret: true
                    }
                },
                variableGroupProjectReferences: [
                    {
                        name: variableGroupName,
                        projectReference: {
                            id: projectId,
                            name: projectName
                        }
                    }
                ],
                providerData: {
                    isShared: false,
                    isAuthorizationRequired: false
                }
            }
        })
    }

    /** Whether the repository has the tag. The filter matches every ref that starts with it: only the exact name counts */
    async tagExists(token: string, organization: string, project: string, repositoryId: string, tagName: string): Promise<boolean> {
        const response = await this.request<AzureDevOpsBranchDTO>({
            url: `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}/refs`,
            params: { filter: `tags/${tagName}`, "api-version": "7.1-preview.1" },
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })
        return (response.data.value ?? []).some(ref => ref.name === `refs/tags/${tagName}`)
    }

    /** The commit the tag points to, undefined without the tag: an annotated tag is peeled to its commit */
    async getTagCommitId(token: string, organization: string, project: string, repositoryId: string, tagName: string): Promise<string | undefined> {
        const response = await this.request<{ value?: { name: string; objectId: string; peeledObjectId?: string }[] }>({
            url: `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}/refs`,
            params: { filter: `tags/${tagName}`, peelTags: true, "api-version": "7.1-preview.1" },
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        })
        const tag = (response.data.value ?? []).find(ref => ref.name === `refs/tags/${tagName}`)
        return tag && (tag.peeledObjectId || tag.objectId)
    }

    /** Azure DevOps answers 200 even when it refuses the ref: the refusal is told in `success` and `updateStatus` */
    async createTag(token: string, organization: string, project: string, repositoryId: string, tagName: string, objectId: string): Promise<void> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}/refs?api-version=7.1-preview.1`

        const response = await this.request<{ value?: AzureDevOpsRefUpdateResult[] }>({
            method: "POST",
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            data: [
                {
                    name: `refs/tags/${tagName}`,
                    oldObjectId: "0000000000000000000000000000000000000000",
                    newObjectId: objectId
                }
            ]
        })

        const refused = (response.data.value ?? []).find(result => !result.success)
        if (refused) {
            throw createBusinessException({
                code: AZURE_DEVOPS_TAG_REFUSED,
                message: `Azure DevOps refused the tag ${tagName}: ${refused.customMessage || refused.updateStatus || "no reason given"}`
            })
        }
    }

    /**
     * Reads a text file from a repository. Returns null when the file does not exist on the branch.
     */
    async getFileContent(token: string, organization: string, project: string, repositoryId: string, filePath: string, branchName: string): Promise<string | null> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}/items?api-version=7.1-preview.1`

        try {
            const response = await this.request<AzureDevOpsItem>({
                url,
                params: {
                    path: filePath.startsWith("/") ? filePath : `/${filePath}`,
                    includeContent: true,
                    "versionDescriptor.version": branchName,
                    "versionDescriptor.versionType": "branch",
                    $format: "json"
                },
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json"
                }
            })

            return response.data?.content ?? null
        } catch (error) {
            if (axios.isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 400)) {
                return null
            }
            throw error
        }
    }

    /** Opens a pull request and returns its web URL. */
    async createPullRequest(
        token: string,
        organization: string,
        project: string,
        repositoryId: string,
        request: { sourceBranch: string; targetBranch: string; title: string; description: string }
    ): Promise<string> {
        const response = await this.request<{ pullRequestId: number; repository: { name: string; project: { name: string } } }>({
            method: "POST",
            url: `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}/pullrequests?api-version=7.1`,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            data: {
                sourceRefName: `refs/heads/${request.sourceBranch}`,
                targetRefName: `refs/heads/${request.targetBranch}`,
                title: request.title,
                // Azure DevOps caps the description at 4000 characters.
                description: request.description.slice(0, 4000)
            }
        })
        const { pullRequestId, repository } = response.data
        return `https://dev.azure.com/${organization}/${encodeURIComponent(repository.project.name)}/_git/${encodeURIComponent(repository.name)}/pullrequest/${pullRequestId}`
    }

    /**
     * Pushes a single file change, an edit by default or an addition when `changeType` says so.
     * When `branchName` does not exist yet, Azure DevOps creates it from `baseCommitId` as part
     * of the push.
     */
    async pushFileEdit(token: string, organization: string, project: string, repositoryId: string, request: AzurePushFileEditRequest): Promise<void> {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}/pushes?api-version=7.1-preview.2`

        await this.request({
            method: "POST",
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            data: {
                refUpdates: [
                    {
                        name: `refs/heads/${request.branchName}`,
                        oldObjectId: request.baseCommitId
                    }
                ],
                commits: [
                    {
                        comment: request.comment,
                        changes: [
                            {
                                changeType: request.changeType || "edit",
                                item: {
                                    path: request.filePath.startsWith("/") ? request.filePath : `/${request.filePath}`
                                },
                                newContent: {
                                    content: request.content,
                                    contentType: "rawtext"
                                }
                            }
                        ]
                    }
                ]
            }
        })
    }
}

export default AzureDevOpsClient
