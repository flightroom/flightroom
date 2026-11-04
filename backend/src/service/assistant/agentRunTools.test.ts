import { FastifyBaseLogger } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { McpToolContext } from "../../mcp/toolDefinition"
import AiChangeJob from "../../models/AiChangeJobModel"
import AiChangeRequest from "../../models/AiChangeRequestModel"
import AiMission from "../../models/AiMissionModel"
import AssistantConversation from "../../models/AssistantConversationModel"
import SandboxUsage from "../../models/SandboxUsageModel"
import { IUser } from "../../models/UserModel"
import { MAX_ACTIVE_AGENT_RUNS, MAX_AUTOMATIC_FOLLOW_UPS } from "./agentRuns"
import { agentRunTools } from "./agentRunTools"
import { ASSISTANT_TOOLS, AssistantToolEvents, AssistantToolRunner, NOT_IN_UPDATE_TURN, toolKind, updateTurnRefusal } from "./assistantActions"
import { UPDATE_ACTION_TTL_MS } from "./pendingActions"

const createJob = vi.fn()
const followUpJob = vi.fn()
const getJob = vi.fn()
const stopJob = vi.fn()
const applyJob = vi.fn()
const openPullRequest = vi.fn()
const discardChange = vi.fn()
const createMission = vi.fn()

