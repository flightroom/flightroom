import axios from "axios"
import sodium from "libsodium-wrappers"
import { CodeRepositoryType } from "../models/CodeRepositoryModel"
import { BuildJobLogDTO, MAX_FAILED_JOB_LOG_BYTES, MAX_FAILED_JOBS } from "../types/BuildStatusDTO"

/** Safety net so a misbehaving pagination cursor cannot turn a repository or branch listing into an endless loop. */
const maxRepositoryPages = 50

/** Callers read manifests and config files: a file larger than this is refused rather than downloaded. */
export const MAX_FILE_CONTENT_BYTES = 10 * 1024 * 1024

export interface GithubAccessTokenResponse {
    access_token: string
    scope: string
    token_type: string
    error?: string
    error_description?: string
    error_uri?: string
}

export interface GithubAccessTokenRquest {
    client_id: string
    client_secret: string
    code: string
}

export interface GithubUser {
    login: string
    id: number
    node_id: string
    avatar_url: string
    gravatar_id: string
    url: string
    html_url: string
    followers_url: string
    following_url: string
    gists_url: string
    starred_url: string
    subscriptions_url: string
    organizations_url: string
    repos_url: string
    events_url: string
    received_events_url: string
    type: string
    site_admin: boolean
    name: string
    company: string | null
    blog: string
    location: string | null
    email: string | null
    hireable: boolean | null
    bio: string | null
    twitter_username: string | null
    public_repos: number
    public_gists: number
    followers: number
    following: number
    created_at: string
    updated_at: string
}

export interface GithubOrganization {
    login: string
    id: number
    node_id: string
    url: string
    repos_url: string
    events_url: string
    hooks_url: string
    issues_url: string
    members_url: string
    public_members_url: string
    avatar_url: string
    description: string | null
    gravatar_id: string
    name: string | null
    company: string | null
    blog: string
    location: string | null
    email: string | null
    twitter_username: string | null
    is_verified: boolean
    has_organization_projects: boolean
    has_repository_projects: boolean
    public_repos: number
    public_gists: number
    followers: number
    following: number
    html_url: string
    created_at: string
    updated_at: string
    type: string
}

export interface CreateRepositoryRequest {
    name: string
    description?: string
    homepage?: string
    private?: boolean
    has_issues?: boolean
    has_projects?: boolean
    has_wiki?: boolean
    is_template?: boolean
    team_id?: number
    auto_init?: boolean
    gitignore_template?: string
    license_template?: string
    allow_squash_merge?: boolean
    allow_merge_commit?: boolean
    allow_rebase_merge?: boolean
    allow_auto_merge?: boolean
    delete_branch_on_merge?: boolean
    has_downloads?: boolean
    visibility?: "public" | "private" | "internal"
}

export interface GithubRepository {
    id: number
    node_id: string
    name: string
    full_name: string
    owner: {
        login: string
        id: number
        avatar_url: string
        type: string
    }
    private: boolean
    html_url: string
    description: string | null
    fork: boolean
    url: string
    clone_url: string
    ssh_url: string
    svn_url: string
    homepage: string | null
    size: number
    stargazers_count: number
    watchers_count: number
    language: string | null
    has_issues: boolean
    has_projects: boolean
    has_wiki: boolean
    has_pages: boolean
    forks_count: number
    archived: boolean
    disabled: boolean
    open_issues_count: number
    license: {
        key: string
        name: string
        spdx_id: string
        url: string
    } | null
    allow_forking: boolean
    is_template: boolean
    topics: string[]
    visibility: string
    forks: number
    open_issues: number
    watchers: number
    default_branch: string
    created_at: string
    updated_at: string
}

export interface CreateBuildRequest {
    version?: string
    type?: CodeRepositoryType
    owner: string
    repositoryName: string
    ref?: string
    inputs?: Record<string, unknown>
    workflowId?: string
}

export interface GithubWorkflowDispatchResponse {
    message?: string
}

export interface GithubWorkflowRun {
    id: number
    name?: string | null
    display_title?: string
    /** For a run started by a tag push this holds the tag name, not a branch. */
    head_branch?: string | null
    head_sha: string
    status?: string | null
    conclusion?: string | null
    html_url: string
    event?: string
    run_started_at?: string
    created_at: string
    updated_at: string
    actor?: { login?: string }
}

export interface GithubWorkflowRunsResponse {
    total_count: number
    workflow_runs: GithubWorkflowRun[]
}

export interface GithubBranch {
    name: string
    commit: {
        sha: string
        url: string
    }
}

export interface GithubPublicKey {
    key_id: string
    key: string
}

