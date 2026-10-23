import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { DEFAULT_RUN_PATH, MaintenanceAgentKind } from "../types/MaintenanceAgent"
import { CONTAINER_DEFAULTS, IServiceEnvVariable, probePath, serviceEnvVariableSchema } from "./ContainerFields"
import { frontendCodeRepositorySchema, ICodeRepositoryFrontend } from "./FrontendModel"
import { CONTEXT_MAX_LENGTH } from "./ProjectModel"
import { IServiceStack } from "./ServiceModel"

/** The last time someone pressed Play, in whichever environment */
export interface IMaintenanceAgentLastRun {
    at: Date
    environmentId: Schema.Types.ObjectId
    ok: boolean
    error?: string
}

/**
 * A container that looks after backend services and frontends of the project: it has a repository, an image and
 * versions as a service does, and is deployed the same way, but is started by a schedule or by Play rather than
 * serving requests. Its slug names its values file in the GitOps repository, next to those of the services and
 * the frontends: no two of them share one.
 */
export interface IMaintenanceAgent extends Document<ObjectId> {
    projectId: Schema.Types.ObjectId
    domainId?: Schema.Types.ObjectId | null
    slug: string
    name: string
    description?: string
    /** Markdown for AI agents about this maintenance agent only */
    context?: string
    template?: string
    stack?: IServiceStack
    version?: string
    codeRepository?: ICodeRepositoryFrontend
    image?: {
        repository?: string
    }
    kind: MaintenanceAgentKind
    /** A cron expression; null when it runs only on Play */
    schedule?: string | null
    timeZone?: string | null
    /** A CONTAINER only: what its CronJob POSTs to */
    runPath: string
    port: number
    livenessPath?: string
    readinessPath?: string
    env: IServiceEnvVariable[]
    configMapIds: Schema.Types.ObjectId[]
    secretIds: Schema.Types.ObjectId[]
    resourceIds: Schema.Types.ObjectId[]
    /** The backend services it maintains */
    serviceIds: Schema.Types.ObjectId[]
    /** The frontends it maintains */
    frontendIds: Schema.Types.ObjectId[]
    lastRun?: IMaintenanceAgentLastRun
    createdAt: Date
    updatedAt: Date
}

const maintenanceAgentSchema = new Schema<IMaintenanceAgent>(
    {
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        domainId: { type: Schema.Types.ObjectId, ref: "Domain", required: false },
        slug: { type: String, required: true, trim: true, lowercase: true },
        name: { type: String, required: true, trim: true },
        description: { type: String, trim: true },
        context: { type: String, trim: true, maxlength: CONTEXT_MAX_LENGTH },
        template: { type: String, required: false },
        stack: {
            type: new Schema({ runtime: String, framework: String, source: { type: String, required: true }, detectedAt: Date }, { _id: false }),
            required: false
        },
        version: { type: String, required: false },
        codeRepository: { type: frontendCodeRepositorySchema, required: false },
        image: {
            repository: { type: String, required: false, trim: true }
        },
        kind: { type: String, enum: Object.values(MaintenanceAgentKind), default: MaintenanceAgentKind.JOB },
        schedule: { type: String, required: false, trim: true, default: null },
        timeZone: { type: String, required: false, trim: true, default: null },
        runPath: {
            type: String,
            trim: true,
            default: DEFAULT_RUN_PATH,
            validate: { validator: (value: string) => /^\/[A-Za-z0-9._~/-]*$/.test(value), message: "The run path starts with / and holds no spaces nor query" }
        },
        port: { type: Number, default: CONTAINER_DEFAULTS.port },
        livenessPath: probePath(CONTAINER_DEFAULTS.livenessPath),
        readinessPath: probePath(CONTAINER_DEFAULTS.readinessPath),
        env: { type: [serviceEnvVariableSchema], default: [] },
        configMapIds: { type: [{ type: Schema.Types.ObjectId, ref: "ConfigMap" }], default: [] },
        secretIds: { type: [{ type: Schema.Types.ObjectId, ref: "Secret" }], default: [] },
        resourceIds: { type: [{ type: Schema.Types.ObjectId, ref: "Resource" }], default: [] },
        serviceIds: { type: [{ type: Schema.Types.ObjectId, ref: "Service" }], default: [] },
        frontendIds: { type: [{ type: Schema.Types.ObjectId, ref: "Frontend" }], default: [] },
        lastRun: {
            type: new Schema<IMaintenanceAgentLastRun>(
                { at: { type: Date, required: true }, environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true }, ok: { type: Boolean, required: true }, error: String },
                { _id: false }
            ),
            required: false
        }
    },
    { timestamps: true }
)

maintenanceAgentSchema.index({ slug: 1, projectId: 1 }, { unique: true })
maintenanceAgentSchema.index({ projectId: 1, serviceIds: 1 })
maintenanceAgentSchema.index({ projectId: 1, frontendIds: 1 })

const MaintenanceAgent = mongoose.model<IMaintenanceAgent>("MaintenanceAgent", maintenanceAgentSchema)
export default MaintenanceAgent
