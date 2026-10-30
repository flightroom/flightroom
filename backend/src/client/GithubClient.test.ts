import axios, { AxiosError, AxiosHeaders } from "axios"
import sodium from "libsodium-wrappers"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { MAX_FAILED_JOB_LOG_BYTES, MAX_FAILED_JOBS } from "../types/BuildStatusDTO"
import GithubClient from "./GithubClient"

const answered = (status: number, headers: Record<string, string> = {}) =>
    new AxiosError("Request failed", String(status), undefined, undefined, {
        status,
        statusText: "",
        data: {},
        headers,
        config: { headers: new AxiosHeaders() }
    })

/** A request that never got an answer: DNS, a reset connection, a timeout */
const unanswered = () => new AxiosError("Network Error", AxiosError.ERR_NETWORK)

/** GitHub refuses a token over its rate limit with a 403 whose headers say the quota is spent */
const rateLimited = () => answered(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" })

const api = "https://api.github.com"
const token = "gho_fake"
const githubHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Flightroom"
}

const stubRequest = () => vi.spyOn(axios, "request")

/** The config of the n-th request the client sent */
const sent = (request: ReturnType<typeof stubRequest>, call = 0) => request.mock.calls[call][0]

/** The body of the n-th request the client sent */
const sentBody = (request: ReturnType<typeof stubRequest>, call = 0) => sent(request, call).data as Record<string, string | undefined>

let keyPair: { publicKey: Uint8Array; privateKey: Uint8Array }
let publicKey: string

/** Opens a sealed box with the private half of the test key pair, as GitHub does on its side */
const opened = (encrypted: string) => sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL), keyPair.publicKey, keyPair.privateKey))

beforeAll(async () => {
    await sodium.ready
    keyPair = sodium.crypto_box_keypair()
    publicKey = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("GithubClient.encryptValueForSecret", () => {
    it("given a repository public key, when a value is encrypted, then only the private key opens it back to the value", async () => {
        const encrypted = await new GithubClient().encryptValueForSecret(publicKey, "s3cr3t-value")

        expect(encrypted).not.toContain("s3cr3t-value")
        expect(opened(encrypted)).toBe("s3cr3t-value")
    })
})

describe("GithubClient.getAccessToken", () => {
    const exchange = { client_id: "client", client_secret: "client-secret", code: "oauth-code" }

    it("given an OAuth code, when it is exchanged, then it is posted to the GitHub login endpoint asking for JSON", async () => {
        const request = stubRequest().mockResolvedValue({ data: { access_token: "gho_new", scope: "repo", token_type: "bearer" } })

        await new GithubClient().getAccessToken(exchange)

        expect(sent(request)).toEqual({
            method: "POST",
            url: "https://github.com/login/oauth/access_token",
            headers: { Accept: "application/json" },
            data: exchange
        })
    })

    it("given GitHub grants the token, when the code is exchanged, then the token payload comes back", async () => {
        stubRequest().mockResolvedValue({ data: { access_token: "gho_new", scope: "repo", token_type: "bearer" } })

        await expect(new GithubClient().getAccessToken(exchange)).resolves.toEqual({ access_token: "gho_new", scope: "repo", token_type: "bearer" })
    })

    /** The endpoint answers 200 with an error field when the code is expired or already used */
    it("given GitHub answers an error payload, when the code is exchanged, then its description is thrown", async () => {
        stubRequest().mockResolvedValue({ data: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } })

        await expect(new GithubClient().getAccessToken(exchange)).rejects.toThrow("The code passed is incorrect or expired.")
    })

    it("given the request fails, when the code is exchanged, then the failure is passed on", async () => {
        const failure = answered(500)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().getAccessToken(exchange)).rejects.toBe(failure)
    })
})

describe("GithubClient.revokeApplicationGrant", () => {
    it("given a token, when the grant is revoked, then a DELETE authenticated with the app credentials carries the token", async () => {
        const request = stubRequest().mockResolvedValue({ status: 204, data: "" })

        await expect(new GithubClient().revokeApplicationGrant("client", "client-secret", "gho_old")).resolves.toBeUndefined()
        expect(sent(request)).toEqual({
            method: "DELETE",
            url: `${api}/applications/client/grant`,
            auth: { username: "client", password: "client-secret" },
            headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Flightroom" },
            data: { access_token: "gho_old" }
        })
    })

    /** The grant is already gone, which is what the revocation wanted */
    it.each([404, 422])("given GitHub answers %i, when the grant is revoked, then it succeeds", async status => {
        stubRequest().mockRejectedValue(answered(status))

        await expect(new GithubClient().revokeApplicationGrant("client", "client-secret", "gho_old")).resolves.toBeUndefined()
    })

    it.each([
        ["an answer of 500", answered(500)],
        ["the rate limit", rateLimited()],
        ["a network error", unanswered()],
        ["a non-HTTP failure", new Error("boom")]
    ])("given %s, when the grant is revoked, then the failure is passed on", async (_, failure) => {
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().revokeApplicationGrant("client", "client-secret", "gho_old")).rejects.toBe(failure)
    })
})

describe("GithubClient.getUser", () => {
    it("given a token, when the user is read, then the authenticated user endpoint is called with the bearer token", async () => {
        const request = stubRequest().mockResolvedValue({ data: { login: "octocat", id: 1 } })

        await expect(new GithubClient().getUser(token)).resolves.toEqual({ login: "octocat", id: 1 })
        expect(sent(request)).toEqual({ url: `${api}/user`, headers: githubHeaders })
    })

    it("given a revoked token, when the user is read, then the 401 is passed on", async () => {
        const failure = answered(401)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().getUser(token)).rejects.toBe(failure)
    })
})

