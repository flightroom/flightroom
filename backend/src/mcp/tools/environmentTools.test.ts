import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetExternalCalls } from "../../utils/externalCallLimiter"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { McpSession, McpToolContext } from "../toolDefinition"
import { environmentTools } from "./environmentTools"

const deleteSingle = vi.fn()

vi.mock("../../service/EnvironmentService", () => ({
    default: class {
        deleteSingle = (...args: unknown[]) => deleteSingle(...args)
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const ENVIRONMENT = "bbbbbbbbbbbbbbbbbbbbbbbb"

const tool = environmentTools.find(candidate => candidate.name === "environment_delete")!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "MEMBER" }],
        scopes: [MCP_SCOPE_READ, MCP_SCOPE_WRITE],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

describe("environment_delete", () => {
    beforeEach(() => {
        deleteSingle.mockReset().mockResolvedValue(undefined)
        resetExternalCalls()
    })

    it("given the budget of calls to outside servers spent, when an environment is deleted removing users, then it is refused, and choices that reach no server are not counted", async () => {
        for (let call = 0; call < 10; call++) await tool.run(tool.inputSchema.parse({ environmentId: ENVIRONMENT, provisionedDatabases: "user" }) as never, context())

        await expect(tool.run(tool.inputSchema.parse({ environmentId: ENVIRONMENT, provisionedDatabases: "drop", confirmName: "x" }) as never, context())).rejects.toMatchObject({
            code: "EXTERNAL_CALLS_RATE_LIMITED"
        })
        for (const provisionedDatabases of [undefined, "unlink", "record"]) {
            await expect(tool.run(tool.inputSchema.parse({ environmentId: ENVIRONMENT, provisionedDatabases }) as never, context())).resolves.toEqual({ deleted: true })
        }
    })

    it("given what becomes of the provisioned databases and the name typed again, when an environment is deleted, then both reach the service", async () => {
        await tool.run(tool.inputSchema.parse({ environmentId: ENVIRONMENT, provisionedDatabases: "drop", confirmName: "Development" }) as never, context())

        expect(deleteSingle).toHaveBeenCalledWith(ENVIRONMENT, "drop", "Development")
    })

    it("given no choice, when an environment is deleted, then the service decides whether one is needed", async () => {
        await tool.run(tool.inputSchema.parse({ environmentId: ENVIRONMENT }) as never, context())

        expect(deleteSingle).toHaveBeenCalledWith(ENVIRONMENT, undefined, undefined)
    })

    it("given a choice that is not one of the four, when the input is read, then it is refused", () => {
        expect(() => tool.inputSchema.parse({ environmentId: ENVIRONMENT, provisionedDatabases: "keep" })).toThrow()
    })

    it("given the tool, when its annotations are read, then it stays destructive", () => {
        expect(tool.annotations.destructiveHint).toBe(true)
    })
})
