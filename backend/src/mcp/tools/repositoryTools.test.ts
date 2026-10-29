import { beforeEach, describe, expect, it, vi } from "vitest"
import { McpSession, McpToolContext } from "../toolDefinition"
import { repositoryTools } from "./repositoryTools"

const setPipelines = vi.fn()

vi.mock("../../service/CodeRepositoryService", () => ({
    default: class {
        setPipelines = (...args: unknown[]) => setPipelines(...args)
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const CONNECTION = "dddddddddddddddddddddddd"
const TEMPLATES_CONNECTION = "eeeeeeeeeeeeeeeeeeeeeeee"

const tool = (name: string) => repositoryTools.find(candidate => candidate.name === name)!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "OWNER" }],
        scopes: ["mfe:read", "mfe:write"],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

const run = (name: string, args: Record<string, unknown> = {}) => tool(name).run(tool(name).inputSchema.parse(args) as never, context())

describe("code_repository_pipelines_set", () => {
    beforeEach(() => {
        setPipelines.mockReset()
    })

    it("given a repository, when set, then the connection is updated with it and the setting comes back", async () => {
        const pipelines = { codeRepository: { codeRepositoryId: TEMPLATES_CONNECTION, repositoryId: "7", name: "acme-pipelines" }, ref: "v2" }
        setPipelines.mockResolvedValue({ _id: CONNECTION, pipelines })

        const result = await run("code_repository_pipelines_set", {
            codeRepositoryId: CONNECTION,
            templatesCodeRepositoryId: TEMPLATES_CONNECTION,
            repositoryId: "7",
            ref: "v2",
            path: "ci/templates"
        })

        expect(setPipelines).toHaveBeenCalledWith(CONNECTION, { codeRepositoryId: TEMPLATES_CONNECTION, repositoryId: "7", ref: "v2", path: "ci/templates" })
        expect(result).toEqual({ pipelines })
    })

    it("given no templates connection, when set, then the repository is reached through the connection itself", async () => {
        setPipelines.mockResolvedValue({ _id: CONNECTION, pipelines: {} })

        await run("code_repository_pipelines_set", { codeRepositoryId: CONNECTION, repositoryId: "7" })

        expect(setPipelines).toHaveBeenCalledWith(CONNECTION, { codeRepositoryId: CONNECTION, repositoryId: "7", ref: undefined, path: undefined })
    })

    it("given a null repository, when set, then the official templates are used again", async () => {
        // Mongoose hands back the nested path as an empty object once it is unset
        setPipelines.mockResolvedValue({ _id: CONNECTION, pipelines: {} })

        const result = await run("code_repository_pipelines_set", { codeRepositoryId: CONNECTION, repositoryId: null })

        expect(setPipelines).toHaveBeenCalledWith(CONNECTION, null)
        expect(result).toEqual({ pipelines: null })
    })

    it("given its definition, when read, then it is confirmed by the user, and it needs the connection it configures", () => {
        const schema = tool("code_repository_pipelines_set").inputSchema

        expect(tool("code_repository_pipelines_set").requiresConfirmation).toBe(true)
        expect(schema.safeParse({ repositoryId: "7" }).success).toBe(false)
        expect(schema.safeParse({ codeRepositoryId: CONNECTION, repositoryId: null }).success).toBe(true)
    })
})
