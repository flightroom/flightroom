import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { KUBE_GREEN_DEFAULT_DAYS, KUBE_GREEN_DEFAULTS, KubeGreenSettings } from "../types/KubeGreen"
import { DEFAULT_LOG_LEVEL, LOG_LEVELS } from "../types/RuntimeVariables"

export interface IEnvironment extends Document<ObjectId> {
    name: string
    description: string
    slug: string
    projectId: Schema.Types.ObjectId
    color: string
    isProduction: boolean
    url?: string
    order: number
    domains?: string[]
    /** The Kubernetes namespace GitOps commits the environment to; its slug in lowercase when unset */
    namespace?: string
    /** What it is exposed under on the domain of the project, e.g. `dev`; unset, the domain itself in production, the slug otherwise */
    subdomain?: string
    /** The addresses and CIDR ranges its host answers to; empty or unset, every one */
    ipAllowList?: string[]
    /** What its containers log at, handed to them as LOG_LEVEL */
    logLevel: string
    /** Whether its containers log JSON rather than plain text, handed to them as LOG_JSON */
    logJson: boolean
    /** When kube-green puts it to sleep, committed by GitOps as SleepInfos in its namespace */
    kubeGreen: KubeGreenSettings
}

const environmentSchema = new Schema<IEnvironment>(
    {
        name: {
            type: String,
            required: true
        },
        description: {
            type: String
        },
        slug: {
            type: String,
            required: true
        },
        color: {
            type: String,
            required: true
        },
        isProduction: {
            type: Boolean,
            default: false
        },
        domains: {
            type: [String],
            required: false
        },
        namespace: {
            type: String,
            trim: true
        },
        subdomain: {
            type: String,
            trim: true,
            lowercase: true
        },
        ipAllowList: {
            type: [String],
            default: undefined
        },
        logLevel: {
            type: String,
            enum: LOG_LEVELS,
            default: DEFAULT_LOG_LEVEL
        },
        logJson: {
            type: Boolean,
            default: true
        },
        // A nested path, not a subdocument: an environment saved before it reads the defaults
        kubeGreen: {
            enabled: { type: Boolean, default: KUBE_GREEN_DEFAULTS.enabled },
            days: {
                type: [new Schema({ weekday: Number, awake: Boolean, wakeUpAt: String, sleepAt: String }, { _id: false })],
                default: KUBE_GREEN_DEFAULT_DAYS
            },
            timeZone: { type: String, default: KUBE_GREEN_DEFAULTS.timeZone },
            suspendDeployments: { type: Boolean, default: KUBE_GREEN_DEFAULTS.suspendDeployments },
            suspendStatefulSets: { type: Boolean, default: KUBE_GREEN_DEFAULTS.suspendStatefulSets },
            suspendCronJobs: { type: Boolean, default: KUBE_GREEN_DEFAULTS.suspendCronJobs },
            excludeApplications: { type: [String], default: undefined }
        },
        projectId: {
            type: Schema.Types.ObjectId,
            ref: "Project",
            required: true,
            index: true
        },
        order: {
            type: Number,
            required: true
        }
    },
    {
        timestamps: true
    }
)

// Create a compound index to ensure the combination of slug and projectId is unique
environmentSchema.index({ slug: 1, projectId: 1 }, { unique: true })

const Environment = mongoose.model<IEnvironment>("Environment", environmentSchema)
export default Environment
