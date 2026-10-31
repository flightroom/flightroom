import type { TFunction } from "i18next"
import * as z from "zod"

/** Same as the backend (ContainerResources.ts): the CPU and memory of a container, as Kubernetes quantities */
export const RESOURCE_FIELDS = ["cpuRequest", "cpuLimit", "memoryRequest", "memoryLimit"] as const
export type ResourceField = (typeof RESOURCE_FIELDS)[number]
export type ContainerResources = Partial<Record<ResourceField, string | null>>

/** Same as the backend: the pods of the Deployment, null for the default of the chart */
export type ContainerReplicas = { replicas?: number | null }

/** Same as the backend: what one environment sets apart, each value left blank being the container's */
export type EnvironmentResources = ContainerResources & ContainerReplicas & { environmentId: string }

/** The form values of one environment that sets its CPU, memory or replicas apart */
export type EnvironmentResourcesFormValues = Record<ResourceField, string> & { replicas: string; environmentId: string }

/** Same as the backend: what the chart of the applications repository sets for a value left empty */
export const CHART_RESOURCE_DEFAULTS: Record<ResourceField, string> = { cpuRequest: "25m", cpuLimit: "500m", memoryRequest: "128Mi", memoryLimit: "512Mi" }

/** Same as the backend (CHART_REPLICAS_DEFAULT, MAX_REPLICAS) */
export const CHART_REPLICAS_DEFAULT = 1
export const MAX_REPLICAS = 20

/** Same as the backend: the seconds before the first probe and between probes, for the liveness and the readiness ones; null for the default of the chart */
export const CHART_PROBE_SECONDS_DEFAULT = 30
export const MAX_PROBE_SECONDS = 3600

