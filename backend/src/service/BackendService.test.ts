import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The scaffold backend reaches the application instance for its logger; importing the real one would
// boot Fastify.
vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

const getSingle = vi.fn()
vi.mock("./MarketService", () => ({
    default: class {
        getSingle = getSingle
    }
}))

const createRepository = vi.fn()
const createTag = vi.fn()
vi.mock("./TemplateScaffoldService", () => ({
    default: class {
        createRepository = createRepository
        createTag = createTag
    }
}))
vi.mock("./templateScaffold/pipelineTemplates", async importOriginal => ({
    ...(await importOriginal<typeof import("./templateScaffold/pipelineTemplates")>()),
    placeholderDomain: () => "https://console.example.com"
}))

const forgetBackends = vi.fn()
vi.mock("./workspace/workspaceCleanup", () => ({ forgetBackends: (...args: unknown[]) => forgetBackends(...args) }))

import { BusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ApiKeyRole } from "../models/ApiKeyModel"
import BackendDeployment from "../models/BackendDeploymentModel"
import Backend from "../models/BackendModel"
import BuiltBackend from "../models/BuiltBackendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Domain from "../models/DomainModel"
import Environment from "../models/EnvironmentModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import { ConfigMap, Secret } from "../models/VariableMapModel"
import { withNoMaintenanceAgents } from "../testing/noMaintenanceAgents"
import BackendDTO from "../types/BackendDTO"
import { BackendRuntime } from "../types/BackendStack"
import { FrontendStackSource } from "../types/FrontendStack"
import BackendService, {
    ensureRequestsWithinLimits,
    imageRepositoryOf,
    isNewerVersion,
    withNormalizedEnvironmentResources,
    withNormalizedEnvironmentVersions,
    withNormalizedReplicas
} from "./BackendService"

withNoMaintenanceAgents()

const projectId = new Types.ObjectId().toString()
const backendId = new Types.ObjectId()

afterEach(() => {
    vi.restoreAllMocks()
    getSingle.mockReset()
    createRepository.mockReset()
    createTag.mockReset()
})

