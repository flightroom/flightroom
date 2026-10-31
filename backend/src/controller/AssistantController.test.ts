import RateLimit from "@fastify/rate-limit"
import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AssistantDisabledError from "../errors/AssistantDisabledError"
import { createBusinessException } from "../errors/BusinessException"
import errorHandler from "../plugins/errorHandler"
import assistantController from "./AssistantController"

const ensureCanChat = vi.fn()
const takeConfirmation = vi.fn()
const chat = vi.fn()
const draftProject = vi.fn()
const saveUsage = vi.fn()
const recordUsage = vi.fn()
const checkTokenLimit = vi.fn()
const calculateCost = vi.fn()
const conversations = vi.hoisted(() => ({
    listConversations: vi.fn(),
    getConversation: vi.fn(),
    saveConversation: vi.fn(),
    deleteConversation: vi.fn(),
    claimTurn: vi.fn(),
    releaseTurn: vi.fn(),
    conversationForRuns: vi.fn(),
    holdTurn: vi.fn(),
    MAX_TURN_MS: 600_000
}))
const runAgentUpdates = vi.fn()
const conversationJobs = vi.fn()
const conversationCost = vi.fn()
const sandboxByJob = vi.fn()

vi.mock("../service/assistant/AssistantService", () => ({
    default: class {
        ensureCanChat = ensureCanChat
        takeConfirmation = takeConfirmation
        chat = chat
        draftProject = draftProject
    }
}))

vi.mock("../models/AssistantUsageModel", () => ({ default: { create: (...args: unknown[]) => saveUsage(...args) } }))

vi.mock("../service/AiUsageService", () => ({
    calculateAiUsageCost: (...args: unknown[]) => calculateCost(...args),
    recordAiUsage: (...args: unknown[]) => recordUsage(...args),
    ensureWithinTokenLimit: (...args: unknown[]) => checkTokenLimit(...args)
}))

vi.mock("../service/assistant/conversations", () => conversations)

const conversationActivity = vi.fn()
const missionsFind = vi.fn()
const missionGet = vi.fn()

vi.mock("../service/assistant/agentUpdates", () => ({
    runAgentUpdates: (...args: unknown[]) => runAgentUpdates(...args),
    conversationActivity: (...args: unknown[]) => conversationActivity(...args)
}))

vi.mock("../models/AiMissionModel", () => ({
    default: { find: (...args: unknown[]) => ({ sort: () => ({ limit: () => ({ lean: () => missionsFind(...args) }) }) }) }
}))

vi.mock("../service/aiChange/AiMissionService", () => ({
    default: class {
        get = missionGet
    }
}))

vi.mock("../service/assistant/agentRuns", () => ({
    conversationCost: (...args: unknown[]) => conversationCost(...args),
    sandboxByJob: (...args: unknown[]) => sandboxByJob(...args)
}))

vi.mock("../service/aiChange/AiChangeJobService", () => ({
    default: class {
        conversationJobs = conversationJobs
    }
}))

const question = { messages: [{ role: "user", content: "Why did the build fail?" }], context: { page: "/builds" }, conversationId: "conversation-1" }
const LEASE = new Date("2026-10-31T10:15:00.000Z")
const held = { lease: () => LEASE, renew: vi.fn(), stop: vi.fn() }

