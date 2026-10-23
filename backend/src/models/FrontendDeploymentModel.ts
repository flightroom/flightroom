import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { BACKEND_DEPLOYMENT_COMMIT_SHA_MAX_LENGTH, BACKEND_DEPLOYMENT_IMAGE_MAX_LENGTH } from "./BackendDeploymentModel"

/**
 * A version of a DOCKER the deploy pipeline of the customer reported as running in an environment,
 * as a BackendDeployment is for a backend: the orchestrator does not deploy a DOCKER either. One
 * document per notification, so the history stays; the version running is the latest by `deployedAt`.
 */
export interface IFrontendDeployment extends Document<ObjectId> {
    frontendId: ObjectId
    environmentId: ObjectId
    version: string
    /** Full reference, e.g. ghcr.io/acme/shell:1.2.0 */
    image?: string
    commitSha?: string
    deployedAt: Date
    createdAt: Date
    updatedAt: Date
}

const frontendDeploymentSchema = new Schema<IFrontendDeployment>(
    {
        frontendId: {
            type: Schema.Types.ObjectId,
            ref: "Frontend",
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

// The latest deploy of a DOCKER in an environment is read first, the most recent insert breaking a tie
frontendDeploymentSchema.index({ frontendId: 1, environmentId: 1, deployedAt: -1, _id: -1 })
frontendDeploymentSchema.index({ environmentId: 1 })

const FrontendDeployment = mongoose.model<IFrontendDeployment>("FrontendDeployment", frontendDeploymentSchema)
export default FrontendDeployment
