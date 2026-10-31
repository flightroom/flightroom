import { isValidObjectId } from "mongoose"
import { fastify } from "../.."
import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { closeSandboxLifetime, openSandboxLifetime, recordSandboxUsage, SandboxOwner } from "../SandboxUsageService"
import { CommandSandbox } from "../sandbox/commandSandbox"
import { ConversationState, OpenShellConfiguration, openShellSandboxes, SandboxLifecycle } from "../sandbox/OpenShellSandboxes"
import { SandboxExec } from "./aiChangeScripts"
import { loggable } from "./aiChangeShared"

/** A usage that cannot be recorded is logged, never thrown: it must not stop a job, a preview or the sweep. */
const logged = async (what: string, conversationId: string, record: () => Promise<void>) => {
    try {
        await record()
    } catch (error) {
        fastify.log.error({ error: loggable(error), conversationId }, `Sandbox ${what} not recorded`)
    }
}

/** The lifetime of the sandboxes of a conversation, counted against `owner`: who created it, a job or a preview. */
export const sandboxLifecycle = (owner: SandboxOwner): SandboxLifecycle => ({
    created: (conversationId, sandboxId) => logged("lifetime", conversationId, () => openSandboxLifetime(conversationId, sandboxId, owner)),
    deleted: (conversationId, sandboxId) => logged("lifetime", conversationId, () => closeSandboxLifetime(conversationId, sandboxId))
})

/** Who the sandbox time of a job is counted against: what its tokens are, a job of a mission apart. */
export const jobSandboxOwner = (
    job: Pick<IAiChangeJob, "_id" | "projectId" | "userId" | "missionId" | "domainId" | "frontendIds" | "backendIds">,
    organizationId?: SandboxOwner["organizationId"]
): SandboxOwner => ({
    organizationId,
    projectId: job.projectId,
    userId: job.userId,
    source: job.missionId ? "mission" : "agent",
    jobId: job._id,
    domainId: job.domainId,
    frontendIds: job.frontendIds,
    backendIds: job.backendIds
})

/**
 * The sandbox of a job: the one of its conversation, the chain of jobs from the same first one, so
 * that the next message finds its dependencies installed. Undefined without a gateway. Its lifetime
 * is counted against `owner` when this job is the one that creates it.
 */
export const sandboxForJob = (config: OpenShellConfiguration, job: Pick<IAiChangeJob, "rootJobId">, owner: SandboxOwner): (() => Promise<CommandSandbox>) | undefined => {
    const sandboxes = openShellSandboxes(config)
    return sandboxes ? () => sandboxes.acquire(job.rootJobId.toString(), sandboxLifecycle(owner)) : undefined
}

/** Records the time of each script and command a job runs in the sandbox of its conversation. */
export const sandboxExecRecorder =
    (job: Pick<IAiChangeJob, "rootJobId">, owner: SandboxOwner) =>
    (exec: SandboxExec): Promise<void> => {
        const conversationId = job.rootJobId.toString()
        return logged("command", conversationId, () => recordSandboxUsage({ ...owner, conversationId, commands: 1, execSeconds: exec.seconds }))
    }

/**
 * Whether somebody still uses the sandbox: busy while one of its jobs waits or runs, or the last job
 * or standalone preview session has not expired. Idle once they have, unknown when this database has
 * neither: a conversation of another installation, or a preview session already expired and removed.
 * A job that died with its process is declared failed by the missions sweep, and its sandbox goes after it.
 */
export const conversationState =
    (idleMs: number, now = () => Date.now()) =>
    async (conversationId: string): Promise<ConversationState> => {
        if (!isValidObjectId(conversationId)) return "unknown"
        const id = toObjectId(conversationId)
        const checkedAt = new Date(now())
        const [activeJob, activePreview] = await Promise.all([
            AiChangeJob.exists({
                rootJobId: id,
                $or: [{ status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] } }, { updatedAt: { $gt: new Date(checkedAt.getTime() - idleMs) } }]
            }),
            StandalonePreviewSession.exists({ _id: id, expiresAt: { $gt: checkedAt } })
        ])
        if (activeJob || activePreview) return "busy"
        const [job, preview] = await Promise.all([AiChangeJob.exists({ rootJobId: id }), StandalonePreviewSession.exists({ _id: id })])
        return job || preview ? "idle" : "unknown"
    }

/** Deletes the sandboxes of the idle conversations of this installation: how many, 0 without a gateway. */
export const sweepIdleSandboxes = async (config: OpenShellConfiguration): Promise<number> => {
    const sandboxes = openShellSandboxes(config)
    return sandboxes
        ? sandboxes.sweep(conversationState(sandboxes.idleMs), (conversationId, sandboxId) => logged("lifetime", conversationId, () => closeSandboxLifetime(conversationId, sandboxId)))
        : 0
}
