/**
 * The environment variables every deploy hands to the containers of an environment, next to HTTP_PORT: how much
 * they log and in which format, set on the environment (the level may be set apart by an application), the slug of the environment and the public URL of the container.
 */

/** The levels an environment logs at, from the most verbose: the names most logging libraries take */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** What an environment logs at when none is set on it */
export const DEFAULT_LOG_LEVEL: LogLevel = "info"

export const isLogLevel = (value: unknown): value is LogLevel => typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)

export const LOG_LEVEL_VARIABLE = "LOG_LEVEL"
export const LOG_JSON_VARIABLE = "LOG_JSON"
export const ENVIRONMENT_VARIABLE = "ENVIRONMENT"
export const PUBLIC_URL_VARIABLE = "PUBLIC_URL"

/** Set by every deploy on every container: a resource setting one of them too would be there twice */
export const RUNTIME_VARIABLES = [LOG_LEVEL_VARIABLE, LOG_JSON_VARIABLE, ENVIRONMENT_VARIABLE, PUBLIC_URL_VARIABLE]

/** What an environment sets of them; an environment saved before they existed logs at info, in JSON */
export interface EnvironmentLogging {
    logLevel?: string | null
    logJson?: boolean | null
}

/** What a backend, a DOCKER frontend or a maintenance agent may set apart: a level of its own, in every environment */
export interface ApplicationLogging {
    /** Null or left out: the level of the environment it runs in */
    logLevel?: string | null
}

/** LOG_LEVEL of a container: its own, else the environment's, else info */
export const effectiveLogLevel = (environment: EnvironmentLogging, own?: string | null): LogLevel =>
    isLogLevel(own) ? own : isLogLevel(environment.logLevel) ? environment.logLevel : DEFAULT_LOG_LEVEL

/** The variables a container gets in an environment; PUBLIC_URL only where there is one, and LOG_LEVEL its own when it sets one */
export const runtimeVariables = (environment: { slug: string } & EnvironmentLogging, publicUrl?: string, ownLogLevel?: string | null): Array<{ name: string; value: string }> => [
    { name: LOG_LEVEL_VARIABLE, value: effectiveLogLevel(environment, ownLogLevel) },
    { name: LOG_JSON_VARIABLE, value: String(environment.logJson !== false) },
    { name: ENVIRONMENT_VARIABLE, value: environment.slug },
    ...(publicUrl ? [{ name: PUBLIC_URL_VARIABLE, value: publicUrl }] : [])
]
