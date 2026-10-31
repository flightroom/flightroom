import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AiChangeJob from "../../models/AiChangeJobModel"
import AiChangeRequest from "../../models/AiChangeRequestModel"
import AiMission from "../../models/AiMissionModel"
import AiUsage from "../../models/AiUsageModel"
import SandboxUsage from "../../models/SandboxUsageModel"
import { AiJobView } from "../aiChange/aiJobViews"
import { conversationCost, describeAgentRun, MAX_DIFF_CHARS } from "./agentRuns"
import { changedLines, unifiedDiff } from "./lineDiff"

const JOB = "dddddddddddddddddddddddd"
const FRONTEND = "bbbbbbbbbbbbbbbbbbbbbbbb"
const BACKEND = "cccccccccccccccccccccccc"

const leanQuery = (value: unknown) => ({ lean: () => Promise.resolve(value) })

const view = (overrides: Partial<AiJobView> = {}) =>
    ({
        _id: JOB,
        rootJobId: JOB,
        status: "DONE",
        prompt: "Fix the build",
        summary: "Fixed the lint error",
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, cost: 0.5, currency: "EUR" },
        events: [
            { at: new Date(), kind: "info", message: "working" },
            { at: new Date(), kind: "thinking", message: "secret reasoning" },
            { at: new Date(), kind: "tool", message: "run_command shop-fe pnpm lint" },
            { at: new Date(), kind: "output", message: "$ pnpm lint\nexit code 1\nerror at line 3" },
            { at: new Date(), kind: "tool", message: "edit_file src/a.ts" },
            { at: new Date(), kind: "tool", message: "run_script shop-fe build" },
            { at: new Date(), kind: "output", message: "exit code 0 (success)" }
        ],
        repositories: [
            { requestId: "r1", kind: "frontend", frontendId: FRONTEND, frontendName: "shop-fe", frontendSlug: "shop-fe", status: "PROPOSED", files: [], baseBranch: "main", branch: "ai-feature/x" },
            { requestId: "r2", kind: "backend", frontendId: BACKEND, frontendName: "orders-be", frontendSlug: "orders-be", status: "PROPOSED", files: [], baseBranch: "main" }
        ],
        ...overrides
    }) as unknown as AiJobView

