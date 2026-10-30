import https from "node:https"
import axios, { CreateAxiosDefaults } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BusinessException } from "../errors/BusinessException"
import ArgoCdClient from "./ArgoCdClient"

/** The configuration the client created its axios instance with */
const configOf = (...options: ConstructorParameters<typeof ArgoCdClient>[2][]) => {
    const create = vi.spyOn(axios, "create").mockReturnValue({} as never)
    new ArgoCdClient("https://argocd.example.com", "token", ...options)
    return create.mock.calls[0][0] as CreateAxiosDefaults
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("ArgoCdClient", () => {
    it("given no option, when it is created, then the certificate is verified by Node", () => {
        expect(configOf().httpsAgent).toBeUndefined()
    })

    it("given insecure, when it is created, then any certificate is accepted, a self-signed one included", () => {
        const agent = configOf({ insecure: true }).httpsAgent

        expect(agent).toBeInstanceOf(https.Agent)
        expect((agent as https.Agent).options.rejectUnauthorized).toBe(false)
    })
})

/** A client whose axios instance answers every GET with `get` */
const clientAnswering = (get: ReturnType<typeof vi.fn>) => {
    vi.spyOn(axios, "create").mockReturnValue({ get } as never)
    return new ArgoCdClient("https://argocd.example.com", "token")
}

describe("ArgoCdClient.listPods", () => {
    it("given a resource tree, when the pods are listed, then only the pods come back with their state", async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                nodes: [
                    { kind: "Deployment", name: "orders", namespace: "dev" },
                    {
                        kind: "Pod",
                        name: "orders-7d9f-abcde",
                        namespace: "dev",
                        health: { status: "Healthy" },
                        info: [
                            { name: "Status Reason", value: "Running" },
                            { name: "Containers", value: "1/1" },
                            { name: "Restart Count", value: "2" }
                        ],
                        createdAt: "2026-10-27T10:00:00Z"
                    }
                ]
            }
        })

        const pods = await clientAnswering(get).listPods("mfe-app", "mfe-project")

        expect(get).toHaveBeenCalledWith("/applications/mfe-app/resource-tree", { params: { project: "mfe-project" } })
        expect(pods).toEqual([{ name: "orders-7d9f-abcde", namespace: "dev", health: "Healthy", status: "Running", containers: "1/1", restarts: 2, createdAt: "2026-10-27T10:00:00Z" }])
    })

    it("given an Application not there yet, when the pods are listed, then none come back", async () => {
        const get = vi.fn().mockRejectedValue(Object.assign(new axios.AxiosError("not found"), { response: { status: 404 } }))

        await expect(clientAnswering(get).listPods("mfe-app", "mfe-project")).resolves.toEqual([])
    })
})

describe("ArgoCdClient.getPodLogs", () => {
    const query = { namespace: "dev", podName: "orders-7d9f-abcde", tailLines: 100 }

    it("given a stream of JSON lines, when the logs are read, then every line but the last marker comes back in order", async () => {
        const get = vi.fn().mockResolvedValue({
            data: [
                JSON.stringify({ result: { content: "started", timeStamp: "2026-10-27T10:00:00Z" } }),
                JSON.stringify({ result: { content: "listening on 8080" } }),
                JSON.stringify({ result: { content: "", last: true } }),
                ""
            ].join("\n")
        })

        const lines = await clientAnswering(get).getPodLogs("mfe-app", "mfe-project", query)

        expect(get).toHaveBeenCalledWith("/applications/mfe-app/logs", { params: { ...query, project: "mfe-project", follow: false }, responseType: "text" })
        expect(lines).toEqual([{ content: "started", timestamp: "2026-10-27T10:00:00Z" }, { content: "listening on 8080" }])
    })

    it("given an error in the stream, when the logs are read, then it fails with what Argo CD said", async () => {
        const get = vi.fn().mockResolvedValue({ data: JSON.stringify({ error: { message: "previous terminated container not found" } }) })

        await expect(clientAnswering(get).getPodLogs("mfe-app", "mfe-project", { ...query, previous: true })).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: expect.stringContaining("previous terminated container not found")
        })
    })
})

const ARGO_URL = "https://argocd.example.com"

