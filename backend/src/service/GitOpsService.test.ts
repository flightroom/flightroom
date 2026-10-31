import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse, parseAllDocuments } from "yaml"

vi.mock("..", () => ({ fastify: { log: { error: vi.fn() }, config: { REPOSITORIES_FOLDER: "/repositories" } } }))

import Backend from "../models/BackendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import { ConfigMap, Secret } from "../models/VariableMapModel"
import { withNoMaintenanceAgents } from "../testing/noMaintenanceAgents"
import ArgoCdService from "./ArgoCdService"
import CodeRepositoryImportService from "./CodeRepositoryImportService"
import GitOpsService, { leavesAsItIs, renderManifest, renderResourceManifest } from "./GitOpsService"
import { CHART_FILES } from "./gitops/applicationManifests"
import { TemplateScaffoldService } from "./TemplateScaffoldService"
import { GitWorkingCopy } from "./workspace/GitWorkingCopy"

withNoMaintenanceAgents()

const projectId = new Types.ObjectId()
const development = new Types.ObjectId()
const production = new Types.ObjectId()
const connectionId = new Types.ObjectId()
const link = { enabled: true, codeRepositoryId: connectionId, repositoryId: "42", name: "platform-config", repositoryData: {} }

type GitOpsFile = { path: string; action: string; content?: string }
type CommitOptions = { branch?: string; prune?: (path: string) => boolean }
type Commit = (message: string, files: (GitOpsFile & { ifMissing?: boolean; replaces?: string[] })[], options?: CommitOptions) => Promise<GitOpsFile[]>
/** The commit of the configuration repository, and the one of the applications repository */
let commit: ReturnType<typeof vi.fn<Commit>>
let applicationsCommit: ReturnType<typeof vi.fn<Commit>>
type InRepository = (projectId: unknown, kind: string, link: unknown, task: (commit: Commit) => Promise<unknown>) => Promise<unknown>

beforeEach(() => {
    vi.spyOn(GitOpsService.prototype as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue(undefined)
    vi.spyOn(GitOpsService.prototype as unknown as { ensureNotViewer: () => Promise<void> }, "ensureNotViewer").mockResolvedValue(undefined)
    vi.spyOn(GitOpsService.prototype as unknown as { ensureOwner: () => Promise<void> }, "ensureOwner").mockResolvedValue(undefined)
    // The repository is not cloned: the task gets a commit that records what it would push
    commit = vi.fn<Commit>().mockResolvedValue([])
    applicationsCommit = vi.fn<Commit>().mockResolvedValue([])
    vi.spyOn(GitOpsService.prototype as unknown as { inRepository: InRepository }, "inRepository").mockImplementation((_projectId, kind, _link, task) =>
        task(kind === "applications" ? applicationsCommit : commit)
    )
    vi.spyOn(Environment, "find").mockResolvedValue([
        { _id: development, slug: "development", projectId },
        { _id: production, slug: "production", projectId }
    ] as never)
    vi.spyOn(CodeRepository, "findOne").mockResolvedValue({ _id: connectionId, name: "GitHub", provider: "GITHUB", accessToken: "token", githubData: { organizationId: "acme" } } as never)
})

afterEach(() => {
    vi.restoreAllMocks()
})

const map = {
    name: "orders",
    entries: [
        {
            key: "LOG_LEVEL",
            values: [
                { environmentId: String(development), value: "debug" },
                { environmentId: String(production), value: "info" }
            ]
        },
        { key: "FEATURE_X", values: [{ environmentId: String(production), value: "true" }] }
    ]
}

describe("renderManifest", () => {
    it("given a config map, when it is rendered for an environment, then it is a ConfigMap with only the keys set there", () => {
        expect(parse(renderManifest("configMap", map, String(development)))).toEqual({
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: "orders", labels: { "app.kubernetes.io/managed-by": "flightroom" } },
            data: { LOG_LEVEL: "debug" }
        })
    })

    it("given a secret, when it is rendered, then it is an Opaque Secret carrying the values base64 encoded as data", () => {
        const manifest = parse(renderManifest("secret", map, String(production)))
        expect(manifest).toMatchObject({ kind: "Secret", type: "Opaque", data: { LOG_LEVEL: "aW5mbw==", FEATURE_X: "dHJ1ZQ==" } })
        expect(manifest.stringData).toBeUndefined()
    })

    it("given a value YAML would read as another type, when it is rendered, then it stays a string", () => {
        const manifest = parse(renderManifest("configMap", { name: "flags", entries: [{ key: "ENABLED", values: [{ environmentId: String(production), value: "true" }] }] }, String(production)))
        expect(manifest.data.ENABLED).toBe("true")
    })
})

describe("renderResourceManifest", () => {
    const resource = {
        name: "orders",
        type: "database",
        variant: "credentials",
        values: [
            { field: "engine", value: "POSTGRESQL", overrides: [] },
            { field: "host", value: "db.internal", overrides: [{ environmentId: production, value: "db.prod.internal" }] },
            { field: "port", value: "5432", overrides: [] }
        ],
        secrets: [{ field: "password", overrides: [{ environmentId: production, value: "s3cret" }] }]
    }
    const decoded = (manifest: { data: Record<string, string> }) => Object.fromEntries(Object.entries(manifest.data).map(([key, value]) => [key, Buffer.from(value, "base64").toString()]))

    it("given a resource, when it is rendered for an environment that overrides it, then it is one Opaque Secret named after it with the overrides and the rest of all", () => {
        const manifest = parse(renderResourceManifest(resource, String(production), "prod"))

        expect(manifest).toMatchObject({
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: { name: "orders.resource", namespace: "prod", labels: { "app.kubernetes.io/managed-by": "flightroom" } }
        })
        expect(decoded(manifest)).toEqual({ DB_ORDERS_ENGINE: "POSTGRESQL", DB_ORDERS_HOST: "db.prod.internal", DB_ORDERS_PORT: "5432", DB_ORDERS_PASSWORD: "s3cret" })
    })

    it("given an environment that overrides nothing, when it is rendered, then the values of all are there and a field set nowhere is left out", () => {
        expect(decoded(parse(renderResourceManifest(resource, String(development))))).toEqual({ DB_ORDERS_ENGINE: "POSTGRESQL", DB_ORDERS_HOST: "db.internal", DB_ORDERS_PORT: "5432" })
    })

    it("given a storage on AWS, when it is rendered, then the fixed provider is among its keys", () => {
        const media = { name: "media", type: "storage", variant: "aws", values: [{ field: "region", value: "eu-west-1", overrides: [] }], secrets: [] }

        expect(decoded(parse(renderResourceManifest(media, String(production))))).toEqual({ STORAGE_MEDIA_REGION: "eu-west-1", STORAGE_MEDIA_PROVIDER: "AWS" })
    })

    it("given an api with a pasted document, when it is rendered, then the document is not in the Secret", () => {
        const payments = { name: "payments", type: "api", variant: "none", values: [{ field: "baseUrl", value: "https://payments.example.com", overrides: [] }], apiSpec: '{"openapi":"3.1.0"}' }

        const content = renderResourceManifest(payments, String(production))

        expect(decoded(parse(content))).toEqual({ API_PAYMENTS_BASE_URL: "https://payments.example.com", API_PAYMENTS_AUTH: "none" })
        expect(content).not.toContain(Buffer.from('{"openapi":"3.1.0"}').toString("base64"))
    })
})

