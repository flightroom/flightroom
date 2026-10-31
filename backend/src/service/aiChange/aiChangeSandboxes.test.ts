import { Types } from "mongoose"
import { beforeEach, describe, expect, it, vi } from "vitest"

const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock("../..", () => ({ fastify: { log } }))
vi.mock("../SandboxUsageService", () => ({ recordSandboxUsage: vi.fn(), openSandboxLifetime: vi.fn(), closeSandboxLifetime: vi.fn() }))

import AiChangeJob, { AiJobStatus } from "../../models/AiChangeJobModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { closeSandboxLifetime, openSandboxLifetime, recordSandboxUsage } from "../SandboxUsageService"
import { conversationState, jobSandboxOwner, sandboxExecRecorder, sandboxLifecycle } from "./aiChangeSandboxes"

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

describe("the sandbox ledger of a job", () => {
    beforeEach(() => vi.clearAllMocks())

    const job = {
        _id: new Types.ObjectId(),
        rootJobId: new Types.ObjectId(CONVERSATION),
        projectId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        domainId: new Types.ObjectId(),
        frontendIds: [new Types.ObjectId()],
        backendIds: []
    }
    const organizationId = new Types.ObjectId()

    it("Given a job, then its sandbox time is counted against its organization, project, user, domain and repositories, a job of a mission as the mission's", () => {
        expect(jobSandboxOwner(job as never, organizationId)).toEqual({
            organizationId,
            projectId: job.projectId,
            userId: job.userId,
            source: "agent",
            jobId: job._id,
            domainId: job.domainId,
            frontendIds: job.frontendIds,
            backendIds: []
        })
        expect(jobSandboxOwner({ ...job, missionId: new Types.ObjectId() } as never, organizationId).source).toBe("mission")
    })

    it("Given a command run in the sandbox, then one command and its seconds are recorded against the conversation of the job", async () => {
        const owner = jobSandboxOwner(job as never, organizationId)

        await sandboxExecRecorder(job as never, owner)({ seconds: 12.5 })

        expect(recordSandboxUsage).toHaveBeenCalledWith({ ...owner, conversationId: CONVERSATION, commands: 1, execSeconds: 12.5 })
    })

    it("Given a ledger that cannot be written, when a command or a lifetime is recorded, then it is logged and nothing throws", async () => {
        vi.mocked(recordSandboxUsage).mockRejectedValue(new Error("mongo down"))
        vi.mocked(openSandboxLifetime).mockRejectedValue(new Error("mongo down"))
        const owner = jobSandboxOwner(job as never, organizationId)

        await expect(sandboxExecRecorder(job as never, owner)({ seconds: 1 })).resolves.toBeUndefined()
        await expect(sandboxLifecycle(owner).created?.(CONVERSATION, "sandbox-1")).resolves.toBeUndefined()

        expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONVERSATION }), "Sandbox command not recorded")
        expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONVERSATION }), "Sandbox lifetime not recorded")
    })

    it("Given a sandbox created then deleted, then its lifetime is opened against the owner and closed by its conversation", async () => {
        const owner = jobSandboxOwner(job as never, organizationId)
        const lifecycle = sandboxLifecycle(owner)

        await lifecycle.created?.(CONVERSATION, "sandbox-1")
        await lifecycle.deleted?.(CONVERSATION, "sandbox-1")

        expect(openSandboxLifetime).toHaveBeenCalledWith(CONVERSATION, "sandbox-1", owner)
        expect(closeSandboxLifetime).toHaveBeenCalledWith(CONVERSATION, "sandbox-1")
    })
})