type Verb = "get" | "post" | "delete"

/** A client whose requests go to the mocks given, one per HTTP verb */
const clientWith = (api: Partial<Record<Verb, ReturnType<typeof vi.fn>>>) => {
    vi.spyOn(axios, "create").mockReturnValue(api as never)
    return new ArgoCdClient(ARGO_URL, "token")
}

/** A failure Argo CD answered, with the status and body given */
const answered = (status: number, data?: unknown) => Object.assign(new axios.AxiosError(`Request failed with status code ${status}`), { response: { status, data } })

/** A failure with no answer at all, as Node reports it under `code` */
const noAnswer = (code?: string, message = "socket hang up") => new axios.AxiosError(message, code)

describe("ArgoCdClient connection", () => {
    it("given a URL and a token, when it is created, then it calls API v1 with the token as a bearer, a timeout and no redirect", () => {
        expect(configOf()).toMatchObject({ baseURL: `${ARGO_URL}/api/v1`, headers: { Authorization: "Bearer token" }, timeout: 30_000, maxRedirects: 0 })
    })

    it("given insecure set to false, when it is created, then the certificate is still verified", () => {
        expect(configOf({ insecure: false }).httpsAgent).toBeUndefined()
    })
})

describe("ArgoCdClient.getUserInfo", () => {
    it("given a token Argo CD recognises, when the session is read, then the account comes back", async () => {
        const get = vi.fn().mockResolvedValue({ data: { loggedIn: true, username: "orchestrator" } })

        await expect(clientWith({ get }).getUserInfo()).resolves.toEqual({ loggedIn: true, username: "orchestrator" })
        expect(get).toHaveBeenCalledWith("/session/userinfo")
    })

    it("given a session that is not logged in, when it is read, then the token is refused with 422, not 401", async () => {
        const failure = clientWith({ get: vi.fn().mockResolvedValue({ data: { loggedIn: false } }) }).getUserInfo()

        await expect(failure).rejects.toBeInstanceOf(BusinessException)
        await expect(failure).rejects.toMatchObject({
            code: "ARGOCD_UNAUTHORIZED",
            statusCode: 422,
            message: expect.stringContaining(`Argo CD at ${ARGO_URL} does not accept the token`),
            details: { url: ARGO_URL }
        })
    })

    it("given an empty answer, when the session is read, then the token is refused", async () => {
        await expect(clientWith({ get: vi.fn().mockResolvedValue({ data: "" }) }).getUserInfo()).rejects.toMatchObject({ code: "ARGOCD_UNAUTHORIZED" })
    })

    it("given Argo CD answers 401, when the session is read, then the token is refused", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(401)) }).getUserInfo()).rejects.toMatchObject({ code: "ARGOCD_UNAUTHORIZED", statusCode: 422 })
    })
})

