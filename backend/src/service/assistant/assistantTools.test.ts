import { beforeEach, describe, expect, it, vi } from "vitest"
import { McpToolContext } from "../../mcp/toolDefinition"
import { assistantOnlyTools } from "./assistantTools"

const getFailedRunLogs = vi.fn()

vi.mock("../BuildStatusService", () => ({
    default: class {
        getFailedRunLogs = getFailedRunLogs
    }
}))

const FRONTEND = "aaaaaaaaaaaaaaaaaaaaaaaa"
const BACKEND = "bbbbbbbbbbbbbbbbbbbbbbbb"
const context = { principal: { _id: "user-1" }, projectId: "project-1" } as unknown as McpToolContext
const toolNamed = (name: string) => assistantOnlyTools.find(tool => tool.name === name)!

describe("assistant-only tools", () => {
    beforeEach(() => {
        getFailedRunLogs.mockReset()
    })

    it("Given the tools MCP lacks, when read, then they are console-only reads", () => {
        for (const tool of assistantOnlyTools) {
            expect(tool.consoleOnly, tool.name).toBe(true)
            expect(tool.scope, tool.name).toBe("mfe:read")
            expect(tool.annotations.readOnlyHint, tool.name).toBe(true)
        }
    })

    it("Given failed CI jobs echoing credentials, when their logs are read, then the secrets are blanked before anything is returned", async () => {
        getFailedRunLogs.mockResolvedValue([{ name: "build", log: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nERROR: lint failed" }])

        const result = (await toolNamed("get_failed_build_logs").run({ frontendId: FRONTEND, runId: "42" } as never, context)) as { job: string; truncated: boolean; log: string }[]

        expect(getFailedRunLogs).toHaveBeenCalledWith("project-1", { frontendId: FRONTEND }, "42")
        expect(result[0]).toMatchObject({ job: "build", truncated: false })
        expect(result[0].log).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
        expect(result[0].log).toContain("ERROR: lint failed")
    })

    it("Given a long log, when read, then only its end is kept, where the error usually is", async () => {
        getFailedRunLogs.mockResolvedValue([{ name: "build", log: `${"x".repeat(20_000)}ERROR at the end` }])

        const result = (await toolNamed("get_failed_build_logs").run({ frontendId: FRONTEND, runId: "42" } as never, context)) as { truncated: boolean; log: string }[]

        expect(result[0].truncated).toBe(true)
        expect(result[0].log.length).toBe(15_000)
        expect(result[0].log.endsWith("ERROR at the end")).toBe(true)
    })

    it("Given a log request without a run id, when validated, then the input is refused", () => {
        expect(toolNamed("get_failed_build_logs").inputSchema.safeParse({ frontendId: FRONTEND }).success).toBe(false)
    })

    it("Given a failed backend build, when its logs are read, then the run is looked up on the backend", async () => {
        getFailedRunLogs.mockResolvedValue([])

        await toolNamed("get_failed_build_logs").run({ backendId: BACKEND, runId: "42" } as never, context)

        expect(getFailedRunLogs).toHaveBeenCalledWith("project-1", { backendId: BACKEND }, "42")
    })

    it("Given a log request naming both a frontend and a backend, or neither, when validated, then the input is refused", () => {
        const schema = toolNamed("get_failed_build_logs").inputSchema
        expect(schema.safeParse({ frontendId: FRONTEND, backendId: BACKEND, runId: "42" }).success).toBe(false)
        expect(schema.safeParse({ runId: "42" }).success).toBe(false)
    })

    it("Given a question about the platform, when the docs are searched, then sections come back with their URL", async () => {
        const sections = (await toolNamed("search_docs").run({ query: "canary release" } as never, context)) as { url: string }[]

        expect(sections.length).toBeGreaterThan(0)
        expect(sections[0].url).toMatch(/^https?:\/\//)
    })
})