describe("BackendService.registerVersionWithPermissionCheck", () => {
    let findOne: ReturnType<typeof vi.fn>
    let upsert: ReturnType<typeof vi.fn>
    let updateOne: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId } as never)
        findOne = vi.spyOn(Backend, "findOne").mockResolvedValue({ _id: backendId, slug: "orders-api" } as never) as unknown as ReturnType<typeof vi.fn>
        upsert = vi
            .spyOn(BuiltBackend, "findOneAndUpdate")
            .mockImplementation((async (_filter: unknown, update: { $set: Record<string, unknown> }) => ({ backendId, ...update.$set })) as never) as unknown as ReturnType<typeof vi.fn>
        updateOne = vi.spyOn(Backend, "updateOne").mockResolvedValue({ matchedCount: 1 } as never) as unknown as ReturnType<typeof vi.fn>
    })

    const register = (body: unknown, slug = "orders-api", version = "1.2.0") => new BackendService().registerVersionWithPermissionCheck(slug, version, projectId, body, ApiKeyRole.MANAGER)

    it.each([[ApiKeyRole.VIEWER], [undefined]])("given a %s key, when a version is registered, then it is forbidden before anything is read or stored", async role => {
        const refusal = new BackendService().registerVersionWithPermissionCheck("orders-api", "1.2.0", projectId, { image: "ghcr.io/acme/orders-api:1.2.0" }, role)

        await expect(refusal).rejects.toMatchObject({ statusCode: 403 })
        expect(findOne).not.toHaveBeenCalled()
        expect(upsert).not.toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given no backend but a maintenance agent with the slug, when its CI registers a version, then the agent moves to it", async () => {
        const agentId = new Types.ObjectId()
        findOne.mockResolvedValue(null)
        vi.spyOn(MaintenanceAgent, "findOne").mockResolvedValue({ _id: agentId, slug: "cleaner" } as never)
        const agentUpdate = vi.spyOn(MaintenanceAgent, "updateOne").mockResolvedValue({ matchedCount: 1 } as never)

        await register({ image: "ghcr.io/acme/cleaner:1.2.0" }, "cleaner")

        expect(upsert.mock.calls[0][0]).toEqual({ backendId: agentId, version: "1.2.0" })
        expect(agentUpdate).toHaveBeenCalledWith({ _id: agentId, version: null }, { $set: { version: "1.2.0", "image.repository": "ghcr.io/acme/cleaner" } })
        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given a tag that is not semver, when it is registered on a backend with a version, then it is stored but the backend keeps its version", async () => {
        findOne.mockResolvedValue({ _id: backendId, slug: "orders-api", version: "1.1.0", image: { repository: "ghcr.io/acme/orders-api" } })

        await register({ image: "ghcr.io/acme/orders-api:nightly" }, "orders-api", "nightly")

        expect(upsert).toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given two runs of one tag inserting at once, when the upsert hits the unique index, then it is retried once", async () => {
        upsert.mockRejectedValueOnce(Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }))

        const built = await register({ image: "ghcr.io/acme/orders-api:1.2.0" })

        expect(upsert).toHaveBeenCalledTimes(2)
        expect(built).toMatchObject({ image: "ghcr.io/acme/orders-api:1.2.0" })
    })

    it("given another failure of the upsert, when a version is registered, then it is not retried", async () => {
        upsert.mockRejectedValueOnce(new Error("connection lost"))

        await expect(register({ image: "ghcr.io/acme/orders-api:1.2.0" })).rejects.toThrow("connection lost")
        expect(upsert).toHaveBeenCalledTimes(1)
    })

    /** Two pipelines finishing together: the one that lost reads the version again and decides again */
    it("given the version moved since it was read, when a version is registered, then the update reads again and keeps the newer one", async () => {
        findOne.mockResolvedValue({ _id: backendId, slug: "orders-api", version: "1.1.0", image: { repository: "ghcr.io/acme/orders-api" } })
        updateOne.mockResolvedValueOnce({ matchedCount: 0 })
        const reread = vi.spyOn(Backend, "findById").mockResolvedValue({ _id: backendId, version: "1.3.0", image: { repository: "ghcr.io/acme/orders-api" } } as never)

        await register({ image: "ghcr.io/acme/orders-api:1.2.0" })

        expect(updateOne).toHaveBeenCalledTimes(1)
        expect(updateOne).toHaveBeenCalledWith({ _id: backendId, version: "1.1.0" }, { $set: { version: "1.2.0" } })
        expect(reread).toHaveBeenCalledWith(backendId)
    })

    it("given an image, when a version is registered, then it is upserted on backend and version and becomes the backend version", async () => {
        const built = await register({ image: "ghcr.io/acme/orders-api:1.2.0", digest: "sha256:abc", commitSha: "deadbeef" })

        expect(upsert).toHaveBeenCalledWith(
            { backendId, version: "1.2.0" },
            { $set: { image: "ghcr.io/acme/orders-api:1.2.0", digest: "sha256:abc", commitSha: "deadbeef" } },
            expect.objectContaining({ upsert: true })
        )
        expect(updateOne).toHaveBeenCalledWith({ _id: backendId, version: null }, { $set: { version: "1.2.0", "image.repository": "ghcr.io/acme/orders-api" } })
        expect(built).toMatchObject({ image: "ghcr.io/acme/orders-api:1.2.0", digest: "sha256:abc" })
    })

    it("given a backend with its image repository set, when a version is registered, then the repository is kept", async () => {
        findOne.mockResolvedValue({ _id: backendId, slug: "orders-api", version: "1.1.0", image: { repository: "registry.acme.io/orders" } })

        await register({ image: "ghcr.io/acme/orders-api:1.2.0" })

        expect(updateOne).toHaveBeenCalledWith({ _id: backendId, version: "1.1.0" }, { $set: { version: "1.2.0" } })
    })

    it("given an older version registered late, when it is registered, then the backend keeps its newer version", async () => {
        findOne.mockResolvedValue({ _id: backendId, slug: "orders-api", version: "1.3.0", image: { repository: "ghcr.io/acme/orders-api" } })

        await register({ image: "ghcr.io/acme/orders-api:1.2.0" })

        expect(upsert).toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given a rerun without digest, when the version is registered again, then the stale digest is removed", async () => {
        await register({ image: "ghcr.io/acme/orders-api:1.2.0" })

        expect(upsert.mock.calls[0][1]).toEqual({ $set: { image: "ghcr.io/acme/orders-api:1.2.0" }, $unset: { digest: "", commitSha: "" } })
    })

    it.each([[undefined], [{}], [{ image: "" }], [{ image: "   " }], [{ image: 42 }]])("given the body %j, when a version is registered, then it is refused before anything is stored", async body => {
        await expect(register(body)).rejects.toBeInstanceOf(BusinessException)
        expect(upsert).not.toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given a digest that is not a string, when a version is registered, then it is refused", async () => {
        await expect(register({ image: "ghcr.io/acme/orders-api:1.2.0", digest: { sha: 1 } })).rejects.toBeInstanceOf(BusinessException)
    })

    it("given a slug no backend of the project has, when a version is registered, then it is not found", async () => {
        findOne.mockResolvedValue(null)

        await expect(register({ image: "ghcr.io/acme/x:1" }, "unknown")).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(upsert).not.toHaveBeenCalled()
    })

    /** The project comes from the API key: a slug of another project is never reachable with it */
    it("given a key of one project, when a version is registered, then the backend is looked up in that project only", async () => {
        await register({ image: "ghcr.io/acme/orders-api:1.2.0" }, "Orders-API")

        const filter = findOne.mock.calls[0][0] as { slug: string; projectId: unknown }
        expect(filter.slug).toBe("orders-api")
        expect(String(filter.projectId)).toBe(projectId)
    })
})

