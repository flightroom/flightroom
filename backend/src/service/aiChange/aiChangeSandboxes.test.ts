import { beforeEach, describe, expect, it, vi } from "vitest"
import AiChangeJob, { AiJobStatus } from "../../models/AiChangeJobModel"
import { conversationIsIdle } from "./aiChangeSandboxes"

vi.mock("../../models/AiChangeJobModel", async importOriginal => {
    const original = await importOriginal<typeof import("../../models/AiChangeJobModel")>()
    return { ...original, default: { exists: vi.fn() } }
})

const CONVERSATION = "65f1a2b3c4d5e6f708192a3b"

describe("conversationIsIdle", () => {
    beforeEach(() => vi.clearAllMocks())

    it("Given a conversation, then it is busy while one of its jobs waits, runs or ended within the idle time", async () => {
        vi.mocked(AiChangeJob.exists).mockResolvedValue({ _id: "job" } as never)
        const now = Date.parse("2026-10-24T10:00:00Z")

        expect(await conversationIsIdle(5 * 60_000, () => now)(CONVERSATION)).toBe(false)

        const [filter] = vi.mocked(AiChangeJob.exists).mock.calls[0] as unknown as [Record<string, unknown>]
        expect(String(filter.rootJobId)).toBe(CONVERSATION)
        expect(filter.$or).toEqual([{ status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] } }, { updatedAt: { $gt: new Date("2026-10-24T09:55:00Z") } }])
    })

    it("Given a conversation none of whose jobs is active, then it is idle", async () => {
        vi.mocked(AiChangeJob.exists).mockResolvedValue(null)
        expect(await conversationIsIdle(5 * 60_000)(CONVERSATION)).toBe(true)
    })

    it("Given a label that is no conversation id, then its sandbox is idle without asking the database", async () => {
        expect(await conversationIsIdle(5 * 60_000)("not-an-id")).toBe(true)
        expect(AiChangeJob.exists).not.toHaveBeenCalled()
    })
})
