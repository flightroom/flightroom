import { isValidObjectId } from "mongoose"
import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { CommandSandbox } from "../sandbox/commandSandbox"
import { OpenShellConfiguration, openShellSandboxes } from "../sandbox/OpenShellSandboxes"

/**
 * The sandbox of a job: the one of its conversation, the chain of jobs from the same first one, so
 * that the next message finds its dependencies installed. Undefined without a gateway.
 */
export const sandboxForJob = (config: OpenShellConfiguration, job: Pick<IAiChangeJob, "rootJobId">): (() => Promise<CommandSandbox>) | undefined => {
    const sandboxes = openShellSandboxes(config)
    return sandboxes ? () => sandboxes.acquire(job.rootJobId.toString()) : undefined
}

/**
 * Whether nobody uses the sandbox any more: none of its jobs waits or runs, and the last job or
 * standalone preview session has expired. A job that died with its process is declared failed by
 * the missions sweep, and its sandbox goes after it.
 */
export const conversationIsIdle =
    (idleMs: number, now = () => Date.now()) =>
    async (conversationId: string): Promise<boolean> => {
        if (!isValidObjectId(conversationId)) return true
        const id = toObjectId(conversationId)
        const checkedAt = new Date(now())
        const [activeJob, activePreview] = await Promise.all([
            AiChangeJob.exists({
                rootJobId: id,
                $or: [{ status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] } }, { updatedAt: { $gt: new Date(checkedAt.getTime() - idleMs) } }]
            }),
            StandalonePreviewSession.exists({ _id: id, expiresAt: { $gt: checkedAt } })
        ])
        return !activeJob && !activePreview
    }

/** Deletes the sandboxes of the idle conversations: how many, 0 without a gateway. */
export const sweepIdleSandboxes = async (config: OpenShellConfiguration): Promise<number> => {
    const sandboxes = openShellSandboxes(config)
    return sandboxes ? sandboxes.sweep(conversationIsIdle(sandboxes.idleMs)) : 0
}