describe("BackendService.create", () => {
    const codeRepositoryId = new Types.ObjectId().toString()

    let exists: ReturnType<typeof vi.fn>

    beforeEach(() => {
        exists = vi.spyOn(Backend, "exists").mockResolvedValue(null) as unknown as ReturnType<typeof vi.fn>
    })

    const create = async (template: Record<string, unknown> | null, slug = " Orders-API ", overrides: Partial<BackendDTO> = {}) => {
        const backend = new BackendService()
        vi.spyOn(backend as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({ _id: codeRepositoryId, projectId } as never)
        const write = vi.spyOn(Backend, "create").mockImplementation((async (doc: unknown) => doc) as never)
        getSingle.mockResolvedValue(template)
        await backend.create(
            {
                name: "Orders API",
                slug,
                codeRepository: { enabled: true, codeRepositoryId, repositoryId: "", createData: { name: "orders-api", template: "service-node-fastify" } },
                ...overrides
            } as BackendDTO,
            projectId
        )
        return write.mock.calls[0]?.[0] as unknown as BackendDTO
    }

    it("given a backend template, when a backend is created, then the repository is scaffolded with the backend placeholders and the stack is kept", async () => {
        const written = await create({ slug: "service-node-fastify", type: "service", compiler: "docker", framework: "Node.js" })

        expect(createRepository).toHaveBeenCalledWith(expect.anything(), expect.anything(), "orders-api", expect.objectContaining({ slug: "service-node-fastify" }), {
            placeholders: { "%serviceSlug%": "orders-api", "%domain%": "https://console.example.com" }
        })
        expect(written.template).toBe("service-node-fastify")
        expect(written.stack).toEqual({ runtime: BackendRuntime.NODE, framework: "Node.js", source: FrontendStackSource.TEMPLATE })
        expect(written.codeRepository?.createData).toBeUndefined()
    })

    it("given a frontend template, when a backend is created, then it is refused before any repository is created", async () => {
        await expect(create({ slug: "vite-remote-react", type: "remote", compiler: "vite", framework: "React" })).rejects.toBeInstanceOf(BusinessException)
        expect(createRepository).not.toHaveBeenCalled()
    })

    it("given an unknown template, when a backend is created, then it is refused before any repository is created", async () => {
        await expect(create(null)).rejects.toBeInstanceOf(BusinessException)
        expect(createRepository).not.toHaveBeenCalled()
    })

    it("given a template typed with another case, when a backend is created, then it is still a backend template", async () => {
        const written = await create({ slug: "service-quarkus", type: "Service", compiler: "docker", framework: "Quarkus" })

        expect(createRepository).toHaveBeenCalledTimes(1)
        expect(written.stack?.runtime).toBe(BackendRuntime.JAVA)
    })

    const springBoot = {
        slug: "service-spring-boot",
        type: "service",
        compiler: "docker",
        framework: "Spring Boot",
        backendDefaults: { port: 8081, livenessPath: "/actuator/health/liveness", readinessPath: "/actuator/health/readiness", docsPath: "/swagger-ui.html", openApiPath: "/v3/api-docs" }
    }

    it("given a template with backend defaults and a backend that sets none, when it is created, then port, probes and API docs come from the template", async () => {
        const written = await create(springBoot)

        expect(written).toMatchObject(springBoot.backendDefaults)
        expect(written.stack?.runtime).toBe(BackendRuntime.JAVA)
    })

    it("given a backend that sets some of the template defaults, when it is created, then its own values are kept and only the rest come from the template", async () => {
        const written = await create(springBoot, " Orders-API ", { port: 9090, readinessPath: "/ready", docsPath: "" })

        expect(written).toMatchObject({
            port: 9090,
            livenessPath: "/actuator/health/liveness",
            readinessPath: "/ready",
            docsPath: "",
            openApiPath: "/v3/api-docs"
        })
    })

    it("given a template without backend defaults, when a backend is created, then nothing is filled in and the model defaults apply", async () => {
        const written = await create({ slug: "service-node-fastify", type: "service", framework: "Node.js" })

        expect(written.port).toBeUndefined()
        expect(written.livenessPath).toBeUndefined()
        expect(written.docsPath).toBeUndefined()
    })

    it("given a slug another backend of the project has, when a backend is created, then it is refused with a 409 before any repository is created", async () => {
        exists.mockResolvedValue({ _id: backendId })

        await expect(create({ slug: "service-node-fastify", type: "service", framework: "Node.js" })).rejects.toMatchObject({ statusCode: 409, code: "BACKEND_SLUG_TAKEN" })
        expect(exists).toHaveBeenCalledWith({ slug: "orders-api", projectId: expect.anything() })
        expect(getSingle).not.toHaveBeenCalled()
        expect(createRepository).not.toHaveBeenCalled()
    })

    it.each([["a"], ["-orders"], ["orders_api"], ["orders.api"], ["orders/api"], ["x".repeat(51)], [""]])(
        "given the slug %j, when a backend is created, then it is refused with a 400 before any repository is created",
        async slug => {
            await expect(create({ slug: "service-node-fastify", type: "service", framework: "Node.js" }, slug)).rejects.toMatchObject({ statusCode: 400, code: "BACKEND_SLUG_INVALID" })
            expect(exists).not.toHaveBeenCalled()
            expect(createRepository).not.toHaveBeenCalled()
        }
    )

    it("given a document the model refuses, when a backend is created, then it is refused with a 400 before any repository is created", async () => {
        const backend = new BackendService()
        vi.spyOn(backend as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()

        const refusal = backend.create({ slug: "orders-api", codeRepository: { enabled: true, codeRepositoryId, repositoryId: "", createData: { name: "orders-api" } } } as BackendDTO, projectId)

        await expect(refusal).rejects.toMatchObject({ statusCode: 400, code: "BACKEND_INVALID" })
        expect(createRepository).not.toHaveBeenCalled()
    })
})

describe("BackendService.update", () => {
    const backend = { _id: backendId, projectId, slug: "orders-api", name: "Orders API" }

    beforeEach(() => {
        vi.spyOn(Backend, "findById").mockResolvedValue(backend as never)
        vi.spyOn(BackendService.prototype as unknown as { ensureAccessToBackend: () => Promise<void> }, "ensureAccessToBackend").mockResolvedValue(undefined)
    })

    it("given a slug in the updates, when a backend is updated, then the slug is never written", async () => {
        const write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never)

        await new BackendService().update(String(backendId), { name: "Orders", slug: "renamed" } as BackendDTO)

        expect(write.mock.calls[0][1]).toEqual({ name: "Orders" })
    })

    it("given a version set by hand, when a backend is updated, then it is written trimmed", async () => {
        const write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never)

        await new BackendService().update(String(backendId), { name: "Orders", version: " 1.4.0 " } as BackendDTO)

        expect(write.mock.calls[0][1]).toEqual({ name: "Orders", version: "1.4.0" })
    })

    it.each(["", "1.4.0+build", "release/1"])("given the version %j, when a backend is updated, then it is refused before anything is written", async version => {
        const write = vi.spyOn(Backend, "findByIdAndUpdate")

        await expect(new BackendService().update(String(backendId), { name: "Orders", version } as BackendDTO)).rejects.toMatchObject({ code: "BACKEND_VERSION_INVALID" })
        expect(write).not.toHaveBeenCalled()
    })

    it("given new probe and docs paths, when a backend is updated, then they are written and validated", async () => {
        const write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never)
        const paths = { livenessPath: "/q/health/live", readinessPath: "/q/health/ready", docsPath: "/q/swagger-ui", openApiPath: "/q/openapi" }

        await new BackendService().update(String(backendId), { name: "Orders", ...paths } as BackendDTO)

        expect(write).toHaveBeenCalledWith(backendId, { name: "Orders", ...paths }, { new: true, runValidators: true })
    })

    it("given a connection of another project, when a backend is linked to it, then it is not found and nothing is written", async () => {
        const codeRepositoryId = new Types.ObjectId().toString()
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({ _id: codeRepositoryId, projectId: new Types.ObjectId() } as never)
        const write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never)

        const refusal = new BackendService().update(String(backendId), { name: "Orders", codeRepository: { enabled: true, codeRepositoryId, repositoryId: "1" } } as BackendDTO)

        await expect(refusal).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(write).not.toHaveBeenCalled()
    })

    it("given a connection of its project, when a backend is linked to it, then the link is written without any creation request", async () => {
        const codeRepositoryId = new Types.ObjectId().toString()
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({ _id: codeRepositoryId, projectId } as never)
        const write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never)

        await new BackendService().update(String(backendId), {
            name: "Orders",
            codeRepository: { enabled: true, codeRepositoryId, repositoryId: "1", createData: { name: "x" } }
        } as BackendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ codeRepository: { codeRepositoryId, createData: undefined } })
    })

    it("given a domain of another project, when a backend is put in it, then it is not found and nothing is written", async () => {
        const domainId = new Types.ObjectId().toString()
        const exists = vi.spyOn(Domain, "exists").mockResolvedValue(null)
        const write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never)

        const refusal = new BackendService().update(String(backendId), { name: "Orders", domainId } as BackendDTO)

        await expect(refusal).rejects.toMatchObject({ code: "DOMAIN_NOT_FOUND", statusCode: 404 })
        expect(exists).toHaveBeenCalledWith({ _id: domainId, projectId })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a blank domain, when a backend is updated, then it is taken out of its domain", async () => {
        const write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never)

        await new BackendService().update(String(backendId), { name: "Orders", domainId: "" } as BackendDTO)

        expect(write.mock.calls[0][1]).toEqual({ name: "Orders", domainId: null })
    })
})

