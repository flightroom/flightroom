import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { McpSession, McpToolContext, requiresConfirmation } from "../toolDefinition"

const renameRepository = vi.fn()
const principals: unknown[] = []

vi.mock("../../service/RepositoryRenameService", async importOriginal => ({
    ...(await importOriginal<typeof import("../../service/RepositoryRenameService")>()),
    default: class {
        constructor(principal: unknown) {
            principals.push(principal)
        }
        renameFrontendRepository = renameRepository
    }
}))

import { frontendTools } from "./frontendTools"

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const FRONTEND = "bbbbbbbbbbbbbbbbbbbbbbbb"

const tool = (name: string) => frontendTools.find(candidate => candidate.name === name)!

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

describe("exposurePath of a DOCKER frontend", () => {
    it.each(["frontend_create", "frontend_update"])("given %s, when its input is read, then exposurePath is described as required for a DOCKER frontend", name => {
        // What MCP clients get: the partial update schema keeps the description only in its JSON Schema
        const description = (z.toJSONSchema(tool(name).inputSchema) as { properties: Record<string, { description?: string }> }).properties.exposurePath.description

        expect(description).toContain("Required to create a DOCKER frontend")
    })

    it("given frontend_create, when its description is read, then it tells a DOCKER frontend needs its exposurePath", () => {
        expect(tool("frontend_create").description).toContain("A DOCKER frontend needs its exposurePath")
    })
})

describe("frontend_repository_rename", () => {
    beforeEach(() => {
        renameRepository.mockReset()
        principals.length = 0
    })

    it("given its definition, when read, then it needs mfe:write, reaches the provider, is offered to MCP clients and waits for the user in the assistant", () => {
        const definition = tool("frontend_repository_rename")

        expect(definition.scope).toBe(MCP_SCOPE_WRITE)
        expect(definition.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true })
        expect(definition.consoleOnly).toBeFalsy()
        expect(requiresConfirmation(definition)).toBe(true)
    })

    it("given a frontend and a new name, when run, then the trimmed name is renamed with the principal bound to the project", async () => {
        renameRepository.mockResolvedValue({ _id: FRONTEND, codeRepository: { name: "checkout-web" } })

        expect(await run("frontend_repository_rename", { frontendId: FRONTEND, name: " checkout-web " })).toEqual({
            _id: FRONTEND,
            codeRepository: { name: "checkout-web" }
        })
        expect(renameRepository).toHaveBeenCalledWith(FRONTEND, "checkout-web")
        expect(principals[0]).toMatchObject({ restrictedToProjectIds: [PROJECT] })
    })

    it("given a name no provider accepts, when parsed, then the call is refused before the service is reached", () => {
        for (const name of ["team/checkout", "checkout.git", "", ".hidden"]) {
            expect(() => run("frontend_repository_rename", { frontendId: FRONTEND, name }), name).toThrow()
        }
        expect(renameRepository).not.toHaveBeenCalled()
    })
})