export interface GithubSecret {
    name: string
    created_at: string
    updated_at: string
}

export interface GithubSecretsListResponse {
    total_count: number
    secrets: GithubSecret[]
}

export interface GithubBaseDTO {
    accessToken: string
    orgName?: string
    userName?: string
}

export interface GithubRepositoryBaseDTO extends GithubBaseDTO {
    repositoryName: string
}

export interface GithubUpsertSecretDTO extends GithubRepositoryBaseDTO {
    secretName: string
    value: string
}

export interface GithubOrganizationSecretDTO extends GithubBaseDTO {
    secretName: string
    value: string
    visibility?: "all" | "private" | "selected"
    selectedRepositoryIds?: number[]
}

export interface GithubFileDTO extends GithubRepositoryBaseDTO {
    path: string
    ref?: string
}

export interface GithubCreateBranchDTO extends GithubRepositoryBaseDTO {
    branchName: string
    sha: string
}

export interface GithubUpdateFileDTO extends GithubRepositoryBaseDTO {
    path: string
    content: string
    message: string
    branch: string
    /** Sha of the blob being replaced. Leave it out to create the file. */
    sha?: string
}

export interface GithubFileContent {
    content: string
    sha: string
}

interface GithubContentsResponse {
    type?: string
    encoding?: string
    content?: string
    size?: number
    sha: string
}

class GithubClient {
    async encryptValueForSecret(key: string, secret: string): Promise<string> {
        await sodium.ready

        // Convert the secret and key to a Uint8Array.
        const binkey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL)
        const binsec = sodium.from_string(secret)

        // Encrypt the secret using libsodium
        const encBytes = sodium.crypto_box_seal(binsec, binkey)