describe("BackendService.update of the attached maps", () => {
    const logging = new Types.ObjectId().toString()
    const database = new Types.ObjectId().toString()
    const backend = { _id: backendId, projectId, slug: "orders-api", name: "Orders API", configMapIds: [logging], secretIds: [] }
    let write: ReturnType<typeof vi.fn>
    let configMaps: ReturnType<typeof vi.fn>
    let secrets: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.spyOn(Backend, "findById").mockResolvedValue(backend as never)
        vi.spyOn(BackendService.prototype as unknown as { ensureAccessToBackend: () => Promise<void> }, "ensureAccessToBackend").mockResolvedValue(undefined)
        configMaps = vi.spyOn(ConfigMap, "find").mockResolvedValue([{ _id: logging, name: "logging", entries: [{ key: "LOG_LEVEL" }] }] as never) as unknown as ReturnType<typeof vi.fn>
        secrets = vi.spyOn(Secret, "find").mockResolvedValue([{ _id: database, name: "database", entries: [{ key: "DATABASE_PASSWORD" }] }] as never) as unknown as ReturnType<typeof vi.fn>
        write = vi.spyOn(Backend, "findByIdAndUpdate").mockResolvedValue(backend as never) as unknown as ReturnType<typeof vi.fn>
    })

    const update = (changes: Partial<BackendDTO>) => new BackendService().update(String(backendId), { name: "Orders API", ...changes } as BackendDTO)

    it("given an update with neither list of maps, when the backend is updated, then no map is read and neither list is written", async () => {
        await update({})

        expect(configMaps).not.toHaveBeenCalled()
        expect(secrets).not.toHaveBeenCalled()
        expect(write.mock.calls[0][1]).toEqual({ name: "Orders API" })
    })

    it("given only the secrets, when the backend is updated, then they are written once each and checked against the config maps it already has", async () => {
        await update({ secretIds: [database, database] })

        expect(configMaps.mock.calls[0][0]).toMatchObject({ projectId })
        expect(write.mock.calls[0][1]).toEqual({ name: "Orders API", secretIds: [database] })
    })

    it.each([[{ $set: { secretIds: [database] } }], [{ "secretIds.0": database }]])("given %j, when the backend is updated, then it is refused before any map is read", async changes => {
        const refusal = update(changes as Partial<BackendDTO>)

        await expect(refusal).rejects.toMatchObject({ code: "BACKEND_INVALID" })
        expect(secrets).not.toHaveBeenCalled()
        expect(write).not.toHaveBeenCalled()
    })

    it("given a map that is not one of the project, when the backend is updated, then it is refused and nothing is written", async () => {
        secrets.mockResolvedValue([])

        const refusal = update({ secretIds: [new Types.ObjectId().toString()] })

        await expect(refusal).rejects.toMatchObject({ code: "BACKEND_VARIABLE_MAP_UNKNOWN" })
        expect(write).not.toHaveBeenCalled()
    })

    it("given an id that is not one, when the backend is updated, then it is refused", async () => {
        await expect(update({ configMapIds: ["not-an-id"] })).rejects.toMatchObject({ code: "BACKEND_VARIABLE_MAPS_INVALID" })
    })

    it("given a secret setting a key a config map of the backend sets, when the backend is updated, then it is refused and nothing is written", async () => {
        secrets.mockResolvedValue([{ _id: database, name: "database", entries: [{ key: "LOG_LEVEL" }] }])

        const refusal = update({ secretIds: [database] })

        await expect(refusal).rejects.toMatchObject({ code: "BACKEND_VARIABLE_KEY_DUPLICATED" })
        expect(write).not.toHaveBeenCalled()
    })

    describe("and of the resources", () => {
        const orders = new Types.ObjectId().toString()
        let resources: ReturnType<typeof vi.fn>

        beforeEach(() => {
            resources = vi.spyOn(Resource, "find").mockResolvedValue([{ _id: orders, name: "orders", type: "database", variant: "credentials" }] as never) as unknown as ReturnType<typeof vi.fn>
        })

        const attach = (resourceIds: string[]) => {
            // The backend attaches no secret: the read of them finds none
            secrets.mockResolvedValue([])
            return update({ resourceIds })
        }

        it("given the secrets only of a backend with no resource, when it is updated, then no resource is read nor written", async () => {
            await update({ secretIds: [database] })

            expect(resources).not.toHaveBeenCalled()
            expect(write.mock.calls[0][1]).not.toHaveProperty("resourceIds")
        })

        it("given a resource of the project listed twice, when the backend is updated, then it is written once and checked against the maps it has", async () => {
            await attach([orders, orders])

            expect(resources.mock.calls[0][0]).toMatchObject({ projectId })
            expect(configMaps).toHaveBeenCalled()
            expect(write.mock.calls[0][1]).toEqual({ name: "Orders API", resourceIds: [orders] })
        })

        it("given a resource that is not one of the project, when the backend is updated, then it is refused and nothing is written", async () => {
            resources.mockResolvedValue([])

            await expect(attach([new Types.ObjectId().toString()])).rejects.toMatchObject({ code: "BACKEND_RESOURCE_UNKNOWN" })
            expect(write).not.toHaveBeenCalled()
        })

        it("given a resource setting a key a config map of the backend sets, when the backend is updated, then it is refused and nothing is written", async () => {
            configMaps.mockResolvedValue([{ _id: logging, name: "logging", entries: [{ key: "DB_ORDERS_HOST" }] }])

            await expect(attach([orders])).rejects.toMatchObject({ code: "BACKEND_VARIABLE_KEY_DUPLICATED" })
            expect(write).not.toHaveBeenCalled()
        })
    })
})