describe("GitOpsService.resolveSettings", () => {
    const repository = { repositoryId: "42", name: "platform-config", cloneUrlHttps: "https://github.com/acme/platform-config.git" }
    const applicationsRepository = { repositoryId: "43", name: "platform-apps", cloneUrlHttps: "https://github.com/acme/platform-apps.git" }
    const applicationsLink = { enabled: true, codeRepositoryId: connectionId, repositoryId: "43", name: "platform-apps", repositoryData: {} }

    beforeEach(() => {
        vi.spyOn(CodeRepositoryImportService.prototype, "fetchRepositories").mockResolvedValue([repository, applicationsRepository])
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId } as never)
    })

    it("given GitOps turned on, when the settings are resolved, then the repository is resolved and nothing is committed", async () => {
        const settings = await new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId), repositoryId: "42" })

        expect(settings).toMatchObject({ enabled: true, codeRepository: { codeRepositoryId: connectionId, repositoryId: "42", name: "platform-config" } })
        expect(settings.applicationsCodeRepository).toBeUndefined()
        expect(commit).not.toHaveBeenCalled()
        expect(applicationsCommit).not.toHaveBeenCalled()
    })

    it("given an applications repository, when the settings are resolved, then both repositories are resolved", async () => {
        const settings = await new GitOpsService().resolveSettings(String(projectId), {
            enabled: true,
            codeRepositoryId: String(connectionId),
            repositoryId: "42",
            applications: { codeRepositoryId: String(connectionId), repositoryId: "43" }
        })

        expect(settings.codeRepository).toMatchObject({ repositoryId: "42" })
        expect(settings.applicationsCodeRepository).toMatchObject({ codeRepositoryId: connectionId, repositoryId: "43", name: "platform-apps" })
    })

    it("given someone who is not an owner, when GitOps is turned on, then it is refused", async () => {
        vi.mocked((GitOpsService.prototype as unknown as { ensureOwner: () => Promise<void> }).ensureOwner).mockRejectedValue(Object.assign(new Error("owner"), { code: "GITOPS_OWNER_REQUIRED" }))

        await expect(new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId), repositoryId: "42" })).rejects.toMatchObject({
            code: "GITOPS_OWNER_REQUIRED"
        })
    })

    it("given a repository the connection cannot reach, when GitOps is turned on, then it is refused", async () => {
        await expect(new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId), repositoryId: "999" })).rejects.toMatchObject({
            code: "GITOPS_REPOSITORY_INVALID"
        })
    })

    it("given a connection of another project, when GitOps is turned on, then it is refused", async () => {
        vi.spyOn(CodeRepository, "findOne").mockResolvedValue(null as never)

        await expect(new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId), repositoryId: "42" })).rejects.toMatchObject({
            code: "GITOPS_REPOSITORY_INVALID"
        })
    })

    it("given no repository and no name to create, when GitOps is turned on, then it is refused", async () => {
        await expect(new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId) })).rejects.toMatchObject({ code: "GITOPS_REPOSITORY_REQUIRED" })
    })

    it("given GitOps turned off, when the settings are resolved, then both stored repositories are kept and nothing is committed", async () => {
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, gitOps: { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink } } as never)

        expect(await new GitOpsService().resolveSettings(String(projectId), { enabled: false })).toEqual({ enabled: false, codeRepository: link, applicationsCodeRepository: applicationsLink })
        expect(commit).not.toHaveBeenCalled()
    })

    describe("with a repository to create", () => {
        let createRepository: ReturnType<typeof vi.spyOn>
        let initialize: ReturnType<typeof vi.spyOn>

        beforeEach(() => {
            createRepository = vi.spyOn(TemplateScaffoldService.prototype, "createRepository").mockImplementation((async (_connection: unknown, target: Record<string, unknown>) => {
                target.repositoryId = "77"
                target.name = "platform-new"
                target.cloneUrlHttps = "https://github.com/acme/platform-new.git"
            }) as never)
            initialize = vi.spyOn(GitWorkingCopy.prototype, "initialize").mockResolvedValue("sha")
        })

        it("given an invalid name, when the settings are resolved, then it is refused before anything is created", async () => {
            await expect(new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId), newRepositoryName: "bad name!" })).rejects.toMatchObject({
                code: "INVALID_REPOSITORY_NAME"
            })
            expect(createRepository).not.toHaveBeenCalled()
            expect(initialize).not.toHaveBeenCalled()
        })

        it("given a valid name, when the settings are resolved, then the repository is created without a deploy secret and gets its first commit", async () => {
            const settings = await new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId), newRepositoryName: "platform-new" })

            expect(createRepository.mock.calls[0][2]).toBe("platform-new")
            expect(createRepository.mock.calls[0][4]).toEqual({ deploySecret: false })
            expect(initialize).toHaveBeenCalledTimes(1)
            expect(initialize.mock.calls[0][0]).toMatchObject({ branch: "main", files: [expect.objectContaining({ path: "README.md" })] })
            expect(settings.codeRepository).toMatchObject({ repositoryId: "77", name: "platform-new" })
        })

        it("given a first commit that does not go through, when the settings are resolved, then they are refused as GITOPS_COMMIT_FAILED", async () => {
            initialize.mockRejectedValue(new Error("push refused"))

            await expect(new GitOpsService().resolveSettings(String(projectId), { enabled: true, codeRepositoryId: String(connectionId), newRepositoryName: "platform-new" })).rejects.toMatchObject({
                code: "GITOPS_COMMIT_FAILED"
            })
        })
    })
})

