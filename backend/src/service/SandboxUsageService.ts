import { AnyKeys, ObjectId, Schema, Types } from "mongoose"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Project from "../models/ProjectModel"
import SandboxUsage, { ISandboxUsage, SandboxUsageSource } from "../models/SandboxUsageModel"
import { toObjectId } from "../utils/mongooseUtils"

type Id = string | ObjectId | Schema.Types.ObjectId | Types.ObjectId

/** Who the time of a sandbox is counted against: the organization is read from the project when the caller does not hold it. */
export interface SandboxOwner {
    projectId: Id
    organizationId?: Id
    userId?: Id
    source: SandboxUsageSource
    jobId?: Id
    domainId?: Id
    frontendIds?: Id[]
    backendIds?: Id[]
}

export interface SandboxUsageEntry extends SandboxOwner {
    conversationId: string
    sandboxId?: string
    commands?: number
    execSeconds?: number
    lifetimeSeconds?: number
}

/** The lifetimes of the sandboxes of a conversation not deleted yet, or of one of them: no command, no lifetime. */
const openLifetimes = (conversationId: string, sandboxId?: string) => ({
    conversationId,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    commands: 0,
    lifetimeSeconds: { $exists: false }
})

/** Ends open lifetimes now. Guarded: a lifetime another replica closed meanwhile is not closed again. */
const close = async (open: { _id: unknown; createdAt: Date }[], now: Date) => {
    for (const lifetime of open) {
        const lifetimeSeconds = Math.max(0, Math.round((now.getTime() - new Date(lifetime.createdAt).getTime()) / 1000))
        await SandboxUsage.updateOne({ _id: lifetime._id, lifetimeSeconds: { $exists: false } }, { $set: { lifetimeSeconds } })
    }
}

/**
 * Adds one amount of sandbox time to the ledger. The callers catch what this throws: a usage that cannot be recorded
 * must never stop a job or a preview.
 */
export const recordSandboxUsage = async (entry: SandboxUsageEntry): Promise<void> => {
    const organizationId = entry.organizationId ?? (await Project.findById(toObjectId(String(entry.projectId)), { organizationId: 1 }).lean())?.organizationId
    if (!organizationId) throw new EntityNotFoundError(String(entry.projectId), `No organization for the project ${String(entry.projectId)}`)
    // The ids come as strings or ObjectIds, whichever the caller holds: the model casts them.
    const document: AnyKeys<ISandboxUsage> = { ...entry, organizationId }
    await SandboxUsage.create(document)
}

/**
 * A sandbox was created for the conversation: its lifetime starts now, closed by {@link closeSandboxLifetime}. A
 * conversation has one sandbox at a time, so a lifetime of it still open belongs to a sandbox that went without its
 * deletion being heard of (the gateway lost it, a close failed, a replica died): it ends now, never left open for good.
 */
export const openSandboxLifetime = async (conversationId: string, sandboxId: string, owner: SandboxOwner, now = new Date()): Promise<void> => {
    await close(await SandboxUsage.find(openLifetimes(conversationId), { createdAt: 1 }).lean(), now)
    await recordSandboxUsage({ ...owner, conversationId, sandboxId, commands: 0, execSeconds: 0 })
}

/**
 * That sandbox of the conversation was deleted: its lifetime ends now. Tied to the sandbox, not to the conversation: a
 * second deletion of it, or a late one heard after the conversation has a new sandbox, closes nothing. None open, a
 * sandbox created before the ledger, records nothing.
 */
export const closeSandboxLifetime = async (conversationId: string, sandboxId: string, now = new Date()): Promise<void> => {
    await close(await SandboxUsage.find(openLifetimes(conversationId, sandboxId), { createdAt: 1 }).lean(), now)
}
