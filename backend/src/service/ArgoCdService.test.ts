import axios, { AxiosError } from "axios"
import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "yaml"

vi.mock("..", () => ({ fastify: { log: { error: vi.fn(), warn: vi.fn() }, config: { REPOSITORIES_FOLDER: "/repositories" } } }))

import ArgoCdClient, { ArgoCdResource } from "../client/ArgoCdClient"
import GitlabClient from "../client/GitlabClient"
import { createBusinessException } from "../errors/BusinessException"
import Backend from "../models/BackendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import Project, { IArgoCdRepositoryCredential, IProjectArgoCd } from "../models/ProjectModel"
import { withNoMaintenanceAgents } from "../testing/noMaintenanceAgents"
import { toObjectId } from "../utils/mongooseUtils"
import ArgoCdService from "./ArgoCdService"
import CodeRepositoryService from "./CodeRepositoryService"
import GitOpsService, { renderNamespace } from "./GitOpsService"
import {
    applicationName,
    applicationSetName,
    appProjectName,
    ENVIRONMENT_LABEL,
    environmentApplicationName,
    environmentsApplicationSetName,
    PROJECT_ID_LABEL,
    unprefixedProjectName
} from "./gitops/argoCdManifests"

withNoMaintenanceAgents()

const projectId = new Types.ObjectId()
const gitlabConnectionId = new Types.ObjectId()
const githubConnectionId = new Types.ObjectId()
const gitlabConnection = {
    _id: gitlabConnectionId,
    name: "GitLab",
    provider: "GITLAB",
    accessToken: "glpat-connection",
    gitlabData: { url: "https://gitlab.example.com", groupId: 1, groupPath: "acme" }
}
const githubConnection = { _id: githubConnectionId, name: "GitHub", provider: "GITHUB", accessToken: "ghp-connection", githubData: { organizationId: "acme" } }
const configurationLink = { enabled: true, codeRepositoryId: gitlabConnectionId, repositoryId: "101", name: "shop-config", repositoryData: {}, gitlab: { path: "acme/shop-config" } }
const applicationsLink = { enabled: true, codeRepositoryId: githubConnectionId, repositoryId: "202", name: "shop-apps", repositoryData: {} }
const ARGO_URL = "https://argocd.example.com"
const CONFIG_REPO = "https://gitlab.example.com/acme/shop-config.git"
const APPS_REPO = "https://github.com/acme/shop-apps.git"
const PROJECT_NAME = appProjectName(String(projectId), "shop")
const environmentName = (environment: string) => environmentApplicationName(String(projectId), "shop", environment)
const ENVIRONMENTS_SET = environmentsApplicationSetName(String(projectId), "shop")
const applicationSetNameOf = (application: string) => applicationSetName(String(projectId), "shop", application)

/** Every call to Argo CD and to GitLab, in the order it was made */
let calls: string[]
let saved: IProjectArgoCd[]
/** The filter of every save, for the lease it matched on */
let saveFilters: Array<Record<string, unknown>>
let previous: IProjectArgoCd | undefined
let gitOps: Record<string, unknown>
let applications: ArgoCdResource[]
let applicationSets: ArgoCdResource[]

const resource = (name: string, spec: Record<string, unknown> = { project: PROJECT_NAME }, labels: Record<string, string> = {}): ArgoCdResource => ({
    metadata: { name, labels: { [PROJECT_ID_LABEL]: String(projectId), ...labels } },
    spec
})

const deployTokenCredential = (overrides: Partial<IArgoCdRepositoryCredential> = {}): IArgoCdRepositoryCredential => ({
    source: "deployToken",
    username: "gitlab+deploy-token-7",
    password: "gldt-old",
    deployTokenId: 7,
    gitlabProjectId: 101,
    argoCdUrl: ARGO_URL,
    repoUrl: CONFIG_REPO,
    argoProject: PROJECT_NAME,
    codeRepositoryId: String(gitlabConnectionId),
    ...overrides
})

const manualCredential = (overrides: Partial<IArgoCdRepositoryCredential> = {}): IArgoCdRepositoryCredential => ({
    source: "manual",
    username: "x-access-token",
    password: "ghp-stored",
    argoCdUrl: ARGO_URL,
    repoUrl: APPS_REPO,
    codeRepositoryId: String(githubConnectionId),
    ...overrides
})

