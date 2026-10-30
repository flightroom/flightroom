import mongoose from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isReplicaSet, onConnected } from "./noSQL"

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

/** The connection answering `hello` with `answer`, or failing with it when it is an error */
const connectedTo = (answer: object) => {
    const command = answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue(answer)
    Object.assign(mongoose.connection, { db: { admin: () => ({ command }) } })
}

afterEach(() => {
    Object.assign(mongoose.connection, { db: undefined })
})

describe("onConnected", () => {
    it("Given a replica set, when the database connects, then it is recorded and the plugin is done without an error", async () => {
        connectedTo({ setName: "rs0" })
        const done = vi.fn()

        await onConnected(log, done)

        expect(isReplicaSet).toBe(true)
        expect(done).toHaveBeenCalledWith()
    })

    it("Given a standalone database, when the database connects, then it is recorded and the plugin is done without an error", async () => {
        connectedTo({})
        const done = vi.fn()

        await onConnected(log, done)

        expect(isReplicaSet).toBe(false)
        expect(done).toHaveBeenCalledWith()
    })

    it("Given the replica set check fails, when the database connects, then the plugin is still done without an error", async () => {
        connectedTo(new Error("hello refused"))
        const done = vi.fn()

        await onConnected(log, done)

        expect(done).toHaveBeenCalledTimes(1)
        expect(done).toHaveBeenCalledWith()
    })

    it("Given no admin database, when the database connects, then the plugin is still done without an error", async () => {
        const done = vi.fn()

        await onConnected(log, done)

        expect(done).toHaveBeenCalledWith()
    })
})
