import { beforeEach, describe, expect, it, vi } from "vitest"
import { createBusinessException } from "../../errors/BusinessException"
import Resource from "../../models/ResourceModel"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { SECRET_PLACEHOLDER } from "../../utils/secretCrypto"
import { McpSession, McpToolContext } from "../toolDefinition"
import { resourceTools } from "./resourceTools"

const catalog = vi.fn()
const getByProjectId = vi.fn()
const getById = vi.fn()
const create = vi.fn()
const update = vi.fn()
const remove = vi.fn()

vi.mock("../../service/ResourceService", () => ({
    ResourceService: class {
        catalog = (...args: unknown[]) => catalog(...args)
        getByProjectId = (...args: unknown[]) => getByProjectId(...args)
        getById = (...args: unknown[]) => getById(...args)
        create = (...args: unknown[]) => create(...args)
        update = (...args: unknown[]) => update(...args)
        delete = (...args: unknown[]) => remove(...args)
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const RESOURCE = "bbbbbbbbbbbbbbbbbbbbbbbb"
const ENVIRONMENT = "cccccccccccccccccccccccc"

const tool = (name: string) => resourceTools.find(candidate => candidate.name === name)!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "MEMBER" }],
        scopes: [MCP_SCOPE_READ, MCP_SCOPE_WRITE],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

/** Runs the tool on its parsed input, as the MCP server and the assistant do, and serialises its result as the server does. */
const run = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(JSON.stringify(await tool(name).run(tool(name).inputSchema.parse(args) as never, context())))

/** A stored api resource: an actual model document, decrypted credential and pasted document included */
const storedApi = () =>
    new Resource({
        _id: RESOURCE,
        projectId: PROJECT,
        name: "payments",
        type: "api",
        variant: "apiKey",
        values: [{ field: "baseUrl", value: "https://api.pay.example.com", overrides: [{ environmentId: ENVIRONMENT, value: "https://dev.pay.example.com" }] }],
        secrets: [{ field: "apiKey", value: "sk-live-SECRET", overrides: [{ environmentId: ENVIRONMENT, value: "sk-test-SECRET" }] }],
        apiSpec: '{"openapi":"3.0.0","info":{"title":"Private"}}',
        apiSpecBytes: 46
    })

describe("resource tools", () => {
    beforeEach(() => {
        for (const mock of [catalog, getByProjectId, getById, create, update, remove]) {
            mock.mockReset()
        }
    })

    it("given their definitions, when read, then reads are read-only, the delete destructive and no write reaches outside", () => {
        expect(resourceTools.map(definition => definition.name)).toEqual(["resource_types_list", "resources_list", "resource_get", "resource_create", "resource_update", "resource_delete"])
        for (const definition of resourceTools) {
            expect(definition.annotations.openWorldHint, definition.name).toBe(false)
        }
        expect(resourceTools.filter(definition => definition.annotations.destructiveHint).map(definition => definition.name)).toEqual(["resource_delete"])
    })

    it("given stored resources, when listed or read, then credentials come back masked, values and overrides readable, and the API document only as present and size", async () => {
        getByProjectId.mockResolvedValue([storedApi()])
        getById.mockResolvedValue(storedApi())

        for (const result of [(await run("resources_list"))[0], await run("resource_get", { resourceId: RESOURCE })]) {
            const text = JSON.stringify(result)
            expect(text).not.toContain("sk-live-SECRET")
            expect(text).not.toContain("sk-test-SECRET")
            expect(text).not.toContain("Private")
            expect(result.fields.apiKey).toEqual({ value: SECRET_PLACEHOLDER, overrides: [{ environmentId: ENVIRONMENT, value: SECRET_PLACEHOLDER }] })
            expect(result.fields.baseUrl).toEqual({ value: "https://api.pay.example.com", overrides: [{ environmentId: ENVIRONMENT, value: "https://dev.pay.example.com" }] })
            expect(result.apiSpec).toEqual({ present: true, bytes: 46 })
            expect(result.env.map((entry: { key: string }) => entry.key)).toContain("API_PAYMENTS_API_KEY")
        }
        expect(getByProjectId).toHaveBeenCalledWith(PROJECT)
    })

    it("given a resource with fields that are no credential, when created, then it reaches the backend of the project", async () => {
        create.mockResolvedValue(storedApi())
        const input = { name: "payments", type: "api", variant: "apiKey", fields: { baseUrl: { value: "https://api.pay.example.com" }, name: { value: "X-API-Key" } } }

        const result = await run("resource_create", input)

        expect(create).toHaveBeenCalledWith(input, PROJECT)
        expect(JSON.stringify(result)).not.toContain("sk-live-SECRET")
    })

    it.each([
        ["the api key of an api", { type: "api", variant: "apiKey", fields: { apiKey: { value: "sk-live" } } }, "apiKey"],
        ["the password of a database", { type: "database", variant: "credentials", fields: { host: { value: "db" }, password: { value: "pw" } } }, "password"],
        ["an override of a client secret", { type: "auth0", variant: "default", fields: { clientSecret: { overrides: [{ environmentId: ENVIRONMENT, value: "x" }] } } }, "clientSecret"],
        ["a credential of a variant that does not exist", { type: "smtp", variant: "nope", fields: { password: { value: "pw" } } }, "password"],
        ["a variable a generic defines as secret", { type: "generic", variant: "custom", customFields: [{ name: "TOKEN", secret: true }], fields: { TOKEN: { value: "t" } } }, "TOKEN"]
    ])("given %s, when created, then it is refused before anything is written", async (_case, input, field) => {
        await expect(run("resource_create", { name: "thing", ...input })).rejects.toMatchObject({
            code: "RESOURCE_SECRET_FROM_CONSOLE",
            message: `Secret fields of a resource are set from the console: ${field}`
        })
        expect(create).not.toHaveBeenCalled()
    })

    it("given a credential in an update, when run, then it is judged by the type and variant stored and refused", async () => {
        getById.mockResolvedValue(storedApi())

        await expect(run("resource_update", { resourceId: RESOURCE, fields: { apiKey: { value: "sk-new" } } })).rejects.toMatchObject({ code: "RESOURCE_SECRET_FROM_CONSOLE" })
        await expect(run("resource_update", { resourceId: RESOURCE, variant: "bearer", fields: { token: { value: "t" } } })).rejects.toMatchObject({ code: "RESOURCE_SECRET_FROM_CONSOLE" })
        expect(update).not.toHaveBeenCalled()
    })

    it("given a generic with its variables and a plain value, when created, then they reach the backend", async () => {
        create.mockResolvedValue(storedApi())
        const input = {
            name: "billing",
            type: "generic",
            variant: "custom",
            customFields: [{ name: "BASE_URL" }, { name: "TOKEN", secret: true }],
            fields: { BASE_URL: { value: "https://billing.example.com" } }
        }

        await run("resource_create", input)

        expect(create).toHaveBeenCalledWith(input, PROJECT)
    })

    it("given a value for a variable the stored generic defines as secret, when updated, then it is refused", async () => {
        getById.mockResolvedValue(new Resource({ _id: RESOURCE, projectId: PROJECT, name: "billing", type: "generic", variant: "custom", customFields: [{ name: "TOKEN", secret: true }] }))

        await expect(run("resource_update", { resourceId: RESOURCE, fields: { TOKEN: { value: "t" } } })).rejects.toMatchObject({ code: "RESOURCE_SECRET_FROM_CONSOLE" })
        expect(update).not.toHaveBeenCalled()
    })

    it("given fields that are no credential, when updated, then they reach the backend", async () => {
        getById.mockResolvedValue(storedApi())
        update.mockResolvedValue(storedApi())

        const result = await run("resource_update", { resourceId: RESOURCE, description: "Payments", fields: { baseUrl: { value: "https://v2.pay.example.com" } } })

        expect(update).toHaveBeenCalledWith(RESOURCE, { description: "Payments", fields: { baseUrl: { value: "https://v2.pay.example.com" } } })
        expect(result.fields.apiKey.value).toBe(SECRET_PLACEHOLDER)
    })

    it("given a field sent as null, when updated, then it reaches the backend as unset", async () => {
        getById.mockResolvedValue(storedApi())
        update.mockResolvedValue(storedApi())

        await run("resource_update", { resourceId: RESOURCE, fields: { specUrl: null } })

        expect(update).toHaveBeenCalledWith(RESOURCE, { fields: { specUrl: null } })
    })

    it("given a new address for a resource with stored credentials, when updated, then it is refused and sent to the console", async () => {
        getById.mockResolvedValue(storedApi())
        update.mockRejectedValue(createBusinessException({ code: "RESOURCE_SECRET_REENTRY_REQUIRED", message: "baseUrl changed", details: { secrets: ["apiKey"], connections: ["baseUrl"] } }))

        await expect(run("resource_update", { resourceId: RESOURCE, fields: { baseUrl: { value: "https://evil.example.com" } } })).rejects.toMatchObject({
            code: "RESOURCE_SECRET_REENTRY_REQUIRED",
            message: expect.stringContaining("from the console"),
            details: { secrets: ["apiKey"], connections: ["baseUrl"] }
        })
    })

    it("given an update without fields, when run, then the resource is not read first", async () => {
        update.mockResolvedValue(storedApi())

        await run("resource_update", { resourceId: RESOURCE, name: "payments-v2" })

        expect(getById).not.toHaveBeenCalled()
        expect(update).toHaveBeenCalledWith(RESOURCE, { name: "payments-v2" })
    })

    it("given a resource, when deleted, then the service deletes it", async () => {
        remove.mockResolvedValue(storedApi())

        expect(await run("resource_delete", { resourceId: RESOURCE })).toEqual({ deleted: true })
        expect(remove).toHaveBeenCalledWith(RESOURCE)
    })

    it("given an unknown type or an invalid name, when the input is validated, then it is refused", () => {
        const schema = tool("resource_create").inputSchema

        expect(schema.safeParse({ name: "payments", type: "api", variant: "none" }).success).toBe(true)
        expect(schema.safeParse({ name: "payments", type: "queue", variant: "none" }).success).toBe(false)
        expect(schema.safeParse({ name: "Payments API", type: "api", variant: "none" }).success).toBe(false)
    })

    it("given the catalog, when listed, then the types come back", async () => {
        catalog.mockReturnValue([{ type: "api", envPrefix: "API", variants: [] }])

        expect(await run("resource_types_list")).toEqual([{ type: "api", envPrefix: "API", variants: [] }])
    })
})