describe("ArgoCdClient failures", () => {
    const failureOf = (error: unknown) => clientWith({ get: vi.fn().mockRejectedValue(error) }).getUserInfo()

    it.each([
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_GET_ISSUER_CERT",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "ERR_TLS_CERT_ALTNAME_INVALID"
    ])("given the certificate is refused with %s, when Argo CD is called, then it says the certificate is not trusted", async code => {
        await expect(failureOf(noAnswer(code))).rejects.toMatchObject({
            code: "ARGOCD_TLS_UNTRUSTED",
            statusCode: 502,
            message: expect.stringContaining(`The certificate of Argo CD at ${ARGO_URL} is not trusted (${code})`),
            details: { url: ARGO_URL, reason: code }
        })
    })

    it("given the connection is refused, when Argo CD is called, then it says Argo CD cannot be reached, with the code Node gave", async () => {
        await expect(failureOf(noAnswer("ECONNREFUSED"))).rejects.toMatchObject({
            code: "ARGOCD_UNREACHABLE",
            statusCode: 502,
            message: expect.stringContaining(`Argo CD cannot be reached at ${ARGO_URL} (ECONNREFUSED)`),
            details: { url: ARGO_URL, reason: "ECONNREFUSED" }
        })
    })

    it("given a failure with no answer and no code, when Argo CD is called, then the message of the error is the reason", async () => {
        await expect(failureOf(noAnswer(undefined, "socket hang up"))).rejects.toMatchObject({ code: "ARGOCD_UNREACHABLE", details: { url: ARGO_URL, reason: "socket hang up" } })
    })

    it("given the account may not do it, when Argo CD answers 403, then it says which RBAC grant is missing for the action", async () => {
        await expect(failureOf(answered(403, { message: "permission denied" }))).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            statusCode: 422,
            message: expect.stringContaining("may not read the session of the token: grant it role:orchestrator"),
            details: { url: ARGO_URL, reason: "read the session of the token" }
        })
    })

    it("given an error Argo CD shaped, when it answers with another status, then its message goes into ours, cut to 200 characters", async () => {
        await expect(failureOf(answered(500, { message: "x".repeat(500) }))).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            statusCode: 502,
            message: `Argo CD did not read the session of the token (500 ${"x".repeat(200)})`,
            details: { url: ARGO_URL, reason: `500 ${"x".repeat(200)}` }
        })
    })

    it("given a proxy answers with a whole page, when the call fails, then only the status is shown", async () => {
        await expect(failureOf(answered(502, "<html><body>Bad Gateway</body></html>"))).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: "Argo CD did not read the session of the token (502)",
            details: { url: ARGO_URL, reason: "502" }
        })
    })

    it("given an answer whose message is not text, when the call fails, then only the status is shown", async () => {
        await expect(failureOf(answered(500, { message: { nested: true } }))).rejects.toMatchObject({ details: { reason: "500" } })
    })

    it("given an answer with no body, when the call fails, then only the status is shown", async () => {
        await expect(failureOf(answered(500))).rejects.toMatchObject({ details: { reason: "500" } })
    })

    it("given Argo CD answers 302, when it is called, then the redirect is a failed request with the status as the reason", async () => {
        await expect(failureOf(answered(302, ""))).rejects.toMatchObject({ code: "ARGOCD_REQUEST_FAILED", details: { reason: "302" } })
    })

    it("given a failure that is not of axios, when Argo CD is called, then its message is the reason", async () => {
        await expect(failureOf(new TypeError("Invalid URL"))).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            statusCode: 502,
            message: "Argo CD did not read the session of the token: Invalid URL",
            details: { url: ARGO_URL, reason: "Invalid URL" }
        })
    })

    it("given a failure that is not an Error, when Argo CD is called, then it is shown as text", async () => {
        await expect(failureOf("boom")).rejects.toMatchObject({ code: "ARGOCD_REQUEST_FAILED", details: { reason: "boom" } })
    })
})

describe("ArgoCdClient.upsertRepository", () => {
    it("given the credentials of a git repository, when they are registered, then they are posted with upsert, not only as credentials", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })
        const repository = { repo: "https://gitlab.example/acme/apps.git", username: "deploy", password: "p4ss", project: "acme" }

        await expect(clientWith({ post }).upsertRepository(repository)).resolves.toBeUndefined()
        expect(post).toHaveBeenCalledWith("/repositories", { type: "git", ...repository }, { params: { upsert: true, credsOnly: false } })
    })

    it("given the account may not register it, when the repository is registered, then the action is named in the refusal", async () => {
        await expect(clientWith({ post: vi.fn().mockRejectedValue(answered(403)) }).upsertRepository({ repo: "https://git.example/apps", username: "u", password: "p" })).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "register the repository https://git.example/apps" }
        })
    })
})

describe("ArgoCdClient.getRepository", () => {
    it.each([
        ["the same URL", "https://gitlab.example/acme/apps.git"],
        ["another case", "HTTPS://GitLab.example/Acme/Apps.git"],
        ["a trailing slash", "https://gitlab.example/acme/apps.git/"],
        ["no .git", "https://gitlab.example/acme/apps"],
        ["spaces around it", "  https://gitlab.example/acme/apps.git  "]
    ])("given it is looked up with %s, when the repository is registered, then it is found as Argo CD compares URLs", async (_, url) => {
        const registered = { repo: "https://gitlab.example/acme/apps.git", project: "acme" }
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo: "https://gitlab.example/acme/other.git" }, registered] } })

        await expect(clientWith({ get }).getRepository(url)).resolves.toEqual(registered)
        expect(get).toHaveBeenCalledWith("/repositories")
    })

    it("given no repository with that URL, when it is looked up, then there is none", async () => {
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo: "https://gitlab.example/acme/other.git" }] } })

        await expect(clientWith({ get }).getRepository("https://gitlab.example/acme/apps.git")).resolves.toBeNull()
    })

    it("given Argo CD answers no items, when a repository is looked up, then there is none", async () => {
        await expect(clientWith({ get: vi.fn().mockResolvedValue({ data: { items: null } }) }).getRepository("https://git.example/apps")).resolves.toBeNull()
    })

    it("given the repositories cannot be listed, when one is looked up, then the failure names the listing", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).getRepository("https://git.example/apps")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "list the repositories" }
        })
    })
})