describe("lineDiff", () => {
    it("Given a file changed in one place, when counted, then each added and removed line counts once", () => {
        expect(changedLines("a\nb\nc\nd\ne", "a\nb\nC\nC2\nd\ne")).toEqual({ added: 2, removed: 1 })
    })

    it("Given a file changed in two far apart places, when counted cheaply, then the lines between them count too: the diff is the exact one", () => {
        expect(changedLines("a\nb\nc\nd\ne", "a\nB\nc\nd\nE")).toEqual({ added: 4, removed: 4 })
    })

    it("Given texts ending with a newline, when counted, then the newline opens no line of its own", () => {
        expect(changedLines(undefined, "a\nb\n")).toEqual({ added: 2, removed: 0 })
        expect(changedLines("a\n", "a\nb\n")).toEqual({ added: 1, removed: 0 })
    })

    it("Given a created file, when diffed, then its hunk starts at line 0 of the empty side", () => {
        expect(unifiedDiff("new.ts", undefined, "x\ny\n", 10_000).diff).toBe(["--- a/new.ts", "+++ b/new.ts", "@@ -0,0 +1,2 @@", "+x", "+y"].join("\n"))
    })

    it("Given a created or a deleted file, when counted, then all its lines are added or removed", () => {
        expect(changedLines(undefined, "a\nb")).toEqual({ added: 2, removed: 0 })
        expect(changedLines("a\nb\nc", undefined)).toEqual({ added: 0, removed: 3 })
    })

    it("Given a change, when diffed, then it reads as a unified diff with its hunk header", () => {
        const { diff, truncated } = unifiedDiff("src/a.ts", "one\ntwo\nthree", "one\n2\nthree", 10_000)

        expect(truncated).toBe(false)
        expect(diff).toBe(["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " one", "-two", "+2", " three"].join("\n"))
    })

    it("Given a diff longer than asked, when diffed, then it is cut and says so", () => {
        const { diff, truncated } = unifiedDiff("big.txt", undefined, "x\n".repeat(10_000), 500)

        expect(truncated).toBe(true)
        expect(diff.length).toBeLessThanOrEqual(501)
    })
})

describe("describeAgentRun", () => {
    beforeEach(() => {
        vi.spyOn(AiChangeRequest, "find").mockImplementation((() =>
            leanQuery([
                {
                    _id: "r1",
                    files: [
                        { path: "src/a.ts", action: "update", originalContent: "one\ntwo\nthree", proposedContent: "one\n2\nthree\nfour" },
                        { path: "src/new.ts", action: "create", proposedContent: "x\ny" },
                        { path: "src/huge.ts", action: "update", proposedContent: "kept without its original" }
                    ]
                },
                { _id: "r2", files: [{ path: "old.go", action: "delete", originalContent: "package main\n" }] }
            ])) as never)
        vi.spyOn(SandboxUsage, "aggregate").mockResolvedValue([{ _id: JOB, commands: 2, execSeconds: 40, lifetimeSeconds: 310 }] as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("Given a finished run, when described, then each repository lists its files with lines added and removed, unknown for a file without its original", async () => {
        const described = await describeAgentRun(view())

        expect(described.repositories[0]).toMatchObject({ name: "shop-fe", filesChanged: 3, linesAdded: 5, linesRemoved: 2, branch: "ai-feature/x" })
        expect(described.repositories[0].files).toEqual([
            { path: "src/a.ts", action: "update", added: 3, removed: 2 },
            { path: "src/new.ts", action: "create", added: 2, removed: 0 },
            { path: "src/huge.ts", action: "update" }
        ])
        expect(described.repositories[1]).toMatchObject({ kind: "backend", id: BACKEND, linesRemoved: 1 })
    })

    it("Given the commands the agent ran, when described, then each comes with its exit code, and the reasoning and outputs stay out of the steps", async () => {
        const described = await describeAgentRun(view())

        expect(described.checks).toEqual([
            { command: "run_command shop-fe pnpm lint", exitCode: 1 },
            { command: "run_script shop-fe build", exitCode: 0 }
        ])
        expect(described.recentEvents.map(entry => entry.kind)).not.toContain("thinking")
        expect(described.recentEvents.map(entry => entry.kind)).not.toContain("output")
    })

    it("Given a run, when described, then its tokens, cost and sandbox time are there, and no diff unless asked", async () => {
        const described = await describeAgentRun(view())

        expect(described.usage).toMatchObject({ inputTokens: 100, cost: 0.5, currency: "EUR" })
        expect(described.sandbox).toEqual({ commands: 2, execSeconds: 40, lifetimeSeconds: 310 })
        expect(described).not.toHaveProperty("diff")
    })

    it("Given a path, when described, then the diff of that file comes too, bounded", async () => {
        const described = await describeAgentRun(view(), { path: "src/a.ts" })

        expect(described.diff).toMatchObject({ repositoryId: FRONTEND, path: "src/a.ts", truncated: false })
        expect((described.diff as { diff: string }).diff).toContain("+four")
        expect(MAX_DIFF_CHARS).toBe(20_000)
    })

    it("Given a path in no proposal, when described, then the diff says so instead of failing", async () => {
        const described = await describeAgentRun(view(), { path: "nope.ts" })

        expect(described.diff).toMatchObject({ path: "nope.ts", error: expect.any(String) })
    })

    it("Given many files, when described, then the list is bounded and says how many are left out", async () => {
        const files = Array.from({ length: 130 }, (_, index) => ({ path: `f${index}.ts`, action: "create", proposedContent: "x" }))
        vi.spyOn(AiChangeRequest, "find").mockImplementation((() => leanQuery([{ _id: "r1", files }])) as never)

        const described = await describeAgentRun(view())

        expect(described.repositories[0].files).toHaveLength(100)
        expect(described.repositories[0]).toMatchObject({ filesChanged: 130, moreFiles: 30 })
    })
})

describe("conversationCost", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("Given answers and agents of a conversation, when summed, then the assistant, the agents (tokens and sandbox) and the total come apart, per currency", async () => {
        const job = new Types.ObjectId()
        const missionJob = new Types.ObjectId()
        const mission = new Types.ObjectId()
        vi.spyOn(AiMission, "find").mockImplementation((() => leanQuery([{ _id: mission }])) as never)
        const jobsFind = vi.spyOn(AiChangeJob, "find").mockImplementation((() => leanQuery([{ _id: job }, { _id: missionJob }])) as never)
        const usageAggregate = vi.spyOn(AiUsage, "aggregate").mockResolvedValue([
            { _id: "EUR", inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 200, cost: 0.3 },
            { _id: null, inputTokens: 50, cachedInputTokens: 0, outputTokens: 10, cost: 0 }
        ] as never)
        vi.spyOn(SandboxUsage, "aggregate").mockResolvedValue([
            { _id: job, commands: 3, execSeconds: 60, lifetimeSeconds: 600 },
            { _id: missionJob, commands: 1, execSeconds: 5, lifetimeSeconds: 300 }
        ] as never)

        const cost = await conversationCost("conversation-1", [
            {},
            { usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 50, cost: 0.1, currency: "EUR" } },
            { usage: { inputTokens: 300, cachedInputTokens: 200, outputTokens: 30, cost: 0.02, currency: "USD" } }
        ])

        expect(jobsFind.mock.calls[0][0]).toEqual({ $or: [{ assistantConversationId: "conversation-1" }, { missionId: { $in: [mission] } }] })
        expect(usageAggregate.mock.calls[0][0][0]).toEqual({ $match: { jobId: { $in: [job, missionJob] } } })
        expect(cost.assistant).toEqual({
            inputTokens: 800,
            cachedInputTokens: 200,
            outputTokens: 80,
            costs: [
                { currency: "EUR", amount: 0.1 },
                { currency: "USD", amount: 0.02 }
            ]
        })
        expect(cost.agents).toEqual({
            inputTokens: 1_050,
            cachedInputTokens: 100,
            outputTokens: 210,
            costs: [{ currency: "EUR", amount: 0.3 }],
            sandbox: { commands: 4, execSeconds: 65, lifetimeSeconds: 900 }
        })
        expect(cost.total.inputTokens).toBe(1_850)
        expect(cost.total.costs).toEqual([
            { currency: "EUR", amount: 0.4 },
            { currency: "USD", amount: 0.02 }
        ])
        expect(cost.total.sandbox).toEqual(cost.agents.sandbox)
    })

    it("Given a conversation without agents, when summed, then only its answers count and no ledger is read", async () => {
        vi.spyOn(AiMission, "find").mockImplementation((() => leanQuery([])) as never)
        vi.spyOn(AiChangeJob, "find").mockImplementation((() => leanQuery([])) as never)
        const usageAggregate = vi.spyOn(AiUsage, "aggregate")
        const sandboxAggregate = vi.spyOn(SandboxUsage, "aggregate")

        const cost = await conversationCost("conversation-1", [{ usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 } }])

        expect(usageAggregate).not.toHaveBeenCalled()
        expect(sandboxAggregate).not.toHaveBeenCalled()
        expect(cost.total).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, costs: [], sandbox: { commands: 0, execSeconds: 0, lifetimeSeconds: 0 } })
    })
})
