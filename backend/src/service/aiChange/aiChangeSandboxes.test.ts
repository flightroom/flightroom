import { beforeEach, describe, expect, it, vi } from "vitest"
import AiChangeJob, { AiJobStatus } from "../../models/AiChangeJobModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { conversationState } from "./aiChangeSandboxes"

vi.mock("../../models/AiChangeJobModel", async importOriginal => {
    const original = await importOriginal<typeof import("../../models/AiChangeJobModel")>()
    return { ...original, default: { exists: vi.fn() } }
})

vi.mock("../../models/StandalonePreviewSessionModel", async importOriginal => {
    const original = await importOriginal<typeof import("../../models/StandalonePreviewSessionModel")>()
    return { ...original, default: { exists: vi.fn() } }
})

const CONVERSATION = "65f1a2b3c4d5e6f708192a3b"

describe("conversationState", () => {
    beforeEach(() => vi.clearAllMocks())

    it("Given a conversation, then it is busy while one of its jobs waits, runs or ended within the idle time", async () => {
        vi.mocked(AiChangeJob.exists).mockResolvedValue({ _id: "job" } as never)
        const now = Date.parse("2026-10-24T10:00:00Z")

        expect(await conversationState(5 * 60_000, () => now)(CONVERSATION)).toBe("busy")

        const [filter] = vi.mocked(AiChangeJob.exists).mock.calls[0] as unknown as [Record<string, unknown>]
        expect(String(filter.rootJobId)).toBe(CONVERSATION)
        expect(filter.$or).toEqual([{ status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] } }, { updatedAt: { $gt: new Date("2026-10-24T09:55:00Z") } }])
    })

    it("Given a conversation of this database none of whose jobs is active, then it is idle", async () => {
        vi.mocked(AiChangeJob.exists).mockImplementation(((filter: Record<string, unknown>) => Promise.resolve("$or" in filter ? null : { _id: "job" })) as never)
        vi.mocked(StandalonePreviewSession.exists).mockResolvedValue(null)
        expect(await conversationState(5 * 60_000)(CONVERSATION)).toBe("idle")
    })

    it("Given a conversation this database has no job nor preview session of, then it is unknown", async () => {
        vi.mocked(AiChangeJob.exists).mockResolvedValue(null)
        vi.mocked(StandalonePreviewSession.exists).mockResolvedValue(null)
        expect(await conversationState(5 * 60_000)(CONVERSATION)).toBe("unknown")
    })

    it("Given a live standalone preview session, then its sandbox is kept until the session expires", async () => {
        vi.mocked(AiChangeJob.exists).mockResolvedValue(null)
        vi.mocked(StandalonePreviewSession.exists).mockResolvedValue({ _id: CONVERSATION } as never)

        expect(await conversationState(5 * 60_000)(CONVERSATION)).toBe("busy")
        expect(StandalonePreviewSession.exists).toHaveBeenCalledWith({
            _id: expect.objectContaining({ toString: expect.any(Function) }),
            expiresAt: { $gt: expect.any(Date) }
        })
    })

    it("Given a label that is no conversation id, then it is unknown without asking the database", async () => {
        expect(await conversationState(5 * 60_000)("not-an-id")).toBe("unknown")
        expect(AiChangeJob.exists).not.toHaveBeenCalled()
    })
})