describe("ArgoCdClient.deleteRepository", () => {
    const repo = "https://gitlab.example/acme/apps.git"
    const encoded = "/repositories/https%3A%2F%2Fgitlab.example%2Facme%2Fapps.git"

    it("given the repository registered in the AppProject, when it is deleted, then its encoded URL is deleted from that AppProject", async () => {
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo, project: "acme" }] } })
        const remove = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ get, delete: remove }).deleteRepository(repo, "acme")).resolves.toBeUndefined()
        expect(remove).toHaveBeenCalledWith(encoded, { params: { appProject: "acme" } })
    })

    it("given the repository registered globally, when it is deleted with no AppProject, then it is deleted globally", async () => {
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo, project: "" }] } })
        const remove = vi.fn().mockResolvedValue({ data: {} })

        await clientWith({ get, delete: remove }).deleteRepository(repo)

        expect(remove).toHaveBeenCalledWith(encoded, { params: { appProject: undefined } })
    })

    it.each([
        ["an empty project", ""],
        ["no project", undefined]
    ])("given the repository registered globally, when it is deleted with an empty AppProject, then it is deleted globally (%s registered)", async (_, registeredProject) => {
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo, project: registeredProject }] } })
        const remove = vi.fn().mockResolvedValue({ data: {} })

        await clientWith({ get, delete: remove }).deleteRepository(repo, "")

        expect(remove).toHaveBeenCalledWith(encoded, { params: { appProject: undefined } })
    })

    it("given the repository registered in an AppProject only, when it is deleted with an empty AppProject, then that registration is left alone", async () => {
        const remove = vi.fn()
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo, project: "acme" }] } })

        await clientWith({ get, delete: remove }).deleteRepository(repo, "")

        expect(remove).not.toHaveBeenCalled()
    })

    it("given the repository is not registered, when it is deleted, then nothing is deleted", async () => {
        const remove = vi.fn()

        await expect(clientWith({ get: vi.fn().mockResolvedValue({ data: { items: [] } }), delete: remove }).deleteRepository(repo, "acme")).resolves.toBeUndefined()
        expect(remove).not.toHaveBeenCalled()
    })

    it("given the repository registered in another AppProject only, when it is deleted, then that registration is left alone", async () => {
        const remove = vi.fn()
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo, project: "someone-else" }] } })

        await clientWith({ get, delete: remove }).deleteRepository(repo, "acme")

        expect(remove).not.toHaveBeenCalled()
    })

    it("given the repository went between the listing and the delete, when it is deleted, then it is not an error", async () => {
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo, project: "acme" }] } })

        await expect(clientWith({ get, delete: vi.fn().mockRejectedValue(answered(404)) }).deleteRepository(repo, "acme")).resolves.toBeUndefined()
    })

    it("given Argo CD refuses the delete, when the repository is deleted, then the failure names the delete", async () => {
        const get = vi.fn().mockResolvedValue({ data: { items: [{ repo, project: "acme" }] } })

        await expect(clientWith({ get, delete: vi.fn().mockRejectedValue(answered(500, { message: "repo in use" })) }).deleteRepository(repo, "acme")).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: `Argo CD did not delete the repository ${repo} (500 repo in use)`
        })
    })
})