describe("GithubClient.getOrganization", () => {
    it("given an organization name, when it is read, then its endpoint answers the organization", async () => {
        const request = stubRequest().mockResolvedValue({ data: { login: "acme", id: 7 } })

        await expect(new GithubClient().getOrganization("acme", token)).resolves.toEqual({ login: "acme", id: 7 })
        expect(sent(request)).toEqual({ url: `${api}/orgs/acme`, headers: githubHeaders })
    })

    it("given an unknown organization, when it is read, then the 404 is passed on", async () => {
        const failure = answered(404)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().getOrganization("ghost", token)).rejects.toBe(failure)
    })
})

describe("GithubClient.getUserOrganizations", () => {
    it("given a token, when the organizations are listed, then the organizations of the user come back", async () => {
        const request = stubRequest().mockResolvedValue({ data: [{ login: "acme" }, { login: "globex" }] })

        await expect(new GithubClient().getUserOrganizations(token)).resolves.toEqual([{ login: "acme" }, { login: "globex" }])
        expect(sent(request)).toEqual({ url: `${api}/user/orgs`, headers: githubHeaders })
    })
})

describe("GithubClient.getRepositoryPublicKey", () => {
    it("given a user repository, when its public key is read, then the actions secrets key of the repository comes back", async () => {
        const request = stubRequest().mockResolvedValue({ data: { key_id: "kid", key: publicKey } })

        await expect(new GithubClient().getRepositoryPublicKey({ accessToken: token, userName: "octocat", repositoryName: "cart-fe" })).resolves.toEqual({ key_id: "kid", key: publicKey })
        expect(sent(request)).toEqual({ url: `${api}/repos/octocat/cart-fe/actions/secrets/public-key`, headers: githubHeaders })
    })

    /** Repository secrets live under /repos/{owner}: GitHub has no /orgs/{org}/repos/{repo}/actions endpoint */
    it("given an organization repository, when its public key is read, then the repository is read under the organization as its owner", async () => {
        const request = stubRequest().mockResolvedValue({ data: { key_id: "kid", key: publicKey } })

        await new GithubClient().getRepositoryPublicKey({ accessToken: token, orgName: "acme", userName: "octocat", repositoryName: "cart-fe" })

        expect(sent(request).url).toBe(`${api}/repos/acme/cart-fe/actions/secrets/public-key`)
    })
})

describe("GithubClient.getOrganizationPublicKey", () => {
    it("given an organization, when its public key is read, then the organization actions secrets key comes back", async () => {
        const request = stubRequest().mockResolvedValue({ data: { key_id: "kid", key: publicKey } })

        await expect(new GithubClient().getOrganizationPublicKey({ accessToken: token, orgName: "acme" })).resolves.toEqual({ key_id: "kid", key: publicKey })
        expect(sent(request)).toEqual({ url: `${api}/orgs/acme/actions/secrets/public-key`, headers: githubHeaders })
    })

    it("given no organization name, when the public key is read, then it is refused without calling GitHub", async () => {
        const request = stubRequest()

        await expect(new GithubClient().getOrganizationPublicKey({ accessToken: token })).rejects.toThrow("Organization name is required")
        expect(request).not.toHaveBeenCalled()
    })
})

describe("GithubClient.upsertRepositorySecret", () => {
    const secret = { accessToken: token, userName: "octocat", repositoryName: "cart-fe", secretName: "DEPLOY/KEY", value: "api-key-value" }

    it("given a secret, when it is stored, then the repository key is read first and the value is PUT sealed with it", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: { key_id: "kid", key: publicKey } })
            .mockResolvedValueOnce({ status: 201, data: "" })

        await expect(new GithubClient().upsertRepositorySecret(secret)).resolves.toBeUndefined()

        expect(request).toHaveBeenCalledTimes(2)
        expect(sent(request, 0)).toEqual({ url: `${api}/repos/octocat/cart-fe/actions/secrets/public-key`, headers: githubHeaders })
        const put = sent(request, 1)
        expect(put).toEqual({
            method: "PUT",
            url: `${api}/repos/octocat/cart-fe/actions/secrets/DEPLOY%2FKEY`,
            headers: githubHeaders,
            data: { encrypted_value: expect.any(String), key_id: "kid" }
        })
        expect(opened(String(sentBody(request, 1).encrypted_value))).toBe("api-key-value")
    })

    it("given an organization repository, when the secret is stored, then the key and the secret are both under the organization as the owner", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: { key_id: "kid", key: publicKey } })
            .mockResolvedValueOnce({ status: 201, data: "" })

        await new GithubClient().upsertRepositorySecret({ ...secret, orgName: "acme" })

        expect(sent(request, 0).url).toBe(`${api}/repos/acme/cart-fe/actions/secrets/public-key`)
        expect(sent(request, 1).url).toBe(`${api}/repos/acme/cart-fe/actions/secrets/DEPLOY%2FKEY`)
    })

    it("given the public key cannot be read, when the secret is stored, then nothing is written and the failure is passed on", async () => {
        const failure = answered(403)
        const request = stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().upsertRepositorySecret(secret)).rejects.toBe(failure)
        expect(request).toHaveBeenCalledTimes(1)
    })
})

