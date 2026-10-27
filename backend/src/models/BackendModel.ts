import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { BackendPaths, BackendRuntime } from "../types/BackendStack"
import { ContainerResources } from "../types/ContainerResources"
import { FrontendStackSource } from "../types/FrontendStack"
import { backendEnvVariableSchema, CONTAINER_DEFAULTS, exposurePath, IBackendEnvVariable, optionalPath, probePath, resourceFields } from "./ContainerFields"
import { frontendCodeRepositorySchema, ICodeRepositoryFrontend } from "./FrontendModel"
import { CONTEXT_MAX_LENGTH } from "./ProjectModel"

export type { IBackendEnvVariable }

/** Runtime and framework of a backend, and where that knowledge came from */
export interface IBackendStack {
    runtime?: BackendRuntime
    framework?: string
    source: FrontendStackSource
    detectedAt?: Date
}

export interface IBackend extends Document<ObjectId>, BackendPaths, ContainerResources {
    projectId: Schema.Types.ObjectId
    /** The functional domain it belongs to, if any */
    domainId?: Schema.Types.ObjectId | null
    slug: string
    name: string
    description?: string
    /** Markdown for AI agents about this backend only; the project context covers what they share. */
    context?: string
    template?: string
    stack?: IBackendStack
    /** The latest version the CI registered */
    version?: string
    codeRepository?: ICodeRepositoryFrontend
    image?: {
        /** Without tag, e.g. ghcr.io/acme/orders-api */
        repository?: string
    }
    port: number
    /** The path it is exposed at on the host of every environment, e.g. /api/orders; null when it is not exposed */
    exposurePath?: string | null
    env: IBackendEnvVariable[]
    /** Config maps of the project the backend receives as environment variables; they live on their own and can be shared */
    configMapIds: Schema.Types.ObjectId[]
    /** Secrets of the project the backend receives as environment variables, as for the config maps */
    secretIds: Schema.Types.ObjectId[]
    /** Resources of the project (a database, a storage...) the backend receives as environment variables; a frontend never attaches one */
    resourceIds: Schema.Types.ObjectId[]
    createdAt: Date
    updatedAt: Date
}

const backendStackSchema = new Schema<IBackendStack>(
    {
        runtime: {
            type: String,
            enum: Object.values(BackendRuntime),
            required: false
        },
        framework: {
            type: String,
            required: false,
            trim: true
        },
        source: {
            type: String,
            enum: Object.values(FrontendStackSource),
            required: true
        },
        detectedAt: {
            type: Date,
            required: false
        }
    },
    { _id: false }
)

const backendSchema = new Schema<IBackend>(
    {
        projectId: {
            type: Schema.Types.ObjectId,
            ref: "Project",
            required: true
        },
        domainId: {
            type: Schema.Types.ObjectId,
            ref: "Domain",
            required: false
        },
        slug: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },
        name: {
            type: String,
            required: true,
            trim: true
        },
        description: {
            type: String,
            trim: true
        },
        context: {
            type: String,
            trim: true,
            maxlength: CONTEXT_MAX_LENGTH
        },
        template: {
            type: String,
            required: false
        },
        stack: {
            type: backendStackSchema,
            required: false
        },
        version: {
            type: String,
            required: false
        },
        codeRepository: {
            type: frontendCodeRepositorySchema,
            required: false
        },
        image: {
            repository: {
                type: String,
                required: false,
                trim: true
            }
        },
        port: {
            type: Number,
            default: CONTAINER_DEFAULTS.port
        },
        livenessPath: probePath(CONTAINER_DEFAULTS.livenessPath),
        readinessPath: probePath(CONTAINER_DEFAULTS.readinessPath),
        docsPath: optionalPath,
        openApiPath: optionalPath,
        exposurePath,
        ...resourceFields,
        env: {
            type: [backendEnvVariableSchema],
            default: []
        },
        configMapIds: {
            type: [{ type: Schema.Types.ObjectId, ref: "ConfigMap" }],
            default: []
        },
        secretIds: {
            type: [{ type: Schema.Types.ObjectId, ref: "Secret" }],
            default: []
        },
        resourceIds: {
            type: [{ type: Schema.Types.ObjectId, ref: "Resource" }],
            default: []
        }
    },
    {
        timestamps: true
    }
)

backendSchema.index({ slug: 1, projectId: 1 }, { unique: true })

/**
 * A backend the migration to maps has not reached yet still holds its old inline values, and Mongoose
 * serialises fields the schema does not know: without this, its secrets would go out through every API,
 * the MCP tools included, which read the document through toObject.
 */
const withoutInlineVariables = {
    transform: (_document: unknown, object: IBackend) => {
        const { configMap: _configMap, secrets: _secrets, ...rest } = object as IBackend & { configMap?: unknown; secrets?: unknown }
        return rest
    }
}
backendSchema.set("toJSON", withoutInlineVariables)
backendSchema.set("toObject", withoutInlineVariables)

const Backend = mongoose.model<IBackend>("Backend", backendSchema)
export default Backend
