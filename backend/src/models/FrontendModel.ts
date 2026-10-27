import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { BackendPaths } from "../types/BackendStack"
import { ContainerResources } from "../types/ContainerResources"
import { IDesignSystem } from "../types/DesignSystem"
import { FrontendCompiler, FrontendFramework, FrontendStackSource } from "../types/FrontendStack"
import { backendEnvVariableSchema, exposurePath, IBackendEnvVariable, optionalPath, resourceFields } from "./ContainerFields"
import { designSystemSchema } from "./DesignSystemSchema"
import { CONTEXT_MAX_LENGTH } from "./ProjectModel"

export enum FrontendType {
    HOST = "HOST",
    REMOTE = "REMOTE"
}

/**
 * How it is built and served, independent from HOST/REMOTE: a host can itself be a remote of other hosts.
 *
 * A BUNDLE is a static bundle the CI uploads and the orchestrator serves. A DOCKER is an app
 * built into an image and served by its own container, exactly like a backend: the orchestrator
 * neither stores its files nor deploys it, the CI registers its versions and the CD reports its deploys.
 * A DOCKER is the top of a tree: it loads remotes, nothing loads it, so it never has parents.
 */
export enum FrontendKind {
    BUNDLE = "BUNDLE",
    DOCKER = "DOCKER"
}

/** Framework and bundler of a frontend, and where that knowledge came from */
export interface IFrontendStack {
    framework?: FrontendFramework
    compiler?: FrontendCompiler
    source: FrontendStackSource
    detectedAt?: Date
}
export interface ICodeRepositoryFrontend {
    enabled: boolean
    name: string
    codeRepositoryId: ObjectId
    repositoryId: string
    repositoryData: Record<string, unknown>
    cloneUrlHttps?: string
    cloneUrlSsh?: string
    gitlab?: {
        groupId?: number
        path?: string
    }
}

export interface ICanaryFrontend {
    enabled: boolean
    percentage: number
    type: CanaryType
    deploymentType: CanaryDeploymentType
    url?: string
    version?: string
}

export interface IHostFrontend {
    type: HostedOn
    url?: string
    storageId?: ObjectId
    entryPoint?: string
}

export interface IPosition {
    x?: number
    y?: number
    width?: number
    height?: number
}
/**
 * The container fields of a DOCKER, named as on a backend. All optional with no default, so a
 * BUNDLE document carries none of them; FrontendService fills the backend defaults in
 * when a DOCKER is created.
 */
export interface IFrontendContainer extends Partial<BackendPaths>, ContainerResources {
    image?: {
        /** Without tag, e.g. ghcr.io/acme/shell */
        repository?: string
    }
    port?: number
    /** The path it is exposed at on the host of every environment, as for a backend */
    exposurePath?: string | null
    env?: IBackendEnvVariable[]
    /** Config maps of the project the container receives as environment variables, as for a backend */
    configMapIds?: Schema.Types.ObjectId[]
    /** Secrets of the project the container receives as environment variables, as for a backend */
    secretIds?: Schema.Types.ObjectId[]
}

export interface IFrontend extends Document<ObjectId>, IFrontendContainer {
    type: FrontendType
    kind: FrontendKind
    template: string
    stack?: IFrontendStack
    slug: string
    name: string
    /** Unset on a DOCKER until its CI registers a first version */
    version: string
    continuousDeployment?: boolean
    path?: string
    projectId: Schema.Types.ObjectId
    /** The functional domain it belongs to, if any */
    domainId?: Schema.Types.ObjectId | null
    canary?: ICanaryFrontend
    host: IHostFrontend
    codeRepository?: ICodeRepositoryFrontend
    description?: string
    /** Markdown for AI agents about this frontend only; the project context covers what they share. */
    context?: string
    /** Replaces the design system of the project for this frontend only; unset, it builds with the project's */
    designSystem?: IDesignSystem
    createdAt: Date
    updatedAt: Date

    parentIds?: ObjectId[]
    /** Backends this frontend calls, linked by hand from the console */
    backendIds?: ObjectId[]
    position?: IPosition
}

export enum HostedOn {
    MFE_ORCHESTRATOR_HUB = "MFE_ORCHESTRATOR_HUB",
    CUSTOM_URL = "CUSTOM_URL",
    CUSTOM_SOURCE = "CUSTOM_SOURCE"
}

/**
 * How the canary decides who gets the new version.
 *
 * The three are not variations of one mechanism: RANDOM and ON_SESSION split traffic by percentage
 * and differ only in whether the draw sticks, while ON_USER ignores the percentage entirely and
 * serves the canary to an explicit list of users.
 */
export enum CanaryType {
    /** A fresh draw on every request: the same browser flips between versions on every reload. */
    RANDOM = "RANDOM",
    /** Sticky per browser, on the id the SDK keeps in localStorage, so it survives a restart. */
    ON_SESSION = "ON_SESSION",
    /** No draw at all: only the users enrolled on the deployment get the canary. */
    ON_USER = "ON_USER"
}

