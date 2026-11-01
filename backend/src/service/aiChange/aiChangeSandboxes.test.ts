import { Types } from "mongoose"
import { beforeEach, describe, expect, it, vi } from "vitest"

const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock("../..", () => ({ fastify: { log } }))
vi.mock("../SandboxUsageService", () => ({ recordSandboxUsage: vi.fn(), openSandboxLifetime: vi.fn(), closeSandboxLifetime: vi.fn() }))

const acquire = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ root: "/sandbox/spaces/x", exec: vi.fn() })))
vi.mock("../sandbox/OpenShellSandboxes", async importOriginal => {
    const original = await importOriginal<typeof import("../sandbox/OpenShellSandboxes")>()
    return { ...original, openShellSandboxes: (config: { OPENSHELL_GATEWAY_URL?: string }) => (config.OPENSHELL_GATEWAY_URL ? { acquire } : undefined) }
})

import AiChangeJob, { AiJobStatus } from "../../models/AiChangeJobModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { closeSandboxLifetime, openSandboxLifetime, recordSandboxUsage } from "../SandboxUsageService"
import { conversationState, jobSandboxOwner, sandboxExecRecorder, sandboxForJob, sandboxKeyOf, sandboxLifecycle } from "./aiChangeSandboxes"

vi.mock("../../models/AiChangeJobModel", async importOriginal => {
    const original = await importOriginal<typeof import("../../models/AiChangeJobModel")>()
    return { ...original, default: { exists: vi.fn(), updateOne: vi.fn() } }
})

vi.mock("../../models/StandalonePreviewSessionModel", async importOriginal => {
    const original = await importOriginal<typeof import("../../models/StandalonePreviewSessionModel")>()
    return { ...original, default: { exists: vi.fn() } }
})

const CONVERSATION = "65f1a2b3c4d5e6f708192a3b"

describe("conversationState", () => {
    beforeEach(() => vi.clearAllMocks())

    it("Given a conversation, then it is running while one of its jobs waits or runs, busy while the last ended within the idle time", async () => {
        vi.mocked(AiChangeJob.exists).mockResolvedValue({ _id: "job" } as never)
        vi.mocked(StandalonePreviewSession.exists).mockResolvedValue(null)
        const now = Date.parse("2026-10-24T10:00:00Z")

        expect(await conversationState(5 * 60_000, () => now)(CONVERSATION)).toBe("running")

        const [filter] = vi.mocked(AiChangeJob.exists).mock.calls[0] as unknown as [Record<string, unknown>]
        expect(String(filter.rootJobId)).toBe(CONVERSATION)
        expect(filter.$or).toEqual([{ status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] } }, { updatedAt: { $gt: new Date("2026-10-24T09:55:00Z") } }])

        vi.mocked(AiChangeJob.exists).mockImplementation(((filter: Record<string, unknown>) => Promise.resolve("status" in filter ? null : { _id: "job" })) as never)
        expect(await conversationState(5 * 60_000, () => now)(CONVERSATION)).toBe("busy")
    })

    it("Given the key of a shared sandbox, then it is used by the jobs saved under it, and no preview session is asked about", async () => {
        vi.mocked(AiChangeJob.exists).mockImplementation(((filter: Record<string, unknown>) => Promise.resolve("status" in filter ? null : { _id: "job" })) as never)
        const key = `domain-${CONVERSATION}`

        expect(await conversationState(5 * 60_000)(key)).toBe("busy")

        const [filter] = vi.mocked(AiChangeJob.exists).mock.calls[0] as unknown as [Record<string, unknown>]
        expect(filter.sandboxKey).toBe(key)
        expect(filter).not.toHaveProperty("rootJobId")
        expect(StandalonePreviewSession.exists).not.toHaveBeenCalled()

        vi.mocked(AiChangeJob.exists).mockResolvedValue(null)
        expect(await conversationState(5 * 60_000)(`project-${CONVERSATION}`)).toBe("unknown")
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

        expect(await conversationState(5 * 60_000)(CONVERSATION)).toBe("running")
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

describe("the sandbox of a job", () => {
    beforeEach(() => vi.clearAllMocks())

    const projectId = new Types.ObjectId()
    const domainA = new Types.ObjectId()
    const domainB = new Types.ObjectId()
    const job = { _id: new Types.ObjectId(), rootJobId: new Types.ObjectId(CONVERSATION), projectId }

    it("Given sharing by domain, then a job uses its domain's sandbox, that of the one domain its repositories are in, else its project's", () => {
        expect(sandboxKeyOf("domain", { ...job, domainId: domainA } as never, [{ domainId: domainB }])).toBe(`domain-${domainA}`)
        expect(sandboxKeyOf("domain", job as never, [{ domainId: domainA }, { domainId: domainA }])).toBe(`domain-${domainA}`)
        expect(sandboxKeyOf("domain", job as never, [{ domainId: domainA }, { domainId: domainB }])).toBe(`project-${projectId}`)
        expect(sandboxKeyOf("domain", job as never, [{ domainId: domainA }, {}])).toBe(`project-${projectId}`)
        expect(sandboxKeyOf("domain", job as never, [{}])).toBe(`project-${projectId}`)
        expect(sandboxKeyOf(undefined, job as never, [{ domainId: domainA }])).toBe(`domain-${domainA}`)
    })

    it("Given sharing by conversation, then a job uses its conversation's sandbox", () => {
        expect(sandboxKeyOf("conversation", { ...job, domainId: domainA } as never, [{ domainId: domainA }])).toBe(CONVERSATION)
    })

    it("Given a shared key, when the sandbox is asked for, then the key is saved on the job first and the commands run in the folder of its conversation", async () => {
        const owner = jobSandboxOwner({ ...job, userId: new Types.ObjectId(), frontendIds: [new Types.ObjectId()], backendIds: [] } as never, new Types.ObjectId())
        const key = `domain-${domainA}`

        await sandboxForJob({ OPENSHELL_GATEWAY_URL: "https://gateway" }, job as never, key, owner)?.()

        expect(AiChangeJob.updateOne).toHaveBeenCalledWith({ _id: job._id }, { $set: { sandboxKey: key } })
        expect(vi.mocked(AiChangeJob.updateOne).mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0])
        // The organization goes along: a warm sandbox is handed out only within the organization it last served.
        expect(acquire).toHaveBeenCalledWith(key, expect.any(Object), CONVERSATION, String(owner.organizationId))
    })

    it("Given a shared sandbox, when it is created, then its lifetime counts against its project and domain, not against the job that happened to create it", async () => {
        const owner = jobSandboxOwner({ ...job, userId: new Types.ObjectId(), frontendIds: [new Types.ObjectId()], backendIds: [] } as never, new Types.ObjectId())
        const key = `domain-${domainA}`

        await sandboxForJob({ OPENSHELL_GATEWAY_URL: "https://gateway" }, job as never, key, owner)?.()
        const lifecycle = acquire.mock.calls[0][1] as { created: (conversation: string, id: string) => Promise<void> }
        await lifecycle.created(key, "sandbox-1")

        expect(openSandboxLifetime).toHaveBeenCalledWith(key, "sandbox-1", { organizationId: owner.organizationId, projectId, source: "agent", domainId: String(domainA) })
    })

    it("Given no gateway, then a job has no sandbox", () => {
        expect(sandboxForJob({}, job as never, CONVERSATION, { projectId, source: "agent" })).toBeUndefined()
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
