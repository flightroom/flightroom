import { beforeEach, describe, expect, it, vi } from "vitest"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import UserCannotAccessThisProjectError from "../../errors/UserCannotAccessThisProjectError"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { McpSession, McpToolContext } from "../toolDefinition"
import { backendTools } from "./backendTools"

const listBackends = vi.fn()
const getBackend = vi.fn()
const createBackend = vi.fn()
const updateBackend = vi.fn()
const deleteBackend = vi.fn()
const backendVersions = vi.fn()
const buildBackend = vi.fn()
const getDomain = vi.fn()
const findCodeRepository = vi.fn()
const getContext = vi.fn()
const attachedVariableKeys = vi.fn()

// Hoisted with the mocks below, which build their service classes with it
const { principals, serviceClass } = vi.hoisted(() => {
    const principals: unknown[] = []
    const serviceClass = (methods: Record<string, unknown>) =>
        class {
            constructor(principal: unknown) {
                principals.push(principal)
                Object.assign(this, methods)
            }
        }
    return { principals, serviceClass }
})

vi.mock("../../service/BackendService", () => ({
    default: serviceClass({
        getByProjectId: (...args: unknown[]) => listBackends(...args),
        getById: (...args: unknown[]) => getBackend(...args),
        create: (...args: unknown[]) => createBackend(...args),
        update: (...args: unknown[]) => updateBackend(...args),
        delete: (...args: unknown[]) => deleteBackend(...args),
        getVersionsById: (...args: unknown[]) => backendVersions(...args),
        build: (...args: unknown[]) => buildBackend(...args)
    })
}))
vi.mock("../../service/DomainService", () => ({ default: serviceClass({ getById: (...args: unknown[]) => getDomain(...args) }) }))
vi.mock("../../service/ProjectService", () => ({ default: serviceClass({ getContext: (...args: unknown[]) => getContext(...args) }) }))
vi.mock("../../service/CodeRepositoryService", () => ({ default: serviceClass({ findById: (...args: unknown[]) => findCodeRepository(...args) }) }))
vi.mock("../../service/VariableMapService", () => ({ attachedVariableKeys: (...args: unknown[]) => attachedVariableKeys(...args) }))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const DOMAIN = "bbbbbbbbbbbbbbbbbbbbbbbb"
const FOREIGN_DOMAIN = "cccccccccccccccccccccccc"
const BACKEND = "dddddddddddddddddddddddd"
const CODE_REPOSITORY = "eeeeeeeeeeeeeeeeeeeeeeee"

const tool = (name: string) => backendTools.find(candidate => candidate.name === name)!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "MEMBER" }],
        scopes: [MCP_SCOPE_READ, MCP_SCOPE_WRITE],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

/** Runs the tool on its parsed input, as the MCP server and the assistant do. */
const run = (name: string, args: Record<string, unknown>) => tool(name).run(tool(name).inputSchema.parse(args) as never, context())

const ordersApi = { _id: BACKEND, name: "Orders API", slug: "orders-api", domainId: DOMAIN, port: 8080 }

