import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../..", () => ({ fastify: { log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, config: { REPOSITORIES_FOLDER: "/repositories" } } }))

import Environment from "../../models/EnvironmentModel"
import Project from "../../models/ProjectModel"
import Resource from "../../models/ResourceModel"
import { ConfigMap, Secret } from "../../models/VariableMapModel"
import { toObjectId } from "../../utils/mongooseUtils"
import StandalonePreviewService, { backendPreviewUrl, previewEnvironments } from "./StandalonePreviewService"

const projectId = toObjectId(String(new Types.ObjectId()))
const devId = new Types.ObjectId()
const stagingId = new Types.ObjectId()
const frontendId = new Types.ObjectId()
const backendId = new Types.ObjectId()
const loggingId = new Types.ObjectId()
const databaseId = new Types.ObjectId()

describe("previewEnvironments", () => {
    let sort: ReturnType<typeof vi.fn>

    beforeEach(() => {
        sort = vi.fn().mockResolvedValue({ _id: devId, slug: "dev", logLevel: "debug", logJson: false })
        vi.spyOn(Environment, "findOne").mockReturnValue({ sort } as never)
        vi.spyOn(ConfigMap, "find").mockResolvedValue([
            {
                _id: loggingId,
                entries: [
                    { key: "API_BASE", value: "https://api.example.test", values: [{ environmentId: devId, value: "https://api.dev.example.test" }] },
                    { key: "ONLY_STAGING", values: [{ environmentId: stagingId, value: "staging" }] },
                    { key: "LOG_LEVEL", value: "error", values: [] }
                ]
            }
        ] as never)
        vi.spyOn(Secret, "find").mockResolvedValue([
            {
                _id: databaseId,
                entries: [
                    { key: "DB_PASSWORD", value: "s3cret", values: [] },
                    { key: "API_BASE", value: "from-secret", values: [] }
                ]
            }
        ] as never)
        vi.spyOn(Resource, "find").mockResolvedValue([] as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ argoCd: { initializedAt: new Date() } } as never)
    })

    afterEach(() => vi.restoreAllMocks())

    it("Given a project, when the environments of a preview are read, then they come from its first environment that is not production", async () => {
        await previewEnvironments(projectId, [])

        expect(Environment.findOne).toHaveBeenCalledWith({ projectId, isProduction: false }, expect.anything())
        expect(sort).toHaveBeenCalledWith({ order: 1 })
    })

    it("Given config maps and secrets attached, then each component gets their values there, a secret over a config map and the platform's over both", async () => {
        const environments = await previewEnvironments(projectId, [
            { _id: backendId, configMapIds: [loggingId], secretIds: [databaseId] },
            { _id: frontendId, configMapIds: [loggingId] }
        ])

        expect(environments.get(String(backendId))).toEqual({ API_BASE: "from-secret", DB_PASSWORD: "s3cret", LOG_LEVEL: "debug", LOG_JSON: "false", ENVIRONMENT: "dev" })
        expect(environments.get(String(frontendId))).toEqual({ API_BASE: "https://api.dev.example.test", LOG_LEVEL: "debug", LOG_JSON: "false", ENVIRONMENT: "dev" })
    })

    it("Given a backend with variables of its own, then it gets them as the deploy hands them: the secret ones over its secrets, the plain ones over those, the platform's over all", async () => {
        const environments = await previewEnvironments(projectId, [
            {
                _id: backendId,
                configMapIds: [loggingId],
                secretIds: [databaseId],
                env: [
                    { name: "OPENAI_API_KEY", secret: true, value: "sk-test" },
                    { name: "DB_PASSWORD", secret: true, value: "own-password" },
                    { name: "API_BASE", secret: false, value: "own-api" },
                    { name: "LOG_LEVEL", secret: false, value: "trace" },
                    { name: "UNSET", secret: false, value: "" }
                ]
            }
        ])

        expect(environments.get(String(backendId))).toEqual({
            API_BASE: "own-api",
            DB_PASSWORD: "own-password",
            OPENAI_API_KEY: "sk-test",
            LOG_LEVEL: "debug",
            LOG_JSON: "false",
            ENVIRONMENT: "dev"
        })
    })

    it("Given a project whose Argo CD is not initialized, then a backend still gets the variables it sets itself", async () => {
        vi.mocked(Project.findById).mockResolvedValue({ argoCd: {} } as never)

        const environments = await previewEnvironments(projectId, [{ _id: backendId, secretIds: [databaseId], env: [{ name: "OPENAI_API_KEY", secret: true, value: "sk-test" }] }])

        expect(environments.get(String(backendId))).toEqual({ OPENAI_API_KEY: "sk-test", LOG_LEVEL: "debug", LOG_JSON: "false", ENVIRONMENT: "dev" })
    })

    it("Given a project with production only, then no component gets any", async () => {
        sort.mockResolvedValue(null)

        expect((await previewEnvironments(projectId, [{ _id: backendId, secretIds: [databaseId] }])).size).toBe(0)
        expect(Secret.find).not.toHaveBeenCalled()
    })

    it("Given a project whose Argo CD is not initialized, then no component gets its config maps, secrets or resources, only what the platform sets", async () => {
        vi.mocked(Project.findById).mockResolvedValue({ argoCd: {} } as never)

        const environments = await previewEnvironments(projectId, [{ _id: backendId, configMapIds: [loggingId], secretIds: [databaseId], resourceIds: [new Types.ObjectId()] }])

        expect(environments.get(String(backendId))).toEqual({ LOG_LEVEL: "debug", LOG_JSON: "false", ENVIRONMENT: "dev" })
        expect(ConfigMap.find).toHaveBeenCalledWith({ _id: { $in: [] }, projectId })
        expect(Secret.find).toHaveBeenCalledWith({ _id: { $in: [] }, projectId })
        expect(Resource.find).toHaveBeenCalledWith({ _id: { $in: [] }, projectId })
    })
})

