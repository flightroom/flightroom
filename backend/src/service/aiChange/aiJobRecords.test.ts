import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AiChangeJob from "../../models/AiChangeJobModel"
import { LiveJobOutput } from "./aiJobRecords"

const jobId = new Types.ObjectId()

describe("LiveJobOutput", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(AiChangeJob, "updateOne").mockResolvedValue({} as never)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    const updates = () => vi.mocked(AiChangeJob.updateOne).mock.calls.map(call => call[1])

    it("Given a script printing, when a while passes, then the job shows its output so far, without colours and masked", async () => {
        const live = new LiveJobOutput(String(jobId))
        live.add("\x1b[32madded 12 packages\x1b[0m\n")
        live.add("npm_abcdefghijklmnopqrstuvwxyz0123456789\n")
        await vi.advanceTimersByTimeAsync(2_000)

        expect(updates()).toHaveLength(1)
        const shown = (updates()[0] as { $set: { liveOutput: string } }).$set.liveOutput
        expect(shown.startsWith("added 12 packages\n")).toBe(true)
        expect(shown).not.toContain("npm_abcdefghijklmnopqrstuvwxyz0123456789")
    })

    it("Given output shown, when the next event comes, then it is unset after the write it follows", async () => {
        const live = new LiveJobOutput(String(jobId))
        live.add("added 12 packages\n")
        await vi.advanceTimersByTimeAsync(2_000)
        await live.end()

        expect(updates()).toEqual([{ $set: { liveOutput: "added 12 packages" } }, { $unset: { liveOutput: 1 } }])
    })

    it("Given the database slow, when the output keeps coming, then only the newest of the writes waiting is made", async () => {
        let release: () => void = () => undefined
        vi.mocked(AiChangeJob.updateOne).mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    release = () => resolve({} as never)
                }) as never
        )
        const live = new LiveJobOutput(String(jobId))
        for (const line of ["one\n", "two\n", "three\n"]) {
            live.add(line)
            await vi.advanceTimersByTimeAsync(2_000)
        }
        release()
        await vi.advanceTimersByTimeAsync(0)
        await live.end()

        expect(updates()).toEqual([{ $set: { liveOutput: "one" } }, { $set: { liveOutput: "one\ntwo\nthree" } }, { $unset: { liveOutput: 1 } }])
    })

    it("Given a script ending before the first write, then nothing is written", async () => {
        const live = new LiveJobOutput(String(jobId))
        live.add("done\n")
        await live.end()
        await vi.advanceTimersByTimeAsync(5_000)

        expect(updates()).toEqual([])
    })

    it("Given more output than is shown, then a secret starting before the shown end is still masked, and the cut line left out", async () => {
        const live = new LiveJobOutput(String(jobId))
        live.add(`NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789${"x".repeat(100)}\n`)
        live.add("added 1 package\n".repeat(300))
        await vi.advanceTimersByTimeAsync(2_000)

        const shown = (updates()[0] as { $set: { liveOutput: string } }).$set.liveOutput
        expect(shown.length).toBeLessThanOrEqual(4_000)
        expect(shown.startsWith("added 1 package\n")).toBe(true)
        expect(shown).not.toContain("abcdefghijklmnopqrstuvwxyz")
    })

    it("Given a write failing, then the agent goes on: the failure is only logged", async () => {
        vi.mocked(AiChangeJob.updateOne).mockRejectedValue(new Error("mongo down"))
        const live = new LiveJobOutput(String(jobId))
        live.add("added 12 packages\n")
        await vi.advanceTimersByTimeAsync(2_000)

        await expect(live.end()).resolves.toBeUndefined()
    })
})
