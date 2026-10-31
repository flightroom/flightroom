import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AssistantConversationMessageDTO } from "../../types/AssistantDTO"
import {
    appendMessages,
    claimServerTurn,
    claimTurn,
    countUpdateTurn,
    deleteConversation,
    getConversation,
    holdTurn,
    MAX_STORED_MESSAGES,
    releaseTurn,
    renewTurn,
    SAVE_GRACE_MS,
    saveConversation,
    TURN_HEARTBEAT_MS,
    toStoredMessage,
    withServerMessages
} from "./conversations"

const updateOne = vi.fn()
const findOne = vi.fn()
const findOneAndUpdate = vi.fn()
const exists = vi.fn()

vi.mock("../../models/AssistantConversationModel", () => ({
    default: {
        updateOne: (...args: unknown[]) => updateOne(...args),
        findOne: (...args: unknown[]) => ({ lean: () => findOne(...args) }),
        findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
        exists: (...args: unknown[]) => exists(...args)
    }
}))

const userId = "64b7f0c2a1b2c3d4e5f60701" as never
const projectId = "64b7f0c2a1b2c3d4e5f60718"

const answerWithTools = {
    id: "m2",
    role: "assistant",
    content: "Created the key.",
    status: "streaming",
    tools: [{ id: "t1", name: "api_key_create", title: "Create API key", kind: "write", status: "running", input: { name: "ci" }, result: { apiKey: "secret-value" } }],
    confirmation: {
        actionId: "a1",
        callId: "t1",
        name: "api_key_create",
        title: "Create API key",
        input: { name: "ci" },
        details: [{ label: "name", value: "ci" }],
        expiresAt: "2026-10-16T12:00:00Z",
        status: "approved"
    }
} as unknown as AssistantConversationMessageDTO

