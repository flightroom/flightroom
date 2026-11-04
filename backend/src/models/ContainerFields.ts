import { Schema } from "mongoose"
import { BACKEND_HTTP_PATH } from "../types/BackendStack"
import { isReplicaCount, MAX_REPLICAS, parseCpu, parseMemory } from "../types/ContainerResources"
import { isExposurePath } from "../types/Exposure"
import { isProbeSeconds, MAX_PROBE_SECONDS, PLATFORM_PROBE_PATHS, PROBE_TIMING_FIELDS, PROBE_TIMING_MINIMUMS, ProbeSettings } from "../types/Probes"
import { isLogLevel, LOG_LEVELS } from "../types/RuntimeVariables"

/**
 * The fields of what runs as a container of its own: a backend, or a frontend built into an
 * image. They live apart from both models because BackendModel already imports FrontendModel, so
 * the frontend schema could not import them from BackendModel without a cycle.
 */

/** A variable the image reads from its environment */
export interface IBackendEnvVariable {
    name: string
    required: boolean
    secret: boolean
    description?: string
}

/**
 * A variable of a backend: what every deploy hands the container, the same in every environment, the values of a config map
 * or a secret being for what changes per environment. Always with a value: one with none is no variable of a backend. The
 * value is encrypted at rest, and a secret one never goes out of the API, which says `valueSet` instead.
 */
export interface IBackendInjectedEnvVariable {
    name: string
    secret: boolean
    description?: string
    value: string
}

/** What a container gets when neither the caller nor a template says otherwise */
export const CONTAINER_DEFAULTS = { port: 8080, ...PLATFORM_PROBE_PATHS }

export const backendEnvVariableSchema = new Schema<IBackendEnvVariable>(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        required: {
            type: Boolean,
            default: false
        },
        secret: {
            type: Boolean,
            default: false
        },
        description: {
            type: String,
            required: false,
            trim: true
        }
    },
    { _id: false }
)

/** A variable of a backend, with the value the deploy hands it: no `required`, since every one has its value */
export const backendInjectedEnvVariableSchema = new Schema<IBackendInjectedEnvVariable>(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        secret: {
            type: Boolean,
            default: false
        },
        description: {
            type: String,
            required: false,
            trim: true
        },
        value: {
            type: String,
            required: true
        }
    },
    { _id: false }
)

const httpPathValidator = {
    validator: (value?: string | null) => value == null || BACKEND_HTTP_PATH.test(value),
    message: (props: { path: string; value: unknown }) => `${props.path} "${props.value}" must start with "/", have at most 256 characters and no whitespace`
}

/** An optional path: blank means the container has none, so it is stored as null rather than as "" */
export const optionalPath = {
    type: String,
    required: false,
    set: (value?: string | null) => value?.trim() || null,
    validate: httpPathValidator
}

/** The path an application is exposed at on the Gateway: optional like the others, with the rules of an HTTPRoute */
export const exposurePath = {
    ...optionalPath,
    validate: {
        validator: (value?: string | null) => value == null || isExposurePath(value),
        message: (props: { path: string; value: unknown }) =>
            `${props.path} "${props.value}" is not a path an HTTPRoute takes: segments of letters, digits and -._~!$&'()*+,;=:@ or %XX, no query, fragment, // nor . or .. segment`
    }
}

const optionalQuantity = (parse: (value: string) => number | undefined, example: string) => ({
    type: String,
    required: false,
    set: (value?: string | null) => value?.trim() || null,
    validate: {
        validator: (value?: string | null) => value == null || parse(value) !== undefined,
        message: (props: { path: string; value: unknown }) => `${props.path} "${props.value}" is not a Kubernetes quantity above zero, e.g. ${example}`
    }
})

/**
 * The CPU and memory of the container, as Kubernetes quantities, and its replicas: blank means the default of the chart, so
 * it is stored as null. That a request is not above its limit is checked by the services, which see what is stored as well.
 */
export const resourceFields = {
    cpuRequest: optionalQuantity(parseCpu, "250m or 0.5"),
    cpuLimit: optionalQuantity(parseCpu, "250m or 0.5"),
    memoryRequest: optionalQuantity(parseMemory, "128Mi or 1Gi"),
    memoryLimit: optionalQuantity(parseMemory, "128Mi or 1Gi"),
    replicas: {
        type: Number,
        required: false,
        validate: {
            validator: (value?: number | null) => value == null || isReplicaCount(value),
            message: (props: { path: string; value: unknown }) => `${props.path} "${props.value}" is not a whole number from 0 to ${MAX_REPLICAS}`
        }
    }
}

/** The initial delay and the period of the liveness and readiness probes, in seconds: blank means the default of the chart, so it is stored as null */
export const probeTimingFields = Object.fromEntries(
    PROBE_TIMING_FIELDS.map(field => [
        field,
        {
            type: Number,
            required: false,
            validate: {
                validator: (value?: number | null) => value == null || isProbeSeconds(value, PROBE_TIMING_MINIMUMS[field]),
                message: (props: { path: string; value: unknown }) => `${props.path} "${props.value}" is not a whole number of seconds from ${PROBE_TIMING_MINIMUMS[field]} to ${MAX_PROBE_SECONDS}`
            }
        }
    ])
)

/**
 * The probe paths of a container: blank inherits the template of its project, so it is stored as null. One stored
 * before the template, the platform's default included, stays its own.
 */
export const probePathFields = { livenessPath: optionalPath, readinessPath: optionalPath }

/** The template of a project for the probes of its backends or of its frontends: each field left blank is the platform's */
export const probeSettingsSchema = new Schema<ProbeSettings>({ ...probePathFields, ...probeTimingFields }, { _id: false })

/** LOG_LEVEL of the container in every environment: blank means the environment's, so it is stored as null */
export const logLevelField = {
    type: String,
    required: false,
    set: (value?: string | null) => value?.trim() || null,
    validate: {
        validator: (value?: string | null) => value == null || isLogLevel(value),
        message: (props: { path: string; value: unknown }) => `${props.path} "${props.value}" is not a log level: ${LOG_LEVELS.join(", ")}`
    }
}

/** What one environment sets apart from the CPU, memory and replicas of the container: each one left blank is the container's */
export interface IEnvironmentResources {
    environmentId: Schema.Types.ObjectId
    cpuRequest?: string | null
    cpuLimit?: string | null
    memoryRequest?: string | null
    memoryLimit?: string | null
    replicas?: number | null
}

const environmentResourcesSchema = new Schema<IEnvironmentResources>({ environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true }, ...resourceFields }, { _id: false })

/** The environments that run the container with CPU and memory of their own; that each one belongs to the project is checked by the services */
export const environmentResourcesField = { type: [environmentResourcesSchema], default: undefined }

/** The version one environment runs: the tag of the image the deploy writes there */
export interface IEnvironmentVersion {
    environmentId: Schema.Types.ObjectId
    version: string
}

const environmentVersionSchema = new Schema<IEnvironmentVersion>(
    { environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true }, version: { type: String, required: true, trim: true, maxlength: 128 } },
    { _id: false }
)

/**
 * The version each environment runs: one with none does not get the application. As for the resources, that each one
 * belongs to the project is checked by the services. Empty on a new one.
 */
export const environmentVersionsField = { type: [environmentVersionSchema], default: () => [] }

/** The environments where the container is deployed continuously; that each one belongs to the project is checked by the services */
export const continuousDeploymentField = { type: [{ type: Schema.Types.ObjectId, ref: "Environment" }], default: undefined }