beforeEach(() => {
    calls = []
    saved = []
    saveFilters = []
    previous = undefined
    gitOps = { enabled: true, codeRepository: configurationLink, applicationsCodeRepository: applicationsLink }
    applications = []
    applicationSets = []

    vi.spyOn(ArgoCdService.prototype as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue(undefined)
    vi.spyOn(GitOpsService.prototype, "ensureOwner").mockResolvedValue(undefined)
    vi.spyOn(Project, "findById").mockImplementation(() => ({ _id: projectId, slug: "shop", organizationId: new Types.ObjectId(), gitOps, argoCd: previous }) as never)
    vi.spyOn(Project, "findOneAndUpdate").mockResolvedValue({ _id: projectId } as never)
    // No other project registered the repositories, nor reads through the registrations of this one
    vi.spyOn(Project, "find").mockResolvedValue([] as never)
    vi.spyOn(Project, "exists").mockResolvedValue(null as never)
    vi.spyOn(Project, "updateOne").mockImplementation(((filter: Record<string, unknown>, update: { $set?: { argoCd: IProjectArgoCd } }) => {
        if (update.$set) {
            saved.push(update.$set.argoCd)
            saveFilters.push(filter)
        }
        return Promise.resolve({ matchedCount: 1 })
    }) as never)
    vi.spyOn(Environment, "find").mockResolvedValue([
        { slug: "development", projectId },
        { slug: "production", namespace: "prod", projectId }
    ] as never)
    vi.spyOn(CodeRepository, "findOne").mockImplementation(((filter: { _id: unknown }) =>
        Promise.resolve(String(filter._id) === String(gitlabConnectionId) ? gitlabConnection : githubConnection)) as never)
    vi.spyOn(CodeRepository, "find").mockResolvedValue([gitlabConnection, githubConnection] as never)
    vi.spyOn(Backend, "find").mockResolvedValue([{ slug: "orders", version: "1.0.0", image: { repository: "ghcr.io/acme/orders" } }, { slug: "draft" }] as never)
    vi.spyOn(Frontend, "find").mockResolvedValue([{ slug: "checkout", version: "2.0.0", image: { repository: "ghcr.io/acme/checkout" } }] as never)
    vi.spyOn(CodeRepositoryService.prototype, "getBranches").mockImplementation(async () => {
        calls.push("branches")
        return [{ branch: "main" }, { branch: "development" }] as never
    })

    vi.spyOn(ArgoCdClient.prototype, "getUserInfo").mockImplementation(async () => {
        calls.push("argo:userinfo")
        return { loggedIn: true, username: "orchestrator" }
    })
    vi.spyOn(ArgoCdClient.prototype, "getProject").mockResolvedValue(null)
    vi.spyOn(ArgoCdClient.prototype, "getApplication").mockResolvedValue(null)
    vi.spyOn(ArgoCdClient.prototype, "getApplicationSet").mockResolvedValue(null)
    vi.spyOn(ArgoCdClient.prototype, "getRepository").mockResolvedValue(null)
    vi.spyOn(ArgoCdClient.prototype, "upsertProject").mockImplementation(async project => {
        calls.push(`argo:upsertProject:${project.metadata.name}`)
    })
    vi.spyOn(ArgoCdClient.prototype, "upsertRepository").mockImplementation(async repository => {
        calls.push(`argo:upsertRepository:${repository.repo}:${repository.username}:${repository.password}:${repository.project ?? "global"}`)
    })
    vi.spyOn(ArgoCdClient.prototype, "deleteRepository").mockImplementation(async (repo, project) => {
        calls.push(`argo:deleteRepository:${repo}:${project ?? "global"}`)
    })
    vi.spyOn(ArgoCdClient.prototype, "upsertApplicationSet").mockImplementation(async applicationSet => {
        calls.push(`argo:upsertApplicationSet:${applicationSet.metadata.name}`)
    })
    vi.spyOn(ArgoCdClient.prototype, "listApplications").mockImplementation(async () => applications)
    vi.spyOn(ArgoCdClient.prototype, "listApplicationSets").mockImplementation(async () => applicationSets)
    vi.spyOn(ArgoCdClient.prototype, "deleteApplicationSet").mockImplementation(async name => {
        calls.push(`argo:deleteApplicationSet:${name}`)
    })
    vi.spyOn(ArgoCdClient.prototype, "deleteProject").mockImplementation(async name => {
        calls.push(`argo:deleteProject:${name}`)
    })
    vi.spyOn(GitlabClient.prototype, "getProject").mockResolvedValue({ id: 101, name: "shop-config", path_with_namespace: "acme/shop-config" })
    vi.spyOn(GitlabClient.prototype, "createDeployToken").mockImplementation(async gitlabProjectId => {
        calls.push(`gitlab:createDeployToken:${gitlabProjectId}`)
        return { id: 8, username: "gitlab+deploy-token-8", token: "gldt-new" }
    })
    vi.spyOn(GitlabClient.prototype, "revokeDeployToken").mockImplementation(async (gitlabProjectId, tokenId) => {
        calls.push(`gitlab:revokeDeployToken:${gitlabProjectId}:${tokenId}`)
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

const initialize = (input: Partial<{ url: string; token: string; repositoryToken: string; insecure: boolean }> = {}) =>
    new ArgoCdService().initialize(String(projectId), { url: `${ARGO_URL}/`, token: "argo-token", repositoryToken: "ghp-read-only", ...input })

describe("ArgoCdService.initialize", () => {
    it("given a token Argo CD refuses, when it is initialized, then nothing is written to Argo CD or GitLab and the failure is stored by code", async () => {
        vi.mocked(ArgoCdClient.prototype.getUserInfo).mockRejectedValue(createBusinessException({ code: "ARGOCD_UNAUTHORIZED", message: "refused", statusCode: 422, details: { url: ARGO_URL } }))

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_UNAUTHORIZED" })

        expect(calls).toEqual([])
        expect(saved).toEqual([{ lastError: { code: "ARGOCD_UNAUTHORIZED", message: "refused", details: { url: ARGO_URL } }, pendingRepositoryDeletions: [], initializingAt: expect.any(Date) }])
    })

    it("given a project, when it is initialized, then the token is checked before anything else", async () => {
        await initialize()

        expect(calls[0]).toBe("argo:userinfo")
    })

    it("given an initialization running, when another one starts, then it is refused as busy and nothing is called", async () => {
        vi.mocked(Project.findOneAndUpdate).mockResolvedValue(null as never)

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_BUSY", statusCode: 409 })

        expect(calls).toEqual([])
    })

    it("given a project, when it is initialized, then the lease is released at the end", async () => {
        await initialize()

        expect(Project.updateOne).toHaveBeenLastCalledWith({ _id: expect.anything(), "argoCd.initializingAt": expect.any(Date) }, { $unset: { "argoCd.initializingAt": 1 } })
    })

    it("given another run that rotated the tokens before the lease was taken, when it is initialized, then the credentials read under the lease are the ones retired", async () => {
        const stale = { url: ARGO_URL, token: "argo-token", repositories: { configuration: deployTokenCredential({ deployTokenId: 6 }) } }
        previous = { url: ARGO_URL, token: "argo-token", repositories: { configuration: deployTokenCredential({ deployTokenId: 7 }) } }
        vi.mocked(Project.findById).mockImplementationOnce(() => ({ _id: projectId, slug: "shop", organizationId: new Types.ObjectId(), gitOps, argoCd: stale }) as never)

        await initialize()

        expect(calls).toContain("gitlab:revokeDeployToken:101:7")
        expect(calls).not.toContain("gitlab:revokeDeployToken:101:6")
    })

    it("given a run, when it saves, then every save matches the lease the save before renewed", async () => {
        await initialize()

        expect(saveFilters.length).toBeGreaterThan(1)
        const acquired = (vi.mocked(Project.findOneAndUpdate).mock.calls[0][1] as { $set: Record<string, unknown> }).$set["argoCd.initializingAt"]
        expect(saveFilters[0]["argoCd.initializingAt"]).toBe(acquired)
        for (let index = 1; index < saveFilters.length; index++) {
            expect(saveFilters[index]["argoCd.initializingAt"]).toEqual(saved[index - 1].initializingAt)
        }
    })

    it("given the lease taken over by another run, when it saves, then it stops as ARGOCD_LEASE_LOST and the deploy token it could not store is revoked", async () => {
        vi.mocked(Project.updateOne).mockImplementation(((_filter: unknown, update: { $set?: unknown }) => Promise.resolve({ matchedCount: update.$set ? 0 : 1 })) as never)

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_LEASE_LOST", statusCode: 409 })

        expect(calls).toContain("gitlab:revokeDeployToken:101:8")
        expect(calls.some(call => call.startsWith("argo:upsertApplicationSet"))).toBe(false)
    })

    it("given a GitLab repository with a deploy token, when it is initialized again, then a new token is created, handed to Argo CD and only then the old one revoked", async () => {
        previous = { url: ARGO_URL, token: "argo-token", repositories: { configuration: deployTokenCredential() } }

        await initialize()

        const rotation = calls.filter(call => call.startsWith("gitlab:") || call.includes("shop-config"))
        expect(rotation).toEqual(["gitlab:createDeployToken:101", `argo:upsertRepository:${CONFIG_REPO}:gitlab+deploy-token-8:gldt-new:${PROJECT_NAME}`, "gitlab:revokeDeployToken:101:7"])
    })

    it("given both repositories, when it is initialized, then the configuration one is scoped to the AppProject and the applications one is global", async () => {
        await initialize()

        expect(calls).toContain(`argo:upsertRepository:${CONFIG_REPO}:gitlab+deploy-token-8:gldt-new:${PROJECT_NAME}`)
        expect(calls).toContain(`argo:upsertRepository:${APPS_REPO}:x-access-token:ghp-read-only:global`)
    })

    it("given the applications repository registered globally by another project of the organization, when it is initialized, then it reads through that registration: no conflict, nothing overwritten", async () => {
        vi.mocked(Project.find).mockResolvedValue([{ slug: "portal", argoCd: { repositories: { applications: manualCredential({ repoUrl: APPS_REPO }) } } }] as never)
        vi.mocked(ArgoCdClient.prototype.getRepository).mockImplementation(async repo => (repo === APPS_REPO ? ({ repo } as never) : null))

        await initialize()

        expect(calls.some(call => call.startsWith(`argo:upsertRepository:${APPS_REPO}`))).toBe(false)
        expect(calls).toContain(`argo:upsertRepository:${CONFIG_REPO}:gitlab+deploy-token-8:gldt-new:${PROJECT_NAME}`)
        expect(saved.at(-1)?.repositories?.applications).toMatchObject({ source: "shared", repoUrl: APPS_REPO, argoCdUrl: ARGO_URL, password: "" })
        expect(saved.at(-1)?.lastError).toBeUndefined()
    })

    it("given another project that only reads through a registration too, when it is initialized, then that one is no holder and the conflict stands", async () => {
        vi.mocked(Project.find).mockResolvedValue([{ slug: "portal", argoCd: { repositories: { applications: manualCredential({ repoUrl: APPS_REPO, source: "shared" }) } } }] as never)
        vi.mocked(ArgoCdClient.prototype.getRepository).mockImplementation(async repo => (repo === APPS_REPO ? ({ repo } as never) : null))

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_REPOSITORY_CONFLICT" })
    })

    it("given a registration another project reads through, when the project that made it links another repository, then the registration is left in place", async () => {
        previous = { url: ARGO_URL, token: "argo-token", repositories: { applications: manualCredential({ repoUrl: "https://github.com/acme/old-apps.git" }) } }
        vi.mocked(Project.exists).mockResolvedValue({ _id: new Types.ObjectId() } as never)

        await initialize()

        expect(calls.some(call => call.startsWith("argo:deleteRepository:https://github.com/acme/old-apps.git"))).toBe(false)
    })

    it("given a GitHub repository and no token pasted nor stored, when it is initialized, then it is refused and the failure is stored", async () => {
        await expect(initialize({ repositoryToken: undefined })).rejects.toMatchObject({ code: "ARGOCD_REPOSITORY_TOKEN_REQUIRED" })

        expect(calls.some(call => call.includes("shop-apps"))).toBe(false)
        expect(saved.at(-1)?.lastError).toMatchObject({ code: "ARGOCD_REPOSITORY_TOKEN_REQUIRED", details: { repository: "shop-apps" } })
    })

    it("given a repository token stored, when it is initialized without one, then the stored one is used for GitHub", async () => {
        previous = { url: ARGO_URL, token: "argo-token", repositories: { applications: manualCredential() } }

        await initialize({ repositoryToken: undefined, token: "••••••••••••" })

        expect(calls).toContain(`argo:upsertRepository:${APPS_REPO}:x-access-token:ghp-stored:global`)
    })

    it("given a repository token stored, when it is initialized against another URL without one, then the stored one is not sent there", async () => {
        previous = { url: ARGO_URL, token: "argo-token", repositories: { applications: manualCredential() } }

        await expect(initialize({ url: "https://elsewhere.example.com", repositoryToken: undefined })).rejects.toMatchObject({ code: "ARGOCD_REPOSITORY_TOKEN_REQUIRED" })

        expect(calls.some(call => call.includes("ghp-stored"))).toBe(false)
    })

    it("given an Argo CD that refuses the repository, when the deploy token was just created, then that token is revoked", async () => {
        vi.mocked(ArgoCdClient.prototype.upsertRepository).mockRejectedValue(createBusinessException({ code: "ARGOCD_FORBIDDEN", message: "forbidden", statusCode: 422 }))

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_FORBIDDEN" })

        expect(calls).toContain("gitlab:revokeDeployToken:101:8")
        expect(saved.at(-1)?.repositories).toEqual({})
    })

    it("given a credential handed to Argo CD, when a later step fails, then it was stored before the failure", async () => {
        vi.mocked(ArgoCdClient.prototype.upsertApplicationSet).mockRejectedValue(new Error("boom"))

        await expect(initialize()).rejects.toThrow("boom")

        expect(saved[0].repositories?.configuration).toMatchObject({ source: "deployToken", password: "gldt-new", deployTokenId: 8, gitlabProjectId: 101, repoUrl: CONFIG_REPO })
        expect(saved.at(-1)).toMatchObject({ url: ARGO_URL, token: "argo-token", lastError: { message: "boom" }, repositories: { configuration: { password: "gldt-new" } } })
    })

    it("given the failure cannot be stored, when it is initialized, then the original error goes on", async () => {
        vi.mocked(ArgoCdClient.prototype.upsertApplicationSet).mockRejectedValue(new Error("boom"))
        vi.mocked(Project.updateOne).mockImplementation(((_filter: unknown, update: { $set?: { argoCd: IProjectArgoCd } }) =>
            update.$set?.argoCd.lastError ? Promise.reject(new Error("database down")) : Promise.resolve({ matchedCount: 1 })) as never)

        await expect(initialize()).rejects.toThrow("boom")
    })

    it("given an environment deleted since, when it is initialized again, then its ApplicationSet is deleted and the generated applications are left alone", async () => {
        applicationSets = [
            resource(ENVIRONMENTS_SET, { template: { spec: { project: PROJECT_NAME } } }),
            resource(applicationSetNameOf("orders"), { template: { spec: { project: PROJECT_NAME } } }),
            resource(applicationSetNameOf("deleted"), { template: { spec: { project: PROJECT_NAME } } })
        ]

        await initialize()

        expect(calls.filter(call => call.startsWith("argo:delete"))).toEqual([`argo:deleteApplicationSet:${applicationSetNameOf("deleted")}`])
        expect(vi.mocked(ArgoCdClient.prototype.listApplicationSets).mock.calls).toEqual([[`${PROJECT_ID_LABEL}=${projectId}`, PROJECT_NAME]])
        expect(ArgoCdClient.prototype.listApplications).not.toHaveBeenCalled()
    })

    describe("given a project initialized by 10.x, its AppProject named without the prefix", () => {
        const EARLIER = unprefixedProjectName(String(projectId), "shop")
        const earlier = (name: string) => resource(name, { template: { spec: { project: EARLIER } } })

        beforeEach(() => {
            previous = { url: ARGO_URL, token: "argo-token", repositories: { configuration: deployTokenCredential({ argoProject: EARLIER }) } }
            vi.mocked(ArgoCdClient.prototype.getProject).mockImplementation(async name => (name === EARLIER ? resource(EARLIER, {}) : null))
            vi.mocked(ArgoCdClient.prototype.listApplicationSets).mockImplementation(async (_selector, appProject) =>
                appProject === EARLIER ? [earlier(EARLIER.replace(/-([0-9a-f]{6})$/, "-orders-$1")), earlier(EARLIER.replace(/-([0-9a-f]{6})$/, "-environments-$1"))] : []
            )
        })

        it("when it is initialized again, then its ApplicationSets there go once those of now are in, and then the old AppProject", async () => {
            await initialize()

            expect(calls).toContain(`argo:upsertProject:${PROJECT_NAME}`)
            const deleted = calls.filter(call => call.startsWith("argo:delete") && !call.startsWith("argo:deleteRepository"))
            expect(deleted).toEqual([
                `argo:deleteApplicationSet:${EARLIER.replace(/-([0-9a-f]{6})$/, "-orders-$1")}`,
                `argo:deleteApplicationSet:${EARLIER.replace(/-([0-9a-f]{6})$/, "-environments-$1")}`,
                `argo:deleteProject:${EARLIER}`
            ])
            expect(calls.indexOf(deleted[0])).toBeGreaterThan(calls.indexOf(`argo:upsertApplicationSet:${applicationSetNameOf("checkout")}`))
            expect(vi.mocked(ArgoCdClient.prototype.listApplicationSets).mock.calls).toEqual([
                [`${PROJECT_ID_LABEL}=${projectId}`, PROJECT_NAME],
                [`${PROJECT_ID_LABEL}=${projectId}`, EARLIER]
            ])
        })

        it("when it is initialized again, then its configuration repository is no conflict: registered for the new AppProject, the old registration deleted", async () => {
            vi.mocked(ArgoCdClient.prototype.getRepository).mockImplementation(async repo => (repo === CONFIG_REPO ? { repo, project: EARLIER } : null))

            await initialize()

            expect(calls).toContain(`argo:upsertRepository:${CONFIG_REPO}:gitlab+deploy-token-8:gldt-new:${PROJECT_NAME}`)
            expect(calls).toContain(`argo:deleteRepository:${CONFIG_REPO}:${EARLIER}`)
        })

        it("when the old AppProject still carries only the mfe-orchestrator label, as its upsert never refreshed the labels, then it is its own and moved", async () => {
            vi.mocked(ArgoCdClient.prototype.getProject).mockImplementation(async name =>
                name === EARLIER ? { metadata: { name, labels: { "mfe-orchestrator/project-id": String(projectId) } }, spec: {} } : null
            )
            vi.mocked(ArgoCdClient.prototype.getRepository).mockImplementation(async repo => (repo === CONFIG_REPO ? { repo, project: EARLIER } : null))

            await initialize()

            expect(calls).toContain(`argo:upsertRepository:${CONFIG_REPO}:gitlab+deploy-token-8:gldt-new:${PROJECT_NAME}`)
            expect(calls).toContain(`argo:deleteProject:${EARLIER}`)
        })

        it("when Argo CD refuses the old AppProject while its Applications are being deleted, then the initialization goes through", async () => {
            vi.mocked(ArgoCdClient.prototype.deleteProject).mockRejectedValue(new Error("referenced by 2 applications"))

            await expect(initialize()).resolves.toMatchObject({ initializedAt: expect.any(Date) })
        })

        it("when the account may no longer read the old AppProject, then it stops before anything is written", async () => {
            vi.mocked(ArgoCdClient.prototype.getProject).mockImplementation(async name =>
                name === EARLIER ? Promise.reject(createBusinessException({ code: "ARGOCD_FORBIDDEN", message: "forbidden", statusCode: 422 })) : null
            )

            await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_FORBIDDEN" })

            expect(calls.some(call => call.startsWith("argo:upsert") || call.startsWith("gitlab:"))).toBe(false)
        })
    })

    it("given a project never initialized, when the account may not read the AppProject named without the prefix, then that one is none of its own", async () => {
        vi.mocked(ArgoCdClient.prototype.getProject).mockImplementation(async name =>
            name === PROJECT_NAME ? null : Promise.reject(createBusinessException({ code: "ARGOCD_FORBIDDEN", message: "forbidden", statusCode: 422 }))
        )

        await initialize()

        expect(calls.some(call => call.startsWith("argo:deleteProject"))).toBe(false)
        expect(ArgoCdClient.prototype.listApplicationSets).not.toHaveBeenCalledWith(expect.anything(), unprefixedProjectName(String(projectId), "shop"))
    })

    it("given leftovers gone between the listing and the delete, when it is initialized, then the 404 of Argo CD does not fail it", async () => {
        applicationSets = [resource(applicationSetNameOf("deleted"), { template: { spec: { project: PROJECT_NAME } } })]
        vi.mocked(ArgoCdClient.prototype.deleteApplicationSet).mockRestore()
        const remove = vi.fn().mockRejectedValue(Object.assign(new AxiosError("Request failed with status code 404"), { response: { status: 404 } }))
        vi.spyOn(axios, "create").mockReturnValue({ delete: remove } as never)

        await expect(initialize()).resolves.toBeDefined()

        expect(remove).toHaveBeenCalledWith(`/applicationsets/${encodeURIComponent(applicationSetNameOf("deleted"))}`)
    })

    it("given a labelled ApplicationSet of another AppProject, when it is initialized, then it is not deleted", async () => {
        applicationSets = [resource(applicationSetNameOf("deleted"), { template: { spec: { project: "someone-else" } } })]

        await initialize()

        expect(calls.some(call => call.startsWith("argo:deleteApplicationSet"))).toBe(false)
    })

    it("given an applications repository no longer linked, when it is initialized again, then its registration is deleted and its credentials forgotten", async () => {
        previous = { url: ARGO_URL, token: "argo-token", repositories: { applications: manualCredential() } }
        gitOps = { enabled: true, codeRepository: configurationLink }

        await initialize()

        expect(calls).toContain(`argo:deleteRepository:${APPS_REPO}:global`)
        expect(saved.at(-1)?.repositories).not.toHaveProperty("applications")
    })

    it("given a configuration repository moved to GitHub, when it is initialized again, then the old registration is deleted and the old deploy token revoked through its own connection", async () => {
        previous = { url: ARGO_URL, token: "argo-token", repositories: { configuration: deployTokenCredential() } }
        gitOps = { enabled: true, codeRepository: { ...applicationsLink, name: "shop-config-gh" } }

        await initialize()

        expect(calls).toContain(`argo:deleteRepository:${CONFIG_REPO}:${PROJECT_NAME}`)
        expect(calls).toContain("gitlab:revokeDeployToken:101:7")
    })

    it("given another Argo CD URL, when it is initialized, then the old registrations are left there but the old deploy tokens are revoked", async () => {
        previous = { url: "https://old.example.com", token: "old-token", repositories: { configuration: deployTokenCredential({ argoCdUrl: "https://old.example.com" }) } }

        await initialize()

        expect(calls.some(call => call.startsWith("argo:deleteRepository"))).toBe(false)
        expect(calls).toContain("gitlab:revokeDeployToken:101:7")
    })

    it("given a repository registered in Argo CD by someone else, when it is initialized, then it is refused before anything is written", async () => {
        vi.mocked(ArgoCdClient.prototype.getRepository).mockImplementation(async repo => (repo === APPS_REPO ? { repo } : null))

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_REPOSITORY_CONFLICT" })

        expect(calls.some(call => call.startsWith("argo:upsert") || call.startsWith("gitlab:"))).toBe(false)
    })

    it("given a project, when it is initialized, then the console makes no Application: the ApplicationSet of the environments and one per deployable backend and frontend", async () => {
        await initialize()

        expect(calls.filter(call => call.startsWith("argo:upsertApplication"))).toEqual([
            `argo:upsertApplicationSet:${ENVIRONMENTS_SET}`,
            `argo:upsertApplicationSet:${applicationSetNameOf("orders")}`,
            `argo:upsertApplicationSet:${applicationSetNameOf("checkout")}`
        ])
        expect(calls).toContain(`argo:upsertProject:${PROJECT_NAME}`)
    })

    it("given an ApplicationSet of the project no longer made, when it is initialized again, then it is deleted once those of the applications are in", async () => {
        applicationSets = [resource(applicationSetNameOf("deleted"), { template: { spec: { project: PROJECT_NAME } } })]

        await initialize()

        expect(calls.indexOf(`argo:deleteApplicationSet:${applicationSetNameOf("deleted")}`)).toBeGreaterThan(calls.indexOf(`argo:upsertApplicationSet:${applicationSetNameOf("checkout")}`))
    })

    it("given an environment without a branch yet, when it is initialized, then the ApplicationSets of the applications leave it out", async () => {
        let orders: ArgoCdResource | undefined
        vi.mocked(ArgoCdClient.prototype.upsertApplicationSet).mockImplementation(async applicationSet => {
            if (applicationSet.metadata.name === applicationSetNameOf("orders")) orders = applicationSet
        })

        await initialize()

        expect(JSON.stringify(orders)).toContain(applicationName(String(projectId), "shop", "orders", "development"))
        expect(JSON.stringify(orders)).not.toContain(applicationName(String(projectId), "shop", "orders", "production"))
    })

    it("given a backend whose Application would take the name of another, when it is initialized, then it is refused before anything is written", async () => {
        vi.mocked(Environment.find).mockResolvedValue([
            { slug: "development", projectId },
            { slug: "checkout-development", projectId }
        ] as never)
        vi.mocked(Backend.find).mockResolvedValue([{ slug: "orders-checkout", version: "1", image: { repository: "orders" } }] as never)
        vi.mocked(Frontend.find).mockResolvedValue([{ slug: "orders", version: "1", image: { repository: "orders" } }] as never)
        vi.mocked(CodeRepositoryService.prototype.getBranches).mockResolvedValue([{ branch: "development" }, { branch: "checkout-development" }] as never)

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_NAME_CLASH" })

        expect(calls.some(call => call.startsWith("argo:upsert") || call.startsWith("gitlab:"))).toBe(false)
    })

    it("given a success, when it is initialized, then the URL has no trailing slash, the error is cleared and the answer holds no credential", async () => {
        previous = { url: ARGO_URL, token: "argo-token", lastError: { message: "earlier" } }

        const status = await initialize()

        expect(saved.at(-1)).toMatchObject({ url: ARGO_URL, token: "argo-token", initializedAt: expect.any(Date) })
        expect(saved.at(-1)?.lastError).toBeUndefined()
        expect(status).toMatchObject({ url: ARGO_URL, configured: true, needsRepositoryToken: true, repositoryTokenProviders: ["GITHUB"], repositoryTokenStored: true, canInitialize: true })
        expect(JSON.stringify(status)).not.toMatch(/argo-token|gldt-new|ghp-read-only/)
    })

    it.each([
        ["AppProject", "getProject"],
        ["Application", "getApplication"],
        ["ApplicationSet", "getApplicationSet"]
    ] as const)("given an %s of the same name made for another project, when it is initialized, then it is refused before anything is written", async (_kind, method) => {
        vi.mocked(ArgoCdClient.prototype[method]).mockResolvedValue(resource("taken", {}, { [PROJECT_ID_LABEL]: "someone-else" }))

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_NAME_CONFLICT" })

        expect(calls.some(call => call.startsWith("argo:upsert") || call.startsWith("gitlab:"))).toBe(false)
    })

    it.each([
        ["getProject", "ARGOCD_NAME_CONFLICT"],
        ["getApplication", "ARGOCD_NAME_CONFLICT"],
        ["getApplicationSet", "ARGOCD_NAME_CONFLICT"]
    ] as const)("given %s refused as forbidden, when it is initialized, then something the account cannot see is there and it is refused as %s", async (method, code) => {
        vi.mocked(ArgoCdClient.prototype[method]).mockRejectedValue(createBusinessException({ code: "ARGOCD_FORBIDDEN", message: "forbidden", statusCode: 422 }))

        await expect(initialize()).rejects.toMatchObject({ code })

        expect(calls.some(call => call.startsWith("argo:upsert") || call.startsWith("gitlab:"))).toBe(false)
    })

    it("given a registration Argo CD does not delete, when the repository is no longer linked, then it is kept for the next run while its credentials go", async () => {
        previous = { url: ARGO_URL, token: "argo-token", repositories: { applications: manualCredential() } }
        gitOps = { enabled: true, codeRepository: configurationLink }
        vi.mocked(ArgoCdClient.prototype.deleteRepository).mockRejectedValue(new Error("argo down"))

        await initialize()

        expect(saved.at(-1)?.pendingRepositoryDeletions).toEqual([{ argoCdUrl: ARGO_URL, repoUrl: APPS_REPO, argoProject: undefined }])
        expect(saved.at(-1)?.repositories).not.toHaveProperty("applications")
    })

    it("given a registration left by an earlier run, when it is initialized again, then its deletion is retried and it goes once done", async () => {
        previous = { url: ARGO_URL, token: "argo-token", pendingRepositoryDeletions: [{ argoCdUrl: ARGO_URL, repoUrl: "https://github.com/acme/old.git" }] }

        await initialize()

        expect(calls).toContain("argo:deleteRepository:https://github.com/acme/old.git:global")
        expect(saved.at(-1)?.pendingRepositoryDeletions).toEqual([])
    })

    it("given another URL and no token, when it is initialized, then the stored token is not sent there", async () => {
        previous = { url: ARGO_URL, token: "argo-token" }

        await expect(initialize({ url: "https://elsewhere.example.com", token: undefined })).rejects.toMatchObject({ code: "ARGOCD_TOKEN_REQUIRED" })

        expect(calls).toEqual([])
    })

    it("given a self-signed certificate accepted, when it is initialized, then the choice is stored and shown", async () => {
        const status = await initialize({ insecure: true })

        expect(saved.at(-1)).toMatchObject({ url: ARGO_URL, insecure: true, initializedAt: expect.any(Date) })
        expect(status.insecure).toBe(true)
    })

    it("given a certificate accepted before, when it is initialized without the choice, then the certificate is verified again", async () => {
        previous = { url: ARGO_URL, token: "argo-token", insecure: true }

        const status = await initialize()

        expect(saved.at(-1)?.insecure).toBe(false)
        expect(status.insecure).toBe(false)
    })

    it("given an http URL, when the installation does not allow it, then it is refused", async () => {
        await expect(initialize({ url: "http://argocd.example.com" })).rejects.toMatchObject({ code: "ARGOCD_URL_INSECURE" })

        expect(calls).toEqual([])
    })

    it("given GitOps turned off, when it is initialized, then it is refused", async () => {
        gitOps = { enabled: false }

        await expect(initialize()).rejects.toMatchObject({ code: "ARGOCD_GITOPS_REQUIRED" })
    })

    it("given someone who is not an owner, when it is initialized, then it is refused", async () => {
        vi.mocked(GitOpsService.prototype.ensureOwner).mockRejectedValue(Object.assign(new Error("owner"), { code: "GITOPS_OWNER_REQUIRED" }))

        await expect(initialize()).rejects.toMatchObject({ code: "GITOPS_OWNER_REQUIRED" })
        expect(calls).toEqual([])
    })
})

describe("ArgoCdService.alignApplications", () => {
    const align = () => new ArgoCdService().alignApplications(toObjectId(String(projectId)))
    const initialized = (overrides: Partial<IProjectArgoCd> = {}): IProjectArgoCd => ({
        url: ARGO_URL,
        token: "argo-token",
        initializedAt: new Date(),
        repositories: { configuration: deployTokenCredential(), applications: manualCredential() },
        ...overrides
    })
    const updates = () => vi.mocked(Project.updateOne).mock.calls.map(([filter, update]) => ({ filter, update: update as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> } }))
    const storedError = () => updates().find(({ update }) => update.$set?.["argoCd.alignError"])

    beforeEach(() => {
        // As the initialization left it: the namespaces of both environments, the custom one of production included
        const destinations = ["development", "prod"].map(namespace => ({ server: "https://kubernetes.default.svc", namespace }))
        vi.mocked(ArgoCdClient.prototype.getProject).mockResolvedValue(resource(PROJECT_NAME, { destinations }))
    })

    it("given Argo CD initialized, when a deploy aligns it, then the ApplicationSet of every deployable backend and frontend is upserted and nothing else", async () => {
        previous = initialized()

        await align()

        expect(calls.filter(call => call.startsWith("argo:"))).toEqual([`argo:upsertApplicationSet:${applicationSetNameOf("orders")}`, `argo:upsertApplicationSet:${applicationSetNameOf("checkout")}`])
        expect(storedError()).toBeUndefined()
    })

    it("given a container registry in the project, when a deploy aligns it, then a backend with a version and no image gets its ApplicationSet too", async () => {
        previous = initialized()
        vi.mocked(Project.findById).mockImplementation(() => ({ _id: projectId, slug: "shop", gitOps, argoCd: previous, containerRegistry: "ghcr.io/acme" }) as never)
        vi.mocked(Backend.find).mockResolvedValue([{ slug: "draft", version: "0.1.0" }] as never)

        await align()

        expect(calls).toContain(`argo:upsertApplicationSet:${applicationSetNameOf("draft")}`)
    })

    it("given an environment added since the initialization, when a deploy aligns it, then the ApplicationSets leave it out until its namespace is in the AppProject", async () => {
        previous = initialized()
        vi.mocked(CodeRepositoryService.prototype.getBranches).mockResolvedValue([{ branch: "development" }, { branch: "production" }] as never)
        vi.mocked(ArgoCdClient.prototype.getProject).mockResolvedValue(resource(PROJECT_NAME, { destinations: [{ server: "https://kubernetes.default.svc", namespace: "development" }] }))
        let orders: ArgoCdResource | undefined
        vi.mocked(ArgoCdClient.prototype.upsertApplicationSet).mockImplementation(async applicationSet => {
            if (applicationSet.metadata.name === applicationSetNameOf("orders")) orders = applicationSet
        })

        await align()

        expect(JSON.stringify(orders)).toContain(applicationName(String(projectId), "shop", "orders", "development"))
        expect(JSON.stringify(orders)).not.toContain(applicationName(String(projectId), "shop", "orders", "production"))
        expect(storedError()?.update.$set?.["argoCd.alignError"]).toMatchObject({ code: "ARGOCD_NAMESPACES_NOT_IN_PROJECT", details: { slug: "production" } })
    })

    it("given a deployed environment the applications repository lists no branch for, when the deploy aligns it, then the settings name it and the branches read", async () => {
        previous = initialized()
        vi.mocked(CodeRepositoryService.prototype.getBranches).mockResolvedValue([{ branch: "main" }, { branch: "development" }] as never)

        await new ArgoCdService().alignApplications(toObjectId(String(projectId)), ["production"])

        expect(calls).toContain(`argo:upsertApplicationSet:${applicationSetNameOf("orders")}`)
        expect(storedError()?.update.$set?.["argoCd.alignError"]).toMatchObject({ code: "ARGOCD_ENVIRONMENTS_WITHOUT_BRANCH", details: { slug: "production", name: "main, development" } })
    })

    it("given a deployed environment whose branch differs only in case, when the deploy aligns it, then it deploys from that branch and nothing is reported", async () => {
        previous = initialized()
        vi.mocked(CodeRepositoryService.prototype.getBranches).mockResolvedValue([{ branch: "development" }, { branch: "PRODUCTION" }] as never)
        let orders: ArgoCdResource | undefined
        vi.mocked(ArgoCdClient.prototype.upsertApplicationSet).mockImplementation(async applicationSet => {
            if (applicationSet.metadata.name === applicationSetNameOf("orders")) orders = applicationSet
        })

        await new ArgoCdService().alignApplications(toObjectId(String(projectId)), ["production"])

        expect(JSON.stringify(orders)).toContain('"branch":"PRODUCTION"')
        expect(storedError()).toBeUndefined()
    })

    it("given an alignment that failed before, when a deploy aligns it, then the stored failure goes", async () => {
        previous = initialized({ alignError: { message: "earlier" } })

        await align()

        expect(updates().map(({ update }) => update)).toContainEqual({ $unset: { "argoCd.alignError": 1 } })
    })

    it.each([
        ["never initialized", { initializedAt: undefined }],
        ["being initialized", { initializingAt: new Date() }]
    ])("given Argo CD %s, when a deploy aligns it, then nothing is sent to Argo CD nor stored", async (_case, overrides) => {
        previous = initialized(overrides as Partial<IProjectArgoCd>)

        await align()

        expect(calls.some(call => call.startsWith("argo:"))).toBe(false)
        expect(storedError()).toBeUndefined()
    })

    it.each([
        ["initialized before the applications repository was linked", { repositories: { configuration: deployTokenCredential() } }],
        ["initialized with another applications repository", { repositories: { applications: manualCredential({ repoUrl: "https://github.com/acme/old-apps.git" }) } }],
        ["moved to another URL since", { url: "https://other.example.com" }]
    ])("given Argo CD %s, when a deploy aligns it, then nothing is upserted and an initialization is asked for", async (_case, overrides) => {
        previous = initialized(overrides as Partial<IProjectArgoCd>)

        await align()

        expect(calls.some(call => call.startsWith("argo:upsert"))).toBe(false)
        expect(storedError()?.update.$set?.["argoCd.alignError"]).toMatchObject({ code: "ARGOCD_REINITIALIZE_REQUIRED" })
    })

    it("given the AppProject of now not there, initialized by 10.x under the one without the prefix, when a deploy aligns it, then nothing is upserted and an initialization is asked for", async () => {
        previous = initialized()
        vi.mocked(ArgoCdClient.prototype.getProject).mockResolvedValue(null)

        await align()

        expect(calls.some(call => call.startsWith("argo:upsert"))).toBe(false)
        expect(storedError()?.update.$set?.["argoCd.alignError"]).toMatchObject({ code: "ARGOCD_REINITIALIZE_REQUIRED" })
    })

    it("given an ApplicationSet of the same name made for another project, when a deploy aligns it, then nothing is upserted and the failure is stored only while no initialization runs", async () => {
        previous = initialized()
        vi.mocked(ArgoCdClient.prototype.getApplicationSet).mockResolvedValue(resource("taken", {}, { [PROJECT_ID_LABEL]: "someone-else" }))

        await expect(align()).resolves.toBeUndefined()

        expect(calls.some(call => call.startsWith("argo:upsert"))).toBe(false)
        expect(storedError()).toMatchObject({ filter: { "argoCd.initializingAt": { $exists: false } }, update: { $set: { "argoCd.alignError": { code: "ARGOCD_NAME_CONFLICT" } } } })
    })

    it("given a backend named after the ApplicationSet of the environments, when a deploy aligns it, then that one is not overwritten", async () => {
        previous = initialized()
        vi.mocked(Backend.find).mockResolvedValue([{ slug: "environments", version: "1", image: { repository: "environments" } }] as never)

        await align()

        expect(calls.some(call => call.startsWith("argo:upsert"))).toBe(false)
        expect(storedError()?.update.$set?.["argoCd.alignError"]).toMatchObject({ code: "ARGOCD_NAME_CLASH" })
    })

    it("given branches that cannot be read, when a deploy aligns it, then the failure is stored by code", async () => {
        previous = initialized()
        vi.mocked(CodeRepositoryService.prototype.getBranches).mockRejectedValue(new Error("404"))

        await align()

        expect(storedError()?.update.$set?.["argoCd.alignError"]).toMatchObject({ code: "ARGOCD_BRANCHES_FAILED", details: { repository: "shop-apps" } })
    })

    it("given the database failing, when a deploy aligns it, then the deploy that went through is not failed", async () => {
        vi.mocked(Project.findById).mockImplementation(() => Promise.reject(new Error("database down")) as never)

        await expect(align()).resolves.toBeUndefined()
    })
})

describe("ArgoCdService.refreshApplications", () => {
    const refresh = (environments: string[] = ["production"]) => new ArgoCdService().refreshApplications(toObjectId(String(projectId)), environments)
    const refreshed = () => vi.mocked(ArgoCdClient.prototype.refreshApplication).mock.calls

    beforeEach(() => {
        vi.spyOn(ArgoCdClient.prototype, "refreshApplication").mockResolvedValue(undefined)
    })

    it("given Argo CD initialized, when a deploy refreshes it, then the Applications of the project in the deployed environments are refreshed", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        const orders = applicationName(String(projectId), "shop", "orders", "production")
        applications = [resource(environmentName("production")), resource(orders), resource("elsewhere", { project: "another-project" })]

        await refresh(["development", "production"])

        expect(vi.mocked(ArgoCdClient.prototype.listApplications).mock.calls).toEqual([[`${PROJECT_ID_LABEL}=${projectId},${ENVIRONMENT_LABEL} in (development,production)`, PROJECT_NAME]])
        expect(refreshed()).toEqual([
            [environmentName("production"), PROJECT_NAME],
            [orders, PROJECT_NAME]
        ])
    })

    it("given Argo CD never initialized, when a deploy refreshes it, then nothing is sent to Argo CD", async () => {
        previous = { url: ARGO_URL, token: "argo-token" }

        await refresh()

        expect(ArgoCdClient.prototype.listApplications).not.toHaveBeenCalled()
    })

    it("given an Application Argo CD fails to refresh, when a deploy refreshes it, then the others are refreshed and the deploy is not failed", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        applications = [resource(environmentName("production")), resource(environmentName("development"))]
        vi.mocked(ArgoCdClient.prototype.refreshApplication).mockRejectedValueOnce(new Error("unreachable"))

        await expect(refresh(["development", "production"])).resolves.toBeUndefined()

        expect(refreshed()).toHaveLength(2)
    })

    it("given Argo CD unreachable, when a deploy refreshes it, then the deploy is not failed", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        vi.mocked(ArgoCdClient.prototype.listApplications).mockRejectedValue(new Error("unreachable"))

        await expect(refresh()).resolves.toBeUndefined()
    })
})

describe("ArgoCdService.get", () => {
    it("given stored credentials, when the status is read, then only their source comes back", async () => {
        previous = {
            url: ARGO_URL,
            token: "argo-token",
            initializedAt: new Date(),
            repositories: { configuration: deployTokenCredential(), applications: manualCredential() }
        }

        const status = await new ArgoCdService().get(String(projectId))

        expect(status.repositories).toEqual({ configuration: { source: "deployToken" }, applications: { source: "manual" } })
        expect(JSON.stringify(status)).not.toMatch(/argo-token|gldt-old|ghp-stored/)
    })

    it("given someone who is not an owner, when the status is read, then it comes back without the right to initialize", async () => {
        vi.mocked(GitOpsService.prototype.ensureOwner).mockRejectedValue(new Error("owner"))

        expect((await new ArgoCdService().get(String(projectId))).canInitialize).toBe(false)
    })
})

describe("Project serialization", () => {
    it("given a project with Argo CD credentials, when it is serialized, then Argo CD is left out", () => {
        const project = new Project({ organizationId: new Types.ObjectId(), name: "Shop", slug: "shop", argoCd: { url: ARGO_URL, token: "argo-token" } })

        expect(project.toJSON()).not.toHaveProperty("argoCd")
        expect(JSON.stringify(project)).not.toContain("argo-token")
    })
})

describe("renderNamespace", () => {
    it("given an environment, when its Namespace is rendered, then Argo CD never prunes nor deletes it", () => {
        expect(parse(renderNamespace({ slug: "production" })).metadata.annotations).toEqual({ "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" })
    })
})

describe("ArgoCdService.getLogs", () => {
    const environmentId = new Types.ObjectId()
    const ORDERS_DEVELOPMENT = applicationName(String(projectId), "shop", "orders", "development")

    beforeEach(() => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        vi.spyOn(ArgoCdService.prototype as unknown as { ensureNotViewer: () => Promise<void> }, "ensureNotViewer").mockResolvedValue(undefined)
        vi.spyOn(Environment, "findOne").mockResolvedValue({ slug: "development", projectId } as never)
        vi.spyOn(Backend, "exists").mockImplementation(((filter: { slug: string }) => Promise.resolve(filter.slug === "orders" ? { _id: new Types.ObjectId() } : null)) as never)
        vi.spyOn(Frontend, "exists").mockResolvedValue(null as never)
        vi.spyOn(ArgoCdClient.prototype, "getPodLogs").mockResolvedValue([{ content: "started" }])
        vi.spyOn(ArgoCdClient.prototype, "listPods").mockResolvedValue([{ name: "orders-abc", namespace: "development" }])
    })

    const getLogs = (slug: string, query: Record<string, unknown>) => new ArgoCdService().getLogs(String(projectId), slug, String(environmentId), query)

    it("given a backend of the project, when its logs are read, then Argo CD is asked for those of the pod of its Application, within bounds", async () => {
        const lines = await getLogs("orders", { pod: "orders-abc", tailLines: "99999", sinceSeconds: "", previous: "true", filter: "  ERROR " })

        expect(lines).toEqual([{ content: "started" }])
        expect(ArgoCdClient.prototype.getPodLogs).toHaveBeenCalledWith(ORDERS_DEVELOPMENT, PROJECT_NAME, {
            namespace: "development",
            podName: "orders-abc",
            tailLines: 5000,
            sinceSeconds: undefined,
            previous: true,
            filter: "ERROR"
        })
    })

    it("given no tail, when the logs are read, then the last 500 lines are asked for", async () => {
        await getLogs("orders", { pod: "orders-abc" })

        expect(vi.mocked(ArgoCdClient.prototype.getPodLogs).mock.calls[0][2]).toMatchObject({ tailLines: 500, previous: false })
    })

    it("given a slug that is none of the project's, when its logs are read, then nothing is asked of Argo CD", async () => {
        await expect(getLogs("payments", { pod: "payments-abc" })).rejects.toThrow()

        expect(ArgoCdClient.prototype.getPodLogs).not.toHaveBeenCalled()
    })

    it("given a pod name that is not one, when the logs are read, then it is refused", async () => {
        await expect(getLogs("orders", { pod: "../secrets" })).rejects.toMatchObject({ code: "ARGOCD_LOGS_INVALID" })
    })

    it("given a viewer, when the logs are read, then it is refused before Argo CD is asked", async () => {
        vi.mocked((ArgoCdService.prototype as unknown as { ensureNotViewer: () => Promise<void> }).ensureNotViewer).mockRejectedValue(
            createBusinessException({ code: "ARGOCD_LOGS_FORBIDDEN", message: "viewer", statusCode: 403 })
        )

        await expect(getLogs("orders", { pod: "orders-abc" })).rejects.toMatchObject({ code: "ARGOCD_LOGS_FORBIDDEN" })
        expect(ArgoCdClient.prototype.getPodLogs).not.toHaveBeenCalled()
    })

    it("given Argo CD not initialized, when the pods are listed, then it says so", async () => {
        previous = undefined

        await expect(new ArgoCdService().listPods(String(projectId), "orders", String(environmentId))).rejects.toMatchObject({ code: "ARGOCD_NOT_CONFIGURED" })
    })

    it("given a backend of the project, when its pods are listed, then those of its Application come back", async () => {
        await expect(new ArgoCdService().listPods(String(projectId), "orders", String(environmentId))).resolves.toEqual([{ name: "orders-abc", namespace: "development" }])
        expect(ArgoCdClient.prototype.listPods).toHaveBeenCalledWith(ORDERS_DEVELOPMENT, PROJECT_NAME)
    })
})