describe("GithubClient.checkRepositorySecretExists", () => {
    const secret = { accessToken: token, userName: "octocat", repositoryName: "cart-fe", secretName: "DEPLOY KEY" }

    it("given the secret is there, when it is checked, then it exists, read by its encoded name", async () => {
        const request = stubRequest().mockResolvedValue({ data: { name: "DEPLOY KEY" } })

        await expect(new GithubClient().checkRepositorySecretExists(secret)).resolves.toBe(true)
        expect(sent(request)).toEqual({ method: "GET", url: `${api}/repos/octocat/cart-fe/actions/secrets/DEPLOY%20KEY`, headers: githubHeaders })
    })

    it("given an organization repository, when the secret is checked, then it is read under the organization as the owner", async () => {
        const request = stubRequest().mockResolvedValue({ data: { name: "DEPLOY KEY" } })

        await new GithubClient().checkRepositorySecretExists({ ...secret, orgName: "acme" })

        expect(sent(request).url).toBe(`${api}/repos/acme/cart-fe/actions/secrets/DEPLOY%20KEY`)
    })

    it("given GitHub answers 404, when the secret is checked, then it does not exist", async () => {
        stubRequest().mockRejectedValue(answered(404))

        await expect(new GithubClient().checkRepositorySecretExists(secret)).resolves.toBe(false)
    })

    it.each([
        ["an answer of 403", answered(403)],
        ["the rate limit", rateLimited()],
        ["a network error", unanswered()],
        ["a non-HTTP failure", new Error("boom")]
    ])("given %s, when the secret is checked, then the failure is passed on", async (_, failure) => {
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().checkRepositorySecretExists(secret)).rejects.toBe(failure)
    })
})

describe("GithubClient.upsertOrganizationSecret", () => {
    const secret = { accessToken: token, orgName: "acme", secretName: "NPM_TOKEN", value: "npm-value" }

    const stubKeyThenPut = () =>
        stubRequest()
            .mockResolvedValueOnce({ data: { key_id: "org-kid", key: publicKey } })
            .mockResolvedValueOnce({ status: 204, data: "" })

    it("given no visibility, when the secret is stored, then it is private and sealed with the organization key", async () => {
        const request = stubKeyThenPut()

        await expect(new GithubClient().upsertOrganizationSecret(secret)).resolves.toBeUndefined()

        expect(sent(request, 0)).toEqual({ url: `${api}/orgs/acme/actions/secrets/public-key`, headers: githubHeaders })
        const put = sent(request, 1)
        expect(put).toEqual({
            method: "PUT",
            url: `${api}/orgs/acme/actions/secrets/NPM_TOKEN`,
            headers: githubHeaders,
            data: { encrypted_value: expect.any(String), key_id: "org-kid", visibility: "private" }
        })
        expect(opened(String(sentBody(request, 1).encrypted_value))).toBe("npm-value")
    })

    it("given selected visibility and repositories, when the secret is stored, then the repositories are sent with it", async () => {
        const request = stubKeyThenPut()

        await new GithubClient().upsertOrganizationSecret({ ...secret, visibility: "selected", selectedRepositoryIds: [11, 12] })

        expect(sent(request, 1).data).toEqual({ encrypted_value: expect.any(String), key_id: "org-kid", visibility: "selected", selected_repository_ids: [11, 12] })
    })

    it("given selected visibility and no repositories, when the secret is stored, then no repository list is sent", async () => {
        const request = stubKeyThenPut()

        await new GithubClient().upsertOrganizationSecret({ ...secret, visibility: "selected", selectedRepositoryIds: [] })

        expect(sent(request, 1).data).not.toHaveProperty("selected_repository_ids")
    })

    it("given a visibility other than selected, when the secret is stored, then the repository list is ignored", async () => {
        const request = stubKeyThenPut()

        await new GithubClient().upsertOrganizationSecret({ ...secret, visibility: "all", selectedRepositoryIds: [11] })

        expect(sent(request, 1).data).toEqual({ encrypted_value: expect.any(String), key_id: "org-kid", visibility: "all" })
    })

    it("given no organization name, when the secret is stored, then it is refused without calling GitHub", async () => {
        const request = stubRequest()

        await expect(new GithubClient().upsertOrganizationSecret({ ...secret, orgName: undefined })).rejects.toThrow("Organization name is required")
        expect(request).not.toHaveBeenCalled()
    })
})

describe("GithubClient.checkOrganizationSecretExists", () => {
    const secret = { accessToken: token, orgName: "acme", secretName: "NPM TOKEN" }

    it("given the secret is there, when it is checked, then it exists, read by its encoded name", async () => {
        const request = stubRequest().mockResolvedValue({ data: { name: "NPM TOKEN" } })

        await expect(new GithubClient().checkOrganizationSecretExists(secret)).resolves.toBe(true)
        expect(sent(request)).toEqual({ method: "GET", url: `${api}/orgs/acme/actions/secrets/NPM%20TOKEN`, headers: githubHeaders })
    })

    it("given GitHub answers 404, when the secret is checked, then it does not exist", async () => {
        stubRequest().mockRejectedValue(answered(404))

        await expect(new GithubClient().checkOrganizationSecretExists(secret)).resolves.toBe(false)
    })

    it.each([
        ["an answer of 500", answered(500)],
        ["a network error", unanswered()],
        ["a non-HTTP failure", new Error("boom")]
    ])("given %s, when the secret is checked, then the failure is passed on", async (_, failure) => {
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().checkOrganizationSecretExists(secret)).rejects.toBe(failure)
    })

    it("given no organization name, when the secret is checked, then it is refused without calling GitHub", async () => {
        const request = stubRequest()

        await expect(new GithubClient().checkOrganizationSecretExists({ ...secret, orgName: undefined })).rejects.toThrow("Organization name is required")
        expect(request).not.toHaveBeenCalled()
    })
})