describe("ArgoCdClient.getProject", () => {
    it("given the AppProject, when it is read, then it comes back, read by its encoded name", async () => {
        const project = { metadata: { name: "acme shop", labels: { "flightroom.dev/project-id": "p1" } } }
        const get = vi.fn().mockResolvedValue({ data: project })

        await expect(clientWith({ get }).getProject("acme shop")).resolves.toEqual(project)
        expect(get).toHaveBeenCalledWith("/projects/acme%20shop")
    })

    it("given Argo CD answers 404, when the AppProject is read, then there is none", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(404)) }).getProject("acme")).resolves.toBeNull()
    })

    it("given an AppProject the account may not read, when it is read, then it is a refusal, not a missing AppProject", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).getProject("acme")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "read the AppProject acme" }
        })
    })
})

describe("ArgoCdClient.getApplication", () => {
    it("given the Application, when it is read, then it comes back with its status, read by its encoded name in the AppProject", async () => {
        const application = { metadata: { name: "orders/dev" }, status: { sync: { status: "Synced", revision: "abc" }, health: { status: "Healthy" } } }
        const get = vi.fn().mockResolvedValue({ data: application })

        await expect(clientWith({ get }).getApplication("orders/dev", "acme")).resolves.toEqual(application)
        expect(get).toHaveBeenCalledWith("/applications/orders%2Fdev", { params: { project: "acme" } })
    })

    it("given Argo CD answers 404, when the Application is read, then there is none", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(404)) }).getApplication("orders", "acme")).resolves.toBeNull()
    })

    it("given an Application the account may not read, when it is read, then it is a refusal, not a missing Application", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).getApplication("orders", "acme")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "read the Application orders" }
        })
    })
})

describe("ArgoCdClient.getApplicationSet", () => {
    it("given the ApplicationSet, when it is read, then it comes back, read by its encoded name", async () => {
        const applicationSet = { metadata: { name: "acme envs" } }
        const get = vi.fn().mockResolvedValue({ data: applicationSet })

        await expect(clientWith({ get }).getApplicationSet("acme envs")).resolves.toEqual(applicationSet)
        expect(get).toHaveBeenCalledWith("/applicationsets/acme%20envs")
    })

    it("given Argo CD answers 404, when the ApplicationSet is read, then there is none", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(404)) }).getApplicationSet("acme-envs")).resolves.toBeNull()
    })

    it("given an ApplicationSet the account may not read, when it is read, then it is a refusal naming it", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).getApplicationSet("acme-envs")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "read the ApplicationSet acme-envs" }
        })
    })
})

describe("ArgoCdClient.upsertProject", () => {
    it("given an AppProject, when it is saved, then it is posted wrapped with upsert", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })
        const project = { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject", metadata: { name: "acme" }, spec: { destinations: [] } }

        await expect(clientWith({ post }).upsertProject(project)).resolves.toBeUndefined()
        expect(post).toHaveBeenCalledWith("/projects", { project, upsert: true })
    })

    it("given Argo CD answers 409, when the AppProject is saved, then the conflict is a failed request carrying its message", async () => {
        const post = vi.fn().mockRejectedValue(answered(409, { message: "existing project spec is different" }))

        await expect(clientWith({ post }).upsertProject({ metadata: { name: "acme" } })).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            statusCode: 502,
            message: "Argo CD did not save the AppProject acme (409 existing project spec is different)"
        })
    })
})

describe("ArgoCdClient.deleteProject", () => {
    it("given the AppProject, when it is deleted, then its encoded name is deleted", async () => {
        const remove = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ delete: remove }).deleteProject("acme old")).resolves.toBeUndefined()
        expect(remove).toHaveBeenCalledWith("/projects/acme%20old")
    })

    it("given the AppProject is gone already, when it is deleted, then it is not an error", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(404)) }).deleteProject("acme")).resolves.toBeUndefined()
    })

    it("given an Application still belongs to it, when the AppProject is deleted, then the refusal of Argo CD comes back", async () => {
        const remove = vi.fn().mockRejectedValue(answered(400, { message: "project is referenced by 1 applications" }))

        await expect(clientWith({ delete: remove }).deleteProject("acme")).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: "Argo CD did not delete the AppProject acme (400 project is referenced by 1 applications)"
        })
    })
})