vi.mock("../..", () => ({ fastify: { config: {}, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }))
vi.mock("../aiChange/AiChangeJobService", () => ({
    default: class {
        create = (...args: unknown[]) => createJob(...args)
        followUp = (...args: unknown[]) => followUpJob(...args)
        get = (...args: unknown[]) => getJob(...args)
        stop = (...args: unknown[]) => stopJob(...args)
        apply = (...args: unknown[]) => applyJob(...args)
    }
}))
vi.mock("../aiChange/AiChangeService", () => ({
    default: class {
        openPullRequest = (...args: unknown[]) => openPullRequest(...args)
        discard = (...args: unknown[]) => discardChange(...args)
    }
}))
vi.mock("../aiChange/AiMissionService", () => ({
    default: class {
        create = (...args: unknown[]) => createMission(...args)
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const FRONTEND = "bbbbbbbbbbbbbbbbbbbbbbbb"
const BACKEND = "cccccccccccccccccccccccc"
const JOB = "dddddddddddddddddddddddd"
const ROOT = "eeeeeeeeeeeeeeeeeeeeeeee"
const CONVERSATION = "conversation-1"

const context = (conversationId: string | null = CONVERSATION, signal?: AbortSignal, update?: boolean) =>
    ({ principal: { _id: "user-1" }, projectId: PROJECT, conversationId: conversationId ?? undefined, signal, update }) as unknown as McpToolContext
const tool = (name: string) => agentRunTools.find(candidate => candidate.name === name)!
const run = (name: string, args: Record<string, unknown>, ctx = context()) => tool(name).run(tool(name).inputSchema.parse(args) as never, ctx)

const jobView = (status = "RUNNING", overrides: Record<string, unknown> = {}) => ({
    _id: JOB,
    rootJobId: ROOT,
    status,
    prompt: "Fix the build",
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    events: [],
    repositories: [{ requestId: "r1", kind: "frontend", frontendId: FRONTEND, frontendName: "shop-fe", frontendSlug: "shop-fe", status: "PROPOSED", files: [], baseBranch: "main" }],
    ...overrides
})

/** A query whose `lean()` resolves to `value`, as the code reads it. */
const leanQuery = (value: unknown) => ({ lean: () => Promise.resolve(value) })

let activeJobs = 0
let runningMissions = 0
let missionJobs = 0
let startedSinceQuestion = 0
let linked: unknown = { _id: JOB, rootJobId: ROOT, status: "RUNNING" }
let followUps = 0
const updateOne = vi.fn()

describe("agent run tools", () => {
    beforeEach(() => {
        for (const mock of [createJob, followUpJob, getJob, stopJob, applyJob, openPullRequest, discardChange, createMission]) mock.mockReset()
        activeJobs = 0
        runningMissions = 0
        missionJobs = 0
        startedSinceQuestion = 0
        followUps = 0
        linked = { _id: JOB, rootJobId: ROOT, status: "RUNNING" }
        updateOne.mockReset().mockResolvedValue({ modifiedCount: 1 })
        vi.spyOn(AiChangeJob, "findOne").mockImplementation((() => leanQuery(linked)) as never)
        vi.spyOn(AiChangeJob, "countDocuments").mockImplementation(((filter: { parentJobId?: unknown; missionId?: unknown; status?: unknown }) =>
            Promise.resolve(filter.parentJobId ? followUps : filter.missionId ? missionJobs : filter.status ? activeJobs : startedSinceQuestion)) as never)
        vi.spyOn(AiChangeJob, "updateOne").mockImplementation(((...args: unknown[]) => updateOne(...args)) as never)
        vi.spyOn(AiMission, "countDocuments").mockResolvedValue(0 as never)
        vi.spyOn(AiMission, "find").mockImplementation((() => leanQuery(Array.from({ length: runningMissions }, (_, index) => ({ _id: `mission-${index}` })))) as never)
        vi.spyOn(AssistantConversation, "findById").mockImplementation((() => leanQuery({ askedAt: new Date("2026-10-31T10:00:00Z") })) as never)
        vi.spyOn(AiChangeRequest, "find").mockImplementation((() => leanQuery([{ _id: "r1", files: [] }])) as never)
        vi.spyOn(SandboxUsage, "aggregate").mockResolvedValue([] as never)
        createJob.mockResolvedValue({ _id: JOB })
        followUpJob.mockResolvedValue({ _id: "ffffffffffffffffffffffff" })
        getJob.mockResolvedValue(jobView())
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe("agent_run_start", () => {
        it("Given a turn without a saved conversation, when an agent is started, then it is refused: nothing could follow it", async () => {
            await expect(run("agent_run_start", { brief: "Fix the build", frontendIds: [FRONTEND] }, context(null))).rejects.toMatchObject({ code: "AGENT_RUN_NO_CONVERSATION" })
            expect(createJob).not.toHaveBeenCalled()
        })

        it("Given repositories and a brief, when an agent is started, then the job service starts it in the project, linked to the conversation, and the model learns how to follow it", async () => {
            const result = (await run("agent_run_start", { brief: "Fix the build: lint fails on line 3", frontendIds: [FRONTEND], backendIds: [BACKEND], effort: "low" })) as Record<string, unknown>

            expect(createJob).toHaveBeenCalledWith(PROJECT, {
                prompt: "Fix the build: lint fails on line 3",
                effort: "low",
                aiModelId: undefined,
                baseBranches: undefined,
                assistantConversationId: CONVERSATION,
                scope: "selection",
                frontendIds: [FRONTEND],
                backendIds: [BACKEND]
            })
            expect(result).toMatchObject({ jobId: JOB, status: "RUNNING" })
            expect(result.next).toContain("agent_run_wait")
        })

        it("Given every repository, when an agent is started, then it works on the whole project as the console's global job", async () => {
            await run("agent_run_start", { brief: "Rename the price API", all: true })

            expect(createJob.mock.calls[0][1]).toMatchObject({ scope: "global", assistantConversationId: CONVERSATION })
            expect(tool("agent_run_start").inputSchema.safeParse({ brief: "Fix", all: true, frontendIds: [FRONTEND] }).success).toBe(false)
        })

        it("Given an update turn the server runs, when an agent or a mission is started, then it is refused: only the user starts more", async () => {
            await expect(run("agent_run_start", { brief: "Fix", frontendIds: [FRONTEND] }, context(CONVERSATION, undefined, true))).rejects.toMatchObject({ code: "AGENT_RUN_NOT_IN_UPDATE" })
            await expect(run("mission_start", { brief: "Upgrade", mode: "global", all: true }, context(CONVERSATION, undefined, true))).rejects.toMatchObject({
                code: "AGENT_RUN_NOT_IN_UPDATE"
            })
            expect(createJob).not.toHaveBeenCalled()
            expect(createMission).not.toHaveBeenCalled()
        })

        it("Given an update turn, when it follows up a run within the limits, then it may", async () => {
            await run("agent_run_follow_up", { jobId: JOB, brief: "Also the tests" }, context(CONVERSATION, undefined, true))

            expect(followUpJob).toHaveBeenCalled()
        })

        it("Given 6 agents started since the user last wrote, roots and follow-ups together, when another is started, then it is refused", async () => {
            startedSinceQuestion = 6

            await expect(run("agent_run_start", { brief: "Fix", frontendIds: [FRONTEND] })).rejects.toMatchObject({ code: "AGENT_RUN_TOO_MANY_STARTED" })
            await expect(run("agent_run_follow_up", { jobId: JOB, brief: "Again" })).rejects.toMatchObject({ code: "AGENT_RUN_TOO_MANY_STARTED" })
            expect(AiChangeJob.countDocuments).toHaveBeenCalledWith({ assistantConversationId: CONVERSATION, createdAt: { $gt: new Date("2026-10-31T10:00:00Z") } })
        })

        it("Given a running mission with 3 jobs at work, when an agent is started, then the mission counts as its jobs and the start is refused", async () => {
            runningMissions = 1
            missionJobs = 3

            await expect(run("agent_run_start", { brief: "Fix", frontendIds: [FRONTEND] })).rejects.toMatchObject({ code: "AGENT_RUN_TOO_MANY" })
        })

        it("Given a domain, when an agent is started, then it works on the domain", async () => {
            await run("agent_run_start", { brief: "Rename the price API", domainId: BACKEND })

            expect(createJob.mock.calls[0][1]).toMatchObject({ scope: "domain", domainId: BACKEND, assistantConversationId: CONVERSATION })
        })

        it("Given neither a domain nor repositories, or both, when validated, then the input is refused", () => {
            const schema = tool("agent_run_start").inputSchema
            expect(schema.safeParse({ brief: "Fix" }).success).toBe(false)
            expect(schema.safeParse({ brief: "Fix", domainId: BACKEND, frontendIds: [FRONTEND] }).success).toBe(false)
        })

        it(`Given ${MAX_ACTIVE_AGENT_RUNS} agents of the conversation at work, a running mission among them, when another is started, then it is refused`, async () => {
            activeJobs = MAX_ACTIVE_AGENT_RUNS - 1
            runningMissions = 1

            await expect(run("agent_run_start", { brief: "Fix", frontendIds: [FRONTEND] })).rejects.toMatchObject({ code: "AGENT_RUN_TOO_MANY", statusCode: 429 })
            expect(createJob).not.toHaveBeenCalled()
            expect(AiChangeJob.countDocuments).toHaveBeenCalledWith(expect.objectContaining({ assistantConversationId: CONVERSATION }))
        })

        it("Given the user's own refusal (a viewer, a token limit), when an agent is started, then the job service's error reaches the model as is", async () => {
            createJob.mockRejectedValue(Object.assign(new Error("A viewer cannot change the code of a frontend or a backend"), { code: "AI_CHANGE_FORBIDDEN" }))

            await expect(run("agent_run_start", { brief: "Fix", frontendIds: [FRONTEND] })).rejects.toMatchObject({ code: "AI_CHANGE_FORBIDDEN" })
        })
    })

    describe("driving a run", () => {
        it("Given a job another conversation started, when it is read, followed up, stopped or applied, then it is not found for this one", async () => {
            linked = null

            for (const [name, args] of [
                ["agent_run_status", { jobId: JOB }],
                ["agent_run_wait", { jobId: JOB, seconds: 1 }],
                ["agent_run_follow_up", { jobId: JOB, brief: "Also the tests" }],
                ["agent_run_stop", { jobId: JOB }],
                ["agent_run_apply", { jobId: JOB, mode: "push" }]
            ] as const) {
                await expect(run(name, args), name).rejects.toMatchObject({ code: "AGENT_RUN_NOT_LINKED", statusCode: 404 })
            }
            expect(AiChangeJob.findOne).toHaveBeenCalledWith(expect.objectContaining({ assistantConversationId: CONVERSATION }), expect.anything())
            expect(getJob).not.toHaveBeenCalled()
            expect(followUpJob).not.toHaveBeenCalled()
            expect(stopJob).not.toHaveBeenCalled()
            expect(applyJob).not.toHaveBeenCalled()
        })

        it("Given a run still working, when its status is read, then it is not marked as heard of: its end will still be told", async () => {
            await run("agent_run_status", { jobId: JOB })

            expect(updateOne).not.toHaveBeenCalled()
        })

        it("Given a run that ended, when its status is read, then it is marked as heard of, so no update turn repeats it", async () => {
            getJob.mockResolvedValue(jobView("DONE"))

            await run("agent_run_status", { jobId: JOB })

            expect(updateOne).toHaveBeenCalledWith(expect.objectContaining({ assistantNotifiedAt: { $exists: false } }), { $set: { assistantNotifiedAt: expect.any(Date) } })
        })

        it("Given a run that ends while waited for, when the wait returns, then it carries the final status", async () => {
            getJob.mockResolvedValueOnce(jobView("RUNNING")).mockResolvedValue(jobView("DONE", { summary: "Fixed lint" }))

            const result = (await run("agent_run_wait", { jobId: JOB, seconds: 5 })) as Record<string, unknown>

            expect(result).toMatchObject({ status: "DONE", summary: "Fixed lint" })
        }, 10_000)

        it("Given a run still working after the wait, when it times out, then it returns the status as it is", async () => {
            const started = Date.now()

            const result = (await run("agent_run_wait", { jobId: JOB, seconds: 1 })) as Record<string, unknown>

            expect(result.status).toBe("RUNNING")
            expect(Date.now() - started).toBeGreaterThanOrEqual(900)
            expect(Date.now() - started).toBeLessThan(4_000)
        }, 10_000)

        it("Given the user leaving the answer, when a wait is under way, then it stops waiting at once", async () => {
            const abort = new AbortController()
            setTimeout(() => abort.abort(), 50)
            const started = Date.now()

            await run("agent_run_wait", { jobId: JOB }, context(CONVERSATION, abort.signal))

            expect(Date.now() - started).toBeLessThan(1_000)
        })

        it("Given more than a minute asked, when validated, then the wait is refused", () => {
            expect(tool("agent_run_wait").inputSchema.safeParse({ jobId: JOB, seconds: 61 }).success).toBe(false)
        })

        it("Given a finished run, when followed up, then the follow-up starts from it on the repositories asked", async () => {
            await run("agent_run_follow_up", { jobId: JOB, brief: "Also the tests", repositoryIds: [FRONTEND] })

            // Linked by the tool itself: a follow-up asked from the console stays the console's.
            expect(followUpJob).toHaveBeenCalledWith(JOB, { prompt: "Also the tests", frontendIds: [FRONTEND], effort: undefined, aiModelId: undefined, assistantConversationId: CONVERSATION })
        })

        it(`Given ${MAX_AUTOMATIC_FOLLOW_UPS} follow-ups of the chain since the user last wrote, when another is asked, then it is refused`, async () => {
            followUps = MAX_AUTOMATIC_FOLLOW_UPS

            await expect(run("agent_run_follow_up", { jobId: JOB, brief: "Again" })).rejects.toMatchObject({ code: "AGENT_RUN_TOO_MANY_FOLLOW_UPS" })
            expect(followUpJob).not.toHaveBeenCalled()
            expect(AiChangeJob.countDocuments).toHaveBeenCalledWith({
                rootJobId: ROOT,
                assistantConversationId: CONVERSATION,
                parentJobId: { $exists: true },
                createdAt: { $gt: new Date("2026-10-31T10:00:00Z") }
            })
        })

        it("Given a run stopped by the supervisor, when stopped, then it is marked as heard of: no note comes back about it", async () => {
            stopJob.mockResolvedValue({ _id: JOB, status: "FAILED", error: "Stopped by the user before the agent finished" })

            const result = await run("agent_run_stop", { jobId: JOB })

            expect(stopJob).toHaveBeenCalledWith(JOB)
            expect(updateOne).toHaveBeenCalled()
            expect(result).toMatchObject({ status: "FAILED" })
        })
    })

    describe("agent_run_apply", () => {
        it("Given a pull request or a direct push, when classified, then the pull request asks the user and the push is destructive", () => {
            expect(toolKind(tool("agent_run_apply"), { jobId: JOB, mode: "pull_request" })).toBe("confirm")
            expect(toolKind(tool("agent_run_apply"), { jobId: JOB, mode: "push" })).toBe("destructive")
            // Before its input is known, a call is taken for the worst.
            expect(toolKind(tool("agent_run_apply"))).toBe("destructive")
        })

        it("Given a push, when applied, then every proposal of the job is brought onto its base by the job service", async () => {
            applyJob.mockResolvedValue(jobView("DONE"))

            await run("agent_run_apply", { jobId: JOB, mode: "push" })

            expect(applyJob).toHaveBeenCalledWith(JOB)
            expect(openPullRequest).not.toHaveBeenCalled()
        })

        it("Given a pull request refused on one repository, when applied, then the others are still opened and each outcome is told", async () => {
            vi.spyOn(AiChangeRequest, "find").mockImplementation((() =>
                leanQuery([
                    { _id: "r1", frontendId: FRONTEND },
                    { _id: "r2", backendId: BACKEND }
                ])) as never)
            openPullRequest.mockRejectedValueOnce(Object.assign(new Error("A follow-up is refining this proposal"), { code: "AI_JOB_FOLLOW_UP_RUNNING" }))
            openPullRequest.mockResolvedValueOnce({ _id: "r2", backendId: BACKEND, branch: "ai-feature/x", baseBranch: "main", pullRequestUrl: "https://git/pr/2" })

            const result = (await run("agent_run_apply", { jobId: JOB, mode: "pull_request" })) as { pullRequests: Record<string, unknown>[] }

            expect(result.pullRequests).toEqual([
                { repositoryId: FRONTEND, error: expect.any(String) },
                { repositoryId: BACKEND, branch: "ai-feature/x", baseBranch: "main", pullRequestUrl: "https://git/pr/2", pullRequestError: undefined }
            ])
        })

        it("Given a pull request, when applied, then one is opened for each proposal still proposed, and nothing is pushed to a base", async () => {
            vi.spyOn(AiChangeRequest, "find").mockImplementation((() => leanQuery([{ _id: "r1" }, { _id: "r2" }])) as never)
            openPullRequest.mockImplementation(async (id: string) => ({ _id: id, frontendId: FRONTEND, branch: "ai-feature/x", baseBranch: "main", pullRequestUrl: `https://git/pr/${id}` }))

            const result = (await run("agent_run_apply", { jobId: JOB, mode: "pull_request" })) as { pullRequests: unknown[] }

            expect(openPullRequest.mock.calls.map(([id]) => id)).toEqual(["r1", "r2"])
            expect(applyJob).not.toHaveBeenCalled()
            expect(result.pullRequests).toHaveLength(2)
        })

        it("Given the apply asked in a turn, when the round runs, then it waits for the user's confirmation instead of running", async () => {
            const runner = new AssistantToolRunner({
                user: { _id: "user-1" } as unknown as IUser,
                projectId: PROJECT,
                role: "MEMBER",
                conversationId: CONVERSATION,
                log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
            })
            const confirms: unknown[] = []
            const events: AssistantToolEvents = { onToolCall: vi.fn(), onToolResult: vi.fn(), onConfirm: frame => confirms.push(frame) }

            const outcome = await runner.runRound([{ id: "c1", name: "agent_run_apply", input: { jobId: JOB, mode: "pull_request" } }], events)

            expect(outcome.awaitingConfirmation).toBe(true)
            expect(confirms).toHaveLength(1)
            expect(events.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: "agent_run_apply", kind: "confirm" }))
            expect(openPullRequest).not.toHaveBeenCalled()
            expect(applyJob).not.toHaveBeenCalled()
        })
    })

    describe("agent_run_discard", () => {
        it("Given a run, when its discard is classified, then it waits for the user's confirmation", () => {
            expect(toolKind(tool("agent_run_discard"), { jobId: JOB })).toBe("confirm")
        })

        it("Given a confirmed discard, when run, then every proposal still proposed is discarded", async () => {
            vi.spyOn(AiChangeRequest, "find").mockImplementation((() => leanQuery([{ _id: "r1", frontendId: FRONTEND }])) as never)
            discardChange.mockResolvedValue({})

            const result = await run("agent_run_discard", { jobId: JOB })

            expect(discardChange).toHaveBeenCalledWith("r1")
            expect(result).toEqual({ jobId: JOB, discarded: [{ repositoryId: FRONTEND }] })
        })

        it("Given a run of another conversation, when discarded, then it is not found", async () => {
            linked = null

            await expect(run("agent_run_discard", { jobId: JOB })).rejects.toMatchObject({ code: "AGENT_RUN_NOT_LINKED" })
            expect(discardChange).not.toHaveBeenCalled()
        })
    })

    describe("mission_start", () => {
        it("Given a mission, when classified, then it waits for the user's confirmation", () => {
            expect(toolKind(tool("mission_start"), { brief: "Upgrade", mode: "global", all: true })).toBe("confirm")
        })

        it("Given a confirmed mission, when run, then the mission service starts it linked to the conversation", async () => {
            createMission.mockResolvedValue({ _id: "m1", status: "RUNNING", mode: "perRepository", repositories: [{}, {}], batchCount: 1, baseBranch: "develop" })

            const result = await run("mission_start", { brief: "Upgrade React", mode: "perRepository", frontendIds: [FRONTEND], baseBranch: "develop" })

            expect(createMission).toHaveBeenCalledWith(PROJECT, {
                prompt: "Upgrade React",
                mode: "perRepository",
                frontendIds: [FRONTEND],
                baseBranch: "develop",
                assistantConversationId: CONVERSATION
            })
            expect(result).toMatchObject({ missionId: "m1", repositories: 2 })
        })

        it("Given the conversation at its limit of agents, when a mission is started, then it is refused", async () => {
            activeJobs = MAX_ACTIVE_AGENT_RUNS

            await expect(run("mission_start", { brief: "Upgrade", mode: "global", all: true })).rejects.toMatchObject({ code: "AGENT_RUN_TOO_MANY" })
            expect(createMission).not.toHaveBeenCalled()
        })
    })

    it("Given a VIEWER, when the assistant starts an agent, then it is refused before anything runs", async () => {
        const runner = new AssistantToolRunner({
            user: { _id: "user-1" } as unknown as IUser,
            projectId: PROJECT,
            role: "VIEWER",
            conversationId: CONVERSATION,
            log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
        })
        const results: { ok: boolean; summary: string }[] = []

        await runner.runRound([{ id: "c1", name: "agent_run_start", input: { brief: "Fix", frontendIds: [FRONTEND] } }], {
            onToolCall: vi.fn(),
            onToolResult: frame => results.push(frame),
            onConfirm: vi.fn()
        })

        expect(results[0]).toMatchObject({ ok: false })
        expect(results[0].summary).toContain("VIEWER")
        expect(createJob).not.toHaveBeenCalled()
    })

    it("Given a turn of a saved conversation, when the runner calls an agent tool, then the tool gets the conversation", async () => {
        const runner = new AssistantToolRunner({
            user: { _id: "user-1" } as unknown as IUser,
            projectId: PROJECT,
            role: "MEMBER",
            conversationId: CONVERSATION,
            log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
        })

        await runner.runRound([{ id: "c1", name: "agent_run_start", input: { brief: "Fix", frontendIds: [FRONTEND] } }], { onToolCall: vi.fn(), onToolResult: vi.fn(), onConfirm: vi.fn() })

        expect(createJob.mock.calls[0][1]).toMatchObject({ assistantConversationId: CONVERSATION })
    })

    describe("in an update turn", () => {
        const updateRunner = () =>
            new AssistantToolRunner({
                user: { _id: "user-1" } as unknown as IUser,
                projectId: PROJECT,
                role: "MEMBER",
                conversationId: CONVERSATION,
                update: true,
                log: { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
            })
        const round = async (name: string, input: Record<string, unknown>) => {
            const results: { ok: boolean; summary: string }[] = []
            const confirms: { expiresAt: string }[] = []
            const outcome = await updateRunner().runRound([{ id: "c1", name, input }], {
                onToolCall: vi.fn(),
                onToolResult: frame => results.push(frame),
                onConfirm: frame => confirms.push(frame)
            })
            return { outcome, results, confirms }
        }

        it("Given a read, when called, then it runs", async () => {
            const { results } = await round("agent_run_status", { jobId: JOB })

            expect(results[0]).toMatchObject({ ok: true })
            expect(getJob).toHaveBeenCalledWith(JOB)
        })

        it("Given a follow-up of its own run, when called, then it runs within the limits", async () => {
            const { results } = await round("agent_run_follow_up", { jobId: JOB, brief: "Also the tests" })

            expect(results[0]).toMatchObject({ ok: true })
            expect(followUpJob).toHaveBeenCalled()
        })

        it("Given an apply waiting for a confirmation, when called, then it is parked for the user, for a day", async () => {
            const { outcome, confirms } = await round("agent_run_apply", { jobId: JOB, mode: "pull_request" })

            expect(outcome.awaitingConfirmation).toBe(true)
            expect(new Date(confirms[0].expiresAt).getTime() - Date.now()).toBeGreaterThan(UPDATE_ACTION_TTL_MS - 60_000)
            expect(openPullRequest).not.toHaveBeenCalled()
        })

        it("Given an agent or a mission to start, when called, then it is refused before anything is parked", async () => {
            for (const [name, input] of [
                ["agent_run_start", { brief: "Fix", frontendIds: [FRONTEND] }],
                ["mission_start", { brief: "Upgrade", mode: "global", all: true }]
            ] as const) {
                const { outcome, results, confirms } = await round(name, input)

                expect(outcome.awaitingConfirmation, name).toBe(false)
                expect(confirms, name).toHaveLength(0)
                expect(results[0], name).toMatchObject({ ok: false, summary: NOT_IN_UPDATE_TURN })
            }
            expect(createJob).not.toHaveBeenCalled()
            expect(createMission).not.toHaveBeenCalled()
        })

        it("Given any other write of the catalog, when called, then it is refused, to be proposed to the user", async () => {
            const { results } = await round("environment_create", { name: "qa", slug: "qa", color: "#22c55e" })

            expect(results[0]).toMatchObject({ ok: false, summary: NOT_IN_UPDATE_TURN })
        })

        it("Given the catalog, when sorted for an update turn, then reads, its own follow-ups and stops, and the tools waiting for the user pass, every other write does not", () => {
            const verdict = (name: string, input: Record<string, unknown> = {}) => updateTurnRefusal(ASSISTANT_TOOLS.find(tool => tool.name === name)!, input)

            for (const name of ["frontends_list", "agent_run_wait", "agent_run_follow_up", "agent_run_stop", "deploy", "agent_run_discard", "environment_replicas_set", "environment_promote"])
                expect(verdict(name), name).toBeUndefined()
            expect(verdict("agent_run_apply", { mode: "push" })).toBeUndefined()
            for (const name of ["agent_run_start", "mission_start", "frontend_trigger_build", "ai_domain_plan", "project_create"]) {
                expect(verdict(name), name).toBe(NOT_IN_UPDATE_TURN)
            }
        })
    })
})
