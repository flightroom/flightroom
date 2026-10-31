import { afterEach, describe, expect, it, vi } from "vitest"
import { createPendingAction, hasPendingAction, PENDING_ACTION_TTL_MS, takePendingAction, UPDATE_ACTION_TTL_MS } from "./pendingActions"

const redis = vi.hoisted(() => ({ client: undefined as unknown }))

vi.mock("../../plugins/redis", () => ({
    get redisClient() {
        return redis.client
    }
}))

const parked = () => createPendingAction({ userId: "user-1", projectId: "project-1", tool: "environment_delete", args: { environmentId: "env-1" }, callId: "call-1" })

describe("pending assistant actions", () => {
    afterEach(() => {
        vi.useRealTimers()
        redis.client = undefined
    })

    it("Given a parked action, when it is created, then its id is long and random and it expires in 15 minutes", async () => {
        const first = await parked()
        const second = await parked()

        expect(first.id).not.toBe(second.id)
        expect(first.id.length).toBeGreaterThanOrEqual(32)
        expect(first.expiresAt - first.createdAt).toBe(PENDING_ACTION_TTL_MS)
    })

    it("Given a parked action, when it is taken twice, then the second take fails: it is single use", async () => {
        const action = await parked()

        await expect(takePendingAction(action.id, "user-1", "project-1")).resolves.toMatchObject({ tool: "environment_delete", callId: "call-1", args: { environmentId: "env-1" } })
        await expect(takePendingAction(action.id, "user-1", "project-1")).rejects.toMatchObject({ code: "ASSISTANT_ACTION_NOT_FOUND", statusCode: 409 })
    })

    it("Given an action of another user or project, when taken, then it is refused and stays available to its owner", async () => {
        const action = await parked()

        await expect(takePendingAction(action.id, "user-2", "project-1")).rejects.toMatchObject({ code: "ASSISTANT_ACTION_NOT_FOUND" })
        await expect(takePendingAction(action.id, "user-1", "project-2")).rejects.toMatchObject({ code: "ASSISTANT_ACTION_NOT_FOUND" })
        await expect(takePendingAction(action.id, "user-1", "project-1")).resolves.toMatchObject({ id: action.id })
    })

    it("Given an action older than 15 minutes, when taken, then it has expired", async () => {
        vi.useFakeTimers()
        const action = await parked()
        vi.advanceTimersByTime(PENDING_ACTION_TTL_MS + 1)

        await expect(takePendingAction(action.id, "user-1", "project-1")).rejects.toMatchObject({ code: "ASSISTANT_ACTION_NOT_FOUND" })
    })

    it("Given Redis, when an action is parked and taken, then it is stored with its TTL under a key bound to user and project, and taken atomically", async () => {
        const store = new Map<string, string>()
        const set = vi.fn(async (key: string, value: string) => {
            store.set(key, value)
            return "OK"
        })
        const evalScript = vi.fn(async (_script: string, { keys }: { keys: string[] }) => {
            const value = store.get(keys[0]) ?? null
            store.delete(keys[0])
            return value
        })
        redis.client = { isOpen: true, set, eval: evalScript, sAdd: vi.fn(), pExpire: vi.fn() }

        const action = await parked()

        expect(set).toHaveBeenCalledWith(`assistant-action:user-1:project-1:${action.id}`, expect.any(String), { PX: PENDING_ACTION_TTL_MS })
        await expect(takePendingAction(action.id, "user-2", "project-1")).rejects.toMatchObject({ code: "ASSISTANT_ACTION_NOT_FOUND" })
        await expect(takePendingAction(action.id, "user-1", "project-1")).resolves.toMatchObject({ id: action.id, tool: "environment_delete" })
        await expect(takePendingAction(action.id, "user-1", "project-1")).rejects.toMatchObject({ code: "ASSISTANT_ACTION_NOT_FOUND" })
        expect(evalScript.mock.calls[0][0]).toContain("del")
    })

    describe("an action waiting in a conversation", () => {
        const inConversation = (conversationId: string, ttlMs?: number) =>
            createPendingAction({ userId: "user-1", projectId: "project-1", tool: "agent_run_apply", args: {}, callId: "call-1", conversationId }, ttlMs)

        it("Given an action parked in a conversation, when asked, then it waits there until it is taken, and in no other conversation", async () => {
            const action = await inConversation("conversation-1")

            await expect(hasPendingAction("user-1", "project-1", "conversation-1")).resolves.toBe(true)
            await expect(hasPendingAction("user-1", "project-1", "conversation-2")).resolves.toBe(false)
            await expect(hasPendingAction("user-2", "project-1", "conversation-1")).resolves.toBe(false)
            await takePendingAction(action.id, "user-1", "project-1", "conversation-1")
            await expect(hasPendingAction("user-1", "project-1", "conversation-1")).resolves.toBe(false)
        })

        it("Given an action of a conversation, when answered from another one, then it is refused", async () => {
            const action = await inConversation("conversation-1")

            await expect(takePendingAction(action.id, "user-1", "project-1", "conversation-2")).rejects.toMatchObject({ code: "ASSISTANT_ACTION_NOT_FOUND" })
        })

        it("Given Redis configured but down, when asked whether an action waits, then it is taken to wait: no update turn runs blind", async () => {
            redis.client = { isOpen: false }

            await expect(hasPendingAction("user-9", "project-9", "conversation-9")).resolves.toBe(true)
        })

        it("Given an action parked by an update turn, when it waits, then it waits a day, not 15 minutes", async () => {
            vi.useFakeTimers()
            const action = await inConversation("conversation-1", UPDATE_ACTION_TTL_MS)
            vi.advanceTimersByTime(PENDING_ACTION_TTL_MS + 1)

            expect(action.expiresAt - action.createdAt).toBe(UPDATE_ACTION_TTL_MS)
            await expect(hasPendingAction("user-1", "project-1", "conversation-1")).resolves.toBe(true)
            await takePendingAction(action.id, "user-1", "project-1", "conversation-1")
        })

        it("Given Redis, when an action waits in a conversation, then it is found through the index of the user and project, which drops what is gone", async () => {
            const store = new Map<string, string>()
            const index = new Set<string>()
            redis.client = {
                isOpen: true,
                set: vi.fn(async (key: string, value: string) => store.set(key, value)),
                get: vi.fn(async (key: string) => store.get(key) ?? null),
                sAdd: vi.fn(async (_key: string, id: string) => index.add(id)),
                sMembers: vi.fn(async () => [...index]),
                sRem: vi.fn(async (_key: string, id: string) => index.delete(id)),
                pExpire: vi.fn()
            }
            const action = await inConversation("conversation-1")

            await expect(hasPendingAction("user-1", "project-1", "conversation-1")).resolves.toBe(true)
            store.clear()
            await expect(hasPendingAction("user-1", "project-1", "conversation-1")).resolves.toBe(false)
            expect(index.has(action.id)).toBe(false)
        })
    })
})