describe("ArgoCdClient.listApplications", () => {
    it("given a label selector, when the Applications are listed, then they are asked for in the AppProject and come back", async () => {
        const items = [{ metadata: { name: "orders-dev" } }]
        const get = vi.fn().mockResolvedValue({ data: { items } })
        const selector = "flightroom.dev/project-id=p1,flightroom.dev/component=configuration"

        await expect(clientWith({ get }).listApplications(selector, "acme")).resolves.toEqual(items)
        expect(get).toHaveBeenCalledWith("/applications", { params: { selector, projects: "acme" } })
    })

    it("given Argo CD answers no items, when the Applications are listed, then none come back", async () => {
        await expect(clientWith({ get: vi.fn().mockResolvedValue({ data: { items: null } }) }).listApplications("a=b", "acme")).resolves.toEqual([])
    })

    it("given the listing fails, when the Applications are listed, then the failure names it", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).listApplications("a=b", "acme")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "list the Applications" }
        })
    })
})

describe("ArgoCdClient.refreshApplication", () => {
    it("given the Application, when it is refreshed, then it is read with a normal refresh in its AppProject", async () => {
        const get = vi.fn().mockResolvedValue({ data: { metadata: { name: "orders" } } })

        await expect(clientWith({ get }).refreshApplication("orders/dev", "acme")).resolves.toBeUndefined()
        expect(get).toHaveBeenCalledWith("/applications/orders%2Fdev", { params: { project: "acme", refresh: "normal" } })
    })

    it("given the Application is gone, when it is refreshed, then it is not an error", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(404)) }).refreshApplication("orders", "acme")).resolves.toBeUndefined()
    })

    it("given any other failure, when the Application is refreshed, then the failure names the refresh", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).refreshApplication("orders", "acme")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "refresh the Application orders" }
        })
    })
})

describe("ArgoCdClient.deleteApplication", () => {
    /** Without its AppProject Argo CD answers 403, not 404, for an Application that is not there: it does not tell which exist */
    it("given the Application, when it is deleted, then its encoded name is deleted without cascade in its AppProject", async () => {
        const remove = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ delete: remove }).deleteApplication("orders/dev", "acme")).resolves.toBeUndefined()
        expect(remove).toHaveBeenCalledWith("/applications/orders%2Fdev", { params: { cascade: false, project: "acme" } })
    })

    it("given the Application went between the listing and the delete, when it is deleted, then it is not an error", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(404)) }).deleteApplication("orders", "acme")).resolves.toBeUndefined()
    })

    it("given Argo CD fails the delete, when the Application is deleted, then the failure names the delete", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(500, { message: "boom" })) }).deleteApplication("orders", "acme")).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: "Argo CD did not delete the Application orders (500 boom)"
        })
    })

    it("given the account may not delete it, when the Application is deleted, then the refusal names the delete", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(403)) }).deleteApplication("orders", "acme")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "delete the Application orders" }
        })
    })
})

describe("ArgoCdClient.upsertApplicationSet", () => {
    it("given an ApplicationSet, when it is saved, then it is posted as it is with upsert", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })
        const applicationSet = { apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", metadata: { name: "acme-envs", labels: { a: "b" } }, spec: { generators: [] } }

        await expect(clientWith({ post }).upsertApplicationSet(applicationSet)).resolves.toBeUndefined()
        expect(post).toHaveBeenCalledWith("/applicationsets", applicationSet, { params: { upsert: true } })
    })

    it("given Argo CD refuses it, when the ApplicationSet is saved, then the failure names it", async () => {
        await expect(clientWith({ post: vi.fn().mockRejectedValue(answered(403)) }).upsertApplicationSet({ metadata: { name: "acme-envs" } })).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "save the ApplicationSet acme-envs" }
        })
    })
})

