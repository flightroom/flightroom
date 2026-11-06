import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LlmClient, LlmToolCall, LlmTurnResult } from "../llm"
import { PREVIEW_FILE } from "./aiChangeScripts"
import { discoverPreview } from "./previewDiscovery"

const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 }

/** A model that calls the tools given, one turn each, then answers. */
const scripted = (turns: LlmToolCall[][]): LlmClient => {
    let index = 0
    return {
        provider: "ANTHROPIC" as never,
        json: vi.fn(),
        turn: vi.fn(async (): Promise<LlmTurnResult> => {
            const toolCalls = turns[index++] ?? []
            return { text: toolCalls.length ? "" : "done", toolCalls, stopReason: toolCalls.length ? "tool_use" : "end_turn", usage, message: { role: "assistant", text: "", toolCalls } }
        })
    }
}

const call = (name: string, input: Record<string, unknown>, id = name): LlmToolCall => ({ id, name, input })

describe("discoverPreview", () => {
    let dir: string
    let repository: never

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "preview-discovery-"))
        await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:22\nCMD node server.js\n")
        await fs.writeFile(path.join(dir, ".env"), "SECRET=1\n")
        await fs.mkdir(path.join(dir, "web"))
        await fs.writeFile(path.join(dir, "web", "index.html"), "<html></html>")
        repository = {
            slug: "backend-shop",
            serviceSlug: "shop",
            kind: "backend",
            runtime: "NODE",
            workingCopy: { dir, listFiles: async () => ["Dockerfile", ".env", "web/index.html"] }
        } as never
    })

    afterEach(() => fs.rm(dir, { recursive: true, force: true }))

    it("Given a first try that fails, then the agent hears why, tries again, and the file that started the server is kept", async () => {
        const restartPreview = vi.fn().mockRejectedValueOnce(new Error("The development server:\nError: listen EADDRINUSE")).mockResolvedValueOnce("https://shop.preview.test")
        const runner = { restartPreview, runCommand: vi.fn() } as never
        const client = scripted([
            [call("read_file", { path: "Dockerfile" })],
            [call("try_preview", { start: "node server.js", port: 3000 }, "first")],
            [call("try_preview", { prepare: "npm ci", start: "node server.js", port: 8080 }, "second")]
        ])
        const onUsage = vi.fn()

        const found = await discoverPreview(client, runner, repository, "No development server is known for NODE", onUsage)

        expect(found.url).toBe("https://shop.preview.test")
        expect(JSON.parse(found.content)).toEqual({ prepare: "npm ci", start: "node server.js", port: 8080 })
        expect(await fs.readFile(path.join(dir, PREVIEW_FILE), "utf8")).toBe(found.content)
        expect(restartPreview).toHaveBeenCalledTimes(2)
        expect(onUsage).toHaveBeenCalledTimes(3)
        // The loop stops on the try that worked: no fourth turn
        expect(client.turn).toHaveBeenCalledTimes(3)
    })

    it("Given a file that may hold secrets, then it is not read", async () => {
        const runner = { restartPreview: vi.fn().mockResolvedValue("https://shop.preview.test"), runCommand: vi.fn() } as never
        const client = scripted([[call("read_file", { path: ".env" })], [call("try_preview", { start: "node server.js", port: 3000 })]])

        await discoverPreview(client, runner, repository, "unknown")

        const results = vi.mocked(client.turn).mock.calls[1][0].messages.flatMap(message => (message.role === "tool" ? message.results : []))
        expect(results[0]).toMatchObject({ isError: true, content: expect.stringContaining("may hold secrets") })
    })

    it("Given an agent that never starts the server, then it fails with the last reason the server gave", async () => {
        const runner = { restartPreview: vi.fn().mockRejectedValue(new Error("Cannot find module 'server.js'")), runCommand: vi.fn() } as never
        const client = scripted([[call("try_preview", { start: "node server.js", port: 3000 })]])

        await expect(discoverPreview(client, runner, repository, "unknown")).rejects.toThrow("Cannot find module 'server.js'")
    })
})
