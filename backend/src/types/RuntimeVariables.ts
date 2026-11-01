/**
 * The environment variables every deploy hands to the containers of an environment, next to HTTP_PORT: how much
 * they log and in which format, set on the environment, and the public URL of the frontend.
 */

/** The levels an environment logs at, from the most verbose: the names most logging libraries take */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

/** What an environment logs at when none is set on it */
export const DEFAULT_LOG_LEVEL: LogLevel = "info"

export const isLogLevel = (value: unknown): value is LogLevel => typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)

export const LOG_LEVEL_VARIABLE = "LOG_LEVEL"
export const LOG_JSON_VARIABLE = "LOG_JSON"
export const PUBLIC_URL_VARIABLE = "PUBLIC_URL"

/** Set by every deploy on every container: a resource setting one of them too would be there twice */
export const RUNTIME_VARIABLES = [LOG_LEVEL_VARIABLE, LOG_JSON_VARIABLE, PUBLIC_URL_VARIABLE]

/** What an environment sets of them; an environment saved before they existed logs at info, in JSON */
export interface EnvironmentLogging {
    logLevel?: string | null
    logJson?: boolean | null
}

/** The variables a container gets in an environment; PUBLIC_URL only where there is one */
export const runtimeVariables = (environment: EnvironmentLogging, publicUrl?: string): Array<{ name: string; value: string }> => [
    { name: LOG_LEVEL_VARIABLE, value: isLogLevel(environment.logLevel) ? environment.logLevel : DEFAULT_LOG_LEVEL },
    { name: LOG_JSON_VARIABLE, value: String(environment.logJson !== false) },
    ...(publicUrl ? [{ name: PUBLIC_URL_VARIABLE, value: publicUrl }] : [])
]