describe("GithubClient.createRepository", () => {
    const repository = { name: "cart-fe", private: true, auto_init: true }

    it("given an organization, when a repository is created, then it is posted to the organization repositories", async () => {
        const request = stubRequest().mockResolvedValue({ data: { id: 1, name: "cart-fe", full_name: "acme/cart-fe" } })

        await expect(new GithubClient().createRepository(repository, token, "acme")).resolves.toEqual({ id: 1, name: "cart-fe", full_name: "acme/cart-fe" })
        expect(sent(request)).toEqual({ method: "POST", url: `${api}/orgs/acme/repos`, headers: githubHeaders, data: repository })
    })

    it("given no organization, when a repository is created, then it is posted to the repositories of the user", async () => {
        const request = stubRequest().mockResolvedValue({ data: { id: 1 } })

        await new GithubClient().createRepository(repository, token)

        expect(sent(request)).toMatchObject({ method: "POST", url: `${api}/user/repos` })
    })

    it("given the name is taken, when a repository is created, then the 422 is passed on", async () => {
        const failure = answered(422)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().createRepository(repository, token, "acme")).rejects.toBe(failure)
    })
})

describe("GithubClient.getBranches", () => {
    it("given an organization, when the branches are listed, then the branches of its repository come back", async () => {
        const request = stubRequest().mockResolvedValue({ data: [{ name: "main", commit: { sha: "a", url: "u" } }] })

        await expect(new GithubClient().getBranches(token, "cart-fe", "acme", "octocat")).resolves.toEqual([{ name: "main", commit: { sha: "a", url: "u" } }])
        expect(sent(request)).toMatchObject({ url: `${api}/repos/acme/cart-fe/branches`, headers: githubHeaders, params: expect.objectContaining({ per_page: 100 }) })
    })

    it("given only a user, when the branches are listed, then the repository of the user is read", async () => {
        const request = stubRequest().mockResolvedValue({ data: [] })

        await expect(new GithubClient().getBranches(token, "cart-fe", undefined, "octocat")).resolves.toEqual([])
        expect(sent(request)).toMatchObject({ url: `${api}/repos/octocat/cart-fe/branches` })
    })

    const branches = (size: number, from = 0) => Array.from({ length: size }, (_, index) => ({ name: `branch-${from + index}`, commit: { sha: "a", url: "u" } }))

    it("given several pages, when the branches are listed, then every page is walked in order and joined", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: branches(100) })
            .mockResolvedValueOnce({ data: branches(100, 100) })
            .mockResolvedValueOnce({ data: branches(5, 200) })

        await expect(new GithubClient().getBranches(token, "cart-fe", "acme")).resolves.toEqual(branches(205))
        expect(request.mock.calls.map(([config]) => config.params)).toEqual([
            { per_page: 100, page: 1 },
            { per_page: 100, page: 2 },
            { per_page: 100, page: 3 }
        ])
        expect(request.mock.calls.every(([config]) => config.url === `${api}/repos/acme/cart-fe/branches`)).toBe(true)
    })

    /** A cursor that never ends would otherwise loop forever */
    it("given every page comes back full, when the branches are listed, then the walk stops after 50 pages", async () => {
        const request = stubRequest().mockResolvedValue({ data: branches(100) })

        await expect(new GithubClient().getBranches(token, "cart-fe", "acme")).resolves.toHaveLength(5000)
        expect(request).toHaveBeenCalledTimes(50)
    })
})

describe("GithubClient.getRepositories", () => {
    const page = (size: number, from = 0) => Array.from({ length: size }, (_, index) => ({ id: from + index }))

    it("given fewer repositories than a page, when they are listed, then one request for page 1 is enough", async () => {
        const request = stubRequest().mockResolvedValue({ data: page(3) })

        await expect(new GithubClient().getRepositories(token)).resolves.toEqual(page(3))
        expect(request).toHaveBeenCalledTimes(1)
        expect(sent(request)).toEqual({ url: `${api}/user/repos`, params: { per_page: 100, page: 1 }, headers: githubHeaders })
    })

    it("given several pages, when the repositories are listed, then every page is walked in order and joined", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: page(100) })
            .mockResolvedValueOnce({ data: page(100, 100) })
            .mockResolvedValueOnce({ data: page(5, 200) })

        const repositories = await new GithubClient().getRepositories(token, "acme")

        expect(repositories).toEqual(page(205))
        expect(request.mock.calls.map(([config]) => config.params)).toEqual([
            { per_page: 100, page: 1 },
            { per_page: 100, page: 2 },
            { per_page: 100, page: 3 }
        ])
        expect(request.mock.calls.every(([config]) => config.url === `${api}/orgs/acme/repos`)).toBe(true)
    })

    it("given an exact multiple of a page, when the repositories are listed, then the empty page after the last one ends the walk", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: page(100) })
            .mockResolvedValueOnce({ data: [] })

        await expect(new GithubClient().getRepositories(token)).resolves.toHaveLength(100)
        expect(request).toHaveBeenCalledTimes(2)
    })

    it("given no repositories, when they are listed, then the list is empty", async () => {
        stubRequest().mockResolvedValue({ data: [] })

        await expect(new GithubClient().getRepositories(token)).resolves.toEqual([])
    })

    /** A cursor that never ends would otherwise loop forever */
    it("given every page comes back full, when the repositories are listed, then the walk stops after 50 pages", async () => {
        const request = stubRequest().mockResolvedValue({ data: page(100) })

        await expect(new GithubClient().getRepositories(token)).resolves.toHaveLength(5000)
        expect(request).toHaveBeenCalledTimes(50)
        expect(sent(request, 49).params).toEqual({ per_page: 100, page: 50 })
    })

    it("given the rate limit is hit on a later page, when the repositories are listed, then the failure is passed on and no partial list comes back", async () => {
        const failure = rateLimited()
        const request = stubRequest()
            .mockResolvedValueOnce({ data: page(100) })
            .mockRejectedValueOnce(failure)

        await expect(new GithubClient().getRepositories(token)).rejects.toBe(failure)
        expect(request).toHaveBeenCalledTimes(2)
    })
})