        // Convert the encrypted Uint8Array to Base64
        const output = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL)

        // Print the output
        return output
    }

    async getAccessToken(data: GithubAccessTokenRquest): Promise<GithubAccessTokenResponse> {
        const responseGithub = await axios.request<GithubAccessTokenResponse>({
            method: "POST",
            url: "https://github.com/login/oauth/access_token",
            headers: {
                Accept: "application/json"
            },
            data
        })

        if (responseGithub.data.error) {
            throw new Error(responseGithub.data.error_description)
        }

        return responseGithub.data
    }

    /**
     * Revoca il grant dell'OAuth App per l'utente proprietario del token.
     * Dopo la revoca GitHub ripropone sempre la pagina di autorizzazione
     * (inclusi i bottoni "Grant" per le organizzazioni) al prossimo authorize.
     */
    async revokeApplicationGrant(clientId: string, clientSecret: string, accessToken: string): Promise<void> {
        try {
            await axios.request({
                method: "DELETE",
                url: `https://api.github.com/applications/${clientId}/grant`,
                auth: {
                    username: clientId,
                    password: clientSecret
                },
                headers: {
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Flightroom"
                },
                data: {
                    access_token: accessToken
                }
            })
        } catch (error: unknown) {
            if (error && typeof error === "object" && "response" in error) {
                const err = error as { response?: { status?: number } }
                // 404/422: token già revocato o non più valido — il grant non esiste, che è l'obiettivo
                if (err.response?.status === 404 || err.response?.status === 422) {
                    return
                }
            }
            throw error
        }
    }

    async getUser(accessToken: string): Promise<GithubUser> {
        const response = await axios.request<GithubUser>({
            url: "https://api.github.com/user",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data
    }

    /** Every repository endpoint, its secrets included, lives under /repos/{owner}: the organization when there is one, the user otherwise */
    private getRepositoryBaseUrlBase(repositoryName: string, orgName?: string, userName?: string) {
        return `https://api.github.com/repos/${orgName || userName}/${repositoryName}`
    }

    async getRepositoryPublicKey({ accessToken, orgName, userName, repositoryName }: GithubRepositoryBaseDTO): Promise<GithubPublicKey> {
        const url = `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/actions/secrets/public-key`

        const response = await axios.request<GithubPublicKey>({
            url,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data
    }

    async getOrganizationPublicKey({ accessToken, orgName }: GithubBaseDTO): Promise<GithubPublicKey> {
        if (!orgName) {
            throw new Error("Organization name is required")
        }

        const url = `https://api.github.com/orgs/${orgName}/actions/secrets/public-key`

        const response = await axios.request<GithubPublicKey>({
            url,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data
    }

    async upsertRepositorySecret({ accessToken, orgName, userName, repositoryName, secretName, value }: GithubUpsertSecretDTO): Promise<void> {
        const { key, key_id } = await this.getRepositoryPublicKey({
            accessToken,
            orgName,
            userName,
            repositoryName
        })

        const url = `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/actions/secrets/${encodeURIComponent(secretName)}`

        await axios.request<void>({
            method: "PUT",
            url,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data: {
                encrypted_value: await this.encryptValueForSecret(key, value),
                key_id
            }
        })
    }

    async checkRepositorySecretExists({ accessToken, orgName, userName, repositoryName, secretName }: Omit<GithubUpsertSecretDTO, "value">): Promise<boolean> {
        try {
            const url = `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/actions/secrets/${encodeURIComponent(secretName)}`

            await axios.request({
                method: "GET",
                url,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Flightroom"
                }
            })

            return true
        } catch (error: unknown) {
            if (error && typeof error === "object" && "response" in error) {
                const err = error as { response?: { status?: number } }
                if (err.response?.status === 404) {
                    return false
                }
            }
            throw error
        }
    }

    async upsertOrganizationSecret({ accessToken, orgName, secretName, value, visibility = "private", selectedRepositoryIds }: GithubOrganizationSecretDTO): Promise<void> {
        if (!orgName) {
            throw new Error("Organization name is required")
        }

        const { key_id, key } = await this.getOrganizationPublicKey({
            accessToken,
            orgName
        })

        const url = `https://api.github.com/orgs/${orgName}/actions/secrets/${encodeURIComponent(secretName)}`

        const data: {
            encrypted_value: string
            key_id: string
            visibility: string
            selected_repository_ids?: number[]
        } = {
            encrypted_value: await this.encryptValueForSecret(key, value),
            key_id: key_id,
            visibility
        }

        // Se la visibilità è 'selected', aggiungi gli ID dei repository selezionati
        if (visibility === "selected" && selectedRepositoryIds && selectedRepositoryIds.length > 0) {
            data.selected_repository_ids = selectedRepositoryIds
        }

        await axios.request<void>({
            method: "PUT",
            url,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data
        })
    }

    async checkOrganizationSecretExists({ accessToken, orgName, secretName }: Omit<GithubOrganizationSecretDTO, "value" | "visibility" | "selectedRepositoryIds">): Promise<boolean> {
        if (!orgName) {
            throw new Error("Organization name is required")
        }

        try {
            const url = `https://api.github.com/orgs/${orgName}/actions/secrets/${encodeURIComponent(secretName)}`

            await axios.request({
                method: "GET",
                url,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Flightroom"
                }
            })

            return true
        } catch (error: unknown) {
            if (error && typeof error === "object" && "response" in error) {
                const err = error as { response?: { status?: number } }
                if (err.response?.status === 404) {
                    return false
                }
            }
            throw error
        }
    }

    async getOrganization(orgName: string, accessToken: string): Promise<GithubOrganization> {
        const response = await axios.request<GithubOrganization>({
            url: `https://api.github.com/orgs/${orgName}`,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data
    }

    async getUserOrganizations(accessToken: string): Promise<GithubOrganization[]> {
        const response = await axios.request<GithubOrganization[]>({
            url: "https://api.github.com/user/orgs",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data
    }

    async createRepository(repositoryData: CreateRepositoryRequest, accessToken: string, orgName?: string): Promise<GithubRepository> {
        const url = orgName ? `https://api.github.com/orgs/${orgName}/repos` : "https://api.github.com/user/repos"

        const response = await axios.request<GithubRepository>({
            method: "POST",
            url,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data: repositoryData
        })

        return response.data
    }

    async getBranches(accessToken: string, repositoryName: string, orgName?: string, userName?: string): Promise<GithubBranch[]> {
        const perPage = 100
        const branches: GithubBranch[] = []

        // GitHub paginates this endpoint, so every page is walked: the branch picker needs every branch.
        for (let page = 1; page <= maxRepositoryPages; page++) {
            const response = await axios.request<GithubBranch[]>({
                url: `https://api.github.com/repos/${orgName || userName}/${repositoryName}/branches`,
                params: { per_page: perPage, page },
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Flightroom"
                }
            })

            branches.push(...response.data)

            if (response.data.length < perPage) break
        }

        return branches
    }

    async getRepositories(accessToken: string, orgName?: string): Promise<GithubRepository[]> {
        const url = orgName ? `https://api.github.com/orgs/${orgName}/repos` : "https://api.github.com/user/repos"
        const perPage = 100
        const repositories: GithubRepository[] = []

        // GitHub paginates this endpoint, so every page is walked: callers need the complete list of repositories.
        for (let page = 1; page <= maxRepositoryPages; page++) {
            const response = await axios.request<GithubRepository[]>({
                url,
                params: { per_page: perPage, page },
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Flightroom"
                }
            })

            repositories.push(...response.data)

            if (response.data.length < perPage) break
        }

        return repositories
    }

    async createBuild(buildData: CreateBuildRequest, accessToken: string): Promise<GithubWorkflowDispatchResponse> {
        const { workflowId = "build-and-deploy.yml" } = buildData

        const response = await axios.request<GithubWorkflowDispatchResponse>({
            url: `https://api.github.com/repos/${buildData.owner}/${buildData.repositoryName}/actions/workflows/${workflowId}/dispatches`,
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data: {
                ref: buildData.ref || "main",
                inputs: {
                    version: buildData.version || "${{github.ref_name}}",
                    ...buildData.inputs
                }
            }
        })

        return response.data || {}
    }

    /**
     * The most recent Actions runs of a repository, newest first.
     *
     * Only the first page is read: the build screen shows a handful of runs per
     * frontend and this endpoint is polled, so walking the pagination would
     * burn the token's rate limit for rows nobody looks at.
     */
    async getWorkflowRuns(accessToken: string, repositoryName: string, perPage: number, orgName?: string, userName?: string): Promise<GithubWorkflowRun[]> {
        const response = await axios.request<GithubWorkflowRunsResponse>({
            url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/actions/runs`,
            params: { per_page: perPage },
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data?.workflow_runs || []
    }

    /**
     * Plain-text logs of the jobs of a run that did not succeed.
     *
     * The logs endpoint answers with a redirect to a short-lived download URL on
     * another host; axios follows it and drops the Authorization header on the way,
     * which is what that URL expects.
     */
    async getFailedJobLogs(accessToken: string, repositoryName: string, runId: string, orgName?: string, userName?: string): Promise<BuildJobLogDTO[]> {
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Flightroom"
        }
        const baseUrl = this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)

        const jobsResponse = await axios.request<{ jobs?: { id: number; name: string; conclusion?: string | null }[] }>({
            url: `${baseUrl}/actions/runs/${encodeURIComponent(runId)}/jobs`,
            params: { per_page: 100 },
            headers
        })
        const failedJobs = (jobsResponse.data?.jobs || []).filter(job => job.conclusion === "failure" || job.conclusion === "timed_out").slice(0, MAX_FAILED_JOBS)

        const downloads = await Promise.allSettled(
            failedJobs.map(async job => {
                const logResponse = await axios.request<string>({
                    url: `${baseUrl}/actions/jobs/${job.id}/logs`,
                    headers,
                    responseType: "text",
                    maxContentLength: MAX_FAILED_JOB_LOG_BYTES
                })
                return { name: job.name, log: logResponse.data }
            })
        )

        // One log that cannot be downloaded (gone, or over the size cap) must not hide the others: only when none came back is it an error
        downloads.forEach((download, index) => {
            // The job name and the message only: the error itself carries the request, token included
            if (download.status === "rejected")
                console.warn(`Could not download the log of GitHub job ${failedJobs[index].name}: ${download.reason instanceof Error ? download.reason.message : String(download.reason)}`)
        })
        const logs = downloads.flatMap(download => (download.status === "fulfilled" ? [download.value] : []))
        const firstFailure = downloads.find(download => download.status === "rejected")
        if (logs.length === 0 && firstFailure) throw firstFailure.reason

        return logs
    }

    /** The branch is one path segment, encoded as Octokit does: release/1.4 is read as release%2F1.4 */
    async getBranchCommitSha(accessToken: string, repositoryName: string, branchName: string, orgName?: string, userName?: string): Promise<string> {
        const response = await axios.request<GithubBranch>({
            url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/branches/${encodeURIComponent(branchName)}`,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data.commit.sha
    }

    /** Whether the repository has the tag: the single ref endpoint matches the exact name, and answers 404 without it */
    async tagExists(accessToken: string, repositoryName: string, tag: string, orgName?: string, userName?: string): Promise<boolean> {
        try {
            const response = await axios.request({
                url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/git/ref/tags/${encodeURIComponent(tag)}`,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Flightroom"
                }
            })
            // A list answers the refs that only start with the name: none of them is the tag
            return !Array.isArray(response.data)
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                return false
            }
            throw error
        }
    }

    /** The commit the tag points to, undefined without the tag: an annotated tag is followed to its commit */
    async getTagCommitSha(accessToken: string, repositoryName: string, tag: string, orgName?: string, userName?: string): Promise<string | undefined> {
        const base = this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)
        const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github.v3+json", "User-Agent": "Flightroom" }
        try {
            const response = await axios.request<{ object: { sha: string; type: string } }>({ url: `${base}/git/ref/tags/${encodeURIComponent(tag)}`, headers })
            // A list answers the refs that only start with the name: none of them is the tag
            if (Array.isArray(response.data)) return undefined
            const { sha, type } = response.data.object
            if (type !== "tag") return sha
            const annotated = await axios.request<{ object: { sha: string } }>({ url: `${base}/git/tags/${sha}`, headers })
            return annotated.data.object.sha
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                return undefined
            }
            throw error
        }
    }

    async createTag(accessToken: string, repositoryName: string, tag: string, sha: string, orgName?: string, userName?: string): Promise<void> {
        const response = await axios.request({
            method: "POST",
            url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/git/refs`,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data: {
                ref: `refs/tags/${tag}`,
                sha: sha
            }
        })

        return response.data
    }

    async getRepository({ accessToken, orgName, userName, repositoryName }: GithubRepositoryBaseDTO): Promise<GithubRepository> {
        const response = await axios.request<GithubRepository>({
            url: this.getRepositoryBaseUrlBase(repositoryName, orgName, userName),
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            }
        })

        return response.data
    }

    async renameRepository({ accessToken, orgName, userName, repositoryName, newName }: GithubRepositoryBaseDTO & { newName: string }): Promise<GithubRepository> {
        const response = await axios.request<GithubRepository>({
            method: "PATCH",
            url: this.getRepositoryBaseUrlBase(repositoryName, orgName, userName),
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data: { name: newName }
        })

        return response.data
    }

    /**
     * Reads a text file from a repository. Returns null when the file does not exist on the
     * given ref, so callers can treat a missing package.json as "nothing to analyse".
     */
    async getFileContent({ accessToken, orgName, userName, repositoryName, path, ref }: GithubFileDTO): Promise<GithubFileContent | null> {
        const url = `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`
        const params = ref ? { ref } : undefined
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "Flightroom"
        }

        try {
            const response = await axios.request<GithubContentsResponse>({ url, params, headers })

            if (Array.isArray(response.data) || response.data.type !== "file" || response.data.content === undefined) {
                return null
            }

            // Over 1 MB the JSON answer leaves the content out (encoding "none"): the blob of its sha still serves it raw,
            // so the content cannot come from a newer commit than the sha. Neither case may return null: that reads as
            // a missing file, and a write after it would try to create it again.
            if (response.data.encoding === "none") {
                if ((response.data.size ?? 0) > MAX_FILE_CONTENT_BYTES) {
                    throw new Error(`${path} is larger than ${MAX_FILE_CONTENT_BYTES} bytes`)
                }
                const raw = await axios.request<string>({
                    url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/git/blobs/${response.data.sha}`,
                    headers: { ...headers, Accept: "application/vnd.github.raw+json" },
                    responseType: "text",
                    maxContentLength: MAX_FILE_CONTENT_BYTES
                })
                return { content: raw.data, sha: response.data.sha }
            }

            return {
                content: Buffer.from(response.data.content, (response.data.encoding as BufferEncoding) || "base64").toString("utf8"),
                sha: response.data.sha
            }
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                return null
            }
            throw error
        }
    }

    /**
     * Creates a branch pointing at `sha`. Returns false when the branch already exists.
     */
    async createBranch({ accessToken, orgName, userName, repositoryName, branchName, sha }: GithubCreateBranchDTO): Promise<boolean> {
        try {
            await axios.request({
                method: "POST",
                url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/git/refs`,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Flightroom"
                },
                data: {
                    ref: `refs/heads/${branchName}`,
                    sha
                }
            })

            return true
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 422) {
                return false
            }
            throw error
        }
    }

    /** Opens a pull request and returns its web URL. */
    async createPullRequest({
        accessToken,
        orgName,
        userName,
        repositoryName,
        head,
        base,
        title,
        body
    }: {
        accessToken: string
        orgName?: string
        userName?: string
        repositoryName: string
        head: string
        base: string
        title: string
        body: string
    }): Promise<string> {
        const response = await axios.request<{ html_url: string }>({
            method: "POST",
            url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/pulls`,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data: { head, base, title, body }
        })
        return response.data.html_url
    }

    async updateFileContent({ accessToken, orgName, userName, repositoryName, path, content, message, branch, sha }: GithubUpdateFileDTO): Promise<void> {
        await axios.request({
            method: "PUT",
            url: `${this.getRepositoryBaseUrlBase(repositoryName, orgName, userName)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Flightroom"
            },
            data: {
                message,
                content: Buffer.from(content, "utf8").toString("base64"),
                branch,
                sha
            }
        })
    }
}

export default GithubClient