describe("ArgoCdClient.listApplicationSets", () => {
    it("given a label selector, when the ApplicationSets are listed, then they are asked for in the AppProject and come back", async () => {
        const items = [{ metadata: { name: "acme-envs" } }]
        const get = vi.fn().mockResolvedValue({ data: { items } })

        await expect(clientWith({ get }).listApplicationSets("flightroom.dev/project-id=p1", "acme")).resolves.toEqual(items)
        expect(get).toHaveBeenCalledWith("/applicationsets", { params: { selector: "flightroom.dev/project-id=p1", projects: "acme" } })
    })

    it("given Argo CD answers no items, when the ApplicationSets are listed, then none come back", async () => {
        await expect(clientWith({ get: vi.fn().mockResolvedValue({ data: {} }) }).listApplicationSets("a=b", "acme")).resolves.toEqual([])
    })

    it("given Argo CD times out, when the ApplicationSets are listed, then it cannot be reached", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(noAnswer("ETIMEDOUT")) }).listApplicationSets("a=b", "acme")).rejects.toMatchObject({
            code: "ARGOCD_UNREACHABLE",
            details: { reason: "ETIMEDOUT" }
        })
    })
})

describe("ArgoCdClient.deleteApplicationSet", () => {
    it("given the ApplicationSet, when it is deleted, then its encoded name is deleted", async () => {
        const remove = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ delete: remove }).deleteApplicationSet("acme envs")).resolves.toBeUndefined()
        expect(remove).toHaveBeenCalledWith("/applicationsets/acme%20envs")
    })

    it("given the ApplicationSet went between the listing and the delete, when it is deleted, then it is not an error", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(404)) }).deleteApplicationSet("acme-envs")).resolves.toBeUndefined()
    })

    it("given Argo CD fails the delete, when the ApplicationSet is deleted, then the failure names the delete", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(500, { message: "boom" })) }).deleteApplicationSet("acme-envs")).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: "Argo CD did not delete the ApplicationSet acme-envs (500 boom)"
        })
    })

    it("given the account may not delete it, when the ApplicationSet is deleted, then the refusal names the delete", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(403)) }).deleteApplicationSet("acme-envs")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "delete the ApplicationSet acme-envs" }
        })
    })
})

describe("ArgoCdClient.createJobFromCronJob", () => {
    it("given a CronJob of the Application, when a run is started, then the create-job action is posted as a JSON string for that CronJob", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ post }).createJobFromCronJob("agents/dev", "acme", "dev", "nightly-agent")).resolves.toBeUndefined()
        expect(post).toHaveBeenCalledWith("/applications/agents%2Fdev/resource/actions", '"create-job"', {
            params: { namespace: "dev", resourceName: "nightly-agent", group: "batch", version: "v1", kind: "CronJob", project: "acme" },
            headers: { "Content-Type": "application/json" }
        })
    })

    it("given the Application is not there, when a run is started, then it fails as a request, not as a missing object", async () => {
        const post = vi.fn().mockRejectedValue(answered(404, { message: "application not found" }))

        await expect(clientWith({ post }).createJobFromCronJob("agents", "acme", "dev", "nightly")).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: "Argo CD did not start a run of the CronJob nightly (404 application not found)"
        })
    })
})

describe("ArgoCdClient.listPods edge cases", () => {
    it("given nodes without a name or a namespace, when the pods are listed, then they are left out", async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                nodes: [
                    { kind: "Pod", namespace: "dev" },
                    { kind: "Pod", name: "orphan" },
                    { kind: "Pod", name: "orders-1", namespace: "dev", info: null }
                ]
            }
        })

        await expect(clientWith({ get }).listPods("orders", "acme")).resolves.toEqual([
            { name: "orders-1", namespace: "dev", health: undefined, status: undefined, containers: undefined, restarts: undefined, createdAt: undefined }
        ])
    })

    it("given a restart count that is not a number, when the pods are listed, then the restarts are left out", async () => {
        const get = vi.fn().mockResolvedValue({ data: { nodes: [{ kind: "Pod", name: "orders-1", namespace: "dev", info: [{ name: "Restart Count", value: "many" }] }] } })

        const [pod] = await clientWith({ get }).listPods("orders", "acme")

        expect(pod.restarts).toBeUndefined()
    })

    it("given a tree with no nodes, when the pods are listed, then none come back", async () => {
        await expect(clientWith({ get: vi.fn().mockResolvedValue({ data: { nodes: null } }) }).listPods("orders", "acme")).resolves.toEqual([])
    })

    it("given an Application name with a slash, when the pods are listed, then it is one encoded path segment", async () => {
        const get = vi.fn().mockResolvedValue({ data: {} })

        await clientWith({ get }).listPods("orders/dev", "acme")

        expect(get).toHaveBeenCalledWith("/applications/orders%2Fdev/resource-tree", { params: { project: "acme" } })
    })

    it("given the account may not read the tree, when the pods are listed, then the refusal names the Application", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).listPods("orders", "acme")).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "read the resources of the Application orders" }
        })
    })
})

