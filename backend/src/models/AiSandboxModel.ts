import mongoose, { Schema } from "mongoose"

/**
 * Creating: the document holds the name while the gateway creates the sandbox. Ready: the gateway gave it its id.
 * Recycling: its key let it go and a replica empties it for the pool; nobody claims it meanwhile.
 */
export type AiSandboxState = "creating" | "ready" | "recycling"

/**
 * A sandbox of the coding agent created since the warm pool, and what it serves now. The labels of a sandbox cannot
 * change on the gateway, while a sandbox serves one key after another: who it serves lives here. Either it is
 * assigned to a key (a domain, a project, a conversation or a live preview) or it waits in the pool, holding one of
 * the slots the installation keeps warm.
 */
export interface IAiSandbox {
    /** Its name on the gateway, random: a recycled sandbox serves other keys. */
    name: string
    sandboxId?: string
    /** The key it serves; one sandbox per key, which serializes the replicas creating one for the same key. */
    key?: string
    /** The slot of the pool it holds while warm and unassigned: 0 up to the warm sandboxes wanted, minus one. */
    slot?: number
    /**
     * The organization it last served. A recycled sandbox keeps the caches of the package managers in its home, which may
     * hold the private packages of that organization: it goes back only to the same organization.
     */
    organizationId?: Schema.Types.ObjectId
    /** Several conversations share its key, each in a folder of its own: the sweep removes those of the idle ones. */
    shared: boolean
    /** The image or template and the network policy it was created with: a sandbox created otherwise is not handed out again. */
    specHash: string
    state: AiSandboxState
    /** When its key let it go: one recycling for too long was left halfway by a replica that stopped. */
    releasedAt?: Date
    createdAt: Date
}

const aiSandboxSchema = new Schema<IAiSandbox>(
    {
        name: { type: String, required: true },
        sandboxId: { type: String },
        key: { type: String },
        slot: { type: Number, min: 0 },
        organizationId: { type: Schema.Types.ObjectId, ref: "Organization" },
        shared: { type: Boolean, default: false },
        specHash: { type: String, required: true },
        state: { type: String, enum: ["creating", "ready", "recycling"], default: "creating", required: true },
        releasedAt: { type: Date }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
)

aiSandboxSchema.index({ name: 1 }, { unique: true })
// One sandbox per key, one per slot: the replicas creating, claiming or recycling one at once agree through these.
aiSandboxSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $exists: true } } })
aiSandboxSchema.index({ slot: 1 }, { unique: true, partialFilterExpression: { slot: { $exists: true } } })

const AiSandbox = mongoose.model<IAiSandbox>("AiSandbox", aiSandboxSchema)
export default AiSandbox
