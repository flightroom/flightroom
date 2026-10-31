import mongoose, { Schema } from "mongoose"

/** What the sandbox ran for: an Edit with AI job, a job of a mission, or a live preview started from a workspace. */
export type SandboxUsageSource = "agent" | "mission" | "preview"

export const SANDBOX_USAGE_SOURCES: readonly SandboxUsageSource[] = ["agent", "mission", "preview"]

/**
 * One amount of sandbox time, kept for good: the seconds one script or command ran (`commands` 1), or how long a
 * sandbox lived from its creation to its deletion (`commands` 0). A sandbox is paid for while it lives, idle minutes
 * included, not only while it runs something: both are kept.
 *
 * Counted against the same keys as the AI tokens (organization, project, domain, repositories), so that the totals
 * are one aggregation away. The lifetime of a sandbox is recorded when it is created, with the id the gateway gave
 * it and no `lifetimeSeconds`, and closed when that very sandbox is deleted: the owner is known at creation, when a
 * preview session may be gone by its deletion.
 */
export interface ISandboxUsage {
    organizationId: Schema.Types.ObjectId
    projectId: Schema.Types.ObjectId
    userId?: Schema.Types.ObjectId
    source: SandboxUsageSource
    /** The job that ran the command, or that created the sandbox: gone after a week if nobody applied it, the usage stays. */
    jobId?: Schema.Types.ObjectId
    domainId?: Schema.Types.ObjectId
    /** The conversation the sandbox is named after: the first job of the chain, or the live preview session. */
    conversationId: string
    /** The id the gateway gave the sandbox, on its lifetime: a conversation has a new sandbox once the last one is deleted. */
    sandboxId?: string
    /** The repositories in the sandbox: each of them counts an equal share. */
    frontendIds: Schema.Types.ObjectId[]
    backendIds: Schema.Types.ObjectId[]
    commands: number
    execSeconds: number
    /** Set once the sandbox is deleted; missing on the lifetime of a sandbox still alive. */
    lifetimeSeconds?: number
    createdAt: Date
}

const sandboxUsageSchema = new Schema<ISandboxUsage>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        source: { type: String, enum: [...SANDBOX_USAGE_SOURCES], required: true },
        jobId: { type: Schema.Types.ObjectId, ref: "AiChangeJob" },
        domainId: { type: Schema.Types.ObjectId, ref: "Domain" },
        conversationId: { type: String, required: true },
        sandboxId: { type: String },
        frontendIds: { type: [{ type: Schema.Types.ObjectId, ref: "Frontend" }], default: [] },
        backendIds: { type: [{ type: Schema.Types.ObjectId, ref: "Backend" }], default: [] },
        commands: { type: Number, default: 0 },
        execSeconds: { type: Number, default: 0 },
        lifetimeSeconds: { type: Number, min: 0 }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
)

// One per level the console shows the totals of, the period last, as for the AI tokens.
sandboxUsageSchema.index({ organizationId: 1, createdAt: -1 })
sandboxUsageSchema.index({ projectId: 1, createdAt: -1 })
sandboxUsageSchema.index({ projectId: 1, userId: 1, createdAt: -1 }, { partialFilterExpression: { userId: { $exists: true } } })
sandboxUsageSchema.index({ domainId: 1, createdAt: -1 }, { partialFilterExpression: { domainId: { $exists: true } } })
sandboxUsageSchema.index({ frontendIds: 1, createdAt: -1 })
sandboxUsageSchema.index({ backendIds: 1, createdAt: -1 })
// The lifetimes still open of a conversation: the one of a sandbox closed when it is deleted, the older ones when a new one opens.
sandboxUsageSchema.index({ conversationId: 1, sandboxId: 1 })

const SandboxUsage = mongoose.model<ISandboxUsage>("SandboxUsage", sandboxUsageSchema)
export default SandboxUsage
