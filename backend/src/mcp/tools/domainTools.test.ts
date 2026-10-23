import { beforeEach, describe, expect, it, vi } from "vitest"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import UserCannotAccessThisProjectError from "../../errors/UserCannotAccessThisProjectError"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { McpSession, McpToolContext } from "../toolDefinition"
import { domainTools } from "./domainTools"
import { frontendTools } from "./frontendTools"

const listDomains = vi.fn()
const getDomain = vi.fn()
const createDomain = vi.fn()
const updateDomain = vi.fn()
const deleteDomain = vi.fn()
const buildDomain = vi.fn()
const listFrontends = vi.fn()
const getFrontend = vi.fn()
const createFrontend = vi.fn()
const updateFrontend = vi.fn()
const listBackends = vi.fn()
const getContext = vi.fn()
const listResources = vi.fn()

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

vi.mock("../../service/DomainService", () => ({
    default: serviceClass({
        getByProjectId: (...args: unknown[]) => listDomains(...args),
        getById: (...args: unknown[]) => getDomain(...args),
        create: (...args: unknown[]) => createDomain(...args),
        update: (...args: unknown[]) => updateDomain(...args),
        delete: (...args: unknown[]) => deleteDomain(...args),
        build: (...args: unknown[]) => buildDomain(...args)
    })
}))
vi.mock("../../service/FrontendService", () => ({
    default: serviceClass({
        getByProjectId: (...args: unknown[]) => listFrontends(...args),
        getById: (...args: unknown[]) => getFrontend(...args),
        create: (...args: unknown[]) => createFrontend(...args),
        update: (...args: unknown[]) => updateFrontend(...args)
    })
}))
vi.mock("../../service/BackendService", () => ({ default: serviceClass({ getByProjectId: (...args: unknown[]) => listBackends(...args) }) }))
vi.mock("../../service/ProjectService", () => ({ default: serviceClass({ getContext: (...args: unknown[]) => getContext(...args) }) }))
vi.mock("../../service/ResourceService", () => ({ ResourceService: serviceClass({ getByProjectId: (...args: unknown[]) => listResources(...args) }) }))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const DOMAIN = "bbbbbbbbbbbbbbbbbbbbbbbb"
const FOREIGN_DOMAIN = "cccccccccccccccccccccccc"
const FRONTEND = "dddddddddddddddddddddddd"
const BACKEND = "eeeeeeeeeeeeeeeeeeeeeeee"

const tools = [...domainTools, ...frontendTools]
const tool = (name: string) => tools.find(candidate => candidate.name === name)!

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

const domain = { _id: DOMAIN, name: "Checkout", slug: "checkout", toObject: () => ({ _id: DOMAIN, name: "Checkout", slug: "checkout" }) }