describe("BackendService.build", () => {
    beforeEach(() => {
        vi.spyOn(Backend, "findById").mockResolvedValue({ _id: backendId, projectId, slug: "orders-api", codeRepository: { enabled: true } } as never)
        vi.spyOn(BackendService.prototype as unknown as { ensureAccessToBackend: () => Promise<void> }, "ensureAccessToBackend").mockResolvedValue(undefined)
    })

    it.each([["1.2.0"], ["v1.2.0-rc.1"], ["2026.10.17_1"]])("given the version %s, when a backend is built, then its repository is tagged in its project", async version => {
        await new BackendService().build(String(backendId), version, "main")

        expect(createTag).toHaveBeenCalledWith({ enabled: true }, projectId, version, "main")
    })

    it.each([["1.2.0+build.5"], [""], ["1.2.0 beta"], ["release/1.2.0"], ["$(rm -rf /)"], ["x".repeat(129)]])(
        "given the version %j, when a backend is built, then it is refused with a 400 before anything is tagged",
        async version => {
            await expect(new BackendService().build(String(backendId), version)).rejects.toMatchObject({ statusCode: 400, code: "BACKEND_VERSION_INVALID" })
            expect(createTag).not.toHaveBeenCalled()
        }
    )
})

describe("imageRepositoryOf", () => {
    it.each([
        ["ghcr.io/acme/orders-api:1.2.0", "ghcr.io/acme/orders-api"],
        ["host:5000/acme/orders:1.2.0", "host:5000/acme/orders"],
        ["host:5000/acme/orders", "host:5000/acme/orders"],
        ["ghcr.io/acme/orders@sha256:abc", "ghcr.io/acme/orders"],
        ["host:5000/orders:1.2.0@sha256:abc", "host:5000/orders"],
        ["orders", "orders"]
    ])("given %s, then the repository is %s", (image, repository) => {
        expect(imageRepositoryOf(image)).toBe(repository)
    })
})

