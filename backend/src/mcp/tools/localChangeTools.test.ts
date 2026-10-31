import { beforeEach, describe, expect, it, vi } from "vitest"
import { requiresConfirmation } from "../toolDefinition"
import { localChangeTools } from "./localChangeTools"

const { checkout, submit, openPullRequest } = vi.hoisted(() => ({ checkout: vi.fn(), submit: vi.fn(), openPullRequest: vi.fn() }))

vi.mock("../../service/workspace/LocalChangeService", () => ({
    MAX_SUBMITTED_FILES: 100,
    default: class {
        checkout = checkout
        submit = submit
        openPullRequest = openPullRequest
    }
}))

const FRONTEND = "bbbbbbbbbbbbbbbbbbbbbbbb"
const BACKEND = "cccccccccccccccccccccccc"
const COMMIT = "a".repeat(40)

const tool = (name: string) => localChangeTools.find(candidate => candidate.name === name)!
const run = (name: string, args: Record<string, unknown>) => tool(name).run(tool(name).inputSchema.parse(args) as never, { principal: {} } as never)

beforeEach(() => vi.clearAllMocks())

describe("localChangeTools", () => {
    it("reads the checkout of a frontend or a backend", async () => {
        await run("repository_checkout_get", { frontendId: FRONTEND })
        await run("repository_checkout_get", { backendId: BACKEND })
        expect(checkout.mock.calls).toEqual([[{ kind: "frontend", id: FRONTEND }], [{ kind: "backend", id: BACKEND }]])
    })

    it("wants exactly one target", async () => {
        await expect(run("repository_checkout_get", {})).rejects.toThrow("either frontendId or backendId")
        await expect(run("repository_checkout_get", { frontendId: FRONTEND, backendId: BACKEND })).rejects.toThrow("either frontendId or backendId")
    })

    it("submits the change without the target fields", async () => {
        const files = [{ path: "src/a.ts", action: "update", content: "x" }]
        await run("code_change_submit", { backendId: BACKEND, baseCommit: COMMIT, title: "Fix", files })
        expect(submit).toHaveBeenCalledWith({ kind: "backend", id: BACKEND }, { baseCommit: COMMIT, title: "Fix", files })
    })

    it("wants a full commit hash and at least one file", () => {
        const schema = tool("code_change_submit").inputSchema
        expect(schema.safeParse({ frontendId: FRONTEND, baseCommit: "abc123", title: "Fix", files: [{ path: "a", action: "delete" }] }).success).toBe(false)
        expect(schema.safeParse({ frontendId: FRONTEND, baseCommit: COMMIT, title: "Fix", files: [] }).success).toBe(false)
    })

    it("opens a pull request between two existing branches", async () => {
        await run("pull_request_create", { backendId: BACKEND, sourceBranch: " release/dev ", targetBranch: "main", title: "Release" })
        expect(openPullRequest).toHaveBeenCalledWith({ kind: "backend", id: BACKEND }, { sourceBranch: "release/dev", targetBranch: "main", title: "Release" })
    })

    it("asks the console user before pushing or opening a pull request", () => {
        expect(requiresConfirmation(tool("code_change_submit"))).toBe(true)
        expect(requiresConfirmation(tool("pull_request_create"))).toBe(true)
        expect(tool("repository_checkout_get").scope).toBe("mfe:read")
        expect(tool("code_change_submit").scope).toBe("mfe:write")
        expect(tool("pull_request_create").scope).toBe("mfe:write")
    })
})
