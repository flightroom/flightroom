import type { TFunction } from "i18next"
import * as z from "zod"

/** Same as the backend (ContainerResources.ts): the CPU and memory of a container, as Kubernetes quantities */
export const RESOURCE_FIELDS = ["cpuRequest", "cpuLimit", "memoryRequest", "memoryLimit"] as const
export type ResourceField = (typeof RESOURCE_FIELDS)[number]
export type ContainerResources = Partial<Record<ResourceField, string | null>>

/** Same as the backend: what one environment sets apart, each value left blank being the container's */
export type EnvironmentResources = ContainerResources & { environmentId: string }

/** The form values of one environment that sets its CPU and memory apart */
export type EnvironmentResourcesFormValues = Record<ResourceField, string> & { environmentId: string }

/** Same as the backend: what the chart of the applications repository sets for a value left empty */
export const CHART_RESOURCE_DEFAULTS: Record<ResourceField, string> = { cpuRequest: "25m", cpuLimit: "500m", memoryRequest: "128Mi", memoryLimit: "512Mi" }

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
}

export const resourceMessages = (t: TFunction): ResourceMessages => ({
    cpuInvalid: t("backends.compute.cpu_invalid"),
    memoryInvalid: t("backends.compute.memory_invalid"),
    cpuRequestAboveLimit: limit => t("backends.compute.cpu_request_above_limit", { limit }),
    memoryRequestAboveLimit: limit => t("backends.compute.memory_request_above_limit", { limit })
})

/** The four fields of a form, empty meaning the default of the chart, and those each environment sets apart, empty meaning the container's */
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
        memoryLimit: quantity(parseMemory, messages.memoryInvalid)
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

const fieldValues = (container?: ContainerResources): Record<ResourceField, string> => ({
    cpuRequest: container?.cpuRequest ?? "",
    cpuLimit: container?.cpuLimit ?? "",
    memoryRequest: container?.memoryRequest ?? "",
    memoryLimit: container?.memoryLimit ?? ""
})

/** What the form holds for a container: empty for a value it does not set, and the environments that set some apart */
export const resourceFormValues = (
    container?: ContainerResources & { environmentResources?: EnvironmentResources[] | null }
): Record<ResourceField, string> & { environmentResources: EnvironmentResourcesFormValues[] } => ({
    ...fieldValues(container),
    environmentResources: (container?.environmentResources ?? []).map(entry => ({ environmentId: entry.environmentId, ...fieldValues(entry) }))
})
