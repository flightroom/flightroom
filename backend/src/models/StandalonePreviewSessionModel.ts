import mongoose, { Document, ObjectId, Schema } from "mongoose"

export interface IStandalonePreviewSession extends Document<ObjectId> {
    projectId: Schema.Types.ObjectId
    targetKind: "frontend" | "domain"
    targetId: Schema.Types.ObjectId
    expiresAt: Date
}

const standalonePreviewSessionSchema = new Schema<IStandalonePreviewSession>(
    {
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        targetKind: { type: String, enum: ["frontend", "domain"], required: true },
        targetId: { type: Schema.Types.ObjectId, required: true },
        expiresAt: { type: Date, required: true }
    },
    { timestamps: true }
)

standalonePreviewSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

const StandalonePreviewSession = mongoose.model<IStandalonePreviewSession>("StandalonePreviewSession", standalonePreviewSessionSchema)
export default StandalonePreviewSession