const CPU_QUANTITY = /^(?:(\d{1,9})m|(\d{1,6}(?:\.\d{1,3})?))$/
const MEMORY_QUANTITY = /^(\d{1,15}(?:\.\d{1,6})?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/
const MEMORY_UNITS: Record<string, number> = { "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 }

/** Millicores; undefined for what is not a CPU quantity above zero */
const parseCpu = (value: string): number | undefined => {
    const match = CPU_QUANTITY.exec(value)
    if (!match) return undefined
    const millicores = match[1] !== undefined ? Number(match[1]) : Number(match[2]) * 1000
    return millicores > 0 ? millicores : undefined
}

/** Bytes; undefined for what is not a memory quantity above zero */
const parseMemory = (value: string): number | undefined => {
    const match = MEMORY_QUANTITY.exec(value)
    if (!match) return undefined
    const bytes = Number(match[1]) * MEMORY_UNITS[match[2] ?? ""]
    return bytes > 0 ? bytes : undefined
}

export interface ResourceMessages {
    cpuInvalid: string
    memoryInvalid: string
    cpuRequestAboveLimit: (limit: string) => string
    memoryRequestAboveLimit: (limit: string) => string
    replicasInvalid: string
    probeInitialDelayInvalid: string
    probePeriodInvalid: string
}

export const resourceMessages = (t: TFunction): ResourceMessages => ({
    cpuInvalid: t("backends.compute.cpu_invalid"),
    memoryInvalid: t("backends.compute.memory_invalid"),
    cpuRequestAboveLimit: limit => t("backends.compute.cpu_request_above_limit", { limit }),
    memoryRequestAboveLimit: limit => t("backends.compute.memory_request_above_limit", { limit }),
    replicasInvalid: t("backends.compute.replicas_invalid", { max: MAX_REPLICAS }),
    probeInitialDelayInvalid: t("backends.probe_initial_delay_invalid", { max: MAX_PROBE_SECONDS }),
    probePeriodInvalid: t("backends.probe_period_invalid", { max: MAX_PROBE_SECONDS })
})

/** A blank field, or an integer from `min` to MAX_PROBE_SECONDS */
export const probeSecondsField = (min: number, message: string) =>
    z
        .string()
        .trim()
        .refine(value => value === "" || (/^\d{1,4}$/.test(value) && Number(value) >= min && Number(value) <= MAX_PROBE_SECONDS), message)

/** The five fields of a form, empty meaning the default of the chart, and those each environment sets apart, empty meaning the container's */
export const createResourceShape = (messages: ResourceMessages) => {
    const quantity = (parse: (value: string) => number | undefined, message: string) =>
        z
            .string()
            .trim()
            .refine(value => value === "" || parse(value) !== undefined, message)
    const fields = {
        cpuRequest: quantity(parseCpu, messages.cpuInvalid),
        cpuLimit: quantity(parseCpu, messages.cpuInvalid),
        memoryRequest: quantity(parseMemory, messages.memoryInvalid),
        memoryLimit: quantity(parseMemory, messages.memoryInvalid),
        replicas: z
            .string()
            .trim()
            .refine(value => value === "" || (/^\d{1,2}$/.test(value) && Number(value) >= 0 && Number(value) <= MAX_REPLICAS), messages.replicasInvalid)
    }
    return { ...fields, environmentResources: z.array(z.object({ environmentId: z.string(), ...fields })) }
}

/**
 * Same rule as the backend (ensureRequestsWithinLimits): Kubernetes refuses a request above its limit, an empty one
 * being the default of the chart. An environment is checked on what it ends up with, its own values else the
 * container's, and only for a pair it sets: the container's own is reported once, on its fields. The issue lands on
 * the request when it was typed, else on the limit.
 */
export const refineResources = (data: ContainerResources & { environmentResources?: ContainerResources[] }, ctx: z.RefinementCtx, messages: ResourceMessages) => {
    const pairs = [
        { request: "cpuRequest", limit: "cpuLimit", parse: parseCpu, message: messages.cpuRequestAboveLimit },
        { request: "memoryRequest", limit: "memoryLimit", parse: parseMemory, message: messages.memoryRequestAboveLimit }
    ] as const
    const refine = (values: ContainerResources, path: (string | number)[], base?: ContainerResources) => {
        const effective = (field: ResourceField) => values[field]?.trim() || base?.[field]?.trim() || CHART_RESOURCE_DEFAULTS[field]
        for (const { request, limit, parse, message } of pairs) {
            if (base && !values[request]?.trim() && !values[limit]?.trim()) continue
            const [requested, limited] = [parse(effective(request)), parse(effective(limit))]
            if (requested === undefined || limited === undefined || requested <= limited) continue
            ctx.addIssue({ code: "custom", message: message(effective(limit)), path: [...path, values[request]?.trim() ? request : limit] })
        }
    }
    refine(data, [])
    data.environmentResources?.forEach((entry, index) => refine(entry, ["environmentResources", index], data))
}

const fieldValues = (container?: ContainerResources & ContainerReplicas): Record<ResourceField | "replicas", string> => ({
    cpuRequest: container?.cpuRequest ?? "",
    cpuLimit: container?.cpuLimit ?? "",
    memoryRequest: container?.memoryRequest ?? "",
    memoryLimit: container?.memoryLimit ?? "",
    replicas: container?.replicas != null ? String(container.replicas) : ""
})

/** What the API receives for the replicas of the form: null for an empty field, the default of the chart */
export const replicaCount = (value?: string): number | null => (value?.trim() ? Number(value) : null)

/** The timings of the liveness and readiness probes: the seconds before the first one and between two */
export const PROBE_TIMING_FIELDS = ["livenessInitialDelaySeconds", "livenessPeriodSeconds", "readinessInitialDelaySeconds", "readinessPeriodSeconds"] as const
export type ProbeTimingField = (typeof PROBE_TIMING_FIELDS)[number]
export type ProbeTimings = Partial<Record<ProbeTimingField, number | null>>

/** The paths Kubernetes probes, with what the platform uses for one that neither the container nor the project template sets */
export const PROBE_PATH_FIELDS = ["livenessPath", "readinessPath"] as const
export type ProbePathField = (typeof PROBE_PATH_FIELDS)[number]
export const PROBE_PATH_DEFAULTS: Record<ProbePathField, string> = { livenessPath: "/health/live", readinessPath: "/health/ready" }

/** Same as the backend: the probe template of a project, for its backends (or frontends): null or absent is the platform default */
export type ProbeTemplate = Partial<Record<ProbePathField, string | null>> & ProbeTimings
export type ProbeSide = "backend" | "frontend"
export type ProbeField = ProbePathField | ProbeTimingField
export const PROBE_FIELDS: readonly ProbeField[] = [...PROBE_PATH_FIELDS, ...PROBE_TIMING_FIELDS]

/** What the API receives for the probe timings of the form: null for an empty field, inherited from the project */
export const probeTimings = (values: Record<ProbeTimingField, string | undefined>): Record<ProbeTimingField, number | null> =>
    Object.fromEntries(PROBE_TIMING_FIELDS.map(field => [field, values[field]?.trim() ? Number(values[field]) : null])) as Record<ProbeTimingField, number | null>

/** What the API receives for the probe paths of the form: null for a blank field, inherited from the project */
export const probePaths = (values: Partial<Record<ProbePathField, string | undefined>>): Record<ProbePathField, string | null> =>
    Object.fromEntries(PROBE_PATH_FIELDS.map(field => [field, values[field]?.trim() || null])) as Record<ProbePathField, string | null>

/** The probe fields of a container in the form: empty to inherit the project template */
export const probeFormValues = (container?: ProbeTimings & Partial<Record<ProbePathField, string | null>>): Record<ProbeField, string> =>
    Object.fromEntries(PROBE_FIELDS.map(field => [field, container?.[field] != null ? String(container[field]) : ""])) as Record<ProbeField, string>

/** Where the effective value of a probe field comes from */
export type ProbeSource = "component" | "project" | "default"

/** Same as the backend: the value of the component, else the template of the project, else the platform default */
export const effectiveProbe = (field: ProbeField, own: string | number | null | undefined, template?: ProbeTemplate): { value: string | number; source: ProbeSource } => {
    if (own != null && own !== "") return { value: own, source: "component" }
    const inherited = template?.[field]
    if (inherited != null && inherited !== "") return { value: inherited, source: "project" }
    return { value: field in PROBE_PATH_DEFAULTS ? PROBE_PATH_DEFAULTS[field as ProbePathField] : CHART_PROBE_SECONDS_DEFAULT, source: "default" }
}

/** What the form holds for a container: empty for a value it does not set, and the environments that set some apart */
export const resourceFormValues = (
    container?: ContainerResources & ContainerReplicas & { environmentResources?: EnvironmentResources[] | null }
): Record<ResourceField | "replicas", string> & { environmentResources: EnvironmentResourcesFormValues[] } => ({
    ...fieldValues(container),
    environmentResources: (container?.environmentResources ?? []).map(entry => ({ environmentId: entry.environmentId, ...fieldValues(entry) }))
})
