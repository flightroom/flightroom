import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AiChangeJob from "../../models/AiChangeJobModel"
import AiChangeRequest from "../../models/AiChangeRequestModel"
import { LiveJobOutput } from "./aiJobRecords"

const jobId = new Types.ObjectId()

describe("LiveJobOutput", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(AiChangeJob, "updateOne").mockResolvedValue({} as never)
        vi.spyOn(AiChangeRequest, "updateMany").mockResolvedValue({} as never)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    const updates = () => vi.mocked(AiChangeJob.updateOne).mock.calls.map(call => call[1])

    it("Given a script printing, when a while passes, then the job and its requests show its output so far, without colours and masked", async () => {
        const live = new LiveJobOutput(String(jobId))
        live.add("\x1b[32madded 12 packages\x1b[0m\n")
        live.add("npm_abcdefghijklmnopqrstuvwxyz0123456789\n")
        await vi.advanceTimersByTimeAsync(2_000)

        expect(updates()).toHaveLength(1)
        const shown = (updates()[0] as { $set: { liveOutput: string } }).$set.liveOutput
        expect(shown.startsWith("added 12 packages\n")).toBe(true)
        expect(shown).not.toContain("npm_abcdefghijklmnopqrstuvwxyz0123456789")
        expect(vi.mocked(AiChangeRequest.updateMany).mock.calls.map(call => call[1])).toEqual(updates())
    })

    it("Given output shown, when the next event comes, then it is unset after the write it follows", async () => {
        const live = new LiveJobOutput(String(jobId))
        live.add("added 12 packages\n")
        await vi.advanceTimersByTimeAsync(2_000)
        await live.end()

        expect(updates()).toEqual([{ $set: { liveOutput: "added 12 packages\n" } }, { $unset: { liveOutput: 1 } }])
    })

    it("Given a script ending before the first write, then nothing is written", async () => {
        const live = new LiveJobOutput(String(jobId))
        live.add("done\n")
        await live.end()
        await vi.advanceTimersByTimeAsync(5_000)

        expect(updates()).toEqual([])
    })

    it("Given a write failing, then the agent goes on: the failure is only logged", async () => {
        vi.mocked(AiChangeJob.updateOne).mockRejectedValue(new Error("mongo down"))
        const live = new LiveJobOutput(String(jobId))
        live.add("added 12 packages\n")
        await vi.advanceTimersByTimeAsync(2_000)

        await expect(live.end()).resolves.toBeUndefined()
    })
})
