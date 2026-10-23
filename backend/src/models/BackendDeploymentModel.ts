import mongoose, { Document, ObjectId, Schema } from "mongoose"

export const BACKEND_DEPLOYMENT_IMAGE_MAX_LENGTH = 512
export const BACKEND_DEPLOYMENT_COMMIT_SHA_MAX_LENGTH = 64

/**
 * A version of a backend the deploy pipeline of the customer reported as running in an environment.
 * The orchestrator does not deploy backends itself: this is what the CD tells it, one document per
 * notification, so the history stays. The version a backend runs in an environment is the latest
 * by `deployedAt`.
 */
export interface IBackendDeployment extends Document<ObjectId> {
    backendId: ObjectId
    environmentId: ObjectId
    version: string
    /** Full reference, e.g. ghcr.io/acme/orders-api:1.2.0 */
    image?: string
    commitSha?: string
    deployedAt: Date
    createdAt: Date
    updatedAt: Date
}

const backendDeploymentSchema = new Schema<IBackendDeployment>(
    {
        backendId: {
            type: Schema.Types.ObjectId,
            ref: "Backend",
            required: true
        },
        environmentId: {
            type: Schema.Types.ObjectId,
            ref: "Environment",
            required: true
        },
        version: {
            type: String,
            required: true,
            trim: true,
            maxlength: 128
        },
        image: {
            type: String,
            required: false,
            trim: true,
            maxlength: BACKEND_DEPLOYMENT_IMAGE_MAX_LENGTH
        },
        commitSha: {
            type: String,
            required: false,
            trim: true,
            maxlength: BACKEND_DEPLOYMENT_COMMIT_SHA_MAX_LENGTH
        },
        deployedAt: {
            type: Date,
            default: Date.now
        }
    },
    {
        timestamps: true
    }
)

// The latest deploy of a backend in an environment is read first, the most recent insert breaking a tie
backendDeploymentSchema.index({ backendId: 1, environmentId: 1, deployedAt: -1, _id: -1 })
// What deleting an environment removes
backendDeploymentSchema.index({ environmentId: 1 })

const BackendDeployment = mongoose.model<IBackendDeployment>("BackendDeployment", backendDeploymentSchema)
export default BackendDeployment