describe("conversations", () => {
    beforeEach(() => {
        updateOne.mockReset().mockResolvedValue({})
        findOne.mockReset()
        findOneAndUpdate.mockReset().mockResolvedValue({ _id: "conversation-1" })
        exists.mockReset().mockResolvedValue(null)
    })

    it("Given an answer with tool inputs and results, when it is stored, then neither is kept", () => {
        const stored = toStoredMessage(answerWithTools)

        expect(JSON.stringify(stored)).not.toContain("secret-value")
        expect(stored.tools?.[0]).not.toHaveProperty("input")
        expect(stored.tools?.[0]).not.toHaveProperty("result")
        expect(stored.confirmation).not.toHaveProperty("input")
    })

    it("Given an answer saved while it streamed, when it is stored, then it reads as finished and its running calls as interrupted", () => {
        const stored = toStoredMessage(answerWithTools)

        expect(stored.status).toBe("done")
        expect(stored.tools?.[0].status).toBe("interrupted")
    })

    it("Given a priced answer, when it is stored, then its cost remains with the conversation", () => {
        const stored = toStoredMessage({ ...answerWithTools, usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, cost: 0.00025, currency: "EUR" } })

        expect(stored.usage).toMatchObject({ cost: 0.00025, currency: "EUR" })
    })

    it("Given an answer longer than what is kept, when it is stored, then it is clipped instead of rejected", () => {
        const long = { ...answerWithTools, content: "x".repeat(100_000), confirmation: { ...answerWithTools.confirmation!, details: [{ label: "variables", value: "y".repeat(5_000) }] } }

        const stored = toStoredMessage(long)

        expect(stored.content).toHaveLength(64_000)
        expect(stored.confirmation?.details[0].value).toHaveLength(2_000)
    })

    it("Given an answer with its reasoning and effort, when it is stored, then both are kept, the reasoning clipped and masked like the answer", () => {
        const long = toStoredMessage({ ...answerWithTools, effort: "high", thinking: "z".repeat(100_000) })
        const withSecret = toStoredMessage({ ...answerWithTools, effort: "low", thinking: "The pipeline sets NPM_TOKEN=abcdef1234567890." })

        expect(long.effort).toBe("high")
        expect(long.thinking).toHaveLength(64_000)
        expect(withSecret.effort).toBe("low")
        expect(withSecret.thinking).not.toContain("abcdef1234567890")
    })

    it("Given an effort this server does not know, when it is stored, then it is dropped and the rest is kept", () => {
        const stored = toStoredMessage({ ...answerWithTools, effort: "turbo" as never, thinking: "Checked the logs." })

        expect(stored).not.toHaveProperty("effort")
        expect(stored.thinking).toBe("Checked the logs.")
    })

    it("Given an answer saved before reasoning was kept, when it is stored, then it gains no reasoning nor effort", () => {
        const stored = toStoredMessage(answerWithTools)

        expect(stored).not.toHaveProperty("thinking")
        expect(stored).not.toHaveProperty("effort")
    })

    it("Given a secret in the answer or in a confirmation card, when it is stored, then it is masked", () => {
        const withSecrets = {
            ...answerWithTools,
            content: "Set NPM_TOKEN=abcdef1234567890 in the pipeline.",
            confirmation: { ...answerWithTools.confirmation!, details: [{ label: "variables", value: "+ API_KEY = sk-live-123456789" }] }
        }

        const stored = toStoredMessage(withSecrets)

        expect(stored.content).not.toContain("abcdef1234567890")
        expect(stored.confirmation?.details[0].value).not.toContain("sk-live-123456789")
    })

    it("Given a conversation, when it is saved, then it is upserted for its user and project, titled by the first question, with no expiry", async () => {
        await saveConversation(userId, projectId, "conversation-1", [{ id: "m1", role: "user", content: "  Why did   the build\nfail? " }, answerWithTools])

        const [filter, update, options] = updateOne.mock.calls[0]
        expect(filter).toEqual({ _id: "conversation-1", userId, projectId, deletedAt: null })
        expect(options).toEqual({ upsert: true })
        expect(update.$set.title).toBe("Why did the build fail?")
        expect(update.$set).not.toHaveProperty("expiresAt")
    })

    it("Given a long first question, when the conversation is saved, then the title is shortened", async () => {
        await saveConversation(userId, projectId, "conversation-1", [{ id: "m1", role: "user", content: "x".repeat(500) }])

        expect(updateOne.mock.calls[0][1].$set.title).toHaveLength(80)
    })

    it("Given an id that belongs to another user or project, or was deleted, when it is saved, then it fails as not found", async () => {
        updateOne.mockRejectedValue(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }))

        await expect(saveConversation(userId, projectId, "conversation-1", [{ id: "m1", role: "user", content: "Hi" }])).rejects.toMatchObject({ statusCode: 404 })
    })

    it("Given a conversation of someone else, or a deleted one, when it is opened, then it is not found", async () => {
        findOne.mockResolvedValue(null)

        await expect(getConversation(userId, projectId, "conversation-1")).rejects.toMatchObject({ statusCode: 404 })
        expect(findOne.mock.calls[0][0]).toEqual({ _id: "conversation-1", userId, projectId, deletedAt: null })
    })

    it("Given a conversation, when it is deleted, then it is only marked as deleted and stays in the database", async () => {
        updateOne.mockResolvedValue({ matchedCount: 1 })

        await deleteConversation(userId, projectId, "conversation-1")

        const [filter, update, options] = updateOne.mock.calls[0]
        expect(filter).toEqual({ _id: "conversation-1", userId, projectId, deletedAt: null })
        expect(update.$set.deletedAt).toBeInstanceOf(Date)
        expect(options).toBeUndefined()
    })

    it("Given no such conversation, or one already deleted, when it is deleted, then it is not found", async () => {
        updateOne.mockResolvedValue({ matchedCount: 0 })

        await expect(deleteConversation(userId, projectId, "conversation-1")).rejects.toMatchObject({ statusCode: 404 })
    })

    describe("messages the server added", () => {
        const user = (id: string) => ({ id, role: "user" as const, content: id })
        const server = (id: string) => ({ id, role: "user" as const, content: id, origin: "server" as const, kind: "agent_update" as const })

        it("Given a note the browser has not seen, when its copy is merged, then the note stays after the message it followed", () => {
            const merged = withServerMessages([user("m1"), user("m2"), server("n1"), server("a1")], [user("m1"), user("m2"), user("m3")])

            expect(merged.map(message => message.id)).toEqual(["m1", "m2", "n1", "a1", "m3"])
        })

        it("Given server messages older than what the browser still sends, when merged, then they stay out: the browser trimmed them", () => {
            const merged = withServerMessages([server("n0"), user("m1"), user("m2")], [user("m1"), user("m2")])

            expect(merged.map(message => message.id)).toEqual(["m1", "m2"])
        })

        it("Given a browser that already holds the server's messages, when merged, then nothing is added twice", () => {
            const merged = withServerMessages([user("m1"), server("n1")], [user("m1"), server("n1"), user("m2")])

            expect(merged.map(message => message.id)).toEqual(["m1", "n1", "m2"])
        })

        it("Given a saved conversation with a note the browser missed, when the browser saves, then the note is kept and the write is guarded on the version read", async () => {
            findOne.mockResolvedValue({ messages: [user("m1"), server("n1")], version: 7 })
            updateOne.mockResolvedValue({ matchedCount: 1 })

            await saveConversation(userId, projectId, "conversation-1", [user("m1"), user("m2")])

            const [filter, update, options] = updateOne.mock.calls[0]
            expect(filter).toMatchObject({ _id: "conversation-1", userId, deletedAt: null, version: 7 })
            expect(update.$inc).toEqual({ version: 1 })
            expect(update.$set.messages.map((message: { id: string }) => message.id)).toEqual(["m1", "n1", "m2"])
            expect(options).toBeUndefined()
        })

        it("Given a note added between the read and the write, when the browser saves, then it reads and merges again", async () => {
            findOne.mockResolvedValueOnce({ messages: [user("m1")], version: 1 }).mockResolvedValueOnce({ messages: [user("m1"), server("n1")], version: 2 })
            updateOne.mockResolvedValueOnce({ matchedCount: 0 }).mockResolvedValueOnce({ matchedCount: 1 })

            await saveConversation(userId, projectId, "conversation-1", [user("m1"), user("m2")])

            expect(updateOne).toHaveBeenCalledTimes(2)
            expect(updateOne.mock.calls[1][1].$set.messages.map((message: { id: string }) => message.id)).toEqual(["m1", "n1", "m2"])
        })

        it("Given the conversation moving on at every attempt, when the browser saves, then the save is refused rather than written over the server's messages", async () => {
            findOne.mockResolvedValue({ messages: [user("m1"), server("n1")], version: 3 })
            updateOne.mockResolvedValue({ matchedCount: 0 })

            await expect(saveConversation(userId, projectId, "conversation-1", [user("m1")])).rejects.toMatchObject({ code: "ASSISTANT_CONVERSATION_CONFLICT", statusCode: 409 })
            // Every attempt guarded: none wrote without the version it read.
            for (const [filter] of updateOne.mock.calls) expect(filter).toHaveProperty("version", 3)
        })

        it("Given a conversation saved before versions were counted, when saved, then the write is guarded on there being none", async () => {
            findOne.mockResolvedValue({ messages: [user("m1")] })
            updateOne.mockResolvedValue({ matchedCount: 1 })

            await saveConversation(userId, projectId, "conversation-1", [user("m1")])

            expect(updateOne.mock.calls[0][0]).toHaveProperty("version", null)
        })

        it("Given a merge longer than what is kept, when saved, then the oldest messages are dropped", async () => {
            const incoming = Array.from({ length: MAX_STORED_MESSAGES }, (_, index) => user(`m${index}`))
            findOne.mockResolvedValue({ messages: [...incoming, server("n1")], version: 1 })
            updateOne.mockResolvedValue({ matchedCount: 1 })

            await saveConversation(userId, projectId, "conversation-1", incoming)

            const saved = updateOne.mock.calls[0][1].$set.messages as { id: string }[]
            expect(saved).toHaveLength(MAX_STORED_MESSAGES)
            expect(saved.at(-1)?.id).toBe("n1")
            expect(saved[0].id).toBe("m1")
        })

        it("Given a conversation opening with a note of the server, when titled, then the title is the user's first question", async () => {
            await saveConversation(userId, projectId, "conversation-1", [server("<agent_update>"), user("Why did the build fail?")])

            expect(updateOne.mock.calls[0][1].$set.title).toBe("Why did the build fail?")
        })

        it("Given messages of the server, when appended, then they are marked as the server's and the oldest are dropped past what is kept", async () => {
            await appendMessages("conversation-1", [{ id: "n1", role: "user", content: "<agent_update>…</agent_update>", kind: "agent_update" }])

            const [filter, update] = updateOne.mock.calls[0]
            expect(filter).toEqual({ _id: "conversation-1", deletedAt: null })
            expect(update.$push.messages).toEqual({ $each: [{ id: "n1", role: "user", content: "<agent_update>…</agent_update>", kind: "agent_update", origin: "server" }], $slice: -40 })
            expect(update.$inc).toEqual({ version: 1 })
        })

        it("Given a browser sending a kind or an origin this server does not know, when stored, then they are dropped", () => {
            const stored = toStoredMessage({ id: "m1", role: "user", content: "Hi", origin: "browser", kind: "other" } as never)

            expect(stored).not.toHaveProperty("origin")
            expect(stored).not.toHaveProperty("kind")
        })
    })

    describe("turns", () => {
        it("Given a free conversation, when a question takes it, then the lease is set, the question marked, and the lease returned", async () => {
            const lease = await claimTurn(userId, projectId, "conversation-1", { asked: true })

            const [filter, update, options] = findOneAndUpdate.mock.calls[0]
            expect(filter).toMatchObject({ _id: "conversation-1", userId, deletedAt: null })
            expect(filter.$or).toEqual([{ turnUntil: null }, { turnUntil: { $lte: expect.any(Date) } }])
            expect(update.$set).toEqual({ turnUntil: lease, savePendingSince: expect.any(Date), askedAt: expect.any(Date), updateTurns: 0 })
            expect(options).toMatchObject({ upsert: true })
        })

        it("Given a question asked of an AI, when it takes the conversation, then the AI is kept for the update turns", async () => {
            await claimTurn(userId, projectId, "conversation-1", { asked: true, aiModelId: "model-1" })

            expect(findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ aiModelId: "model-1", updateTurns: 0 })
        })

        it("Given a confirmation answered, when it takes the conversation, then the question time is left alone", async () => {
            await claimTurn(userId, projectId, "conversation-1")

            expect(findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty("askedAt")
            expect(findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty("updateTurns")
        })

        it("Given a conversation another turn holds, when a question takes it, then it gets no lease", async () => {
            findOneAndUpdate.mockRejectedValue(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }))
            exists.mockResolvedValue({ _id: "conversation-1" })

            await expect(claimTurn(userId, projectId, "conversation-1")).resolves.toBeUndefined()
            // Once more first: the browser's first save may have inserted it at the same moment.
            expect(findOneAndUpdate).toHaveBeenCalledTimes(2)
        })

        it("Given a conversation of someone else, when a question takes it, then it is not found", async () => {
            findOneAndUpdate.mockRejectedValue(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }))

            await expect(claimTurn(userId, projectId, "conversation-1")).rejects.toMatchObject({ statusCode: 404 })
        })

        it("Given a turn of the user, when its answer is saved, then the conversation is marked saved; not on the save of the question before it streams", async () => {
            const question = { id: "m1", role: "user" as const, content: "Fix the build" }

            await saveConversation(userId, projectId, "conversation-1", [question, { id: "m2", role: "assistant", content: "", status: "streaming" }])
            await saveConversation(userId, projectId, "conversation-1", [question, { id: "m2", role: "assistant", content: "Started an agent.", status: "done" }])

            expect(updateOne.mock.calls[0][1]).not.toHaveProperty("$unset")
            expect(updateOne.mock.calls[1][1].$unset).toEqual({ savePendingSince: 1 })
        })

        it("Given a turn of the user the browser has yet to save, when the server takes the conversation, then it may only once the grace is over", async () => {
            await claimServerTurn("conversation-1")

            const [filter] = findOneAndUpdate.mock.calls[0]
            const [, saved] = filter.$and
            expect(saved.$or[0]).toEqual({ savePendingSince: null })
            expect(Date.now() - saved.$or[1].savePendingSince.$lte.getTime()).toBeGreaterThanOrEqual(SAVE_GRACE_MS)
        })

        it("Given a lease, when released, then only that very lease is freed", async () => {
            const lease = new Date("2026-10-31T10:15:00Z")

            await releaseTurn("conversation-1", lease)

            expect(updateOne).toHaveBeenCalledWith({ _id: "conversation-1", turnUntil: lease }, { $unset: { turnUntil: 1 } })
        })
    })

    describe("holding a turn", () => {
        afterEach(() => {
            vi.useRealTimers()
        })

        it("Given the lease held, when renewed, then it is extended, guarded on the lease held", async () => {
            const lease = new Date("2026-10-31T10:03:00Z")

            const renewed = await renewTurn("conversation-1", lease)

            expect(findOneAndUpdate).toHaveBeenCalledWith({ _id: "conversation-1", turnUntil: lease }, { $set: { turnUntil: renewed } }, { projection: { _id: 1 } })
            expect(renewed?.getTime()).toBeGreaterThan(Date.now())
        })

        it("Given a lease run out and taken by another turn, when renewed, then it is lost", async () => {
            findOneAndUpdate.mockResolvedValue(null)

            await expect(renewTurn("conversation-1", new Date())).resolves.toBeUndefined()
        })

        it("Given a turn running, when the heartbeat beats, then the lease is renewed each time, and the turn stopped once it cannot be", async () => {
            vi.useFakeTimers()
            const onLost = vi.fn()
            const held = holdTurn("conversation-1", new Date(), onLost)

            await vi.advanceTimersByTimeAsync(TURN_HEARTBEAT_MS)
            await vi.advanceTimersByTimeAsync(TURN_HEARTBEAT_MS)
            expect(findOneAndUpdate).toHaveBeenCalledTimes(2)
            // The second renewal is guarded on the lease the first one returned.
            expect(findOneAndUpdate.mock.calls[1][0].turnUntil).toEqual(findOneAndUpdate.mock.calls[0][1].$set.turnUntil)
            expect(onLost).not.toHaveBeenCalled()

            findOneAndUpdate.mockResolvedValue(null)
            await vi.advanceTimersByTimeAsync(TURN_HEARTBEAT_MS)
            expect(onLost).toHaveBeenCalledTimes(1)
            await expect(held.renew()).resolves.toBe(false)
            await vi.advanceTimersByTimeAsync(TURN_HEARTBEAT_MS * 3)
            expect(findOneAndUpdate).toHaveBeenCalledTimes(3)
            held.stop()
        })

        it("Given the update turns since the last question, when one more is counted, then it is refused at the cap", async () => {
            findOneAndUpdate.mockResolvedValueOnce({ _id: "conversation-1" }).mockResolvedValueOnce(null)

            await expect(countUpdateTurn("conversation-1", 5)).resolves.toBe(true)
            await expect(countUpdateTurn("conversation-1", 5)).resolves.toBe(false)
            expect(findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: "conversation-1", $or: [{ updateTurns: null }, { updateTurns: { $lt: 5 } }] })
        })
    })
})