describe("GithubClient.createBuild", () => {
    it("given only the repository, when a build is dispatched, then the default workflow runs on main with the ref name as version", async () => {
        const request = stubRequest().mockResolvedValue({ status: 204, data: "" })

        await expect(new GithubClient().createBuild({ owner: "acme", repositoryName: "cart-fe" }, token)).resolves.toEqual({})
        expect(sent(request)).toEqual({
            url: `${api}/repos/acme/cart-fe/actions/workflows/build-and-deploy.yml/dispatches`,
            method: "POST",
            headers: githubHeaders,
            data: { ref: "main", inputs: { version: "${{github.ref_name}}" } }
        })
    })

    it("given a workflow, a ref, a version and inputs, when a build is dispatched, then they are all sent", async () => {
        const request = stubRequest().mockResolvedValue({ data: { message: "queued" } })

        const dispatched = new GithubClient().createBuild(
            { owner: "acme", repositoryName: "cart-fe", workflowId: "release.yml", ref: "develop", version: "1.4.0", inputs: { environment: "staging" } },
            token
        )

        await expect(dispatched).resolves.toEqual({ message: "queued" })
        expect(sent(request)).toMatchObject({
            url: `${api}/repos/acme/cart-fe/actions/workflows/release.yml/dispatches`,
            data: { ref: "develop", inputs: { version: "1.4.0", environment: "staging" } }
        })
    })

    it("given the workflow does not exist, when a build is dispatched, then the 404 is passed on", async () => {
        const failure = answered(404)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().createBuild({ owner: "acme", repositoryName: "cart-fe" }, token)).rejects.toBe(failure)
    })
})

describe("GithubClient.getWorkflowRuns", () => {
    it("given an organization repository, when its runs are read, then one page of the requested size is asked for", async () => {
        const runs = [{ id: 2, head_sha: "b", html_url: "h", created_at: "c", updated_at: "u" }]
        const request = stubRequest().mockResolvedValue({ data: { total_count: 40, workflow_runs: runs } })

        await expect(new GithubClient().getWorkflowRuns(token, "cart-fe", 10, "acme", "octocat")).resolves.toEqual(runs)
        expect(request).toHaveBeenCalledTimes(1)
        expect(sent(request)).toEqual({ url: `${api}/repos/acme/cart-fe/actions/runs`, params: { per_page: 10 }, headers: githubHeaders })
    })

    it("given only a user, when the runs are read, then the repository of the user is read", async () => {
        const request = stubRequest().mockResolvedValue({ data: { total_count: 0, workflow_runs: [] } })

        await expect(new GithubClient().getWorkflowRuns(token, "cart-fe", 5, undefined, "octocat")).resolves.toEqual([])
        expect(sent(request)).toMatchObject({ url: `${api}/repos/octocat/cart-fe/actions/runs` })
    })

    it.each([[{}], [""]])("given an answer without runs (%j), when the runs are read, then the list is empty", async data => {
        stubRequest().mockResolvedValue({ data })

        await expect(new GithubClient().getWorkflowRuns(token, "cart-fe", 5, "acme")).resolves.toEqual([])
    })
})

describe("GithubClient.getFailedJobLogs", () => {
    const job = (id: number, conclusion: string | null) => ({ id, name: `job-${id}`, conclusion })

    it("given a run, when its failed jobs are read, then the jobs of the run are listed by its encoded id", async () => {
        const request = stubRequest().mockResolvedValue({ data: { jobs: [] } })

        await expect(new GithubClient().getFailedJobLogs(token, "cart-fe", "41/2", "acme")).resolves.toEqual([])
        expect(sent(request)).toEqual({ url: `${api}/repos/acme/cart-fe/actions/runs/41%2F2/jobs`, params: { per_page: 100 }, headers: githubHeaders })
    })

    it("given failed, timed out and passing jobs, when the logs are read, then only the failed and timed out ones are downloaded as text", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: { jobs: [job(1, "success"), job(2, "failure"), job(3, "cancelled"), job(4, "timed_out"), job(5, null)] } })
            .mockResolvedValueOnce({ data: "error TS2322" })
            .mockResolvedValueOnce({ data: "timed out after 360 minutes" })

        const logs = await new GithubClient().getFailedJobLogs(token, "cart-fe", "41", undefined, "octocat")

        expect(logs).toEqual([
            { name: "job-2", log: "error TS2322" },
            { name: "job-4", log: "timed out after 360 minutes" }
        ])
        expect(request).toHaveBeenCalledTimes(3)
        expect(sent(request, 1)).toEqual({
            url: `${api}/repos/octocat/cart-fe/actions/jobs/2/logs`,
            headers: githubHeaders,
            responseType: "text",
            maxContentLength: MAX_FAILED_JOB_LOG_BYTES
        })
        expect(sent(request, 2).url).toBe(`${api}/repos/octocat/cart-fe/actions/jobs/4/logs`)
    })

    it("given more failed jobs than the cap, when the logs are read, then only the first ones are downloaded", async () => {
        const jobs = Array.from({ length: MAX_FAILED_JOBS + 2 }, (_, index) => job(index + 1, "failure"))
        const request = stubRequest().mockResolvedValueOnce({ data: { jobs } }).mockResolvedValue({ data: "log" })

        await expect(new GithubClient().getFailedJobLogs(token, "cart-fe", "41", "acme")).resolves.toHaveLength(MAX_FAILED_JOBS)
        expect(request).toHaveBeenCalledTimes(1 + MAX_FAILED_JOBS)
    })

    it("given an answer without jobs, when the logs are read, then there is nothing to download", async () => {
        const request = stubRequest().mockResolvedValue({ data: {} })

        await expect(new GithubClient().getFailedJobLogs(token, "cart-fe", "41", "acme")).resolves.toEqual([])
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("given the run cannot be read, when the logs are read, then the failure is passed on", async () => {
        const failure = answered(404)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().getFailedJobLogs(token, "cart-fe", "41", "acme")).rejects.toBe(failure)
    })
})

