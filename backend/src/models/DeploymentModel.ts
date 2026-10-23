import { Document, model, ObjectId, Schema } from "mongoose"
import { encryptedFields } from "../utils/encryptedFieldsPlugin"
import { IBackend } from "./BackendModel"
import { IFrontend } from "./FrontendModel"
import { IGlobalVariable } from "./GlobalVariableModel"
import { IStorage, STORAGE_SECRET_PATHS } from "./StorageModel"

/**
 * A config map, a secret or a resource as the deploy recorded it in its environment: the keys set there,
 * with their values for a config map only. A secret's values are not copied here, nor a resource's, which
 * mixes credentials with the rest: nothing reads them back.
 */
export interface IDeployedVariableMap {
    _id: ObjectId
    name: string
    entries: Array<{ key: string; value?: string }>
}

/** A backend as the deploy recorded it: only what tells which one, at which version and where it is exposed, never its env */
export type IDeployedBackend = Pick<IBackend, "_id" | "slug" | "name" | "domainId" | "version" | "image" | "exposurePath">

export interface IDeployment extends Document<ObjectId> {
    environmentId: ObjectId
    variables?: IGlobalVariable[]
    frontends?: IFrontend[]
    /** Absent from the deployments made before the backends were recorded */
    backends?: IDeployedBackend[]
    /** Absent from the deployments made before the config maps and secrets were recorded, as for the backends */
    configMaps?: IDeployedVariableMap[]
    secrets?: IDeployedVariableMap[]
    /** The resources some backend attaches; absent from the deployments made before resources existed */
    resources?: IDeployedVariableMap[]
    storages?: IStorage[]
    deploymentId: string
    active: boolean
    deployedAt: Date
}

const deploymentSchema = new Schema<IDeployment>(
    {
        environmentId: {
            type: Schema.Types.ObjectId,
            required: true,
            trim: true
        },
        deploymentId: {
            type: String,
            required: true,
            trim: true
        },
        variables: {
            type: Array,
            required: false
        },
        frontends: {
            type: Array,
            required: false
        },
        backends: {
            type: Array,
            required: false
        },
        configMaps: {
            type: Array,
            required: false
        },
        secrets: {
            type: Array,
            required: false
        },
        resources: {
            type: Array,
            required: false
        },
        storages: {
            type: Array,
            required: false
        },
        active: {
            type: Boolean,
            required: true,
            default: false
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

// Aggiungo un indice composto per garantire l'unicità della coppia environmentId e deploymentId
deploymentSchema.index({ environmentId: 1, deploymentId: 1 }, { unique: true })
// The deployment an environment serves: the active one, or the most recent when none is flagged
deploymentSchema.index({ environmentId: 1, active: -1, deployedAt: -1 })

/**
 * A deployment freezes a copy of the storages of the project, credentials included, and the serve API
 * reads the bucket keys from that copy rather than from the storage itself. Encrypting the storage
 * collection alone would therefore leave every key of every past deployment in the clear right next
 * to it.
 */
deploymentSchema.plugin(encryptedFields, {
    model: "Deployment",
    paths: STORAGE_SECRET_PATHS.map(path => `storages.${path}`)
})

const Deployment = model<IDeployment>("Deployment", deploymentSchema)
export default Deployment