export enum CanaryDeploymentType {
    BASED_ON_VERSION = "BASED_ON_VERSION",
    BASED_ON_URL = "BASED_ON_URL"
}

const frontendHostTypeSchema = new Schema<IHostFrontend>({
    type: {
        type: String,
        enum: [HostedOn.CUSTOM_URL, HostedOn.MFE_ORCHESTRATOR_HUB, HostedOn.CUSTOM_SOURCE],
        default: HostedOn.CUSTOM_URL,
        required: true
    },
    url: {
        type: String,
        required: false
    },
    storageId: {
        type: Schema.Types.ObjectId,
        ref: "Storage",
        required: false
    },
    entryPoint: {
        type: String,
        required: false
    }
})

const frontendCanaryTypeSchema = new Schema<ICanaryFrontend>({
    enabled: {
        type: Boolean,
        default: false
    },
    percentage: {
        type: Number,
        min: 0,
        max: 100,
        default: 0
    },
    type: {
        type: String,
        enum: [CanaryType.RANDOM, CanaryType.ON_SESSION, CanaryType.ON_USER],
        default: CanaryType.ON_SESSION,
        required: true
    },
    deploymentType: {
        type: String,
        enum: [CanaryDeploymentType.BASED_ON_VERSION, CanaryDeploymentType.BASED_ON_URL],
        default: CanaryDeploymentType.BASED_ON_VERSION,
        required: true
    },
    url: {
        type: String,
        required: false
    },
    version: {
        type: String,
        required: false
    }
})

/** Shared with the backends, which link their repository exactly the same way */
export const frontendCodeRepositorySchema = new Schema<ICodeRepositoryFrontend>({
    enabled: {
        type: Boolean,
        default: false
    },
    codeRepositoryId: {
        type: Schema.Types.ObjectId,
        ref: "Repository",
        required: false
    },
    repositoryId: {
        type: String,
        required: false
    },
    name: {
        type: String,
        required: false
    },
    repositoryData: {
        type: Object,
        required: false
    },
    cloneUrlHttps: {
        type: String,
        required: false,
        trim: true
    },
    cloneUrlSsh: {
        type: String,
        required: false,
        trim: true
    },
    gitlab: {
        groupId: {
            type: Number,
            required: false
        },
        path: {
            type: String,
            required: false
        }
    }
})

const frontendStackSchema = new Schema<IFrontendStack>(
    {
        framework: {
            type: String,
            enum: Object.values(FrontendFramework),
            required: false
        },
        compiler: {
            type: String,
            enum: Object.values(FrontendCompiler),
            required: false
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

const frontendPositionSchema = new Schema<IPosition>({
    x: {
        type: Number,
        required: false
    },
    y: {
        type: Number,
        required: false
    },
    width: {
        type: Number,
        required: false
    },
    height: {
        type: Number,
        required: false
    }
})

const frontendSchema: Schema = new Schema<IFrontend>(
    {
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
        designSystem: {
            type: designSystemSchema,
            required: false
        },
        version: {
            type: String,
            // A DOCKER gets its first one from the first version its CI registers, as a backend
            required: function (this: IFrontend) {
                return this.kind !== FrontendKind.DOCKER
            }
        },
        type: {
            type: String,
            enum: [FrontendType.HOST, FrontendType.REMOTE],
            default: FrontendType.HOST,
            required: true
        },
        kind: {
            type: String,
            enum: Object.values(FrontendKind),
            default: FrontendKind.BUNDLE,
            required: true
        },
        template: {
            type: String,
            required: false
        },
        stack: {
            type: frontendStackSchema,
            required: false
        },
        canary: {
            type: frontendCanaryTypeSchema,
            required: false
        },
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
        host: {
            type: frontendHostTypeSchema,
            required: true
        },
        codeRepository: {
            type: frontendCodeRepositorySchema,
            required: false
        },
        parentIds: {
            type: [Schema.Types.ObjectId],
            ref: "Frontend",
            required: false
        },
        backendIds: {
            type: [Schema.Types.ObjectId],
            ref: "Backend",
            required: false
        },
        path: {
            type: String,
            required: false
        },
        position: {
            type: frontendPositionSchema,
            required: false
        },
        // The arrays default to undefined, not to [], so that a BUNDLE document stays without them
        image: {
            repository: {
                type: String,
                required: false,
                trim: true
            }
        },
        port: {
            type: Number,
            required: false
        },
        livenessPath: optionalPath,
        readinessPath: optionalPath,
        docsPath: optionalPath,
        openApiPath: optionalPath,
        exposurePath,
        ...resourceFields,
        env: {
            type: [backendEnvVariableSchema],
            default: undefined
        },
        configMapIds: {
            type: [{ type: Schema.Types.ObjectId, ref: "ConfigMap" }],
            default: undefined
        },
        secretIds: {
            type: [{ type: Schema.Types.ObjectId, ref: "Secret" }],
            default: undefined
        }
    },
    {
        timestamps: true
    }
)

frontendSchema.index({ slug: 1, projectId: 1 }, { unique: true })

const Frontend = mongoose.model<IFrontend>("Frontend", frontendSchema)
export default Frontend
