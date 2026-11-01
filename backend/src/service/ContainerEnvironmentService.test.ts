import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({ fastify: { log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, config: { REPOSITORIES_FOLDER: "/repositories" } } }))

import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import { ConfigMap, Secret } from "../models/VariableMapModel"
import ContainerEnvironmentService from "./ContainerEnvironmentService"

const projectId = new Types.ObjectId()
const environmentId = new Types.ObjectId()
const otherEnvironmentId = new Types.ObjectId()
const backendId = new Types.ObjectId()
const domainId = new Types.ObjectId()
const configMapId = new Types.ObjectId()
const secretId = new Types.ObjectId()
const resourceId = new Types.ObjectId()

const backend = (overrides: Record<string, unknown> = {}) => ({
    _id: backendId,
    projectId,
    domainId,
    slug: "orders",
    port: 3000,
    exposurePath: "/orders",
    image: { repository: "ghcr.io/acme/orders" },
    environmentVersions: [{ environmentId, version: "1.4.0" }],
    configMapIds: [configMapId],
    secretIds: [secretId],
    resourceIds: [resourceId],
    env: [
        { name: "DB_PASSWORD", required: true, secret: true },
        { name: "PAYMENTS_URL", required: true, secret: false }
    ],
    ...overrides
})

const project = (overrides: Record<string, unknown> = {}) => ({
    _id: projectId,
    slug: "acme",
    exposure: { domain: "acme.example.com", certificateIssuer: "letsencrypt" },
    gitOps: { enabled: true, codeRepository: {}, applicationsCodeRepository: {} },
    ...overrides
})

const base = ContainerEnvironmentService.prototype as unknown as { ensureAccessToProject: () => Promise<void>; getDomainScope: () => Promise<string[] | undefined> }

