import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { ContainerResourcesByEnvironment } from "../types/ContainerResources"
import { VersionByEnvironment } from "../types/EnvironmentVersions"
import { DEFAULT_RUN_PATH, MaintenanceAgentKind } from "../types/MaintenanceAgent"
import { IBackendStack } from "./BackendModel"
import { backendEnvVariableSchema, CONTAINER_DEFAULTS, environmentResourcesField, environmentVersionsField, IBackendEnvVariable, probePath, resourceFields } from "./ContainerFields"
import { frontendCodeRepositorySchema, ICodeRepositoryFrontend } from "./FrontendModel"
import { CONTEXT_MAX_LENGTH } from "./ProjectModel"

/** The last time someone pressed Play, in whichever environment */
export interface IMaintenanceAgentLastRun {
    at: Date
    environmentId: Schema.Types.ObjectId
    ok: boolean
    error?: string
}

/**
 * The credential the container of the agent calls the console with in one environment, to read the logs and the
 * builds of what it maintains there: minted at the first deploy of the environment and written by every deploy
 * into the Secret the container reads. Kept encrypted, as the deploy needs it back.
 */
export interface IMaintenanceAgentRuntimeToken {
    environmentId: Schema.Types.ObjectId
    token: string
}

/**
 * A container that looks after backends and frontends of the project: it has a repository, an image and
 * versions as a backend does, and is deployed the same way, but is started by a schedule or by Play rather than
 * serving requests. Its slug names its values file in the GitOps repository, next to those of the backends and
 * the frontends: no two of them share one.
 */
export interface IMaintenanceAgent extends Document<ObjectId>, ContainerResourcesByEnvironment, VersionByEnvironment {
    projectId: Schema.Types.ObjectId
    domainId?: Schema.Types.ObjectId | null
    slug: string
    name: string
    description?: string
    /** Markdown for AI agents about this maintenance agent only */
    context?: string
    template?: string
    stack?: IBackendStack
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
    env: IBackendEnvVariable[]
    configMapIds: Schema.Types.ObjectId[]
    secretIds: Schema.Types.ObjectId[]
    resourceIds: Schema.Types.ObjectId[]
    /** The backends it maintains */
    backendIds: Schema.Types.ObjectId[]
    /** The frontends it maintains */
    frontendIds: Schema.Types.ObjectId[]
    lastRun?: IMaintenanceAgentLastRun
    /** Never read unless asked for: no answer of the console carries them */
    runtimeTokens?: IMaintenanceAgentRuntimeToken[]
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
        ...resourceFields,
        environmentResources: environmentResourcesField,
        environmentVersions: environmentVersionsField,
        env: { type: [backendEnvVariableSchema], default: [] },
        configMapIds: { type: [{ type: Schema.Types.ObjectId, ref: "ConfigMap" }], default: [] },
        secretIds: { type: [{ type: Schema.Types.ObjectId, ref: "Secret" }], default: [] },
        resourceIds: { type: [{ type: Schema.Types.ObjectId, ref: "Resource" }], default: [] },
        backendIds: { type: [{ type: Schema.Types.ObjectId, ref: "Backend" }], default: [] },
        frontendIds: { type: [{ type: Schema.Types.ObjectId, ref: "Frontend" }], default: [] },
        lastRun: {
            type: new Schema<IMaintenanceAgentLastRun>(
                { at: { type: Date, required: true }, environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true }, ok: { type: Boolean, required: true }, error: String },
                { _id: false }
            ),
            required: false
        },
        runtimeTokens: {
            type: [
                new Schema<IMaintenanceAgentRuntimeToken>(
                    { environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true }, token: { type: String, required: true } },
                    { _id: false }
                )
            ],
            default: undefined,
            select: false
        }
    },
    { timestamps: true }
)

maintenanceAgentSchema.index({ slug: 1, projectId: 1 }, { unique: true })
maintenanceAgentSchema.index({ projectId: 1, backendIds: 1 })
maintenanceAgentSchema.index({ projectId: 1, frontendIds: 1 })

const MaintenanceAgent = mongoose.model<IMaintenanceAgent>("MaintenanceAgent", maintenanceAgentSchema)
export default MaintenanceAgent