describe("backend tools", () => {
    beforeEach(() => {
        for (const mock of [listBackends, getBackend, createBackend, updateBackend, deleteBackend, backendVersions, buildBackend, getDomain, findCodeRepository]) {
            mock.mockReset()
        }
        principals.length = 0
    })

    it("given their definitions, when read, then reads need mfe:read, writes mfe:write and only the delete is destructive", () => {
        const reads = backendTools.filter(definition => definition.scope === MCP_SCOPE_READ).map(definition => definition.name)
        expect(reads.sort()).toEqual(["backend_get", "backend_versions", "backends_list"])
        for (const definition of backendTools) {
            expect(definition.consoleOnly, definition.name).toBeFalsy()
        }
        expect(backendTools.filter(definition => definition.annotations.destructiveHint).map(definition => definition.name)).toEqual(["backend_delete"])
    })

    describe("backends_list", () => {
        const backends = [ordersApi, { _id: "ffffffffffffffffffffffff", slug: "billing", domainId: null }, { _id: "999999999999999999999999", slug: "legacy" }]

        it("given backends, when listed without a filter, then every backend of the project comes back", async () => {
            listBackends.mockResolvedValue(backends)

            expect(await run("backends_list", {})).toEqual(backends)
            expect(listBackends).toHaveBeenCalledWith(PROJECT)
            expect(principals[0]).toMatchObject({ restrictedToProjectIds: [PROJECT] })
        })

        it("given backends in and out of domains, when listed by domain or by none, then only the matching ones come back", async () => {
            listBackends.mockResolvedValue(backends)
            getDomain.mockResolvedValue({ _id: DOMAIN })

            expect(((await run("backends_list", { domainId: DOMAIN })) as { slug: string }[]).map(item => item.slug)).toEqual(["orders-api"])
            expect(((await run("backends_list", { domainId: DOMAIN.toUpperCase() })) as { slug: string }[]).map(item => item.slug)).toEqual(["orders-api"])
            expect(((await run("backends_list", { domainId: "none" })) as { slug: string }[]).map(item => item.slug)).toEqual(["billing", "legacy"])
        })

        it("given an unknown domain, when listed by it, then it is not found rather than an empty list", async () => {
            listBackends.mockResolvedValue(backends)
            getDomain.mockResolvedValue(null)

            await expect(run("backends_list", { domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(EntityNotFoundError)
        })
    })

    describe("backend_get", () => {
        it("given a backend of the project, when read, then it comes back with the AI context of the backend, its domain and the project, and the keys of what it attaches", async () => {
            const aiContext = {
                project: { id: PROJECT, name: "Shop" },
                domains: [],
                frontends: [],
                backends: [{ id: BACKEND, slug: "orders-api", name: "Orders API", context: "Routes live in src/routes" }]
            }
            getContext.mockResolvedValue(aiContext)
            const attachedVariables = [{ key: "DB_ORDERS_URL", secret: true, source: "resource", from: "orders", resourceType: "database" }]
            attachedVariableKeys.mockResolvedValue(attachedVariables)
            const backend = { ...ordersApi, toObject: () => ordersApi }
            getBackend.mockResolvedValue(backend)

            expect(await run("backend_get", { backendId: BACKEND })).toEqual({ ...ordersApi, aiContext, attachedVariables })
            expect(getContext).toHaveBeenCalledWith(PROJECT, { backendId: BACKEND })
            expect(attachedVariableKeys).toHaveBeenCalledWith(backend, PROJECT)
        })

        it("given a backend that does not exist, when read, then it is not found", async () => {
            getBackend.mockResolvedValue(null)

            await expect(run("backend_get", { backendId: BACKEND })).rejects.toBeInstanceOf(EntityNotFoundError)
        })
    })

    describe("backend_create", () => {
        const input = { name: "Orders API", slug: "orders-api", port: 3000, env: [{ name: "DATABASE_URL", required: true, secret: true }] }

        it("given a backend in a domain of the project, when created, then the service creates it in the project", async () => {
            getDomain.mockResolvedValue({ _id: DOMAIN })
            createBackend.mockResolvedValue(ordersApi)

            expect(await run("backend_create", { ...input, domainId: DOMAIN })).toBe(ordersApi)
            expect(createBackend).toHaveBeenCalledWith({ ...input, domainId: DOMAIN }, PROJECT)
        })

        it("given a domain of another project, when created, then it is refused before anything is written", async () => {
            getDomain.mockRejectedValue(new UserCannotAccessThisProjectError())

            await expect(run("backend_create", { ...input, domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
            expect(createBackend).not.toHaveBeenCalled()
        })

        it("given a code repository connection of another project, when created, then it is refused before anything is written", async () => {
            findCodeRepository.mockRejectedValue(new EntityNotFoundError(CODE_REPOSITORY))

            await expect(run("backend_create", { ...input, codeRepository: { enabled: true, codeRepositoryId: CODE_REPOSITORY, repositoryId: "42" } })).rejects.toBeInstanceOf(EntityNotFoundError)
            expect(createBackend).not.toHaveBeenCalled()
        })

        it("given a request to scaffold a repository, a version or a project id, when parsed, then they are dropped", () => {
            const parsed = tool("backend_create").inputSchema.parse({
                ...input,
                version: "1.0.0",
                template: "node-api",
                projectId: PROJECT,
                codeRepository: { enabled: true, codeRepositoryId: CODE_REPOSITORY, repositoryId: "42", createData: { name: "orders-api" } }
            }) as Record<string, unknown> & { codeRepository: Record<string, unknown> }

            expect(parsed).not.toHaveProperty("version")
            expect(parsed).not.toHaveProperty("template")
            expect(parsed).not.toHaveProperty("projectId")
            expect(parsed.codeRepository).not.toHaveProperty("createData")
        })

        it("given an invalid slug, probe path, port or variable name, when validated, then it is refused", () => {
            const schema = tool("backend_create").inputSchema

            expect(schema.safeParse({ ...input, slug: "-orders" }).success).toBe(false)
            expect(schema.safeParse({ ...input, livenessPath: "health" }).success).toBe(false)
            expect(schema.safeParse({ ...input, port: 70000 }).success).toBe(false)
            expect(schema.safeParse({ ...input, env: [{ name: "1BAD" }] }).success).toBe(false)
        })
    })

    describe("backend_update", () => {
        it("given resources to attach, when updated, then their ids reach the backend, more than 50 or a bad id refused", async () => {
            getBackend.mockResolvedValue(ordersApi)
            updateBackend.mockResolvedValue(ordersApi)
            const resourceIds = ["ffffffffffffffffffffffff"]

            await run("backend_update", { backendId: BACKEND, resourceIds })

            expect(updateBackend).toHaveBeenCalledWith(BACKEND, { resourceIds })
            const schema = backendTools.find(candidate => candidate.name === "backend_update")!.inputSchema
            expect(schema.safeParse({ backendId: BACKEND, resourceIds: ["nope"] }).success).toBe(false)
            expect(schema.safeParse({ backendId: BACKEND, resourceIds: Array.from({ length: 51 }, () => resourceIds[0]) }).success).toBe(false)
        })

        it("given new fields, when updated, then they reach the backend and the slug is dropped", async () => {
            getBackend.mockResolvedValue(ordersApi)
            updateBackend.mockResolvedValue(ordersApi)

            await run("backend_update", { backendId: BACKEND, slug: "renamed", port: 9000, docsPath: null })

            expect(updateBackend).toHaveBeenCalledWith(BACKEND, { port: 9000, docsPath: null })
        })

        it("given a domain of another project, when updated, then it is refused before anything is written", async () => {
            getBackend.mockResolvedValue(ordersApi)
            getDomain.mockResolvedValue(null)

            await expect(run("backend_update", { backendId: BACKEND, domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(EntityNotFoundError)
            expect(updateBackend).not.toHaveBeenCalled()
        })

        it("given a code repository connection of another project, when updated, then it is refused before anything is written", async () => {
            getBackend.mockResolvedValue(ordersApi)
            findCodeRepository.mockRejectedValue(new EntityNotFoundError(CODE_REPOSITORY))

            await expect(run("backend_update", { backendId: BACKEND, codeRepository: { enabled: true, codeRepositoryId: CODE_REPOSITORY, repositoryId: "42" } })).rejects.toBeInstanceOf(
                EntityNotFoundError
            )
            expect(updateBackend).not.toHaveBeenCalled()
        })

        it("given null as domain, when updated, then the backend is taken out of its domain", async () => {
            getBackend.mockResolvedValue(ordersApi)
            updateBackend.mockResolvedValue({ ...ordersApi, domainId: null })

            await run("backend_update", { backendId: BACKEND, domainId: null })

            expect(getDomain).not.toHaveBeenCalled()
            expect(updateBackend).toHaveBeenCalledWith(BACKEND, { domainId: null })
        })

        it("given a backend of another project, when updated, then the refusal surfaces and nothing is written", async () => {
            getBackend.mockRejectedValue(new UserCannotAccessThisProjectError())

            await expect(run("backend_update", { backendId: BACKEND, port: 9000 })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
            expect(updateBackend).not.toHaveBeenCalled()
        })
    })

    describe("backend_delete", () => {
        it("given a backend, when deleted, then the service deletes it", async () => {
            deleteBackend.mockResolvedValue(ordersApi)

            expect(await run("backend_delete", { backendId: BACKEND })).toBe(ordersApi)
            expect(deleteBackend).toHaveBeenCalledWith(BACKEND)
        })

        it("given a backend of another project, when deleted, then the refusal surfaces", async () => {
            deleteBackend.mockRejectedValue(new UserCannotAccessThisProjectError())

            await expect(run("backend_delete", { backendId: BACKEND })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
        })
    })

    describe("backend_versions", () => {
        it("given a backend, when its versions are listed, then the backend's list is returned", async () => {
            backendVersions.mockResolvedValue([{ version: "1.2.0" }])

            expect(await run("backend_versions", { backendId: BACKEND })).toEqual([{ version: "1.2.0" }])
            expect(backendVersions).toHaveBeenCalledWith(BACKEND)
        })
    })

    describe("backend_trigger_build", () => {
        it("given a version and a branch, when triggered, then the backend tags the branch and it reaches outside", async () => {
            buildBackend.mockResolvedValue(undefined)
            getBackend.mockResolvedValue({ ...ordersApi, codeRepository: { enabled: true } })

            expect(await run("backend_trigger_build", { backendId: BACKEND, version: "1.3.0", branch: "develop" })).toEqual({ triggered: true })
            expect(buildBackend).toHaveBeenCalledWith(BACKEND, "1.3.0", "develop")
            expect(tool("backend_trigger_build").annotations).toMatchObject({ openWorldHint: true, destructiveHint: false })
        })

        it("given a backend without a linked repository, when triggered, then it is refused rather than answered as started", async () => {
            getBackend.mockResolvedValue(ordersApi)

            await expect(run("backend_trigger_build", { backendId: BACKEND, version: "1.3.0" })).rejects.toMatchObject({ code: "BACKEND_REPOSITORY_MISSING" })
            expect(buildBackend).not.toHaveBeenCalled()
        })

        it("given a version that cannot be a tag, when the input is validated, then it is refused", () => {
            expect(tool("backend_trigger_build").inputSchema.safeParse({ backendId: BACKEND, version: "1.3 beta" }).success).toBe(false)
        })
    })

    describe("config maps and secrets", () => {
        it("given map ids, when a backend is updated, then they reach the backend", async () => {
            getBackend.mockResolvedValue(ordersApi)
            updateBackend.mockResolvedValue(ordersApi)

            await run("backend_update", { backendId: BACKEND, configMapIds: [DOMAIN], secretIds: [FOREIGN_DOMAIN] })

            expect(updateBackend).toHaveBeenCalledWith(BACKEND, expect.objectContaining({ configMapIds: [DOMAIN], secretIds: [FOREIGN_DOMAIN] }))
        })
    })
})
