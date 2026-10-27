import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"

const { log } = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("..", () => ({ fastify: { log, config: {} } }))

import User from "../models/UserModel"
import { AWAY_AFTER_MS, isAway, PRESENCE_WRITE_MS, recordPresence } from "./UserService"

const now = new Date("2026-10-27T12:00:00Z")
const ago = (ms: number) => new Date(now.getTime() - ms)
const userId = new Types.ObjectId()

afterEach(() => {
    vi.restoreAllMocks()
})

describe("recordPresence", () => {
    it("given a user seen more than a minute ago, when they make a request, then the moment is stored without touching updatedAt", async () => {
        const updateOne = vi.spyOn(User, "updateOne").mockResolvedValue({} as never)
        await recordPresence({ _id: userId as never, lastSeenAt: ago(PRESENCE_WRITE_MS) }, now)

        expect(updateOne).toHaveBeenCalledWith({ _id: userId }, { lastSeenAt: now }, { timestamps: false })
    })

    it("given a user seen a few seconds ago, when they make a request, then nothing is written", async () => {
        const updateOne = vi.spyOn(User, "updateOne").mockResolvedValue({} as never)
        await recordPresence({ _id: userId as never, lastSeenAt: ago(5000) }, now)

        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given the write fails, when a request records the presence, then the request does not fail", async () => {
        vi.spyOn(User, "updateOne").mockRejectedValue(new Error("timeout"))

        await expect(recordPresence({ _id: userId as never }, now)).resolves.toBeUndefined()
        expect(log.warn).toHaveBeenCalled()
    })
})

describe("isAway", () => {
    it.each([
        ["never seen", undefined, true],
        ["seen a minute ago", ago(60 * 1000), false],
        ["silent for the away delay", ago(AWAY_AFTER_MS), true]
    ])("given a user %s, then whether they are away follows", (_, lastSeenAt, away) => {
        expect(isAway({ lastSeenAt }, now)).toBe(away)
    })
})