describe("ContainerEnvironmentService.get", () => {
    beforeEach(() => {
        vi.spyOn(base, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(base, "getDomainScope").mockResolvedValue(undefined)
        vi.spyOn(Backend, "findOne").mockResolvedValue(backend() as never)
        // The backends of the project, for the URLs every container gets: this one only
        vi.spyOn(Backend, "find").mockResolvedValue([backend()] as never)
        vi.spyOn(Frontend, "findOne").mockResolvedValue(null as never)
        vi.spyOn(Frontend, "find").mockResolvedValue([
            {
                _id: new Types.ObjectId(),
                slug: "shop",
                exposurePath: "/shop",
                backendIds: [backendId],
                image: { repository: "ghcr.io/acme/shop" },
                environmentVersions: [{ environmentId, version: "2.0.0" }]
            }
        ] as never)
        vi.spyOn(Project, "findById").mockResolvedValue(project() as never)
        vi.spyOn(Environment, "find").mockResolvedValue([
            { _id: environmentId, slug: "dev", subdomain: "dev", logLevel: "debug", logJson: true },
            { _id: otherEnvironmentId, slug: "prod", isProduction: true }
        ] as never)
        vi.spyOn(ConfigMap, "find").mockResolvedValue([
            {
                _id: configMapId,
                name: "orders-config",
                entries: [
                    { key: "LOG_LEVEL", value: "warn" },
                    { key: "SHOWN", value: "all", values: [{ environmentId, value: "dev-only" }] }
                ]
            }
        ] as never)
        vi.spyOn(Secret, "find").mockResolvedValue([
            {
                _id: secretId,
                name: "orders-db",
                entries: [
                    { key: "DB_PASSWORD", value: "s3cr3t-value" },
                    { key: "UNSET_HERE", values: [{ environmentId: otherEnvironmentId, value: "x" }] }
                ]
            }
        ] as never)
        vi.spyOn(Resource, "find").mockResolvedValue([
            { _id: resourceId, name: "cache", type: "redis", variant: "credentials", values: [{ field: "host", value: "redis.internal" }], secrets: [{ field: "password", value: "redis-pass" }] }
        ] as never)
    })

    afterEach(() => vi.restoreAllMocks())

    const get = (kind: "backend" | "frontend" = "backend") => new ContainerEnvironmentService({ _id: "user-1" } as never).get(String(projectId), { kind, id: String(backendId) }, String(environmentId))

    it("given a deployed backend, when its environment is read, then the platform's variables, the config map's values and the secrets masked come back, with what wins", async () => {
        const result = await get()

        expect(result).toMatchObject({ state: "next_deploy", version: "1.4.0" })
        expect(result.notes).toBeUndefined()
        expect(result.variables).toContainEqual({ name: "HTTP_PORT", source: "platform", value: "3000" })
        expect(result.variables).toContainEqual({ name: "PUBLIC_URL", source: "platform", value: "https://dev.acme.example.com/orders" })
        expect(result.variables).toContainEqual({ name: "LOG_LEVEL", source: "configMap orders-config", value: "warn", overriddenBy: "platform" })
        expect(result.variables).toContainEqual({ name: "SHOWN", source: "configMap orders-config", value: "dev-only" })
        expect(result.variables).toContainEqual({ name: "DB_PASSWORD", source: "secret orders-db", masked: { set: true, length: 12 } })
        expect(result.variables.map(variable => variable.name)).not.toContain("UNSET_HERE")
        const fromResource = result.variables.filter(variable => variable.source === "resource cache.resource")
        expect(fromResource.map(variable => variable.name)).toEqual(expect.arrayContaining([expect.stringMatching(/^REDIS_.*HOST$/), expect.stringMatching(/^REDIS_.*PASSWORD$/)]))
        expect(fromResource.find(variable => variable.name.endsWith("HOST"))).toMatchObject({ masked: { set: true, length: 14 } })
        expect(fromResource.find(variable => variable.name.endsWith("PASSWORD"))).toMatchObject({ masked: { set: true, length: 10 } })
        expect(fromResource.every(variable => variable.masked && variable.value === undefined)).toBe(true)
        expect(result.missing).toEqual([{ name: "PAYMENTS_URL", required: true, secret: false }])
        const json = JSON.stringify(result)
        expect(json).not.toContain("s3cr3t-value")
        expect(json).not.toContain("redis-pass")
        expect(json).not.toContain("redis.internal")
    })

    it("given another backend and a DOCKER frontend deployed in the environment, when the environment is read, then their URLs inside the cluster come from the platform's ConfigMap", async () => {
        vi.mocked(Backend.find).mockResolvedValue([
            backend(),
            backend({ _id: new Types.ObjectId(), slug: "payments" }),
            backend({ _id: new Types.ObjectId(), slug: "billing", environmentVersions: [] })
        ] as never)

        const result = await get()

        const services = result.variables.filter(variable => variable.source === "configMap services.flightroom")
        expect(services).toEqual([
            { name: "ORDERS_URL", source: "configMap services.flightroom", value: "http://orders" },
            { name: "PAYMENTS_URL", source: "configMap services.flightroom", value: "http://payments" },
            { name: "SHOP_URL", source: "configMap services.flightroom", value: "http://shop" }
        ])
        expect(Frontend.find).toHaveBeenCalledWith({ projectId: String(projectId), kind: "DOCKER" })
        expect(result.missing).toEqual([])
    })

    it("given an environment that sets no version of it, when its environment is read, then it says the deploy leaves it out, an earlier container possibly still running", async () => {
        vi.mocked(Backend.findOne).mockResolvedValue(backend({ environmentVersions: [{ environmentId: otherEnvironmentId, version: "1.4.0" }] }) as never)

        await expect(get()).resolves.toEqual({ state: "not_in_deploy", variables: [], missing: [] })
        expect(ConfigMap.find).not.toHaveBeenCalled()
    })

    it.each([{ enabled: false }, { enabled: true, codeRepository: {} }])("given a project deploying no container through GitOps (%o), when the environment is read, then it says so", async gitOps => {
        vi.mocked(Project.findById).mockResolvedValue(project({ gitOps }) as never)

        await expect(get()).resolves.toEqual({ state: "no_gitops", variables: [], missing: [] })
        expect(ConfigMap.find).not.toHaveBeenCalled()
    })

    it("given an environment whose subdomain the deploy would refuse, when its environment is read, then the rest comes back without PUBLIC_URL and a note says why", async () => {
        vi.mocked(Environment.find).mockResolvedValue([{ _id: environmentId, slug: "dev", subdomain: "Not_A_Label" }] as never)

        const result = await get()

        expect(result.state).toBe("next_deploy")
        expect(result.variables.map(variable => variable.name)).not.toContain("PUBLIC_URL")
        expect(result.variables).toContainEqual({ name: "HTTP_PORT", source: "platform", value: "3000" })
        expect(result.notes).toEqual([expect.stringMatching(/^PUBLIC_URL left out: .*Not_A_Label/)])
    })

    it("given a value too long to send, when the environment is read, then it is cut and says so", async () => {
        vi.mocked(ConfigMap.find).mockResolvedValue([{ _id: configMapId, name: "orders-config", entries: [{ key: "BIG", value: "x".repeat(5_000) }] }] as never)

        const big = (await get()).variables.find(variable => variable.name === "BIG")

        expect(big?.value).toMatch(/… \[cut at 2000 of 5000 characters\]$/)
    })

    it("given a member scoped to another domain, when they read the environment of a backend of this one, then it is refused before anything is read", async () => {
        vi.mocked(base.getDomainScope).mockResolvedValue([String(new Types.ObjectId())])

        await expect(get()).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        expect(ConfigMap.find).not.toHaveBeenCalled()
        expect(Secret.find).not.toHaveBeenCalled()
    })

    it("given a frontend, when its environment is read, then only a DOCKER one of the project is looked for", async () => {
        await expect(get("frontend")).rejects.toThrow()

        const filter = vi.mocked(Frontend.findOne).mock.calls[0][0] as unknown as { _id: unknown; projectId: unknown; kind: string }
        expect([String(filter._id), String(filter.projectId), filter.kind]).toEqual([String(backendId), String(projectId), "DOCKER"])
    })

    it("given ids that are not ids, when the environment is read, then nothing is looked for", async () => {
        await expect(new ContainerEnvironmentService({ _id: "user-1" } as never).get(String(projectId), { kind: "backend", id: "nope" }, String(environmentId))).rejects.toThrow()
        await expect(new ContainerEnvironmentService({ _id: "user-1" } as never).get(String(projectId), { kind: "backend", id: String(backendId) }, "nope")).rejects.toThrow()
        expect(Backend.findOne).not.toHaveBeenCalled()
    })
})
