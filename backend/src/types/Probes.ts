import { BACKEND_HTTP_PATH } from "./BackendStack"

/** The timings of the liveness and readiness probes of a container, in seconds: each one left out is the chart's */
export interface ProbeTimings {
    /** Before the first liveness probe: a container that starts slowly needs more, or it is restarted before it is up */
    livenessInitialDelaySeconds?: number | null
    /** Between two liveness probes */
    livenessPeriodSeconds?: number | null
    /** Before the first readiness probe */
    readinessInitialDelaySeconds?: number | null
    /** Between two readiness probes */
    readinessPeriodSeconds?: number | null
}

/**
 * The probes of a container, or the template of a project for its backends or its frontends: each one left out
 * of a container is its project's, and each one left out of the project the platform's path or the chart's timing.
 */
export interface ProbeSettings extends ProbeTimings {
    livenessPath?: string | null
    readinessPath?: string | null
}

/** The template of a project: the backends and the maintenance agents follow the backend one, the DOCKER frontends the frontend one */
export interface ProjectProbes {
    backend?: ProbeSettings
    frontend?: ProbeSettings
}

export const PROBE_SIDES = ["backend", "frontend"] as const

export const MAX_PROBE_SECONDS = 3600

/** The least each timing may be: a delay may be none, a period not, as Kubernetes wants */
export const PROBE_TIMING_MINIMUMS: Record<keyof ProbeTimings, number> = {
    livenessInitialDelaySeconds: 0,
    livenessPeriodSeconds: 1,
    readinessInitialDelaySeconds: 0,
    readinessPeriodSeconds: 1
}

export const PROBE_TIMING_FIELDS = Object.keys(PROBE_TIMING_MINIMUMS) as Array<keyof ProbeTimings>

export const PROBE_PATH_FIELDS = ["livenessPath", "readinessPath"] as const

/** What a container is probed on when neither it nor its project says */
export const PLATFORM_PROBE_PATHS = { livenessPath: "/health/live", readinessPath: "/health/ready" }

/** What the chart Flightroom writes gives a container that sets none of them */
export const CHART_PROBE_DEFAULTS = { initialDelaySeconds: 30, periodSeconds: 30 }

export const isProbeSeconds = (value: unknown, minimum: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= MAX_PROBE_SECONDS

export const isProbePath = (value: unknown): value is string => typeof value === "string" && BACKEND_HTTP_PATH.test(value)

/**
 * The probes of a container: its own, else the template of its project. The paths always have one, the platform's
 * last; a timing left out of both stays out, for the chart to give its own.
 */
export const effectiveProbes = (own: ProbeSettings, template?: ProbeSettings | null): ProbeSettings & typeof PLATFORM_PROBE_PATHS => {
    const timings = Object.fromEntries(PROBE_TIMING_FIELDS.flatMap(field => [own[field] ?? template?.[field]].filter(value => value != null).map(value => [field, value])))
    return {
        livenessPath: own.livenessPath || template?.livenessPath || PLATFORM_PROBE_PATHS.livenessPath,
        readinessPath: own.readinessPath || template?.readinessPath || PLATFORM_PROBE_PATHS.readinessPath,
        ...timings
    }
}