describe("domain tools", () => {
    beforeEach(() => {
        for (const mock of [listDomains, getDomain, createDomain, updateDomain, deleteDomain, buildDomain, listFrontends, getFrontend, createFrontend, updateFrontend, listBackends, listResources]) {
            mock.mockReset()
        }
        principals.length = 0
    })

    it("given their definitions, when read, then reads need mfe:read, writes mfe:write and only the delete is destructive", () => {
        for (const definition of domainTools) {
            expect(definition.consoleOnly, definition.name).toBeFalsy()
            expect(definition.scope, definition.name).toBe(["domains_list", "domain_get"].includes(definition.name) ? MCP_SCOPE_READ : MCP_SCOPE_WRITE)
        }
        expect(domainTools.filter(definition => definition.annotations.destructiveHint).map(definition => definition.name)).toEqual(["domain_delete"])
        expect(tool("domain_delete").description).toContain('"no domain"')
    })

    it("given domains with members, when listed, then the counts the service returns come back from the project of the token", async () => {
        const domains = [{ _id: DOMAIN, name: "Checkout", frontendsCount: 2, backendsCount: 1 }]
        listDomains.mockResolvedValue(domains)

        expect(await run("domains_list", {})).toEqual(domains)
        expect(listDomains).toHaveBeenCalledWith(PROJECT)
        expect(principals[0]).toMatchObject({ restrictedToProjectIds: [PROJECT] })
    })

    it("given a domain, when read, then its frontends and backends are listed by id, name and slug, with the AI context of the domain", async () => {
        const aiContext = { project: { id: PROJECT, name: "Shop" }, domains: [{ id: DOMAIN, slug: "checkout", name: "Checkout", context: "Prices are in cents" }], frontends: [], backends: [] }
        getContext.mockResolvedValue(aiContext)
        getDomain.mockResolvedValue(domain)
        listFrontends.mockResolvedValue([
            { _id: FRONTEND, name: "Cart", slug: "cart", domainId: DOMAIN, version: "1.0.0" },
            { _id: "ffffffffffffffffffffffff", name: "Search", slug: "search", domainId: null }
        ])
        listBackends.mockResolvedValue([{ _id: BACKEND, name: "Orders API", slug: "orders-api", domainId: DOMAIN, port: 8080 }])

        expect(await run("domain_get", { domainId: DOMAIN })).toEqual({
            _id: DOMAIN,
            name: "Checkout",
            slug: "checkout",
            frontends: [{ _id: FRONTEND, name: "Cart", slug: "cart" }],
            backends: [{ _id: BACKEND, name: "Orders API", slug: "orders-api" }],
            aiContext
        })
        expect(getContext).toHaveBeenCalledWith(PROJECT, { domainId: DOMAIN })
    })

    it("given a domain whose backends attach resources, when read, then each is listed with its variables and the backends using it, and resources are read only then", async () => {
        getContext.mockResolvedValue({})
        getDomain.mockResolvedValue(domain)
        listFrontends.mockResolvedValue([])
        const database = "abababababababababababab"
        listBackends.mockResolvedValue([
            { _id: BACKEND, name: "Orders API", slug: "orders-api", domainId: DOMAIN, resourceIds: [database] },
            { _id: "ffffffffffffffffffffffff", name: "Search", slug: "search", domainId: null, resourceIds: ["cdcdcdcdcdcdcdcdcdcdcdcd"] }
        ])
        listResources.mockResolvedValue([
            { _id: database, name: "orders", type: "database", variant: "connectionString", secrets: [{ field: "connectionString", value: "postgres://secret" }] },
            { _id: "cdcdcdcdcdcdcdcdcdcdcdcd", name: "search", type: "redis", variant: "connectionString" }
        ])

        const result = (await run("domain_get", { domainId: DOMAIN })) as { resources?: unknown }

        expect(result.resources).toEqual([
            { _id: database, name: "orders", type: "database", variant: "connectionString", env: ["DB_ORDERS_ENGINE", "DB_ORDERS_URL", "DB_ORDERS_SCHEMA"], usedBy: ["orders-api"] }
        ])
        expect(JSON.stringify(result)).not.toContain("postgres://secret")
        expect(listResources).toHaveBeenCalledWith(PROJECT)
    })

    it("given a domain whose backends attach none, when read, then no resource is read nor listed", async () => {
        getContext.mockResolvedValue({})
        getDomain.mockResolvedValue(domain)
        listFrontends.mockResolvedValue([])
        listBackends.mockResolvedValue([{ _id: BACKEND, name: "Orders API", slug: "orders-api", domainId: DOMAIN }])

        expect(await run("domain_get", { domainId: DOMAIN })).not.toHaveProperty("resources")
        expect(listResources).not.toHaveBeenCalled()
    })

    it("given a domain that does not exist, when read, then it is not found", async () => {
        getDomain.mockResolvedValue(null)

        await expect(run("domain_get", { domainId: DOMAIN })).rejects.toBeInstanceOf(EntityNotFoundError)
    })

    it("given a name, a slug and a description, when created, then the domain is created in the project", async () => {
        createDomain.mockResolvedValue(domain)
        const input = { name: "Checkout", slug: "checkout", description: "Paying for the cart" }

        expect(await run("domain_create", input)).toBe(domain)
        expect(createDomain).toHaveBeenCalledWith(input, PROJECT)
    })

    it("given an invalid slug or an empty name, when the input is validated, then it is refused", () => {
        const schema = tool("domain_create").inputSchema

        expect(schema.safeParse({ name: "Checkout" }).success).toBe(true)
        expect(schema.safeParse({ name: "" }).success).toBe(false)
        expect(schema.safeParse({ name: "Checkout", slug: "Check out" }).success).toBe(false)
    })

    it("given a new name and description, when updated, then only those reach the backend and a slug is dropped", async () => {
        updateDomain.mockResolvedValue(domain)

        await run("domain_update", { domainId: DOMAIN, name: "Payments", description: "Money", slug: "payments" })

        expect(updateDomain).toHaveBeenCalledWith(DOMAIN, { name: "Payments", description: "Money" })
    })

    it("given null as description, when updated, then null reaches the backend to clear it", async () => {
        updateDomain.mockResolvedValue(domain)

        await run("domain_update", { domainId: DOMAIN, description: null })

        expect(updateDomain).toHaveBeenCalledWith(DOMAIN, { description: null })
    })

    it("given a domain of another project, when updated, then the refusal surfaces", async () => {
        updateDomain.mockRejectedValue(new UserCannotAccessThisProjectError())

        await expect(run("domain_update", { domainId: FOREIGN_DOMAIN, name: "Payments" })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
    })

    it("given a domain, when deleted, then the service deletes it", async () => {
        deleteDomain.mockResolvedValue(domain)

        expect(await run("domain_delete", { domainId: DOMAIN })).toBe(domain)
        expect(deleteDomain).toHaveBeenCalledWith(DOMAIN)
    })

    it("given a domain of another project, when deleted, then the refusal surfaces", async () => {
        deleteDomain.mockRejectedValue(new UserCannotAccessThisProjectError())

        await expect(run("domain_delete", { domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
    })

    describe("domain_trigger_build", () => {
        it("given a version and a branch, when run, then the backend tags the domain and its per-repository result comes back", async () => {
            const result = { version: "1.4.0", ref: "release", repositories: [{ repository: "cart-fe", members: [], status: "tagged" }] }
            buildDomain.mockResolvedValue(result)

            expect(await run("domain_trigger_build", { domainId: DOMAIN, version: "1.4.0", branch: "release" })).toBe(result)
            expect(buildDomain).toHaveBeenCalledWith(DOMAIN, "1.4.0", "release")
        })

        it("given its definition, when read, then it reaches the git providers without destroying anything", () => {
            expect(tool("domain_trigger_build").annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true, destructiveHint: false })
        })

        it.each([["1.4 beta"], [""], ["x".repeat(129)]])("given the version %j, when validated, then it is refused", version => {
            expect(tool("domain_trigger_build").inputSchema.safeParse({ domainId: DOMAIN, version }).success).toBe(false)
        })

        it.each([["release..1"], ["has space"], ["/main"], ["main.lock"], [""]])("given the branch %j, when validated, then it is refused as git would", branch => {
            expect(tool("domain_trigger_build").inputSchema.safeParse({ domainId: DOMAIN, version: "1.4.0", branch }).success).toBe(false)
        })

        it("given a branch with a slash, when validated, then it is accepted", () => {
            expect(tool("domain_trigger_build").inputSchema.safeParse({ domainId: DOMAIN, version: "1.4.0", branch: "release/1.4" }).success).toBe(true)
        })

        it("given a repository failing its check, when run, then the refusal surfaces", async () => {
            buildDomain.mockRejectedValue(Object.assign(new Error("No repository was tagged"), { code: "DOMAIN_BUILD_CHECK_FAILED" }))

            await expect(run("domain_trigger_build", { domainId: DOMAIN, version: "1.4.0" })).rejects.toMatchObject({ code: "DOMAIN_BUILD_CHECK_FAILED" })
        })
    })
})

describe("frontend tools and domains", () => {
    beforeEach(() => {
        for (const mock of [getDomain, listFrontends, getFrontend, createFrontend, updateFrontend]) {
            mock.mockReset()
        }
    })

    const frontends = [
        { _id: FRONTEND, slug: "cart", domainId: DOMAIN },
        { _id: "ffffffffffffffffffffffff", slug: "search", domainId: null },
        { _id: "999999999999999999999999", slug: "legacy" }
    ]

    it("given frontends in and out of domains, when listed by domain, then only the matching ones come back", async () => {
        listFrontends.mockResolvedValue(frontends)
        getDomain.mockResolvedValue(domain)

        expect(((await run("frontends_list", { domainId: DOMAIN })) as { slug: string }[]).map(item => item.slug)).toEqual(["cart"])
        expect(getDomain).toHaveBeenCalledWith(DOMAIN)
        expect(((await run("frontends_list", { domainId: "none" })) as { slug: string }[]).map(item => item.slug)).toEqual(["search", "legacy"])
        expect(((await run("frontends_list", {})) as unknown[]).length).toBe(3)
        expect(getDomain).toHaveBeenCalledTimes(1)
    })

    it("given a domain id in uppercase, when listed by it, then the same frontends come back", async () => {
        listFrontends.mockResolvedValue(frontends)
        getDomain.mockResolvedValue(domain)

        expect(((await run("frontends_list", { domainId: DOMAIN.toUpperCase() })) as { slug: string }[]).map(item => item.slug)).toEqual(["cart"])
    })

    it("given an unknown domain or one of another project, when listed by it, then it is not found rather than an empty list", async () => {
        listFrontends.mockResolvedValue(frontends)
        getDomain.mockResolvedValueOnce(null).mockRejectedValueOnce(new UserCannotAccessThisProjectError())

        await expect(run("frontends_list", { domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(EntityNotFoundError)
        await expect(run("frontends_list", { domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
    })

    it("given a domain filter that is neither an id nor none, when validated, then it is refused", () => {
        expect(tool("frontends_list").inputSchema.safeParse({ domainId: "all" }).success).toBe(false)
    })

    it("given a domain of the project, when a frontend is created in it, then the domain reaches the backend", async () => {
        getDomain.mockResolvedValue(domain)
        createFrontend.mockResolvedValue({ _id: FRONTEND })

        await run("frontend_create", { name: "Cart", slug: "cart", version: "1.0.0", domainId: DOMAIN })

        expect(getDomain).toHaveBeenCalledWith(DOMAIN)
        expect(createFrontend).toHaveBeenCalledWith(expect.objectContaining({ domainId: DOMAIN }), PROJECT)
    })

    it("given a domain of another project, when a frontend is created in it, then it is refused before anything is written", async () => {
        getDomain.mockRejectedValue(new UserCannotAccessThisProjectError())

        await expect(run("frontend_create", { name: "Cart", slug: "cart", version: "1.0.0", domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
        expect(createFrontend).not.toHaveBeenCalled()
    })

    it("given a domain that does not exist, when a frontend is moved to it, then it is refused before anything is written", async () => {
        getFrontend.mockResolvedValue({ _id: FRONTEND })
        getDomain.mockResolvedValue(null)

        await expect(run("frontend_update", { frontendId: FRONTEND, domainId: FOREIGN_DOMAIN })).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(updateFrontend).not.toHaveBeenCalled()
    })

    it("given null as domain, when a frontend is updated, then it is taken out of its domain without a lookup", async () => {
        getFrontend.mockResolvedValue({ _id: FRONTEND })
        updateFrontend.mockResolvedValue({ _id: FRONTEND, domainId: null })
        await run("frontend_update", { frontendId: FRONTEND, domainId: null })

        expect(getDomain).not.toHaveBeenCalled()
        expect(updateFrontend).toHaveBeenCalledWith(FRONTEND, { domainId: null })
    })
})