describe("ArgoCdClient.getPodLogs edge cases", () => {
    const query = { namespace: "dev", podName: "orders-1", tailLines: 50 }

    it("given every option, when the logs are read, then they all go into the query with the AppProject and no follow", async () => {
        const get = vi.fn().mockResolvedValue({ data: "" })
        const full = { ...query, sinceSeconds: 600, previous: true, filter: "ERROR" }

        await expect(clientWith({ get }).getPodLogs("orders/dev", "acme", full)).resolves.toEqual([])
        expect(get).toHaveBeenCalledWith("/applications/orders%2Fdev/logs", { params: { ...full, project: "acme", follow: false }, responseType: "text" })
    })

    it("given lines that are not JSON, entries without a result and a result without content, when the logs are read, then only the results come back", async () => {
        const get = vi.fn().mockResolvedValue({
            data: ["not json", "   ", JSON.stringify({}), JSON.stringify({ result: { timeStamp: "2026-10-27T10:00:00Z" } }), JSON.stringify({ result: { content: "ok" } })].join("\n")
        })

        await expect(clientWith({ get }).getPodLogs("orders", "acme", query)).resolves.toEqual([{ content: "", timestamp: "2026-10-27T10:00:00Z" }, { content: "ok" }])
    })

    it("given a refusal of Kubernetes as a line of content, when the logs are read, then it is shown as a line", async () => {
        const refusal = "a container name must be specified for pod orders-1, choose one of: [app sidecar]"
        const get = vi.fn().mockResolvedValue({ data: JSON.stringify({ result: { content: refusal } }) })

        await expect(clientWith({ get }).getPodLogs("orders", "acme", query)).resolves.toEqual([{ content: refusal }])
    })

    it("given no body, when the logs are read, then none come back", async () => {
        await expect(clientWith({ get: vi.fn().mockResolvedValue({ data: undefined }) }).getPodLogs("orders", "acme", query)).resolves.toEqual([])
    })

    it("given an error in the stream after some lines, when the logs are read, then it fails with a 502 naming the pod", async () => {
        const get = vi.fn().mockResolvedValue({ data: [JSON.stringify({ result: { content: "started" } }), JSON.stringify({ error: { message: "stream cut" } })].join("\n") })

        await expect(clientWith({ get }).getPodLogs("orders", "acme", query)).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            statusCode: 502,
            message: "Argo CD did not read the logs of the pod orders-1: stream cut"
        })
    })

    it("given an error with no message in the stream, when the logs are read, then it says the stream failed", async () => {
        const get = vi.fn().mockResolvedValue({ data: JSON.stringify({ error: {} }) })

        await expect(clientWith({ get }).getPodLogs("orders", "acme", query)).rejects.toMatchObject({ message: "Argo CD did not read the logs of the pod orders-1: the stream of logs failed" })
    })

    it("given a long error in the stream, when the logs are read, then its message is cut to 200 characters", async () => {
        const get = vi.fn().mockResolvedValue({ data: JSON.stringify({ error: { message: "e".repeat(500) } }) })

        await expect(clientWith({ get }).getPodLogs("orders", "acme", query)).rejects.toMatchObject({ details: { reason: "e".repeat(200) } })
    })

    it("given a pod the Application does not run, when its logs are read, then the refusal names the pod", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(403)) }).getPodLogs("orders", "acme", query)).rejects.toMatchObject({
            code: "ARGOCD_FORBIDDEN",
            details: { reason: "read the logs of the pod orders-1" }
        })
    })

    it("given Argo CD answers 404, when the logs are read, then it is a failure, not an empty log", async () => {
        await expect(clientWith({ get: vi.fn().mockRejectedValue(answered(404, { message: "pods not found" })) }).getPodLogs("orders", "acme", query)).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            details: { reason: "404 pods not found" }
        })
    })
})