describe("ensureRequestsWithinLimits", () => {
    const environmentId = new Types.ObjectId()

    it("given an environment whose own limit is below the request of the application, when it is checked, then it is refused", () => {
        expect(() => ensureRequestsWithinLimits({ cpuRequest: "1", cpuLimit: "2", environmentResources: [{ environmentId, cpuLimit: "500m" }] })).toThrow(BusinessException)
    })

    it("given an environment that raises both the request and the limit, when it is checked, then it is accepted", () => {
        expect(() => ensureRequestsWithinLimits({ cpuRequest: "250m", environmentResources: [{ environmentId, cpuRequest: "2", cpuLimit: "4" }] })).not.toThrow()
    })

    it("given a lower limit of the application under the request an environment kept from before, when it is checked, then it is refused", () => {
        const existing = { environmentResources: [{ environmentId, memoryRequest: "1Gi" }], memoryLimit: "2Gi" }

        expect(() => ensureRequestsWithinLimits({ memoryLimit: "512Mi" }, existing)).toThrow(BusinessException)
    })
})

describe("withNormalizedEnvironmentResources", () => {
    const projectObjectId = new Types.ObjectId(projectId) as never
    const production = new Types.ObjectId()

    beforeEach(() => {
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: production }] as never)
    })

    it("given values with blanks and an environment setting none, when normalized, then blanks are null and that environment is left out", async () => {
        const dto = {
            environmentResources: [
                { environmentId: String(production), cpuLimit: " 2 ", memoryLimit: "" },
                { environmentId: String(new Types.ObjectId()), cpuRequest: " " }
            ]
        }

        expect((await withNormalizedEnvironmentResources(dto, projectObjectId)).environmentResources).toEqual([
            { environmentId: String(production), cpuRequest: null, cpuLimit: "2", memoryRequest: null, memoryLimit: null, replicas: null }
        ])
    })

    it("given an environment setting only its replicas, as the digits a form sends, when normalized, then it is kept with a number", async () => {
        const dto = { environmentResources: [{ environmentId: String(production), replicas: " 3 " as unknown as number }] }

        expect((await withNormalizedEnvironmentResources(dto, projectObjectId)).environmentResources).toEqual([
            { environmentId: String(production), cpuRequest: null, cpuLimit: null, memoryRequest: null, memoryLimit: null, replicas: 3 }
        ])
    })

    it.each([
        ["an environment of another project", [{ environmentId: String(new Types.ObjectId()), cpuLimit: "1" }]],
        [
            "an environment listed twice",
            [
                { environmentId: String(production), cpuLimit: "1" },
                { environmentId: String(production), memoryLimit: "1Gi" }
            ]
        ],
        ["a value that is no quantity", [{ environmentId: String(production), memoryLimit: "lots" }]],
        ["replicas that are no whole number", [{ environmentId: String(production), replicas: 1.5 }]],
        ["replicas above the most", [{ environmentId: String(production), replicas: 21 }]]
    ])("given %s, when normalized, then it is refused", async (_case, environmentResources) => {
        await expect(withNormalizedEnvironmentResources({ environmentResources }, projectObjectId)).rejects.toThrow(BusinessException)
    })

    it("given no environmentResources, when normalized, then nothing is read", async () => {
        expect(await withNormalizedEnvironmentResources({}, projectObjectId)).toEqual({})
        expect(Environment.find).not.toHaveBeenCalled()
    })
})

