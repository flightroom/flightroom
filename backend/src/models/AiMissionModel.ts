import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { LLM_EFFORTS, LlmEffort } from "../service/llm/types"

/**
 * `global`: one agent per batch sees all its repositories at once. `perRepository`: each repository
 * gets an agent of its own, with the same prompt.
 */
export type AiMissionMode = "global" | "perRepository"

export enum AiMissionStatus {
    /** Some batch is still to run or running. */
    RUNNING = "RUNNING",
    /** Every batch ran, and at least one job finished. */
    DONE = "DONE",
    /** Every job failed. */
    FAILED = "FAILED",
    /** A user stopped it: its active jobs were stopped, its queued repositories never start. */
    STOPPED = "STOPPED"
}

export interface IAiMissionRepository {
    kind: "frontend" | "service"
    id: Schema.Types.ObjectId
    /** The batch it runs in, from 0: batch i+1 starts once every job of batch i is over. */
    batch: number
    /** The job working on it, set the moment it is claimed: unset while queued. A `global` batch shares one job. */
    jobId?: Schema.Types.ObjectId
    /** Why its job could not even be started: it never will be. */
    error?: string
}

/**
 * One prompt over many repositories of a project. A mission runs no agent itself: it starts jobs
 * ({@link IAiChangeJob}) batch after batch, and each job's requests are reviewed and applied as usual.
 */
export interface IAiMission extends Document<ObjectId> {
    projectId: Schema.Types.ObjectId
    userId: Schema.Types.ObjectId
    prompt: string
    mode: AiMissionMode
    /** Every repository of the project, rather than a selection: what a domain-scoped member may neither start nor see. */
    all: boolean
    /** In `perRepository` mode, the jobs of the current batch active at once. */
    concurrency: number
    effort?: LlmEffort
    /** The AI every job runs on: an id of the organization's AIs, or `system`. */
    aiModelId: string
    /** In the order they are shown. */
    repositories: IAiMissionRepository[]
    currentBatch: number
    batchCount: number
    /** How many repositories were handed to a job so far: each claim is made on the count it read, so two advances racing never both start. */
    claims: number
    status: AiMissionStatus
    stoppedAt?: Date
    /** Set when it ends, like a job's: the mission goes with its jobs. */
    expiresAt?: Date
    createdAt: Date
    updatedAt: Date
}

const repositorySchema = new Schema<IAiMissionRepository>(
    {
        kind: { type: String, enum: ["frontend", "service"], required: true },
        id: { type: Schema.Types.ObjectId, required: true },
        batch: { type: Number, required: true },
        jobId: { type: Schema.Types.ObjectId, ref: "AiChangeJob" },
        error: { type: String }
    },
    { _id: false }
)

const aiMissionSchema = new Schema<IAiMission>(
    {
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        prompt: { type: String, required: true, maxlength: 8_000 },
        mode: { type: String, enum: ["global", "perRepository"], required: true },
        all: { type: Boolean, default: false },
        concurrency: { type: Number, min: 1, max: 10, default: 3 },
        effort: { type: String, enum: [...LLM_EFFORTS] },
        aiModelId: { type: String, required: true },
        repositories: { type: [repositorySchema], default: [] },
        currentBatch: { type: Number, default: 0 },
        batchCount: { type: Number, required: true },
        claims: { type: Number, default: 0 },
        status: { type: String, enum: Object.values(AiMissionStatus), default: AiMissionStatus.RUNNING, required: true },
        stoppedAt: { type: Date },
        expiresAt: { type: Date }
    },
    { timestamps: true }
)

aiMissionSchema.index({ projectId: 1, createdAt: -1 })
aiMissionSchema.index({ projectId: 1, status: 1 })
aiMissionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

const AiMission = mongoose.model<IAiMission>("AiMission", aiMissionSchema)
export default AiMission
