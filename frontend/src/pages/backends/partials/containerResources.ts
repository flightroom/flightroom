import type { TFunction } from "i18next"
import * as z from "zod"

/** Same as the backend (ContainerResources.ts): the CPU and memory of a container, as Kubernetes quantities */
export const RESOURCE_FIELDS = ["cpuRequest", "cpuLimit", "memoryRequest", "memoryLimit"] as const
export type ResourceField = (typeof RESOURCE_FIELDS)[number]
export type ContainerResources = Partial<Record<ResourceField, string | null>>

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

/** The four fields of a form: empty means the default of the chart */
export const createResourceShape = (messages: ResourceMessages) => {
    const quantity = (parse: (value: string) => number | undefined, message: string) =>
        z
            .string()
            .trim()
            .refine(value => value === "" || parse(value) !== undefined, message)
    return {
        cpuRequest: quantity(parseCpu, messages.cpuInvalid),
        cpuLimit: quantity(parseCpu, messages.cpuInvalid),
        memoryRequest: quantity(parseMemory, messages.memoryInvalid),
        memoryLimit: quantity(parseMemory, messages.memoryInvalid)
    }
}

/**
 * Same rule as the backend (requestAboveLimit): Kubernetes refuses a request above its limit, an empty one being the
 * default of the chart. The issue lands on the request when it was typed, else on the limit.
 */
export const refineResources = (data: ContainerResources, ctx: z.RefinementCtx, messages: ResourceMessages) => {
    const effective = (field: ResourceField) => data[field]?.trim() || CHART_RESOURCE_DEFAULTS[field]
    const pairs = [
        { request: "cpuRequest", limit: "cpuLimit", parse: parseCpu, message: messages.cpuRequestAboveLimit },
        { request: "memoryRequest", limit: "memoryLimit", parse: parseMemory, message: messages.memoryRequestAboveLimit }
    ] as const
    for (const { request, limit, parse, message } of pairs) {
        const [requested, limited] = [parse(effective(request)), parse(effective(limit))]
        if (requested === undefined || limited === undefined || requested <= limited) continue
        ctx.addIssue({ code: "custom", message: message(effective(limit)), path: [data[request]?.trim() ? request : limit] })
    }
}

/** What the form holds for a container: empty for a value it does not set */
export const resourceFormValues = (container?: ContainerResources): Record<ResourceField, string> => ({
    cpuRequest: container?.cpuRequest ?? "",
    cpuLimit: container?.cpuLimit ?? "",
    memoryRequest: container?.memoryRequest ?? "",
    memoryLimit: container?.memoryLimit ?? ""
})