describe("withNormalizedReplicas", () => {
    it.each([
        ["left out", {}, {}],
        ["blank, as a form sends an empty field", { replicas: "" }, { replicas: null }],
        ["the digits a form sends", { replicas: "3" }, { replicas: 3 }],
        ["zero, a container that runs no pod", { replicas: "0" }, { replicas: 0 }],
        ["a number", { replicas: 20 }, { replicas: 20 }]
    ])("given replicas %s, when normalized, then they are stored as a number or null", (_case, dto, expected) => {
        expect(withNormalizedReplicas(dto as never)).toEqual(expected)
    })

    it.each([[-1], [21], [1.5], ["two"]])("given replicas %s, when normalized, then they are refused", replicas => {
        expect(() => withNormalizedReplicas({ replicas: replicas as never })).toThrow(BusinessException)
    })
})

describe("withNormalizedEnvironmentVersions", () => {
    const projectObjectId = new Types.ObjectId(projectId) as never
    const production = new Types.ObjectId()

    beforeEach(() => {
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: production }] as never)
    })

    it("given a version with spaces and an environment left blank, when normalized, then the version is trimmed and that environment is left out", async () => {
        const dto = {
            environmentVersions: [
                { environmentId: String(production), version: " 1.2.0 " },
                { environmentId: String(new Types.ObjectId()), version: "" }
            ]
        }

        expect((await withNormalizedEnvironmentVersions(dto, projectObjectId)).environmentVersions).toEqual([{ environmentId: String(production), version: "1.2.0" }])
    })

    it.each([
        ["an environment of another project", [{ environmentId: String(new Types.ObjectId()), version: "1.0.0" }]],
        [
            "an environment listed twice",
            [
                { environmentId: String(production), version: "1.0.0" },
                { environmentId: String(production), version: "1.1.0" }
            ]
        ],
        ["a version that is no tag of an image", [{ environmentId: String(production), version: "1.0.0+build" }]]
    ])("given %s, when normalized, then it is refused", async (_case, environmentVersions) => {
        await expect(withNormalizedEnvironmentVersions({ environmentVersions }, projectObjectId)).rejects.toThrow(BusinessException)
    })

    it("given no environmentVersions, when normalized, then nothing is read", async () => {
        expect(await withNormalizedEnvironmentVersions({}, projectObjectId)).toEqual({})
        expect(Environment.find).not.toHaveBeenCalled()
    })
})

