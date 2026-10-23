import mongoose, { Document, ObjectId, Schema } from "mongoose"

export enum MaintenanceRunStatus {
    /** Argo CD created the Job from the CronJob: how it goes is the cluster's to tell */
    STARTED = "started",
    /** Argo CD refused, or could not be reached: no Job was created */
    FAILED = "failed"
}

/** A run of a maintenance agent someone started with Play; those of the schedule happen in the cluster only */
export interface IMaintenanceRun extends Document<ObjectId> {
    projectId: Schema.Types.ObjectId
    agentId: Schema.Types.ObjectId
    environmentId: Schema.Types.ObjectId
    trigger: "manual"
    status: MaintenanceRunStatus
    error?: string
    userId?: Schema.Types.ObjectId
    createdAt: Date
    updatedAt: Date
}

const maintenanceRunSchema = new Schema<IMaintenanceRun>(
    {
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        agentId: { type: Schema.Types.ObjectId, ref: "MaintenanceAgent", required: true },
        environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true },
        trigger: { type: String, enum: ["manual"], default: "manual" },
        status: { type: String, enum: Object.values(MaintenanceRunStatus), required: true },
        error: { type: String, required: false },
        userId: { type: Schema.Types.ObjectId, ref: "User", required: false }
    },
    { timestamps: true }
)

maintenanceRunSchema.index({ agentId: 1, createdAt: -1 })

const MaintenanceRun = mongoose.model<IMaintenanceRun>("MaintenanceRun", maintenanceRunSchema)
export default MaintenanceRun
