import { isValidObjectId } from "mongoose"
import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { CommandSandbox } from "../sandbox/commandSandbox"
import { ConversationState, OpenShellConfiguration, openShellSandboxes } from "../sandbox/OpenShellSandboxes"

/**
 * The sandbox of a job: the one of its conversation, the chain of jobs from the same first one, so
 * that the next message finds its dependencies installed. Undefined without a gateway.
 */
export const sandboxForJob = (config: OpenShellConfiguration, job: Pick<IAiChangeJob, "rootJobId">): (() => Promise<CommandSandbox>) | undefined => {
    const sandboxes = openShellSandboxes(config)
    return sandboxes ? () => sandboxes.acquire(job.rootJobId.toString()) : undefined
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
    return sandboxes ? sandboxes.sweep(conversationState(sandboxes.idleMs)) : 0
}