describe("isNewerVersion", () => {
    it.each([
        ["1.2.0", undefined, true],
        ["1.2.0", "1.1.9", true],
        ["1.10.0", "1.9.0", true],
        ["v2.0.0", "1.9.9", true],
        ["1.2.0", "1.2.0", false],
        ["1.1.0", "1.2.0", false],
        ["1.2.0", "1.2.0-beta.1", true],
        ["1.2.0-beta.1", "1.2.0", false],
        ["1.2.0-beta.2", "1.2.0-beta.1", true],
        ["1.2.0-alpha.10", "1.2.0-alpha.9", true],
        ["latest", undefined, true],
        ["1.2.0", "", true],
        ["latest", "1.2.0", false],
        ["1.2.0", "nightly", false]
    ])("given %s over %s, then it is newer: %s", (candidate, current, newer) => {
        expect(isNewerVersion(candidate, current)).toBe(newer)
    })
})

describe("BackendService.delete", () => {
    it("given a backend, when it is deleted, then its versions and reported deploys go and its workspace and AI changes are forgotten", async () => {
        const backend = { _id: backendId, projectId, slug: "orders-api" }
        vi.spyOn(Backend, "findById").mockResolvedValue(backend as never)
        vi.spyOn(BackendService.prototype as unknown as { ensureAccessToBackend: () => Promise<void> }, "ensureAccessToBackend").mockResolvedValue(undefined)
        const deleteVersions = vi.spyOn(BuiltBackend, "deleteMany").mockResolvedValue({} as never)
        const deleteDeploys = vi.spyOn(BackendDeployment, "deleteMany").mockResolvedValue({} as never)
        vi.spyOn(Backend, "findByIdAndDelete").mockResolvedValue(backend as never)

        await new BackendService().delete(String(backendId))

        expect(deleteVersions).toHaveBeenCalledWith({ backendId })
        expect(deleteDeploys).toHaveBeenCalledWith({ backendId })
        expect(forgetBackends).toHaveBeenCalledWith([backend])
    })
})
