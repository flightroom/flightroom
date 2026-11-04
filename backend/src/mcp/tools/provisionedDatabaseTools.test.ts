import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetExternalCalls } from "../../utils/externalCallLimiter"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { McpSession, McpToolContext, requiresConfirmation } from "../toolDefinition"
import { provisionedDatabaseTools } from "./provisionedDatabaseTools"

const databases = { getByProjectId: vi.fn(), getById: vi.fn(), create: vi.fn(), link: vi.fn(), unlink: vi.fn(), delete: vi.fn() }

vi.mock("../../service/ProvisionedDatabaseService", () => ({
    default: class {
        getByProjectId = (...args: unknown[]) => databases.getByProjectId(...args)
        getById = (...args: unknown[]) => databases.getById(...args)
        create = (...args: unknown[]) => databases.create(...args)
        link = (...args: unknown[]) => databases.link(...args)
        unlink = (...args: unknown[]) => databases.unlink(...args)
        delete = (...args: unknown[]) => databases.delete(...args)
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
/** The connected MongoDB the databases are created on */
const SERVER = "bbbbbbbbbbbbbbbbbbbbbbbb"
const DATABASE = "cccccccccccccccccccccccc"
const RESOURCE = "dddddddddddddddddddddddd"
const ENVIRONMENT = "eeeeeeeeeeeeeeeeeeeeeeee"
const PASSWORD = "generated-password-never-shown"

const tool = (name: string) => provisionedDatabaseTools.find(candidate => candidate.name === name)!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "MEMBER" }],
        scopes: [MCP_SCOPE_READ, MCP_SCOPE_WRITE],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

const run = (name: string, args: Record<string, unknown>) => tool(name).run(tool(name).inputSchema.parse(args) as never, context())

/** A database as the model holds it: the password in clear, which only toFrontendObject masks */
const stored = { _id: DATABASE, databaseName: "report_dev", password: PASSWORD, toFrontendObject: () => ({ _id: DATABASE, databaseName: "report_dev", password: "••••" }) }

beforeEach(() => {
    for (const mock of Object.values(databases)) mock.mockReset()
    resetExternalCalls()
})

describe("the budget of the tools reaching a server", () => {
    it("given ten creates, links and deletes in a minute, when an eleventh comes, then it is refused before the service is called", async () => {
        databases.create.mockResolvedValue(stored)
        databases.link.mockResolvedValue(stored)
        for (let call = 0; call < 4; call++) await run("provisioned_database_create", { databaseId: SERVER, databaseName: "report_dev" })
        for (let call = 0; call < 4; call++) await run("provisioned_database_link", { provisionedDatabaseId: DATABASE, resourceId: RESOURCE, environmentId: ENVIRONMENT })
        for (let call = 0; call < 2; call++) await run("provisioned_database_delete", { provisionedDatabaseId: DATABASE, mode: "user" })

        await expect(run("provisioned_database_create", { databaseId: SERVER, databaseName: "report_dev" })).rejects.toMatchObject({ code: "EXTERNAL_CALLS_RATE_LIMITED", statusCode: 429 })
        expect(databases.create).toHaveBeenCalledTimes(4)
    })

    it("given the budget spent, when a database is removed from Flightroom only, then it is not counted", async () => {
        databases.create.mockResolvedValue(stored)
        for (let call = 0; call < 10; call++) await run("provisioned_database_create", { databaseId: SERVER, databaseName: "report_dev" })

        await expect(run("provisioned_database_delete", { provisionedDatabaseId: DATABASE, mode: "record" })).resolves.toEqual({ deleted: true })
    })

    it("given the budget spent, when databases are listed, then reading is not counted", async () => {
        databases.create.mockResolvedValue(stored)
        databases.getByProjectId.mockResolvedValue([])
        for (let call = 0; call < 10; call++) await run("provisioned_database_create", { databaseId: SERVER, databaseName: "report_dev" })

        await expect(run("provisioned_databases_list", {})).resolves.toEqual([])
    })
})

describe("provisioned database tools", () => {
    it.each([
        ["provisioned_databases_list", { databaseId: SERVER }, () => databases.getByProjectId.mockResolvedValue([stored])],
        ["provisioned_database_get", { provisionedDatabaseId: DATABASE }, () => databases.getById.mockResolvedValue(stored)],
        ["provisioned_database_create", { databaseId: SERVER, databaseName: "report_dev" }, () => databases.create.mockResolvedValue(stored)],
        ["provisioned_database_link", { provisionedDatabaseId: DATABASE, resourceId: RESOURCE, environmentId: ENVIRONMENT }, () => databases.link.mockResolvedValue(stored)],
        ["provisioned_database_unlink", { provisionedDatabaseId: DATABASE }, () => databases.unlink.mockResolvedValue(stored)]
    ])("given %s, when it answers, then the generated password is not in it", async (name, args, arrange) => {
        arrange()

        expect(JSON.stringify(await run(name, args))).not.toContain(PASSWORD)
    })

    it("given a connected database, when its databases are listed, then the project and that database are both the filter", async () => {
        databases.getByProjectId.mockResolvedValue([])

        await run("provisioned_databases_list", { databaseId: SERVER })

        expect(databases.getByProjectId).toHaveBeenCalledWith(PROJECT, SERVER)
    })

    it("given a link, when a database is created, then the connected database, the name and the link reach the service", async () => {
        databases.create.mockResolvedValue(stored)

        await run("provisioned_database_create", { databaseId: SERVER, databaseName: "report_dev", link: { resourceId: RESOURCE, environmentId: ENVIRONMENT } })

        expect(databases.create).toHaveBeenCalledWith(SERVER, expect.objectContaining({ databaseName: "report_dev", link: { resourceId: RESOURCE, environmentId: ENVIRONMENT } }))
    })

    it("given a name with capitals, when a database is created, then the input is refused before the service", () => {
        expect(() => tool("provisioned_database_create").inputSchema.parse({ databaseId: SERVER, databaseName: "Report" })).toThrow()
    })

    it("given mode drop and the name, when a database is deleted, then both reach the service", async () => {
        expect(await run("provisioned_database_delete", { provisionedDatabaseId: DATABASE, mode: "drop", confirmName: "report_dev" })).toEqual({ deleted: true })
        expect(databases.delete).toHaveBeenCalledWith(DATABASE, "drop", "report_dev")
    })

    it("given a mode that is not one of the three, when a database is deleted, then the input is refused", () => {
        expect(() => tool("provisioned_database_delete").inputSchema.parse({ provisionedDatabaseId: DATABASE, mode: "everything" })).toThrow()
    })

    it("given the delete tool, when its annotations are read, then it is destructive and the assistant asks first", () => {
        expect(tool("provisioned_database_delete").annotations).toMatchObject({ destructiveHint: true, openWorldHint: true })
        expect(requiresConfirmation(tool("provisioned_database_delete"))).toBe(true)
    })

    it.each(["provisioned_database_create", "provisioned_database_link", "provisioned_database_unlink"])(
        "given %s, which changes a server or a resource, when it is read, then the assistant asks first",
        name => {
            expect(requiresConfirmation(tool(name))).toBe(true)
        }
    )
})
