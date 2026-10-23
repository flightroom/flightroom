import { Schema } from "mongoose"
import { BACKEND_HTTP_PATH } from "../types/BackendStack"
import { isExposurePath } from "../types/Exposure"

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

/** What a container gets when neither the caller nor a template says otherwise */
export const CONTAINER_DEFAULTS = { port: 8080, livenessPath: "/health/live", readinessPath: "/health/ready" }

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

const httpPathValidator = {
    validator: (value?: string | null) => value == null || BACKEND_HTTP_PATH.test(value),
    message: (props: { path: string; value: unknown }) => `${props.path} "${props.value}" must start with "/", have at most 256 characters and no whitespace`
}

/** A probe path: always set, the template or the platform default when not given */
export const probePath = (defaultValue: string) => ({ type: String, default: defaultValue, trim: true, validate: httpPathValidator })

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