describe("GitOpsService.deploy", () => {
    const ordersId = new Types.ObjectId()
    const logging = { _id: new Types.ObjectId(), name: "logging", entries: [{ key: "LOG_LEVEL", values: [{ environmentId: String(production), value: "info" }] }] }
    const database = { _id: new Types.ObjectId(), name: "database", entries: [{ key: "PASSWORD", values: [{ environmentId: String(production), value: "s3cret" }] }] }
    const applicationsLink = { enabled: true, codeRepositoryId: connectionId, repositoryId: "43", name: "platform-apps", repositoryData: {} }

    const gitOpsOn = (gitOps: object = { enabled: true, codeRepository: link }) => vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, gitOps } as never)
    const deployOf =
        (...ids: Types.ObjectId[]) =>
        (task: () => Promise<unknown> = async () => "deployed") =>
            new GitOpsService().deploy(ids as never, task)

    beforeEach(() => {
        vi.spyOn(GitOpsService.prototype as unknown as { ensureAccessToEnvironment: () => Promise<boolean> }, "ensureAccessToEnvironment").mockResolvedValue(true)
        vi.spyOn(GitOpsService.prototype as unknown as { domainScopeFilter: () => Promise<object> }, "domainScopeFilter").mockResolvedValue({})
        vi.spyOn(ConfigMap, "find").mockResolvedValue([logging] as never)
        vi.spyOn(Secret, "find").mockResolvedValue([database] as never)
        vi.spyOn(Resource, "find").mockResolvedValue([] as never)
        vi.spyOn(Backend, "find").mockResolvedValue([] as never)
        vi.spyOn(Frontend, "find").mockResolvedValue([] as never)
    })

    it("given GitOps off, when environments are deployed, then only the deploy runs", async () => {
        gitOpsOn({ enabled: false, codeRepository: link })
        const run = vi.fn().mockResolvedValue("deployed")

        expect(await deployOf(production)(run)).toBe("deployed")
        expect(run).toHaveBeenCalledTimes(1)
        expect(commit).not.toHaveBeenCalled()
    })

    it("given an environment the user cannot reach, when it is deployed, then it is refused before anything is committed", async () => {
        gitOpsOn()
        vi.mocked((GitOpsService.prototype as unknown as { ensureAccessToEnvironment: () => Promise<boolean> }).ensureAccessToEnvironment).mockRejectedValue(
            Object.assign(new Error("forbidden"), { code: "FORBIDDEN" })
        )
        const run = vi.fn()

        await expect(deployOf(production)(run)).rejects.toMatchObject({ code: "FORBIDDEN" })
        expect(commit).not.toHaveBeenCalled()
        expect(run).not.toHaveBeenCalled()
    })

    it("given a viewer of the project, when an environment is deployed, then it is refused before anything is committed", async () => {
        gitOpsOn()
        vi.mocked((GitOpsService.prototype as unknown as { ensureNotViewer: () => Promise<void> }).ensureNotViewer).mockRejectedValue(
            Object.assign(new Error("viewer"), { code: "GITOPS_VIEWER_FORBIDDEN" })
        )
        const run = vi.fn()

        await expect(deployOf(production)(run)).rejects.toMatchObject({ code: "GITOPS_VIEWER_FORBIDDEN" })
        expect(commit).not.toHaveBeenCalled()
        expect(run).not.toHaveBeenCalled()
    })

    it("given production deployed, when it is committed, then the namespace and the maps of production only are in one commit before the deploy", async () => {
        gitOpsOn()
        const run = vi.fn().mockResolvedValue("deployed")

        await deployOf(production)(run)

        expect(commit).toHaveBeenCalledTimes(1)
        const [message, files] = commit.mock.calls[0]
        expect(message).toBe("Deploy production")
        expect(files.map(file => [file.path, file.action])).toEqual([
            ["production/namespace.yaml", "update"],
            ["production/configMaps/logging.yaml", "update"],
            ["production/secrets/database.yaml", "update"]
        ])
        expect(parse(files[0].content!)).toMatchObject({ kind: "Namespace", metadata: { name: "production" } })
        expect(commit.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0])
    })

    it("given two environments deployed, when they are committed, then each one gets its files in the same commit", async () => {
        gitOpsOn()

        await deployOf(development, production)()

        expect(commit.mock.calls[0][1].map(file => file.path)).toEqual(
            expect.arrayContaining(["development/namespace.yaml", "production/namespace.yaml", "development/configMaps/logging.yaml", "production/secrets/database.yaml"])
        )
    })

    it("given production deployed, when the commit prunes, then the manifests of production and of an environment that no longer exists go and those of another one stay", async () => {
        gitOpsOn()

        await deployOf(production)()

        const prune = commit.mock.calls[0][2]!.prune!
        expect(prune("production/configMaps/old.yaml")).toBe(true)
        expect(prune("production/namespace.yaml")).toBe(true)
        expect(prune("deleted-env/secrets/database.yaml")).toBe(true)
        expect(prune("deleted-env/namespace.yaml")).toBe(true)
        expect(prune("development/configMaps/logging.yaml")).toBe(false)
        expect(prune("development/namespace.yaml")).toBe(false)
        expect(prune("README.md")).toBe(false)
        expect(prune("production/configMaps/notes.txt")).toBe(false)
        expect(prune("production/notes.yaml")).toBe(false)
        expect(prune("production/configMaps/nested/old.yaml")).toBe(false)
    })

    describe("with resources", () => {
        const attachedId = new Types.ObjectId()
        const attached = { _id: attachedId, name: "orders", type: "redis", variant: "connectionString", values: [], secrets: [{ field: "url", value: "redis://cache", overrides: [] }] }
        const detached = { _id: new Types.ObjectId(), name: "unused", type: "redis", variant: "connectionString", values: [], secrets: [] }

        beforeEach(() => {
            vi.spyOn(Resource, "find").mockResolvedValue([attached, detached] as never)
            vi.spyOn(Backend, "find").mockResolvedValue([{ slug: "orders-api", resourceIds: [attachedId] }] as never)
        })

        it("given a resource a backend attaches and one attached to nothing, when production is deployed, then both are committed, after the maps", async () => {
            gitOpsOn()

            await deployOf(production)()

            const files = commit.mock.calls[0][1]
            expect(files.map(file => file.path)).toEqual([
                "production/namespace.yaml",
                "production/configMaps/logging.yaml",
                "production/secrets/database.yaml",
                "production/resources/orders.yaml",
                "production/resources/unused.yaml"
            ])
            expect(parse(files[3].content!)).toMatchObject({
                kind: "Secret",
                metadata: { name: "orders.resource", namespace: "production" },
                data: { REDIS_ORDERS_URL: Buffer.from("redis://cache").toString("base64") }
            })
            expect(Resource.find).toHaveBeenCalledWith({ projectId: expect.anything() })
        })

        it("given a resource detached since the last deploy, when production is deployed, then its Secret stays: a values file not redeployed may still name it", async () => {
            gitOpsOn()

            await deployOf(production)()

            expect(commit.mock.calls[0][1].map(file => file.path)).toContain("production/resources/unused.yaml")
            // The backends are not read to tell which ones are attached
            expect(Backend.find).not.toHaveBeenCalled()
        })

        it("given a resource deleted since the last deploy, when production is deployed, then its manifest is among those the commit prunes", async () => {
            gitOpsOn()

            await deployOf(production)()

            const prune = commit.mock.calls[0][2]!.prune!
            expect(commit.mock.calls[0][1].map(file => file.path)).not.toContain("production/resources/deleted.yaml")
            expect(prune("production/resources/deleted.yaml")).toBe(true)
            expect(prune("development/resources/deleted.yaml")).toBe(false)
            expect(prune("production/resources/nested/deleted.yaml")).toBe(false)
        })
    })

    describe("with a maintenance agent", () => {
        const agentId = new Types.ObjectId()
        const token = `fra_${agentId}_${production}_${"a".repeat(64)}`

        beforeEach(() => {
            vi.stubEnv("BACKEND_URL", "https://console.example.com/api")
            const agents = [{ _id: agentId, slug: "cleaner", runtimeTokens: [{ environmentId: production, token }] }]
            vi.spyOn(MaintenanceAgent, "find").mockImplementation((() => Object.assign(Promise.resolve(agents), { select: () => Promise.resolve(agents) })) as never)
        })

        afterEach(() => {
            vi.unstubAllEnvs()
        })

        it("given an agent with its token for production, when production is deployed, then its Secret holds the URL of the console and that token, after the maps", async () => {
            gitOpsOn()

            await deployOf(production)()

            const files = commit.mock.calls[0][1]
            expect(files.map(file => file.path).at(-1)).toBe("production/maintenanceAgents/cleaner.yaml")
            const manifest = parse(files.at(-1)!.content!)
            expect(manifest).toMatchObject({ kind: "Secret", type: "Opaque", metadata: { name: "cleaner.flightroom", namespace: "production" } })
            expect(Object.fromEntries(Object.entries(manifest.data as Record<string, string>).map(([key, value]) => [key, Buffer.from(value, "base64").toString()]))).toEqual({
                FLIGHTROOM_API_URL: "https://console.example.com/api",
                FLIGHTROOM_AGENT_TOKEN: token
            })
        })

        it("given an agent deleted since the last deploy, when production is deployed, then its Secret is among those the commit prunes", async () => {
            gitOpsOn()

            await deployOf(production)()

            const prune = commit.mock.calls[0][2]!.prune!
            expect(prune("production/maintenanceAgents/deleted.yaml")).toBe(true)
            expect(prune("development/maintenanceAgents/cleaner.yaml")).toBe(false)
        })
    })

    it("given a deploy that fails after the commit, when it is run, then the files are committed back and the failure goes on", async () => {
        gitOpsOn()
        const undo = [{ path: "production/namespace.yaml", action: "delete" }]
        commit.mockResolvedValueOnce(undo)

        await expect(deployOf(production)(() => Promise.reject(new Error("rollout failed")))).rejects.toThrow("rollout failed")

        expect(commit).toHaveBeenCalledTimes(2)
        expect(commit.mock.calls[1]).toEqual(["Revert: deploy production", undo])
    })

    it("given a commit that changed nothing, when the deploy fails, then there is nothing to revert", async () => {
        gitOpsOn()

        await expect(deployOf(production)(() => Promise.reject(new Error("rollout failed")))).rejects.toThrow("rollout failed")

        expect(commit).toHaveBeenCalledTimes(1)
    })

    it("given a commit that does not go through, when an environment is deployed, then the deploy never runs", async () => {
        gitOpsOn()
        commit.mockRejectedValue(new Error("push refused"))
        const run = vi.fn()

        await expect(deployOf(production)(run)).rejects.toThrow("push refused")
        expect(run).not.toHaveBeenCalled()
    })

    it("given an environment with its own namespace, when it is deployed, then the Namespace and the maps are named after it and the files after the slug", async () => {
        gitOpsOn()
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: production, slug: "production", namespace: "shop-prod", projectId }] as never)

        await deployOf(production)(vi.fn())

        const [, files] = commit.mock.calls[0]
        expect(files.map(file => file.path)).toEqual(["production/namespace.yaml", "production/configMaps/logging.yaml", "production/secrets/database.yaml"])
        expect(parse(files[0].content!)).toMatchObject({ kind: "Namespace", metadata: { name: "shop-prod" } })
        expect(parse(files[1].content!).metadata.namespace).toBe("shop-prod")
        expect(parse(files[2].content!).metadata.namespace).toBe("shop-prod")
    })

    it("given an environment with no namespace, when it is deployed, then the maps go in the namespace named as its slug", async () => {
        gitOpsOn()

        await deployOf(production)(vi.fn())

        const [, files] = commit.mock.calls[0]
        expect(parse(files[1].content!).metadata.namespace).toBe("production")
    })

    it("given environments made by the console with uppercase slugs, when they are deployed, then the files go under the slug and the namespace set wins over it", async () => {
        gitOpsOn()
        vi.spyOn(Environment, "find").mockResolvedValue([
            { _id: development, slug: "DEV", namespace: "tnb-ai-applications-development", projectId },
            { _id: production, slug: "PROD", projectId }
        ] as never)

        await deployOf(development, production)()

        const [, files] = commit.mock.calls[0]
        const byPath = Object.fromEntries(files.map(file => [file.path, parse(file.content!)]))
        expect(byPath["DEV/namespace.yaml"].metadata.name).toBe("tnb-ai-applications-development")
        expect(byPath["DEV/configMaps/logging.yaml"].metadata.namespace).toBe("tnb-ai-applications-development")
        expect(byPath["PROD/namespace.yaml"].metadata.name).toBe("prod")
        expect(byPath["PROD/secrets/database.yaml"].metadata.namespace).toBe("prod")
    })

    it("given an environment namespace that is not a DNS label, when it is deployed, then it is refused before anything is committed", async () => {
        gitOpsOn()
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: production, slug: "production", namespace: "Shop_Prod", projectId }] as never)
        const run = vi.fn()

        await expect(deployOf(production)(run)).rejects.toMatchObject({ code: "GITOPS_ENVIRONMENT_NAMESPACE_INVALID" })
        expect(commit).not.toHaveBeenCalled()
        expect(run).not.toHaveBeenCalled()
    })

    it("given an environment slug that is not a DNS label, when it is deployed, then it is refused before anything is committed", async () => {
        gitOpsOn()
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: production, slug: "Prod_1", projectId }] as never)
        const run = vi.fn()

        await expect(deployOf(production)(run)).rejects.toMatchObject({ code: "GITOPS_ENVIRONMENT_SLUG_INVALID" })
        expect(commit).not.toHaveBeenCalled()
        expect(run).not.toHaveBeenCalled()
    })

    describe("with the project exposed on a domain", () => {
        const exposedOn = (exposure: object | undefined, gitOps: object = { enabled: true, codeRepository: link }) =>
            vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, slug: "shop", gitOps, exposure } as never)
        const documentsOf = (content: string) => parseAllDocuments(content).map(document => document.toJSON())
        /** development, then production, which is the production environment unless told otherwise */
        const subdomains = (ofDevelopment?: string, ofProduction?: string, { developmentInProduction = false } = {}) =>
            vi.spyOn(Environment, "find").mockResolvedValue([
                { _id: development, slug: "development", subdomain: ofDevelopment, isProduction: developmentInProduction, projectId },
                { _id: production, slug: "production", subdomain: ofProduction, isProduction: true, projectId }
            ] as never)

        it("given a domain with an issuer, when production is deployed, then its Gateway answers on its subdomain with a certificate and a redirect to HTTPS", async () => {
            exposedOn({ domain: "example.com", certificateIssuer: "letsencrypt" })
            vi.spyOn(Environment, "find").mockResolvedValue([
                { _id: development, slug: "development", subdomain: "dev", projectId },
                { _id: production, slug: "production", subdomain: "app", projectId }
            ] as never)

            await deployOf(production)()

            const [, files] = commit.mock.calls[0]
            expect(files.map(file => file.path)).toEqual(["production/namespace.yaml", "production/gateway.yaml", "production/configMaps/logging.yaml", "production/secrets/database.yaml"])
            const [certificate, gateway, redirect] = documentsOf(files[1].content!)
            expect(certificate).toMatchObject({
                kind: "Certificate",
                metadata: { namespace: "production" },
                spec: { dnsNames: ["app.example.com"], issuerRef: { name: "letsencrypt", kind: "ClusterIssuer" } }
            })
            expect(gateway).toMatchObject({ kind: "Gateway", metadata: { namespace: "production" }, spec: { gatewayClassName: "traefik" } })
            expect(gateway.spec.listeners.map((listener: { name: string; hostname: string }) => [listener.name, listener.hostname])).toEqual([
                ["http", "app.example.com"],
                ["https", "app.example.com"]
            ])
            expect(redirect).toMatchObject({ kind: "HTTPRoute", spec: { parentRefs: [{ name: gateway.metadata.name, sectionName: "http" }] } })
        })

        it("given the production environment with no subdomain, when it is deployed, then its Gateway answers on the domain itself", async () => {
            exposedOn({ domain: "example.com" })
            subdomains("dev", undefined)

            await deployOf(production)()

            const gateway = commit.mock.calls[0][1].find(file => file.path === "production/gateway.yaml")!
            const documents = documentsOf(gateway.content!)
            expect(documents.map(document => document.kind)).toEqual(["Gateway"])
            expect(documents[0].spec.listeners).toEqual([expect.objectContaining({ name: "http", hostname: "example.com", port: 80 })])
        })

        it("given no domain, when production is deployed, then no Gateway is committed and the one it had is pruned", async () => {
            exposedOn(undefined)

            await deployOf(production)()

            const [, files, options] = commit.mock.calls[0]
            expect(files.map(file => file.path)).not.toContain("production/gateway.yaml")
            expect(options!.prune!("production/gateway.yaml")).toBe(true)
            expect(options!.prune!("development/gateway.yaml")).toBe(false)
        })

        it("given an environment out of production with no subdomain, when it is deployed, then its Gateway answers on its slug in lowercase", async () => {
            exposedOn({ domain: "example.com" })
            vi.spyOn(Environment, "find").mockResolvedValue([
                { _id: development, slug: "DEV", isProduction: false, projectId },
                { _id: production, slug: "production", isProduction: true, projectId }
            ] as never)

            await deployOf(development)()

            const gateway = documentsOf(commit.mock.calls[0][1].find(file => file.path === "DEV/gateway.yaml")!.content!)[0]
            expect(gateway.spec.listeners[0].hostname).toBe("dev.example.com")
        })

        it("given a subdomain equal to the slug of another environment, when one is deployed, then it is refused before anything is committed", async () => {
            exposedOn({ domain: "example.com" })
            subdomains(undefined, "development")

            await expect(deployOf(production)(vi.fn())).rejects.toMatchObject({ code: "GITOPS_ENVIRONMENT_HOST_TAKEN" })
            expect(commit).not.toHaveBeenCalled()
        })

        it("given two production environments with no subdomain, when one is deployed, then it is refused before anything is committed", async () => {
            exposedOn({ domain: "example.com" })
            subdomains(undefined, undefined, { developmentInProduction: true })
            const run = vi.fn()

            await expect(deployOf(production)(run)).rejects.toMatchObject({ code: "GITOPS_ENVIRONMENT_HOST_TAKEN" })
            expect(commit).not.toHaveBeenCalled()
            expect(run).not.toHaveBeenCalled()
        })

        it("given a subdomain that is not made of DNS labels, when it is deployed, then it is refused before anything is committed", async () => {
            exposedOn({ domain: "example.com" })
            subdomains("dev", "app_1")

            await expect(deployOf(production)(vi.fn())).rejects.toMatchObject({ code: "GITOPS_ENVIRONMENT_SUBDOMAIN_INVALID" })
            expect(commit).not.toHaveBeenCalled()
        })

        it.each([
            ["an issuer", { domain: "example.com", certificateIssuer: "letsencrypt" }, { listener: "https", hsts: true }],
            ["no issuer", { domain: "example.com" }, { listener: "http", hsts: false }]
        ])("given %s and a backend with an exposure path, when the applications are committed, then its route is on the Gateway of the environment", async (_case, exposure, expected) => {
            exposedOn(exposure, { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink })
            subdomains("dev", "app")
            vi.spyOn(Backend, "find").mockResolvedValue([
                { slug: "orders-api", environmentVersions: [{ environmentId: production, version: "1.4.0" }], image: { repository: "ghcr.io/acme/orders-api" }, exposurePath: "/api/orders" },
                { slug: "billing-api", environmentVersions: [{ environmentId: production, version: "1.0.0" }], image: { repository: "ghcr.io/acme/billing-api" } }
            ] as never)

            await deployOf(production)()

            const files = applicationsCommit.mock.calls[0][1]
            const gateway = documentsOf(commit.mock.calls[0][1].find(file => file.path === "production/gateway.yaml")!.content!).find(document => document.kind === "Gateway")
            expect(parse(files.find(file => file.path === "orders-api.yaml")!.content!).route).toEqual({ gateway: gateway.metadata.name, path: "/api/orders", ...expected })
            expect(parse(files.find(file => file.path === "billing-api.yaml")!.content!).route).toBeUndefined()
        })

        it("given an environment with an IP allow list, when it is deployed, then its Gateway carries the Middleware and the routes go through it", async () => {
            exposedOn({ domain: "example.com", certificateIssuer: "letsencrypt" }, { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink })
            vi.spyOn(Environment, "find").mockResolvedValue([
                { _id: development, slug: "development", subdomain: "dev", projectId },
                { _id: production, slug: "production", subdomain: "app", isProduction: true, ipAllowList: ["203.0.113.0/24"], projectId }
            ] as never)
            vi.spyOn(Backend, "find").mockResolvedValue([
                { slug: "orders-api", environmentVersions: [{ environmentId: production, version: "1.4.0" }], image: { repository: "ghcr.io/acme/orders-api" }, exposurePath: "/api/orders" }
            ] as never)

            await deployOf(production)()

            const documents = documentsOf(commit.mock.calls[0][1].find(file => file.path === "production/gateway.yaml")!.content!)
            const middleware = documents.find(document => document.kind === "Middleware")
            expect(middleware.spec.ipAllowList.sourceRange).toEqual(["203.0.113.0/24"])
            const values = applicationsCommit.mock.calls[0][1].find(file => file.path === "orders-api.yaml")!
            expect(parse(values.content!).route.ipAllowList).toBe(middleware.metadata.name)
        })

        it("given an environment whose IP allow list was emptied, when it is deployed, then the routes still go through its Middleware, open to every address", async () => {
            exposedOn({ domain: "example.com" }, { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink })
            vi.spyOn(Environment, "find").mockResolvedValue([
                { _id: development, slug: "development", subdomain: "dev", projectId },
                { _id: production, slug: "production", subdomain: "app", isProduction: true, ipAllowList: [], projectId }
            ] as never)
            vi.spyOn(Backend, "find").mockResolvedValue([
                { slug: "orders-api", environmentVersions: [{ environmentId: production, version: "1.4.0" }], image: { repository: "ghcr.io/acme/orders-api" }, exposurePath: "/api/orders" }
            ] as never)

            await deployOf(production)()

            const middleware = documentsOf(commit.mock.calls[0][1].find(file => file.path === "production/gateway.yaml")!.content!).find(document => document.kind === "Middleware")
            expect(middleware.spec.ipAllowList.sourceRange).toEqual(["0.0.0.0/0", "::/0"])
            expect(parse(applicationsCommit.mock.calls[0][1].find(file => file.path === "orders-api.yaml")!.content!).route.ipAllowList).toBe(middleware.metadata.name)
        })

        it("given an environment that never had an IP allow list, when it is deployed, then the routes go through no Middleware", async () => {
            exposedOn({ domain: "example.com" }, { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink })
            subdomains("dev", "app")
            vi.spyOn(Backend, "find").mockResolvedValue([
                { slug: "orders-api", environmentVersions: [{ environmentId: production, version: "1.4.0" }], image: { repository: "ghcr.io/acme/orders-api" }, exposurePath: "/api/orders" }
            ] as never)

            await deployOf(production)()

            const values = applicationsCommit.mock.calls[0][1].find(file => file.path === "orders-api.yaml")!
            expect(parse(values.content!).route).not.toHaveProperty("ipAllowList")
        })

        describe("runtime variables", () => {
            const ordersId = new Types.ObjectId()
            const withShopCallingOrders = () => {
                vi.spyOn(Environment, "find").mockResolvedValue([
                    { _id: development, slug: "development", subdomain: "dev", projectId },
                    { _id: production, slug: "production", subdomain: "app", isProduction: true, logLevel: "warn", logJson: true, projectId }
                ] as never)
                vi.spyOn(Backend, "find").mockResolvedValue([
                    {
                        _id: ordersId,
                        slug: "orders-api",
                        environmentVersions: [{ environmentId: production, version: "1.4.0" }],
                        image: { repository: "ghcr.io/acme/orders-api" },
                        exposurePath: "/api/orders"
                    }
                ] as never)
                vi.spyOn(Frontend, "find").mockResolvedValue([
                    {
                        _id: new Types.ObjectId(),
                        slug: "shop-fe",
                        kind: "DOCKER",
                        environmentVersions: [{ environmentId: production, version: "2.0.0" }],
                        image: { repository: "ghcr.io/acme/shop-fe" },
                        exposurePath: "/shop/",
                        backendIds: [ordersId]
                    }
                ] as never)
            }
            const envOf = (path: string) => parse(applicationsCommit.mock.calls[0][1].find(file => file.path === path)!.content!).env

            it("given an environment that logs at warn in JSON and a frontend calling a backend, when it is deployed, then both containers get the logging and the URL of the frontend", async () => {
                exposedOn({ domain: "example.com", certificateIssuer: "letsencrypt" }, { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink })
                withShopCallingOrders()

                await deployOf(production)()

                const expected = [
                    { name: "LOG_LEVEL", value: "warn" },
                    { name: "LOG_JSON", value: "true" },
                    { name: "FRONTEND_URL", value: "https://app.example.com/shop" }
                ]
                expect(envOf("orders-api.yaml")).toEqual(expected)
                expect(envOf("shop-fe.yaml")).toEqual(expected)
            })

            it("given a project exposed on no domain, when it is deployed, then the containers get their logging and no FRONTEND_URL", async () => {
                exposedOn(undefined, { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink })
                withShopCallingOrders()

                await deployOf(production)()

                expect(envOf("orders-api.yaml").map((variable: { name: string }) => variable.name)).toEqual(["LOG_LEVEL", "LOG_JSON"])
            })
        })
    })

    describe("with two applications exposed at the same path", () => {
        it("given a backend and a frontend at /api, when an environment is deployed, then it is refused before anything is committed", async () => {
            vi.spyOn(Project, "findById").mockResolvedValue({
                _id: projectId,
                slug: "shop",
                gitOps: { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink },
                exposure: { domain: "example.com" }
            } as never)
            vi.spyOn(Environment, "find").mockResolvedValue([{ _id: production, slug: "production", projectId }] as never)
            vi.spyOn(Backend, "find").mockResolvedValue([
                { slug: "orders-api", environmentVersions: [{ environmentId: production, version: "1.0.0" }], image: { repository: "ghcr.io/acme/orders-api" }, exposurePath: "/api" }
            ] as never)
            vi.spyOn(Frontend, "find").mockResolvedValue([
                { slug: "shell", environmentVersions: [{ environmentId: production, version: "2.0.0" }], image: { repository: "ghcr.io/acme/shell" }, exposurePath: "/api/" }
            ] as never)
            const run = vi.fn()

            await expect(deployOf(production)(run)).rejects.toMatchObject({ code: "GITOPS_EXPOSURE_PATH_TAKEN" })
            expect(commit).not.toHaveBeenCalled()
            expect(run).not.toHaveBeenCalled()
        })
    })

    describe("with an applications repository", () => {
        const orders = {
            _id: ordersId,
            slug: "orders-api",
            environmentVersions: [{ environmentId: production, version: "1.4.0" }],
            image: { repository: "ghcr.io/acme/orders-api" },
            configMapIds: [logging._id],
            secretIds: [database._id]
        }
        const notBuilt = { _id: new Types.ObjectId(), slug: "not-built", name: "Not built" }

        beforeEach(() => {
            gitOpsOn({ enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink })
            vi.spyOn(Backend, "find").mockResolvedValue([orders, notBuilt] as never)
        })

        it("given production deployed, when the applications are committed, then one commit goes on the branch production with the values of the deployable ones only", async () => {
            await deployOf(production)()

            expect(applicationsCommit).toHaveBeenCalledTimes(1)
            const [message, files, options] = applicationsCommit.mock.calls[0]
            expect(message).toBe("Deploy production")
            expect(options?.branch).toBe("production")
            const values = files.filter(file => !file.path.startsWith("microservice-chart/"))
            expect(values.map(file => file.path)).toEqual(["orders-api.yaml"])
            expect(parse(values[0].content!)).toMatchObject({ image: { host: "ghcr.io", name: "acme/orders-api", tag: "1.4.0" }, environmentMaps: ["logging"], secrets: ["database"] })
        })

        it("given a backend attaching a resource, when the applications are committed, then its values list the Secret of the resource after those of its secrets", async () => {
            const cacheId = new Types.ObjectId()
            vi.spyOn(Resource, "find").mockResolvedValue([{ _id: cacheId, name: "cache", type: "redis", variant: "connectionString", values: [], secrets: [] }] as never)
            vi.spyOn(Backend, "find").mockResolvedValue([{ ...orders, resourceIds: [cacheId] }] as never)

            await deployOf(production)()

            const values = applicationsCommit.mock.calls[0][1].filter(file => !file.path.startsWith("microservice-chart/"))
            expect(parse(values[0].content!)).toMatchObject({ environmentMaps: ["logging"], secrets: ["database", "cache.resource"] })
            expect(commit.mock.calls[0][1].map(file => file.path)).toContain("production/resources/cache.yaml")
        })

        it("given a project with a container registry, when the applications are committed, then one with a version and no image gets the slug in the registry", async () => {
            vi.spyOn(Project, "findById").mockResolvedValue({
                _id: projectId,
                gitOps: { enabled: true, codeRepository: link, applicationsCodeRepository: applicationsLink },
                containerRegistry: "azimutmarketplace.azurecr.io"
            } as never)
            vi.spyOn(Backend, "find").mockResolvedValue([orders, { ...notBuilt, environmentVersions: [{ environmentId: production, version: "0.3.0" }] }] as never)

            await deployOf(production)()

            const values = applicationsCommit.mock.calls[0][1].filter(file => !file.path.startsWith("microservice-chart/"))
            expect(values.map(file => file.path)).toEqual(["orders-api.yaml", "not-built.yaml"])
            expect(parse(values[1].content!).image).toEqual({ host: "azimutmarketplace.azurecr.io", name: "not-built", tag: "0.3.0" })
        })

        it("given the applications are committed, when the chart is written, then every chart file is flagged to be written only when missing", async () => {
            await deployOf(production)()

            const chart = applicationsCommit.mock.calls[0][1].filter(file => file.path.startsWith("microservice-chart/"))
            expect(chart.map(file => file.path)).toEqual(CHART_FILES.map(file => file.path))
            expect(chart.every(file => file.ifMissing === true)).toBe(true)
            expect(chart.find(file => file.path.endsWith("httproute.yaml"))!.replaces).toEqual(CHART_FILES.find(file => file.path.endsWith("httproute.yaml"))!.replaces)
        })

        it("given the applications are committed, when the commit prunes, then only the values files of applications that no longer exist go", async () => {
            await deployOf(production)()

            const prune = applicationsCommit.mock.calls[0][2]!.prune!
            expect(prune("removed-api.yaml")).toBe(true)
            expect(prune("orders-api.yaml")).toBe(false)
            expect(prune("not-built.yaml")).toBe(false)
            expect(prune("microservice-chart/Chart.yaml")).toBe(false)
            expect(prune("README.md")).toBe(false)
        })

        it("given two environments deployed, when the applications are committed, then each one gets a commit on its own branch", async () => {
            await deployOf(development, production)()

            expect(applicationsCommit.mock.calls.map(call => call[2]?.branch)).toEqual(["development", "production"])
        })

        it("given a deploy of one functional domain, when the applications are committed, then only the backends and frontends of that domain are read", async () => {
            const domainId = new Types.ObjectId()

            await new GitOpsService().deploy([production] as never, async () => "deployed", String(domainId))

            expect(vi.mocked(Backend.find).mock.calls[0][0]).toEqual({ projectId: String(projectId), domainId: String(domainId) })
            expect(vi.mocked(Frontend.find).mock.calls[0][0]).toMatchObject({ projectId: String(projectId), domainId: String(domainId) })
        })

        it("given the configuration and the applications commits, when an environment is deployed, then the deploy runs after both", async () => {
            const run = vi.fn().mockResolvedValue("deployed")

            await deployOf(production)(run)

            expect(commit.mock.invocationCallOrder[0]).toBeLessThan(applicationsCommit.mock.invocationCallOrder[0])
            expect(applicationsCommit.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0])
        })

        it("given a deploy that went through, when the applications are committed, then Argo CD is aligned with them afterwards", async () => {
            const align = vi.spyOn(ArgoCdService.prototype, "alignApplications").mockResolvedValue(undefined)
            const run = vi.fn().mockResolvedValue("deployed")

            await deployOf(production)(run)

            expect(String(align.mock.calls[0][0])).toBe(String(projectId))
            expect(run.mock.invocationCallOrder[0]).toBeLessThan(align.mock.invocationCallOrder[0])
        })

        it("given a deploy that fails, when the applications were committed, then Argo CD is not aligned", async () => {
            const align = vi.spyOn(ArgoCdService.prototype, "alignApplications").mockResolvedValue(undefined)

            await expect(deployOf(production)(() => Promise.reject(new Error("rollout failed")))).rejects.toThrow("rollout failed")

            expect(align).not.toHaveBeenCalled()
        })

        it("given a deploy that went through, when Argo CD is aligned, then the Applications of the deployed environments are refreshed afterwards", async () => {
            const align = vi.spyOn(ArgoCdService.prototype, "alignApplications").mockResolvedValue(undefined)
            const refresh = vi.spyOn(ArgoCdService.prototype, "refreshApplications").mockResolvedValue(undefined)

            await deployOf(development, production)()

            expect(refresh.mock.calls[0][1]).toEqual(["development", "production"])
            expect(align.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0])
        })

        it("given a deploy that fails, when the applications were committed, then no Application is refreshed", async () => {
            const refresh = vi.spyOn(ArgoCdService.prototype, "refreshApplications").mockResolvedValue(undefined)

            await expect(deployOf(production)(() => Promise.reject(new Error("rollout failed")))).rejects.toThrow("rollout failed")

            expect(refresh).not.toHaveBeenCalled()
        })

        it("given a deploy that fails, when both repositories were pushed, then the applications branches are reverted before the configuration", async () => {
            const configurationUndo = [{ path: "production/namespace.yaml", action: "delete" }]
            const applicationsUndo = [{ path: "orders-api.yaml", action: "delete" }]
            commit.mockResolvedValueOnce(configurationUndo)
            applicationsCommit.mockResolvedValueOnce(applicationsUndo)

            await expect(deployOf(production)(() => Promise.reject(new Error("rollout failed")))).rejects.toThrow("rollout failed")

            expect(applicationsCommit.mock.calls[1]).toEqual(["Revert: deploy production", applicationsUndo, { branch: "production" }])
            expect(commit.mock.calls[1]).toEqual(["Revert: deploy production", configurationUndo])
            expect(applicationsCommit.mock.invocationCallOrder[1]).toBeLessThan(commit.mock.invocationCallOrder[1])
        })
    })
})

describe("leavesAsItIs", () => {
    const chartFile = { ifMissing: true, replaces: ["as written before"] }

    it.each([
        ["missing from the branch", chartFile, undefined, false],
        ["as Flightroom wrote it before", chartFile, "as written before", false],
        ["changed by the team", chartFile, "changed by hand", true],
        ["changed by the team, with no earlier version", { ifMissing: true }, "changed by hand", true],
        ["not a chart file", { replaces: ["as written before"] }, "changed by hand", false]
    ])("given a file %s, when it is committed, then it is left as it is: %s", (_case, file, current, expected) => {
        expect(leavesAsItIs(file, current)).toBe(expected)
    })
})