describe("GithubClient.tagExists", () => {
    it("given the tag, when it is looked up, then it exists, read by its exact ref", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { ref: "refs/tags/1.2.0", object: { sha: "a" } } })

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2.0", undefined, "acme")).resolves.toBe(true)
        expect(request.mock.calls[0][0]).toMatchObject({ url: "https://api.github.com/repos/acme/cart-fe/git/ref/tags/1.2.0" })
    })

    it("given a token, when the tag is looked up, then the request carries the GitHub headers", async () => {
        const request = stubRequest().mockResolvedValue({ data: { ref: "refs/tags/1.2.0" } })

        await new GithubClient().tagExists(token, "cart-fe", "1.2.0", "acme")

        expect(sent(request)).toEqual({ url: `${api}/repos/acme/cart-fe/git/ref/tags/1.2.0`, headers: githubHeaders })
    })

    /** An answer in a list holds the refs that only start with the name */
    it("given GitHub answers a list of refs, when the tag is looked up, then it does not exist", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: [{ ref: "refs/tags/1.2.0" }, { ref: "refs/tags/1.2.0-rc" }] })

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2", undefined, "acme")).resolves.toBe(false)
    })

    it("given GitHub answers 404, when the tag is looked up, then it does not exist", async () => {
        vi.spyOn(axios, "request").mockRejectedValue(answered(404))

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2.0", "acme")).resolves.toBe(false)
    })

    it("given any other failure, when the tag is looked up, then it is passed on", async () => {
        const failure = answered(401)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2.0", "acme")).rejects.toBe(failure)
    })

    it("given a network error, when the tag is looked up, then it is passed on rather than read as a missing tag", async () => {
        const failure = unanswered()
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().tagExists(token, "cart-fe", "1.2.0", "acme")).rejects.toBe(failure)
    })
})

describe("GithubClient.getTagCommitSha", () => {
    it("given a lightweight tag, when its commit is read, then the sha it points to comes back with one request", async () => {
        const request = stubRequest().mockResolvedValue({ data: { ref: "refs/tags/1.2.0", object: { sha: "commit-sha", type: "commit" } } })

        await expect(new GithubClient().getTagCommitSha(token, "cart-fe", "1.2.0", "acme")).resolves.toBe("commit-sha")
        expect(request).toHaveBeenCalledTimes(1)
        expect(sent(request)).toEqual({ url: `${api}/repos/acme/cart-fe/git/ref/tags/1.2.0`, headers: githubHeaders })
    })

    it("given an annotated tag, when its commit is read, then the tag object is followed to its commit", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: { object: { sha: "tag-object-sha", type: "tag" } } })
            .mockResolvedValueOnce({ data: { object: { sha: "commit-sha", type: "commit" } } })

        await expect(new GithubClient().getTagCommitSha(token, "cart-fe", "1.2.0", undefined, "octocat")).resolves.toBe("commit-sha")
        expect(sent(request, 1)).toEqual({ url: `${api}/repos/octocat/cart-fe/git/tags/tag-object-sha`, headers: githubHeaders })
    })

    it("given a tag with a slash, when its commit is read, then the name is one encoded path segment", async () => {
        const request = stubRequest().mockResolvedValue({ data: { object: { sha: "commit-sha", type: "commit" } } })

        await new GithubClient().getTagCommitSha(token, "cart-fe", "release/1.4", "acme")

        expect(sent(request).url).toBe(`${api}/repos/acme/cart-fe/git/ref/tags/release%2F1.4`)
    })

    it("given GitHub answers a list of refs, when the commit is read, then there is no tag", async () => {
        const request = stubRequest().mockResolvedValue({ data: [{ ref: "refs/tags/1.2.0" }] })

        await expect(new GithubClient().getTagCommitSha(token, "cart-fe", "1.2", "acme")).resolves.toBeUndefined()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("given GitHub answers 404, when the commit is read, then there is no tag", async () => {
        stubRequest().mockRejectedValue(answered(404))

        await expect(new GithubClient().getTagCommitSha(token, "cart-fe", "1.2.0", "acme")).resolves.toBeUndefined()
    })

    it.each([
        ["an answer of 500", answered(500)],
        ["the rate limit", rateLimited()],
        ["a network error", unanswered()]
    ])("given %s, when the commit is read, then the failure is passed on", async (_, failure) => {
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().getTagCommitSha(token, "cart-fe", "1.2.0", "acme")).rejects.toBe(failure)
    })
})

describe("GithubClient.createTag", () => {
    it("given a commit, when a tag is created, then a tag ref pointing at it is posted", async () => {
        const request = stubRequest().mockResolvedValue({ status: 201, data: { ref: "refs/tags/1.2.0" } })

        await new GithubClient().createTag(token, "cart-fe", "1.2.0", "commit-sha", "acme")

        expect(sent(request)).toEqual({
            method: "POST",
            url: `${api}/repos/acme/cart-fe/git/refs`,
            headers: githubHeaders,
            data: { ref: "refs/tags/1.2.0", sha: "commit-sha" }
        })
    })

    it("given the tag already exists, when it is created, then the 422 is passed on", async () => {
        const failure = answered(422)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().createTag(token, "cart-fe", "1.2.0", "commit-sha", undefined, "octocat")).rejects.toBe(failure)
    })
})