describe("startRepositories, a domain with several frontends and backends", () => {
    const component = (kind: "frontend" | "backend", slug: string, exposurePath?: string) => ({ kind, slug, exposurePath }) as never
    const repository = (slug: string) => ({ slug }) as never
    const fakeRunner = (failing: string[] = []) => {
        const started: string[] = []
        const runner = {
            canPreview: vi.fn().mockResolvedValue(true),
            startPreview: vi.fn(async (repo: { slug: string }) => {
                if (failing.includes(repo.slug)) throw new Error(`${repo.slug} did not listen`)
                started.push(repo.slug)
                return `https://${repo.slug}.preview.test`
            }),
            startGateway: vi.fn().mockResolvedValue("https://gateway.preview.test")
        }
        return { runner, started }
    }
    const startRepositories = (components: never[], repositories: never[], runner: unknown) =>
        (new StandalonePreviewService(undefined, {} as never) as unknown as { startRepositories: (...args: unknown[]) => Promise<string | undefined> }).startRepositories(
            components,
            repositories,
            runner,
            {}
        )

    it("Given frontends and backends, then the backends start first, the frontend at the root last, and the others are routed under their path on the gateway", async () => {
        const { runner, started } = fakeRunner()

        const url = await startRepositories(
            [component("frontend", "shell-fe"), component("frontend", "admin-fe", "/admin"), component("backend", "orders-be", "/api/orders"), component("backend", "jobs-be")],
            [repository("shell-fe"), repository("admin-fe"), repository("orders-be"), repository("jobs-be")],
            runner
        )

        expect(url).toBe("https://gateway.preview.test")
        expect(started).toEqual(["orders-be", "jobs-be", "admin-fe", "shell-fe"])
        expect(runner.startGateway).toHaveBeenCalledWith(repository("shell-fe"), [
            { path: "/api/orders", repository: repository("orders-be") },
            { path: "/admin", repository: repository("admin-fe") }
        ])
    })

    it("Given no frontend at the root, then the preview opens on the first one, and the others still start", async () => {
        const { runner, started } = fakeRunner()

        const url = await startRepositories([component("frontend", "a-fe", "/a"), component("frontend", "c-fe", "/c")], [repository("a-fe"), repository("c-fe")], runner)

        expect(started).toEqual(["c-fe", "a-fe"])
        expect(runner.startGateway).toHaveBeenCalledWith(repository("a-fe"), [{ path: "/c", repository: repository("c-fe") }])
        expect(url).toBe("https://gateway.preview.test")
    })

    it("Given a frontend other than the one opened that fails, then the preview still opens, without its route", async () => {
        const { runner } = fakeRunner(["admin-fe"])

        const url = await startRepositories([component("frontend", "shell-fe"), component("frontend", "admin-fe", "/admin")], [repository("shell-fe"), repository("admin-fe")], runner)

        expect(url).toBe("https://shell-fe.preview.test")
        expect(runner.startGateway).not.toHaveBeenCalled()
    })

    it("Given the frontend opened fails, then the preview fails with its reason", async () => {
        const { runner } = fakeRunner(["shell-fe"])

        await expect(startRepositories([component("frontend", "shell-fe")], [repository("shell-fe")], runner)).rejects.toThrow("shell-fe did not listen")
    })

    it("Given a domain with a full-stack backend and no frontend, then the preview opens on that backend", async () => {
        const { runner, started } = fakeRunner()

        const url = await startRepositories([component("backend", "app-be")], [repository("app-be")], runner)

        expect(started).toEqual(["app-be"])
        expect(url).toBe("https://app-be.preview.test")
        expect(runner.startGateway).not.toHaveBeenCalled()
    })

    it("Given a domain of backends only, then it opens on the one at the root, the others routed under their path", async () => {
        const { runner } = fakeRunner()

        const url = await startRepositories([component("backend", "orders-be", "/api/orders"), component("backend", "app-be")], [repository("orders-be"), repository("app-be")], runner)

        expect(url).toBe("https://gateway.preview.test")
        expect(runner.startGateway).toHaveBeenCalledWith(repository("app-be"), [{ path: "/api/orders", repository: repository("orders-be") }])
    })

    it("Given a domain of backends only, none with a known development server, then the preview fails saying so", async () => {
        const { runner } = fakeRunner()
        runner.canPreview.mockResolvedValue(false)

        await expect(startRepositories([component("backend", "app-be")], [repository("app-be")], runner)).rejects.toMatchObject({ code: "OPENSHELL_PREVIEW_NO_SERVER" })
    })

    const withAgent = (discover: unknown) => {
        const service = new StandalonePreviewService(undefined, {} as never) as unknown as {
            discover: unknown
            startRepositories: (...args: unknown[]) => Promise<string | undefined>
        }
        service.discover = discover
        return (components: never[], repositories: never[], runner: unknown) => service.startRepositories(components, repositories, runner, {})
    }

    it("Given a full-stack backend Flightroom cannot start, then an agent finds how and the preview opens on it", async () => {
        const { runner } = fakeRunner(["app-be"])
        runner.canPreview.mockResolvedValue(false)
        const discover = vi.fn().mockResolvedValue("https://app-be.found.test")

        const url = await withAgent(discover)([component("backend", "app-be")], [repository("app-be")], runner)

        expect(url).toBe("https://app-be.found.test")
        expect(discover).toHaveBeenCalledWith(runner, repository("app-be"), "app-be did not listen")
    })

    it("Given a frontend and a backend the agent cannot start either, then the backend is left out and the frontend still opens", async () => {
        const { runner } = fakeRunner(["orders-be"])
        runner.canPreview.mockImplementation(async (repo: { slug: string }) => repo.slug !== "orders-be")
        const discover = vi.fn().mockRejectedValue(new Error("no way found"))

        const url = await withAgent(discover)([component("frontend", "shell-fe"), component("backend", "orders-be", "/api")], [repository("shell-fe"), repository("orders-be")], runner)

        expect(url).toBe("https://shell-fe.preview.test")
        expect(runner.startGateway).not.toHaveBeenCalled()
    })
})

describe("backendPreviewUrl", () => {
    it("Given a backend with docs, then its preview opens on them, whatever slashes the two carry", () => {
        expect(backendPreviewUrl("https://preview.example.test/", "/docs")).toBe("https://preview.example.test/docs")
        expect(backendPreviewUrl("https://gateway.example.test/sandbox/abc", "api/docs")).toBe("https://gateway.example.test/sandbox/abc/api/docs")
    })

    it("Given a backend without docs, then its preview opens on its root", () => {
        expect(backendPreviewUrl("https://preview.example.test/", undefined)).toBe("https://preview.example.test/")
    })
})
