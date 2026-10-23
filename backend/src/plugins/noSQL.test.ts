import { beforeEach, describe, expect, it, vi } from "vitest"

const { runMigrations } = vi.hoisted(() => ({ runMigrations: vi.fn() }))
vi.mock("../utils/migrations", () => ({ runMigrations }))

import { onConnected } from "./noSQL"

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

describe("onConnected", () => {
    beforeEach(() => {
        runMigrations.mockReset()
    })

    it("Given the migrations succeed, when the database connects, then the plugin is done without an error", async () => {
        runMigrations.mockResolvedValue(undefined)
        const done = vi.fn()

        await onConnected(log, done)

        expect(done).toHaveBeenCalledWith()
    })

    it("Given a migration fails, when the database connects, then the plugin is done with its error and the application does not start", async () => {
        const failure = new Error("rename refused")
        runMigrations.mockRejectedValue(failure)
        const done = vi.fn()

        await onConnected(log, done)

        expect(done).toHaveBeenCalledTimes(1)
        expect(done).toHaveBeenCalledWith(failure)
    })
})
