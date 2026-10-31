/**
 * The CPU and memory a container asks for and is held to, as Kubernetes quantities. Each one is optional:
 * left out, the chart of the applications repository sets it, with the values below.
 */
export interface ContainerResources {
    cpuRequest?: string | null
    cpuLimit?: string | null
    memoryRequest?: string | null
    memoryLimit?: string | null
    /** The pods of the Deployment: left out, the chart runs one */
    replicas?: number | null
}

export const CONTAINER_RESOURCE_FIELDS = ["cpuRequest", "cpuLimit", "memoryRequest", "memoryLimit"] as const

/** What one environment sets apart from the values of the application: each one left out is the application's */
export interface EnvironmentResources extends ContainerResources {
    environmentId: unknown
}

/** The resources of an application, with those it sets apart in some environments */
export interface ContainerResourcesByEnvironment extends ContainerResources {
    environmentResources?: EnvironmentResources[] | null
}

/** The resources of an application in one environment: what the environment sets, else what the application sets */
export const resourcesIn = (application: ContainerResourcesByEnvironment, environmentId: unknown): ContainerResources => {
    const own = application.environmentResources?.find(entry => String(entry.environmentId) === String(environmentId))
    return {
        ...Object.fromEntries(CONTAINER_RESOURCE_FIELDS.map(field => [field, own?.[field]?.trim() || application[field]?.trim() || null])),
        replicas: own?.replicas ?? application.replicas ?? null
    }
}

/** The pods the chart runs of a container that sets none, and the most one may set */
export const CHART_REPLICAS_DEFAULT = 1
export const MAX_REPLICAS = 20

export const isReplicaCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_REPLICAS

/** What the chart Flightroom writes gives a container that sets none of them */
export const CHART_RESOURCE_DEFAULTS = { cpuRequest: "25m", cpuLimit: "500m", memoryRequest: "128Mi", memoryLimit: "512Mi" }

/** CPU in cores or millicores: 250m, 0.5, 1. Kubernetes keeps no precision below 1m */
const CPU_QUANTITY = /^(?:(\d{1,9})m|(\d{1,6}(?:\.\d{1,3})?))$/

/** Memory in bytes, with a binary or a decimal suffix: 128Mi, 1Gi, 512M, 1000000 */
const MEMORY_QUANTITY = /^(\d{1,15}(?:\.\d{1,6})?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/

const MEMORY_UNITS: Record<string, number> = {
    "": 1,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    Pi: 2 ** 50,
    Ei: 2 ** 60
}

/** Millicores; undefined for what is not a CPU quantity or is zero */
export const parseCpu = (value: string): number | undefined => {
    const match = CPU_QUANTITY.exec(value)
    if (!match) return undefined
    const millicores = match[1] !== undefined ? Number(match[1]) : Number(match[2]) * 1000
    return millicores > 0 ? millicores : undefined
}

/** Bytes; undefined for what is not a memory quantity or is zero */
export const parseMemory = (value: string): number | undefined => {
    const match = MEMORY_QUANTITY.exec(value)
    if (!match) return undefined
    const bytes = Number(match[1]) * MEMORY_UNITS[match[2] ?? ""]
    return bytes > 0 ? bytes : undefined
}

/**
 * The resource whose request ends up above its limit, which Kubernetes refuses the Deployment for. One left out is
 * the default of the chart: a request of 1 with no limit is above its 500m. Undefined when both fit, or a value
 * is not a quantity at all, which the field itself refuses.
 */
export const requestAboveLimit = (resources: ContainerResources): "cpu" | "memory" | undefined => {
    const effective = (field: (typeof CONTAINER_RESOURCE_FIELDS)[number]) => resources[field]?.trim() || CHART_RESOURCE_DEFAULTS[field]
    const cpu = [parseCpu(effective("cpuRequest")), parseCpu(effective("cpuLimit"))]
    if (cpu[0] !== undefined && cpu[1] !== undefined && cpu[0] > cpu[1]) return "cpu"
    const memory = [parseMemory(effective("memoryRequest")), parseMemory(effective("memoryLimit"))]
    if (memory[0] !== undefined && memory[1] !== undefined && memory[0] > memory[1]) return "memory"
    return undefined
}
