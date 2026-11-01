import AiSandbox, { IAiSandbox } from "../../models/AiSandboxModel"
import { toObjectId } from "../../utils/mongooseUtils"

/** A sandbox as the pool keeps it: assigned to a key, or warm in a slot. */
export interface PooledSandbox {
    name: string
    sandboxId?: string
    key?: string
    slot?: number
    organizationId?: string
    shared: boolean
    specHash: string
    state: IAiSandbox["state"]
    /** When its key let it go, while it is being emptied for the pool. */
    releasedAt?: Date
    createdAt: Date
}

/** What happened to a sandbox moved back into the pool. */
export type ReleaseOutcome = "released" | "slotTaken" | "gone"

/**
 * Where the sandboxes of the installation and what they serve are kept, for every replica. The writes are atomic and
 * guarded by the unique key, slot and name: two replicas doing the same thing at once end with one of them done.
 */
export interface SandboxPool {
    /** False when the key or the slot is already held: another replica got there first. */
    insert(sandbox: Omit<PooledSandbox, "createdAt">): Promise<boolean>
    byKey(key: string): Promise<PooledSandbox | undefined>
    byName(name: string): Promise<PooledSandbox | undefined>
    all(): Promise<PooledSandbox[]>
    /** The gateway created it, with this id, or it was emptied for the pool: it can be handed out. */
    markReady(name: string, sandboxId: string): Promise<void>
    /**
     * Hands a warm sandbox created as `specHash` is, after `bornAfter`, to the key: one last recycled by the same
     * organization first, else one never used. Never one recycled by another organization, nor one being emptied.
     * Undefined when none is warm, or the key got one meanwhile.
     */
    claim(key: string, organizationId: string, specHash: string, shared: boolean, bornAfter: Date): Promise<PooledSandbox | undefined>
    /** Moves a sandbox from the key it still holds to the slot, to be emptied: only the first replica asking does it. */
    release(name: string, key: string, slot: number, releasedAt: Date): Promise<ReleaseOutcome>
    remove(name: string): Promise<void>
    /** Removes the record of a sandbox only while it is warm: false when a key claimed it meanwhile, or it is gone. */
    removeWarm(name: string): Promise<boolean>
}

const DUPLICATE_KEY = 11000

const isDuplicate = (error: unknown) => (error as { code?: unknown } | null)?.code === DUPLICATE_KEY

const toPooled = (document: IAiSandbox): PooledSandbox => ({
    name: document.name,
    sandboxId: document.sandboxId,
    key: document.key,
    slot: document.slot,
    organizationId: document.organizationId ? String(document.organizationId) : undefined,
    shared: Boolean(document.shared),
    specHash: document.specHash,
    state: document.state,
    releasedAt: document.releasedAt,
    createdAt: document.createdAt
})

/** The pool in MongoDB, shared by the replicas of the installation. */
export const mongoSandboxPool: SandboxPool = {
    async insert(sandbox) {
        try {
            const { organizationId, ...rest } = sandbox
            await AiSandbox.create({ ...rest, ...(organizationId ? { organizationId: toObjectId(organizationId) } : {}) })
            return true
        } catch (error) {
            if (isDuplicate(error)) return false
            throw error
        }
    },
    async byKey(key) {
        const document = await AiSandbox.findOne({ key }).lean<IAiSandbox>()
        return document ? toPooled(document) : undefined
    },
    async byName(name) {
        const document = await AiSandbox.findOne({ name }).lean<IAiSandbox>()
        return document ? toPooled(document) : undefined
    },
    async all() {
        return (await AiSandbox.find().lean<IAiSandbox[]>()).map(toPooled)
    },
    async markReady(name, sandboxId) {
        await AiSandbox.updateOne({ name }, { $set: { sandboxId, state: "ready" }, $unset: { releasedAt: 1 } })
    },
    async claim(key, organizationId, specHash, shared, bornAfter) {
        const organization = toObjectId(organizationId)
        for (const owner of [{ organizationId: organization }, { organizationId: { $exists: false } }]) {
            try {
                const claimed = await AiSandbox.findOneAndUpdate(
                    { slot: { $exists: true }, state: "ready", specHash, createdAt: { $gt: bornAfter }, ...owner },
                    { $set: { key, organizationId: organization, shared }, $unset: { slot: 1 } },
                    // The youngest first: it has the most time left before its maximum age.
                    { sort: { createdAt: -1 }, returnDocument: "after" }
                ).lean<IAiSandbox>()
                if (claimed) return toPooled(claimed)
            } catch (error) {
                // The key got a sandbox from another replica meanwhile: the caller reads it.
                if (isDuplicate(error)) return undefined
                throw error
            }
        }
        return undefined
    },
    async release(name, key, slot, releasedAt) {
        try {
            const result = await AiSandbox.updateOne({ name, key }, { $set: { slot, shared: false, state: "recycling", releasedAt }, $unset: { key: 1 } })
            return result.matchedCount ? "released" : "gone"
        } catch (error) {
            if (isDuplicate(error)) return "slotTaken"
            throw error
        }
    },
    async remove(name) {
        await AiSandbox.deleteOne({ name })
    },
    async removeWarm(name) {
        const result = await AiSandbox.deleteOne({ name, slot: { $exists: true }, key: { $exists: false } })
        return result.deletedCount === 1
    }
}

/** How many sandboxes are warm, still being created for the pool, and serving a key. */
export const sandboxPoolCounts = async (): Promise<{ warm: number; creating: number; assigned: number }> => {
    const [warm, creating, assigned] = await Promise.all([
        AiSandbox.countDocuments({ slot: { $exists: true }, state: "ready" }),
        AiSandbox.countDocuments({ slot: { $exists: true }, state: { $in: ["creating", "recycling"] } }),
        AiSandbox.countDocuments({ key: { $exists: true } })
    ])
    return { warm, creating, assigned }
}