describe("AssistantController", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        ensureCanChat.mockReset().mockResolvedValue(undefined)
        takeConfirmation.mockReset()
        chat.mockReset()
        draftProject.mockReset()
        saveUsage.mockReset().mockResolvedValue({})
        recordUsage.mockReset().mockResolvedValue(undefined)
        checkTokenLimit.mockReset().mockResolvedValue(undefined)
        calculateCost.mockReset().mockResolvedValue(undefined)
        for (const [name, mock] of Object.entries(conversations)) if (name !== "MAX_TURN_MS") (mock as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined)
        conversations.claimTurn.mockResolvedValue(LEASE)
        conversations.holdTurn.mockReset().mockReturnValue(held)
        runAgentUpdates.mockReset().mockResolvedValue(undefined)
        conversationActivity.mockReset().mockResolvedValue("none")
        missionsFind.mockReset().mockResolvedValue([])
        missionGet.mockReset()
        conversationJobs.mockReset().mockResolvedValue([])
        conversationCost.mockReset()
        sandboxByJob.mockReset().mockResolvedValue(new Map())

        app = Fastify()
        app.decorate("config", { ANTHROPIC_API_KEY: "test-key", ASSISTANT_RATE_LIMIT_MAX: 20 } as never)
        app.decorateRequest("databaseUser", null as never)
        app.addHook("onRequest", async request => {
            request.databaseUser = { _id: "user-1" } as never
        })
        await app.register(errorHandler)
        await app.register(assistantController)
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given no project header, when a question is asked, then the request is rejected before anything is streamed", async () => {
        const response = await app.inject({ method: "POST", url: "/assistant/chat", payload: question })

        expect(response.statusCode).toBeGreaterThanOrEqual(400)
        expect(chat).not.toHaveBeenCalled()
    })

    it("Given an AI the project may not use, when a question asks for it, then it answers 422 with the code instead of opening a stream", async () => {
        ensureCanChat.mockRejectedValue(createBusinessException({ code: "AI_MODEL_NOT_AVAILABLE", message: "not here", statusCode: 422 }))

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: { ...question, aiModelId: "system" } })

        expect(ensureCanChat).toHaveBeenCalledWith("project-1", "system")
        expect(response.statusCode).toBe(422)
        expect(response.headers["content-type"]).not.toContain("text/event-stream")
        expect(chat).not.toHaveBeenCalled()
    })

    it("Given a member who spent their monthly AI tokens, when a question is asked, then it answers 429 with the code instead of opening a stream", async () => {
        checkTokenLimit.mockRejectedValue(createBusinessException({ code: "AI_TOKEN_LIMIT_REACHED", message: "spent", statusCode: 429 }))

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })

        expect(checkTokenLimit).toHaveBeenCalledWith("project-1", "user-1")
        expect(response.statusCode).toBe(429)
        expect(response.json()).toMatchObject({ error: { code: "AI_TOKEN_LIMIT_REACHED" } })
        expect(chat).not.toHaveBeenCalled()
    })

    it("Given an installation without the assistant, when a question is asked, then it answers 404 instead of opening a stream", async () => {
        ensureCanChat.mockRejectedValue(new AssistantDisabledError())

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })

        expect(response.statusCode).toBe(404)
        expect(response.headers["content-type"]).not.toContain("text/event-stream")
    })

    it("Given a conversation that does not end with the user, when it is sent, then it is rejected", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/assistant/chat",
            headers: { "project-id": "project-1" },
            payload: { messages: [...question.messages, { role: "assistant", content: "..." }] }
        })

        expect(response.statusCode).toBe(400)
        expect(chat).not.toHaveBeenCalled()
    })

    it("Given an oversized message, when it is sent, then the schema rejects it", async () => {
        const response = await app.inject({
            method: "POST",
            url: "/assistant/chat",
            headers: { "project-id": "project-1" },
            payload: { messages: [{ role: "user", content: "x".repeat(8_001) }] }
        })

        expect(response.statusCode).toBe(400)
    })

    it("Given a valid question, when it is answered, then tool, text and done frames are streamed in order", async () => {
        chat.mockImplementation(async (_projectId, _request, handlers) => {
            handlers.onToolCall({ id: "c1", name: "build_status_get", title: "Get build status", input: {}, kind: "read" })
            handlers.onToolResult({ id: "c1", ok: true, summary: "1 result", result: [{ status: "failed" }] })
            handlers.onText("The build ")
            handlers.onText("failed on lint.")
            return { stopReason: "end_turn", wrote: false }
        })

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })

        expect(response.statusCode).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(chat.mock.calls[0][0]).toBe("project-1")
        expect(chat.mock.calls[0][4]).toBeUndefined()
        expect(takeConfirmation).not.toHaveBeenCalled()
        expect(response.body).toBe(
            [
                'event: tool_call\ndata: {"id":"c1","name":"build_status_get","title":"Get build status","input":{},"kind":"read"}\n\n',
                'event: tool_result\ndata: {"id":"c1","ok":true,"summary":"1 result","result":[{"status":"failed"}]}\n\n',
                'event: text\ndata: {"delta":"The build "}\n\n',
                'event: text\ndata: {"delta":"failed on lint."}\n\n',
                'event: done\ndata: {"stopReason":"end_turn","wrote":false}\n\n'
            ].join("")
        )
    })

    it("Given an effort the model does not know, when a question is sent, then the schema rejects it", async () => {
        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: { ...question, effort: "extreme" } })

        expect(response.statusCode).toBe(400)
        expect(chat).not.toHaveBeenCalled()
    })

    it("Given a chosen effort, when the question is answered, then it reaches the backend, the reasoning streams as thinking frames and the usage records the effort", async () => {
        const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }
        chat.mockImplementation(async (_projectId, _request, handlers) => {
            handlers.onThinking("Check the logs.")
            handlers.onText("Lint failed.")
            return { stopReason: "end_turn", wrote: false, usage, effort: "xhigh", aiModelId: "system", provider: "anthropic" }
        })

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "64b7f0c2a1b2c3d4e5f60718" }, payload: { ...question, effort: "xhigh" } })

        expect(chat.mock.calls[0][1]).toMatchObject({ effort: "xhigh" })
        expect(response.body).toContain('event: thinking\ndata: {"delta":"Check the logs."}\n\nevent: text\ndata: {"delta":"Lint failed."}')
        expect(saveUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "end_turn", effort: "xhigh", aiModelId: "system", provider: "anthropic", ...usage }))
    })

    it("Given a destructive call, when the turn stops on it, then a confirm frame and a done frame awaiting confirmation are streamed", async () => {
        const confirm = { actionId: "a1", callId: "c1", name: "environment_delete", title: "Delete environment", input: { environmentId: "e1" }, expiresAt: "2026-10-15T10:15:00.000Z" }
        chat.mockImplementation(async (_projectId, _request, handlers) => {
            handlers.onConfirm(confirm)
            return { stopReason: "awaiting_confirmation", wrote: false }
        })

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })

        expect(response.body).toBe([`event: confirm\ndata: ${JSON.stringify(confirm)}\n\n`, 'event: done\ndata: {"stopReason":"awaiting_confirmation","wrote":false}\n\n'].join(""))
    })

    it("Given a confirmation, when the conversation ends with the assistant's message, then the action is taken for this project and the turn resumes with it", async () => {
        const action = { id: "a1", tool: "environment_delete" }
        takeConfirmation.mockResolvedValue(action)
        chat.mockResolvedValue({ stopReason: "end_turn", wrote: true })

        const response = await app.inject({
            method: "POST",
            url: "/assistant/chat",
            headers: { "project-id": "project-1" },
            payload: { messages: [...question.messages, { role: "assistant", content: "I will delete staging." }], confirmation: { actionId: "a1", approved: true }, conversationId: "conversation-1" }
        })

        expect(response.statusCode).toBe(200)
        expect(takeConfirmation).toHaveBeenCalledWith("project-1", "a1", "conversation-1")
        expect(chat.mock.calls[0][4]).toEqual({ action, approved: true })
        expect(response.body).toContain('event: done\ndata: {"stopReason":"end_turn","wrote":true}')
    })

    describe("turns of a conversation", () => {
        it("Given a question in a saved conversation, when it is answered, then the turn holds the conversation, renewed, marks the question and its AI, and frees it after", async () => {
            chat.mockResolvedValue({ stopReason: "end_turn", wrote: false })

            const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: { ...question, aiModelId: "system" } })

            expect(response.statusCode).toBe(200)
            expect(conversations.claimTurn).toHaveBeenCalledWith("user-1", "project-1", "conversation-1", { asked: true, aiModelId: "system" })
            expect(conversations.holdTurn).toHaveBeenCalledWith("conversation-1", LEASE, expect.any(Function))
            expect(chat.mock.calls[0][1]).toMatchObject({ conversationId: "conversation-1" })
            expect(held.stop).toHaveBeenCalled()
            expect(conversations.releaseTurn).toHaveBeenCalledWith("conversation-1", LEASE)
            // The updates wait for the browser to save this turn: see the save.
            expect(runAgentUpdates).not.toHaveBeenCalled()
        })

        it("Given the lease lost while the answer streams, when the heartbeat says so, then the turn is stopped", async () => {
            let signal: AbortSignal | undefined
            chat.mockImplementation(async (_projectId: string, _request: unknown, _handlers: unknown, turnSignal: AbortSignal) => {
                signal = turnSignal
                const onLost = conversations.holdTurn.mock.calls[0][2] as () => void
                onLost()
                return { stopReason: "end_turn", wrote: false }
            })

            await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })

            expect(signal?.aborted).toBe(true)
        })

        it("Given a conversation an update turn holds, when a question is asked, then it answers 409 before any stream, and a pending confirmation is not used up", async () => {
            conversations.claimTurn.mockResolvedValue(undefined)

            const response = await app.inject({
                method: "POST",
                url: "/assistant/chat",
                headers: { "project-id": "project-1" },
                payload: {
                    messages: [...question.messages, { role: "assistant", content: "I will delete staging." }],
                    confirmation: { actionId: "a1", approved: true },
                    conversationId: "conversation-1"
                }
            })

            expect(response.statusCode).toBe(409)
            expect(response.json().error.code).toBe("ASSISTANT_CONVERSATION_BUSY")
            expect(conversations.claimTurn).toHaveBeenCalledWith("user-1", "project-1", "conversation-1", { asked: false, aiModelId: undefined })
            expect(takeConfirmation).not.toHaveBeenCalled()
            expect(chat).not.toHaveBeenCalled()
        })

        it("Given an expired confirmation, when it is refused, then the conversation is freed for the next turn", async () => {
            takeConfirmation.mockRejectedValue(createBusinessException({ code: "ASSISTANT_ACTION_NOT_FOUND", message: "expired", statusCode: 409 }))

            const response = await app.inject({
                method: "POST",
                url: "/assistant/chat",
                headers: { "project-id": "project-1" },
                payload: {
                    messages: [...question.messages, { role: "assistant", content: "I will delete staging." }],
                    confirmation: { actionId: "a1", approved: true },
                    conversationId: "conversation-1"
                }
            })

            expect(response.statusCode).toBe(409)
            expect(conversations.releaseTurn).toHaveBeenCalledWith("conversation-1", LEASE)
            expect(chat).not.toHaveBeenCalled()
        })

        it("Given a question without a conversation, when it is sent, then the schema rejects it: every turn takes the lease", async () => {
            const { conversationId: _conversationId, ...withoutConversation } = question

            const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: withoutConversation })

            expect(response.statusCode).toBe(400)
            expect(chat).not.toHaveBeenCalled()
        })

        it("Given an answer saved by the browser, when the save is done, then the updates of the agents run after it, never before", async () => {
            const messages = [
                { id: "m1", role: "user", content: "Fix the build" },
                { id: "m2", role: "assistant", content: "Started an agent.", status: "done" }
            ]

            const response = await app.inject({ method: "PUT", url: "/assistant/conversations/conversation-1", headers: { "project-id": "project-1" }, payload: { messages } })

            expect(response.statusCode).toBe(204)
            expect(runAgentUpdates).toHaveBeenCalledWith("conversation-1", expect.anything(), expect.anything())
            expect(conversations.saveConversation.mock.invocationCallOrder[0]).toBeLessThan(runAgentUpdates.mock.invocationCallOrder[0])
        })

        it("Given the save of a question whose answer is about to stream, when the save is done, then no update runs: it would take the conversation from the answer", async () => {
            const messages = [
                { id: "m1", role: "user", content: "Fix the build" },
                { id: "m2", role: "assistant", content: "", status: "streaming" }
            ]

            await app.inject({ method: "PUT", url: "/assistant/conversations/conversation-1", headers: { "project-id": "project-1" }, payload: { messages } })

            expect(runAgentUpdates).not.toHaveBeenCalled()
        })

        it("Given a save that fails, when it is refused, then no update runs on a conversation the browser could not save", async () => {
            conversations.saveConversation.mockRejectedValue(createBusinessException({ code: "ASSISTANT_CONVERSATION_CONFLICT", message: "changed", statusCode: 409 }))

            const response = await app.inject({
                method: "PUT",
                url: "/assistant/conversations/conversation-1",
                headers: { "project-id": "project-1" },
                payload: { messages: [{ id: "m1", role: "user", content: "Hi" }] }
            })

            expect(response.statusCode).toBe(409)
            expect(runAgentUpdates).not.toHaveBeenCalled()
        })
    })

    it("Given an answer, when it ends, then its tokens are saved for the project", async () => {
        const usage = { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 150 }
        chat.mockResolvedValue({ stopReason: "end_turn", wrote: false, usage })

        await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "64b7f0c2a1b2c3d4e5f60718" }, payload: question })

        expect(saveUsage).toHaveBeenCalledWith(expect.objectContaining({ projectId: "64b7f0c2a1b2c3d4e5f60718", stopReason: "end_turn", ...usage }))
        expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ projectId: "64b7f0c2a1b2c3d4e5f60718", userId: "user-1", source: "assistant", ...usage }))
        // The assistant works on the whole project: no domain nor repository is credited.
        expect(recordUsage.mock.calls[0][0]).not.toHaveProperty("domainId")
        expect(recordUsage.mock.calls[0][0]).not.toHaveProperty("frontendIds")
        expect(recordUsage.mock.calls[0][0]).not.toHaveProperty("backendIds")
    })

    it("Given configured token rates, when an answer ends, then its cost is sent to the interaction and recorded", async () => {
        calculateCost.mockResolvedValue({ amount: 0.00025, currency: "EUR" })
        chat.mockResolvedValue({ stopReason: "end_turn", wrote: false, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }, aiModelId: "custom-ai" })

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "64b7f0c2a1b2c3d4e5f60718" }, payload: question })

        expect(response.body).toContain('"usage":{"inputTokens":10,"cachedInputTokens":0,"outputTokens":5,"cost":0.00025,"currency":"EUR"}')
        expect(saveUsage).toHaveBeenCalledWith(expect.objectContaining({ aiModelId: "custom-ai", cost: 0.00025, currency: "EUR" }))
        expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ aiModelId: "custom-ai", cost: 0.00025, currency: "EUR" }))
    })

    it("Given an answer failing after two model rounds, when it ends with an error, then the ledger still counts both rounds and the usage document stays for finished answers", async () => {
        const spentOn = { effort: "high", aiModelId: "system", provider: "anthropic" }
        chat.mockImplementation(async (_projectId, _request, handlers) => {
            handlers.onUsage({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 }, spentOn)
            handlers.onUsage({ inputTokens: 200, cachedInputTokens: 0, outputTokens: 20 }, spentOn)
            throw new Error("provider down")
        })

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "64b7f0c2a1b2c3d4e5f60718" }, payload: question })

        expect(response.body).toContain("event: error")
        expect(recordUsage).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: "64b7f0c2a1b2c3d4e5f60718", source: "assistant", ...spentOn, inputTokens: 300, cachedInputTokens: 60, outputTokens: 30 })
        )
        expect(saveUsage).not.toHaveBeenCalled()
    })

    it("Given a priced answer failing after tokens were spent, when it ends with an error, then the interaction and ledger still show its cost", async () => {
        const spentOn = { effort: "high", aiModelId: "custom-ai", provider: "anthropic" }
        calculateCost.mockResolvedValue({ amount: 0.00025, currency: "EUR" })
        chat.mockImplementation(async (_projectId, _request, handlers) => {
            handlers.onUsage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 }, spentOn)
            throw new Error("provider down")
        })

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "64b7f0c2a1b2c3d4e5f60718" }, payload: question })

        expect(response.body).toContain('"usage":{"inputTokens":10,"cachedInputTokens":2,"outputTokens":5,"cost":0.00025,"currency":"EUR"}')
        expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ ...spentOn, cost: 0.00025, currency: "EUR" }))
        expect(saveUsage).not.toHaveBeenCalled()
    })

    it("Given an answer failing before any model round, when it ends with an error, then nothing is recorded", async () => {
        chat.mockRejectedValue(new Error("no AI"))

        await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "64b7f0c2a1b2c3d4e5f60718" }, payload: question })

        expect(recordUsage).not.toHaveBeenCalled()
        expect(saveUsage).not.toHaveBeenCalled()
    })

    it("Given the ledger cannot be written, when the answer ends, then the usage document is saved anyway and the stream closes with done", async () => {
        chat.mockResolvedValue({ stopReason: "end_turn", wrote: false, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } })
        recordUsage.mockRejectedValue(new Error("mongo down"))

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "64b7f0c2a1b2c3d4e5f60718" }, payload: question })

        expect(response.body).toContain("event: done")
        expect(response.body).not.toContain("event: error")
        expect(saveUsage).toHaveBeenCalled()
    })

    it("Given the usage cannot be saved, when the answer ends, then the stream still closes with done and no error", async () => {
        chat.mockResolvedValue({ stopReason: "end_turn", wrote: false, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } })
        saveUsage.mockRejectedValue(new Error("mongo down"))

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })

        expect(response.body).toContain("event: done")
        expect(response.body).not.toContain("event: error")
    })

    it("Given an expired or already answered confirmation, when it is sent, then it fails with an HTTP error before any stream", async () => {
        takeConfirmation.mockRejectedValue(createBusinessException({ code: "ASSISTANT_ACTION_NOT_FOUND", message: "This confirmation has expired or was already answered", statusCode: 409 }))

        const response = await app.inject({
            method: "POST",
            url: "/assistant/chat",
            headers: { "project-id": "project-1" },
            payload: { messages: question.messages, confirmation: { actionId: "a1", approved: true }, conversationId: "conversation-1" }
        })

        expect(response.statusCode).toBe(409)
        expect(response.headers["content-type"]).not.toContain("text/event-stream")
        expect(chat).not.toHaveBeenCalled()
    })

    it.each([{ actionId: "a1" }, { actionId: "", approved: true }, { actionId: "a1", approved: "yes" }, { actionId: "x".repeat(101), approved: true }])(
        "Given a malformed confirmation %j, when it is sent, then the schema rejects it",
        async confirmation => {
            const response = await app.inject({
                method: "POST",
                url: "/assistant/chat",
                headers: { "project-id": "project-1" },
                payload: { messages: question.messages, confirmation, conversationId: "conversation-1" }
            })

            expect(response.statusCode).toBe(400)
            expect(takeConfirmation).not.toHaveBeenCalled()
            expect(chat).not.toHaveBeenCalled()
        }
    )

    it("Given the model call fails mid-answer, when streaming, then an error frame closes the stream", async () => {
        chat.mockImplementation(async (_projectId, _request, handlers) => {
            handlers.onText("Partial")
            throw new Error("boom")
        })

        const response = await app.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })

        expect(response.body).toContain('event: text\ndata: {"delta":"Partial"}')
        expect(response.body).toContain('event: error\ndata: {"code":"ASSISTANT_ERROR"}')
    })

    it("Given a project description, when a draft is asked, then the draft is returned", async () => {
        draftProject.mockResolvedValue({
            reply: "How many environments?",
            options: [],
            ready: false,
            draft: { name: "Portal", description: "", environments: [], domains: [], codeRepository: "NONE", notes: "" }
        })

        const response = await app.inject({
            method: "POST",
            url: "/assistant/project-draft",
            payload: { organizationId: "64b7f0c2a1b2c3d4e5f60719", messages: [{ role: "user", content: "A portal" }], locale: "it", aiModelId: "system" }
        })

        expect(response.statusCode).toBe(200)
        expect(response.json().draft.name).toBe("Portal")
        expect(draftProject).toHaveBeenCalledWith("64b7f0c2a1b2c3d4e5f60719", [{ role: "user", content: "A portal" }], "it", "system")
    })

    it("Given a draft asked without the organization, when it is sent, then it is rejected: the AIs are the organization's", async () => {
        const response = await app.inject({ method: "POST", url: "/assistant/project-draft", payload: { messages: [{ role: "user", content: "A portal" }], locale: "it" } })

        expect(response.statusCode).toBe(400)
        expect(draftProject).not.toHaveBeenCalled()
    })

    it("Given a rate limit of the assistant's own, when it is exceeded, then further questions get 429 while the rest of the API is unaffected", async () => {
        const limited = Fastify()
        limited.decorate("config", { ANTHROPIC_API_KEY: "test-key", ASSISTANT_RATE_LIMIT_MAX: 2 } as never)
        limited.decorateRequest("databaseUser", null as never)
        limited.addHook("onRequest", async request => {
            request.databaseUser = { _id: "user-1" } as never
        })
        await limited.register(RateLimit, { max: 100, timeWindow: "1 minute" })
        await limited.register(assistantController)
        chat.mockResolvedValue({ stopReason: "end_turn", wrote: false })

        const ask = () => limited.inject({ method: "POST", url: "/assistant/chat", headers: { "project-id": "project-1" }, payload: question })
        expect((await ask()).statusCode).toBe(200)
        expect((await ask()).statusCode).toBe(200)
        expect((await ask()).statusCode).toBe(429)

        await limited.close()
    })

    describe("conversations", () => {
        const headers = { "project-id": "64b7f0c2a1b2c3d4e5f60718" }

        it("Given a project, when the history is asked for, then it lists the user's conversations there", async () => {
            conversations.listConversations.mockResolvedValue([{ id: "conversation-1", title: "Why did the build fail?", updatedAt: "2026-10-16T10:00:00.000Z" }])

            const response = await app.inject({ method: "GET", url: "/assistant/conversations", headers })

            expect(response.statusCode).toBe(200)
            expect(conversations.listConversations).toHaveBeenCalledWith("user-1", headers["project-id"])
            expect(response.json()).toHaveLength(1)
        })

        it("Given a member who spent their monthly AI tokens, when the history is asked for, then it still answers: reading spends no token", async () => {
            checkTokenLimit.mockRejectedValue(createBusinessException({ code: "AI_TOKEN_LIMIT_REACHED", message: "spent", statusCode: 429 }))
            conversations.listConversations.mockResolvedValue([])

            const response = await app.inject({ method: "GET", url: "/assistant/conversations", headers })

            expect(response.statusCode).toBe(200)
            expect(checkTokenLimit).not.toHaveBeenCalled()
        })

        it("Given an installation without the assistant, when the history is asked for, then it answers 404", async () => {
            ensureCanChat.mockRejectedValue(new AssistantDisabledError())

            const response = await app.inject({ method: "GET", url: "/assistant/conversations", headers })

            expect(response.statusCode).toBe(404)
            expect(conversations.listConversations).not.toHaveBeenCalled()
        })

        it("Given a conversation, when it is saved, then it is stored for the user and project", async () => {
            const messages = [{ id: "m1", role: "user", content: "Why did the build fail?" }]

            const response = await app.inject({ method: "PUT", url: "/assistant/conversations/conversation-1", headers, payload: { messages } })

            expect(response.statusCode).toBe(204)
            expect(conversations.saveConversation).toHaveBeenCalledWith("user-1", headers["project-id"], "conversation-1", messages)
        })

        it("Given answers with their reasoning and effort, a level unknown to this server among them, when saved, then nothing is rejected and all reach the store", async () => {
            const messages = [
                { id: "m1", role: "user", content: "Why did the build fail?" },
                { id: "m2", role: "assistant", content: "Lint failed.", thinking: "Check the logs.", effort: "xhigh" },
                { id: "m3", role: "assistant", content: "Fixed.", effort: "turbo" }
            ]

            const response = await app.inject({ method: "PUT", url: "/assistant/conversations/conversation-1", headers, payload: { messages } })

            expect(response.statusCode).toBe(204)
            expect(conversations.saveConversation).toHaveBeenCalledWith("user-1", headers["project-id"], "conversation-1", messages)
        })

        it("Given an id that is not a plain token, when a conversation is saved, then the schema rejects it", async () => {
            const response = await app.inject({ method: "PUT", url: "/assistant/conversations/bad$id!!", headers, payload: { messages: [{ id: "m1", role: "user", content: "Hi" }] } })

            expect(response.statusCode).toBe(400)
            expect(conversations.saveConversation).not.toHaveBeenCalled()
        })

        it("Given a conversation that started agents, when its agent runs are asked for, then each job comes with its sandbox time, with its missions, the cost and the messages the server added", async () => {
            const messages = [{ id: "m1" }, { id: "update-1", origin: "server" }, { id: "m3", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }]
            conversations.conversationForRuns.mockResolvedValue({ messages, busy: false })
            conversationJobs.mockResolvedValue([{ _id: "6720f0c2a1b2c3d4e5f60701", status: "DONE" }])
            sandboxByJob.mockResolvedValue(new Map([["6720f0c2a1b2c3d4e5f60701", { commands: 2, execSeconds: 30, lifetimeSeconds: 300 }]]))
            missionsFind.mockResolvedValue([{ _id: "6720f0c2a1b2c3d4e5f60799" }])
            missionGet.mockResolvedValue({
                _id: "6720f0c2a1b2c3d4e5f60799",
                prompt: "Bump React",
                status: "RUNNING",
                repositories: [{}, {}, {}],
                counts: { queued: 1, running: 1 },
                usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 },
                createdAt: "2026-10-31T10:00:00.000Z"
            })
            const cost = { assistant: { inputTokens: 1 }, agents: { inputTokens: 2 }, total: { inputTokens: 3 } }
            conversationCost.mockResolvedValue(cost)
            conversationActivity.mockResolvedValue("missions")

            const response = await app.inject({ method: "GET", url: "/assistant/conversations/conversation-1/agent-runs", headers })

            expect(response.statusCode).toBe(200)
            expect(conversations.conversationForRuns).toHaveBeenCalledWith("user-1", headers["project-id"], "conversation-1")
            expect(conversationJobs).toHaveBeenCalledWith(headers["project-id"], "conversation-1")
            expect(conversationCost).toHaveBeenCalledWith("conversation-1", messages)
            expect(response.json()).toEqual({
                jobs: [{ _id: "6720f0c2a1b2c3d4e5f60701", status: "DONE", sandbox: { commands: 2, execSeconds: 30, lifetimeSeconds: 300 } }],
                missions: [
                    {
                        _id: "6720f0c2a1b2c3d4e5f60799",
                        prompt: "Bump React",
                        status: "RUNNING",
                        repositories: 3,
                        done: 1,
                        usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 },
                        createdAt: "2026-10-31T10:00:00.000Z"
                    }
                ],
                cost,
                serverMessageIds: ["update-1"],
                activity: "missions"
            })
        })

        it("Given a turn holding the conversation, when its agent runs are asked for, then the panel polls as for agents at work", async () => {
            conversations.conversationForRuns.mockResolvedValue({ messages: [], busy: true })
            conversationCost.mockResolvedValue({})

            const response = await app.inject({ method: "GET", url: "/assistant/conversations/conversation-1/agent-runs", headers })

            expect(response.json().activity).toBe("agents")
        })

        it("Given a conversation of someone else, when its agent runs are asked for, then it is not found", async () => {
            conversations.conversationForRuns.mockRejectedValue(createBusinessException({ code: "ASSISTANT_CONVERSATION_NOT_FOUND", message: "Conversation not found", statusCode: 404 }))

            const response = await app.inject({ method: "GET", url: "/assistant/conversations/conversation-1/agent-runs", headers })

            expect(response.statusCode).toBe(404)
            expect(conversationJobs).not.toHaveBeenCalled()
        })

        it("Given a conversation, when it is opened and then deleted, then both act on that id for the user", async () => {
            conversations.getConversation.mockResolvedValue({ id: "conversation-1", title: "t", updatedAt: "2026-10-16T10:00:00.000Z", messages: [] })

            const opened = await app.inject({ method: "GET", url: "/assistant/conversations/conversation-1", headers })
            const deleted = await app.inject({ method: "DELETE", url: "/assistant/conversations/conversation-1", headers })

            expect(opened.statusCode).toBe(200)
            expect(conversations.getConversation).toHaveBeenCalledWith("user-1", headers["project-id"], "conversation-1")
            expect(deleted.statusCode).toBe(204)
            expect(conversations.deleteConversation).toHaveBeenCalledWith("user-1", headers["project-id"], "conversation-1")
        })
    })
})
