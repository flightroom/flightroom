import { describe, expect, it, vi } from "vitest"
import { McpToolContext } from "../toolDefinition"
import { aiUsageTools } from "./aiUsageTools"

const forMember = vi.fn()

vi.mock("../../service/AiUsageService", async importOriginal => ({
    ...(await importOriginal<typeof import("../../service/AiUsageService")>()),
    default: class {
        forMember = (...args: unknown[]) => forMember(...args)
    }
}))

const [tool] = aiUsageTools
const userId = "64b7f0c2a1b2c3d4e5f60718"
const context = { principal: {}, projectId: "64b7f0c2a1b2c3d4e5f60719" } as unknown as McpToolContext

describe("user_ai_usage", () => {
    it("Given a userId and two days, when it is parsed, then the granularity is day and the zone is left to the service", () => {
        expect(tool.inputSchema.parse({ userId, from: "2026-10-01", to: "2026-10-23" })).toEqual({ userId, from: "2026-10-01", to: "2026-10-23", granularity: "day" })
    })

    it("Given both userId and email, or neither, when it is parsed, then it is refused", () => {
        expect(tool.inputSchema.safeParse({ userId, email: "ada@example.com", from: "2026-10-01", to: "2026-10-23" }).success).toBe(false)
        expect(tool.inputSchema.safeParse({ from: "2026-10-01", to: "2026-10-23" }).success).toBe(false)
    })

    it("Given a date-time, an unknown time zone or another granularity, when it is parsed, then it is refused", () => {
        const base = { userId, from: "2026-10-01", to: "2026-10-23" }

        expect(tool.inputSchema.safeParse({ ...base, from: "2026-10-01T00:00:00Z" }).success).toBe(false)
        expect(tool.inputSchema.safeParse({ ...base, timeZone: "Mars/Olympus" }).success).toBe(false)
        expect(tool.inputSchema.safeParse({ ...base, granularity: "hour" }).success).toBe(false)
        expect(tool.inputSchema.safeParse({ ...base, timeZone: "Europe/Rome", granularity: "week" }).success).toBe(true)
    })

    it("Given an email, when it runs, then the service is asked for the person by email in the project of the call", async () => {
        const args = tool.inputSchema.parse({ email: "ada@example.com", from: "2026-10-01", to: "2026-10-23", granularity: "month", timeZone: "Europe/Rome" })

        await tool.run(args, context)

        expect(forMember).toHaveBeenCalledWith(context.projectId, { email: "ada@example.com" }, { from: "2026-10-01", to: "2026-10-23", granularity: "month", timeZone: "Europe/Rome" })
    })
})