describe("ArgoCdService.rollout", () => {
    const environmentId = new Types.ObjectId()
    const deploymentId = new Types.ObjectId()
    const PUSHED = "a1b2c3d"
    const rollout = (domainId?: string) => new ArgoCdService().rollout(String(projectId), String(deploymentId), domainId)
    const deployed = (slug: string, status: ArgoCdResource["status"]): ArgoCdResource => ({ ...resource(applicationName(String(projectId), "shop", slug, "development")), status })
    const synced = (health: string, revision = PUSHED): ArgoCdResource["status"] => ({ sync: { status: "Synced", revision }, health: { status: health } })
    let later: Array<{ applicationsRevision: string }>
    let shipped: Record<string, unknown>
    let before: Record<string, unknown> | null

    beforeEach(() => {
        later = []
        shipped = {}
        before = null
        vi.spyOn(Deployment, "findById").mockImplementation((async () => ({ _id: deploymentId, environmentId, applicationsRevision: PUSHED, ...shipped })) as never)
        vi.spyOn(Deployment, "find").mockImplementation((async () => later) as never)
        vi.spyOn(Deployment, "findOne").mockImplementation((async () => before) as never)
        vi.spyOn(Environment, "findOne").mockResolvedValue({ _id: environmentId, slug: "development", projectId } as never)
        vi.spyOn(ArgoCdService.prototype as unknown as { getDomainScope: () => Promise<undefined> }, "getDomainScope").mockResolvedValue(undefined)
        vi.spyOn(ArgoCdClient.prototype, "listPods").mockResolvedValue([{ name: "checkout-7d9-abc", namespace: "development", health: "Progressing", containers: "0/1" }])
    })

    it("given a project deploying through no Argo CD, when the rollout is read, then it is not tracked and over with the commit", async () => {
        const result = await rollout()

        expect(result).toMatchObject({ tracked: false, applications: [], done: true, failed: false })
        expect(ArgoCdClient.prototype.listApplications).not.toHaveBeenCalled()
    })

    it("given one application running the deploy and one replacing its pods, when the rollout is read, then it is not done and only the second one's pods are read", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        applications = [deployed("orders", synced("Healthy")), deployed("checkout", synced("Progressing"))]

        const result = await rollout()

        expect(result.tracked).toBe(true)
        expect(result.done).toBe(false)
        // The backend without a version is not deployed: nothing to follow
        expect(result.applications.map(application => [application.slug, application.state])).toEqual([
            ["orders", "healthy"],
            ["checkout", "progressing"]
        ])
        expect(result.applications[1].pods).toEqual([expect.objectContaining({ containers: "0/1" })])
        expect(ArgoCdClient.prototype.listPods).toHaveBeenCalledTimes(1)
        expect(vi.mocked(ArgoCdClient.prototype.listApplications).mock.calls).toEqual([[`${PROJECT_ID_LABEL}=${projectId},${ENVIRONMENT_LABEL}=development`, PROJECT_NAME]])
    })

    it("given a deploy that changed the version of one application only, when the rollout is read, then only that one is updated", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        applications = [deployed("orders", synced("Healthy")), deployed("checkout", synced("Progressing"))]
        const [orders, checkout] = [new Types.ObjectId(), new Types.ObjectId()]
        vi.mocked(Backend.find).mockResolvedValue([{ _id: orders, slug: "orders", version: "1.0.0", image: { repository: "ghcr.io/acme/orders" } }] as never)
        vi.mocked(Frontend.find).mockResolvedValue([{ _id: checkout, slug: "checkout", version: "2.1.0", image: { repository: "ghcr.io/acme/checkout" } }] as never)
        shipped = { backends: [{ _id: orders, version: "1.0.0" }], frontends: [{ _id: checkout, version: "2.1.0" }] }
        // Without a deploy before it, everything is updated
        const result = await rollout()
        before = { backends: [{ _id: orders, version: "1.0.0" }], frontends: [{ _id: checkout, version: "2.0.0" }] }

        const updated = await rollout()

        expect(result.applications.every(application => application.updated)).toBe(true)
        expect(updated.applications.map(application => [application.slug, application.updated])).toEqual([
            ["orders", false],
            ["checkout", true]
        ])
        expect(vi.mocked(Deployment.findOne).mock.calls[0]).toEqual([{ environmentId, _id: { $lt: deploymentId } }, expect.anything(), { sort: { _id: -1 } }])
    })

    it("given Argo CD still on the revision before the deploy, when the rollout is read, then nothing counts as done", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        applications = [deployed("orders", synced("Healthy", "9f8e7d6")), deployed("checkout", synced("Healthy", "9f8e7d6"))]

        const result = await rollout()

        expect(result.applications.every(application => application.state === "waiting")).toBe(true)
        expect(result.done).toBe(false)
    })

    it("given a later deploy pushed on the same branch, when the rollout is read, then Argo CD synced to it holds this deploy too", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        later = [{ applicationsRevision: "e5f6a7b" }]
        applications = [deployed("orders", synced("Healthy", "e5f6a7b")), deployed("checkout", synced("Healthy", "e5f6a7b"))]

        const result = await rollout()

        expect(result.done).toBe(true)
        expect(vi.mocked(Deployment.find).mock.calls[0][0]).toMatchObject({ environmentId, _id: { $gt: deploymentId } })
    })

    it("given an Application the ApplicationSet has not generated yet, when the rollout is read, then that application is waiting", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        applications = []

        const result = await rollout()

        expect(result.applications.every(application => application.state === "waiting")).toBe(true)
    })

    it("given a deploy of one domain, when the rollout is read, then only the applications of that domain are followed", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        const domainId = String(new Types.ObjectId())

        await rollout(domainId)

        expect(vi.mocked(Backend.find).mock.calls[0][0]).toMatchObject({ projectId: toObjectId(String(projectId)), domainId: toObjectId(domainId) })
        expect(vi.mocked(Frontend.find).mock.calls[0][0]).toMatchObject({ projectId: toObjectId(String(projectId)), domainId: toObjectId(domainId), kind: "DOCKER" })
    })

    it("given a member scoped to some domains deploying the whole project, when the rollout is read, then only the applications of those domains are followed", async () => {
        previous = { url: ARGO_URL, token: "argo-token", initializedAt: new Date() }
        const scoped = String(new Types.ObjectId())
        vi.spyOn(ArgoCdService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([scoped])

        await rollout()

        expect(vi.mocked(Backend.find).mock.calls[0][0]).toMatchObject({ domainId: { $in: [toObjectId(scoped)] } })
    })
})