describe("GithubClient.getBranchCommitSha", () => {
    it("given a branch with a slash, when its commit is read, then the name is one encoded path segment", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { commit: { sha: "abc" } } })

        await expect(new GithubClient().getBranchCommitSha("token", "cart-fe", "release/1.4", undefined, "acme")).resolves.toBe("abc")
        expect(request.mock.calls[0][0]).toMatchObject({ url: "https://api.github.com/repos/acme/cart-fe/branches/release%2F1.4" })
    })

    it("given an organization and a user, when the commit is read, then the organization owns the repository", async () => {
        const request = stubRequest().mockResolvedValue({ data: { commit: { sha: "abc" } } })

        await new GithubClient().getBranchCommitSha(token, "cart-fe", "main", "acme", "octocat")

        expect(sent(request)).toEqual({ url: `${api}/repos/acme/cart-fe/branches/main`, headers: githubHeaders })
    })

    it("given the branch does not exist, when its commit is read, then the 404 is passed on", async () => {
        const failure = answered(404)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().getBranchCommitSha(token, "cart-fe", "gone", "acme")).rejects.toBe(failure)
    })
})

describe("GithubClient.getRepository", () => {
    it("given a repository, when it is read, then the repository endpoint answers it", async () => {
        const request = stubRequest().mockResolvedValue({ data: { id: 1, name: "cart-fe", default_branch: "main" } })

        await expect(new GithubClient().getRepository({ accessToken: token, orgName: "acme", repositoryName: "cart-fe" })).resolves.toEqual({ id: 1, name: "cart-fe", default_branch: "main" })
        expect(sent(request)).toEqual({ url: `${api}/repos/acme/cart-fe`, headers: githubHeaders })
    })
})

describe("GithubClient.renameRepository", () => {
    it("given a new name, when the repository is renamed, then the new name is patched and the renamed repository comes back", async () => {
        const request = stubRequest().mockResolvedValue({ data: { id: 1, name: "checkout-fe" } })

        const renamed = new GithubClient().renameRepository({ accessToken: token, userName: "octocat", repositoryName: "cart-fe", newName: "checkout-fe" })

        await expect(renamed).resolves.toEqual({ id: 1, name: "checkout-fe" })
        expect(sent(request)).toEqual({ method: "PATCH", url: `${api}/repos/octocat/cart-fe`, headers: githubHeaders, data: { name: "checkout-fe" } })
    })

    it("given the new name is taken, when the repository is renamed, then the 422 is passed on", async () => {
        const failure = answered(422)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().renameRepository({ accessToken: token, orgName: "acme", repositoryName: "cart-fe", newName: "taken" })).rejects.toBe(failure)
    })
})

describe("GithubClient.getFileContent", () => {
    const file = { accessToken: token, orgName: "acme", repositoryName: "cart-fe", path: "package.json" }
    const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

    it("given a file, when it is read, then its base64 content is decoded and its sha comes back", async () => {
        const request = stubRequest().mockResolvedValue({ data: { type: "file", encoding: "base64", content: base64('{"name":"cart"}'), sha: "blob-sha" } })

        await expect(new GithubClient().getFileContent(file)).resolves.toEqual({ content: '{"name":"cart"}', sha: "blob-sha" })
        expect(sent(request)).toEqual({ url: `${api}/repos/acme/cart-fe/contents/package.json`, params: undefined, headers: githubHeaders })
    })

    it("given a ref, when the file is read, then it is read on that ref", async () => {
        const request = stubRequest().mockResolvedValue({ data: { type: "file", encoding: "base64", content: base64("x"), sha: "s" } })

        await new GithubClient().getFileContent({ ...file, ref: "release/1.4" })

        expect(sent(request).params).toEqual({ ref: "release/1.4" })
    })

    it("given a nested path with a space, when the file is read, then the slashes stay and the space is encoded", async () => {
        const request = stubRequest().mockResolvedValue({ data: { type: "file", encoding: "base64", content: base64("x"), sha: "s" } })

        await new GithubClient().getFileContent({ ...file, path: "apps/web app/package.json" })

        expect(sent(request).url).toBe(`${api}/repos/acme/cart-fe/contents/apps/web%20app/package.json`)
    })

    /** Left as they are, # would cut the path into a fragment and ? into a query */
    it("given a path with a hash and a question mark, when the file is read, then each segment is encoded and the slashes stay", async () => {
        const request = stubRequest().mockResolvedValue({ data: { type: "file", encoding: "base64", content: base64("x"), sha: "s" } })

        await new GithubClient().getFileContent({ ...file, path: "docs/a b#c?.md" })

        expect(sent(request).url).toBe(`${api}/repos/acme/cart-fe/contents/docs/a%20b%23c%3F.md`)
    })

    /** Over 1 MB GitHub leaves the content out of the JSON answer: encoding "none" and an empty content */
    it("given a file over 1 MB, when it is read, then its raw content is downloaded and the sha of the first answer comes back", async () => {
        const request = stubRequest()
            .mockResolvedValueOnce({ data: { type: "file", encoding: "none", content: "", sha: "big-sha" } })
            .mockResolvedValueOnce({ data: '{"name":"big"}' })

        await expect(new GithubClient().getFileContent({ ...file, ref: "main" })).resolves.toEqual({ content: '{"name":"big"}', sha: "big-sha" })
        expect(request).toHaveBeenCalledTimes(2)
        expect(sent(request, 1)).toEqual({
            url: `${api}/repos/acme/cart-fe/contents/package.json`,
            params: { ref: "main" },
            headers: { ...githubHeaders, Accept: "application/vnd.github.raw+json" },
            responseType: "text"
        })
    })

    it("given an answer without encoding, when the file is read, then the content is read as base64", async () => {
        stubRequest().mockResolvedValue({ data: { type: "file", content: base64("plain"), sha: "s" } })

        await expect(new GithubClient().getFileContent(file)).resolves.toEqual({ content: "plain", sha: "s" })
    })

    it.each([
        ["a directory listing", [{ type: "file", name: "package.json" }]],
        ["a symlink", { type: "symlink", target: "../package.json", sha: "s" }],
        ["a submodule", { type: "submodule", sha: "s" }],
        ["a file without content", { type: "file", sha: "s" }]
    ])("given the path is %s, when it is read, then there is no file", async (_, data) => {
        stubRequest().mockResolvedValue({ data })

        await expect(new GithubClient().getFileContent(file)).resolves.toBeNull()
    })

    it("given GitHub answers 404, when the file is read, then there is no file", async () => {
        stubRequest().mockRejectedValue(answered(404))

        await expect(new GithubClient().getFileContent(file)).resolves.toBeNull()
    })

    it.each([
        ["an answer of 403", answered(403)],
        ["the rate limit", rateLimited()],
        ["a network error", unanswered()]
    ])("given %s, when the file is read, then the failure is passed on", async (_, failure) => {
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().getFileContent(file)).rejects.toBe(failure)
    })
})

