import mongoose, { Document, ObjectId, Schema } from "mongoose"

/** A version of a backend whose image the CI pushed and registered */
export interface IBuiltBackend extends Document<ObjectId> {
    backendId: ObjectId
    version: string
    /** Full reference, e.g. ghcr.io/acme/orders-api:1.2.0 */
    image: string
    digest?: string
    commitSha?: string
    createdAt: Date
    updatedAt: Date
}

const builtBackendSchema = new Schema<IBuiltBackend>(
    {
        backendId: {
            type: Schema.Types.ObjectId,
            ref: "Backend",
            required: true,
            index: true
        },
        version: {
            type: String,
            required: true,
            trim: true,
            maxlength: 255
        },
        image: {
            type: String,
            required: true,
            trim: true
        },
        digest: {
            type: String,
            required: false,
            trim: true
        },
        commitSha: {
            type: String,
            required: false,
            trim: true
        }
    },
    {
        timestamps: true
    }
)

// A CI rerun on the same tag registers the same version again: it replaces the entry
builtBackendSchema.index({ backendId: 1, version: 1 }, { unique: true })

const BuiltBackend = mongoose.model<IBuiltBackend>("BuiltBackend", builtBackendSchema)
export default BuiltBackend