describe("GithubClient.createBranch", () => {
    const branch = { accessToken: token, userName: "octocat", repositoryName: "cart-fe", branchName: "flightroom/change-1", sha: "base-sha" }

    it("given a new branch, when it is created, then a head ref pointing at the sha is posted", async () => {
        const request = stubRequest().mockResolvedValue({ status: 201, data: {} })

        await expect(new GithubClient().createBranch(branch)).resolves.toBe(true)
        expect(sent(request)).toEqual({
            method: "POST",
            url: `${api}/repos/octocat/cart-fe/git/refs`,
            headers: githubHeaders,
            data: { ref: "refs/heads/flightroom/change-1", sha: "base-sha" }
        })
    })

    it("given the branch already exists, when it is created, then GitHub's 422 is read as not created", async () => {
        stubRequest().mockRejectedValue(answered(422))

        await expect(new GithubClient().createBranch(branch)).resolves.toBe(false)
    })

    it.each([
        ["an answer of 404", answered(404)],
        ["a network error", unanswered()]
    ])("given %s, when the branch is created, then the failure is passed on", async (_, failure) => {
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().createBranch(branch)).rejects.toBe(failure)
    })
})

describe("GithubClient.createPullRequest", () => {
    const pullRequest = { accessToken: token, orgName: "acme", repositoryName: "cart-fe", head: "flightroom/change-1", base: "main", title: "Change", body: "Details" }

    it("given a head and a base, when a pull request is opened, then it is posted and its web URL comes back", async () => {
        const request = stubRequest().mockResolvedValue({ data: { number: 3, html_url: "https://github.com/acme/cart-fe/pull/3" } })

        await expect(new GithubClient().createPullRequest(pullRequest)).resolves.toBe("https://github.com/acme/cart-fe/pull/3")
        expect(sent(request)).toEqual({
            method: "POST",
            url: `${api}/repos/acme/cart-fe/pulls`,
            headers: githubHeaders,
            data: { head: "flightroom/change-1", base: "main", title: "Change", body: "Details" }
        })
    })

    it("given no commits between the branches, when a pull request is opened, then the 422 is passed on", async () => {
        const failure = answered(422)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().createPullRequest(pullRequest)).rejects.toBe(failure)
    })
})

describe("GithubClient.updateFileContent", () => {
    const update = {
        accessToken: token,
        orgName: "acme",
        repositoryName: "cart-fe",
        path: "apps/web app/package.json",
        content: '{"name":"città"}',
        message: "chore: bump",
        branch: "flightroom/change-1"
    }

    it("given the sha of the current blob, when the file is updated, then the content is PUT in base64 against that sha", async () => {
        const request = stubRequest().mockResolvedValue({ data: { content: { sha: "new-sha" } } })

        await expect(new GithubClient().updateFileContent({ ...update, sha: "old-sha" })).resolves.toBeUndefined()
        expect(sent(request)).toEqual({
            method: "PUT",
            url: `${api}/repos/acme/cart-fe/contents/apps/web%20app/package.json`,
            headers: githubHeaders,
            data: { message: "chore: bump", content: Buffer.from('{"name":"città"}', "utf8").toString("base64"), branch: "flightroom/change-1", sha: "old-sha" }
        })
    })

    it("given no sha, when the file is written, then it is created without a sha", async () => {
        const request = stubRequest().mockResolvedValue({ data: {} })

        await new GithubClient().updateFileContent(update)

        expect(sentBody(request).sha).toBeUndefined()
    })

    it("given a path with a hash and a question mark, when the file is written, then each segment is encoded and the slashes stay", async () => {
        const request = stubRequest().mockResolvedValue({ data: {} })

        await new GithubClient().updateFileContent({ ...update, path: "docs/a b#c?.md" })

        expect(sent(request).url).toBe(`${api}/repos/acme/cart-fe/contents/docs/a%20b%23c%3F.md`)
    })

    /** GitHub answers 409 when the sha is no longer the head of the branch */
    it("given a stale sha, when the file is updated, then the 409 is passed on", async () => {
        const failure = answered(409)
        stubRequest().mockRejectedValue(failure)

        await expect(new GithubClient().updateFileContent({ ...update, sha: "stale" })).rejects.toBe(failure)
    })
})
