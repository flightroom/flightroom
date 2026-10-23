import ServiceDTO from "./ServiceDTO"

/**
 * How a maintenance agent runs. A CONTAINER is always on, like a backend service, and does its work when its
 * run path is called; a JOB is a container that starts, does its work and exits. Both run on a schedule, on
 * Play, or both: what starts them is a Kubernetes CronJob in every environment.
 */
export enum MaintenanceAgentKind {
    CONTAINER = "container",
    JOB = "job"
}

/** What the CronJob of a CONTAINER calls by default */
export const DEFAULT_RUN_PATH = "/run"

const MACROS = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"])

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

/** The five fields of a cron expression as Kubernetes reads them: minute, hour, day of month, month, day of week */
const FIELDS: Array<{ min: number; max: number; names?: string[] }> = [
    { min: 0, max: 59 },
    { min: 0, max: 23 },
    { min: 1, max: 31 },
    { min: 1, max: 12, names: MONTHS },
    // 0 to 6 only: the cron parser of Kubernetes refuses 7 for Sunday
    { min: 0, max: 6, names: DAYS }
]

const fieldValue = (token: string, field: (typeof FIELDS)[number]): number | undefined => {
    const named = field.names?.indexOf(token.toLowerCase()) ?? -1
    if (named >= 0) return named + field.min
    if (!/^\d+$/.test(token)) return undefined
    const value = Number(token)
    return value >= field.min && value <= field.max ? value : undefined
}

const isValidPart = (part: string, field: (typeof FIELDS)[number]): boolean => {
    const [range, step, ...rest] = part.split("/")
    if (rest.length > 0 || (step !== undefined && !/^[1-9]\d*$/.test(step))) return false
    if (range === "*" || range === "?") return true
    const [from, to, ...more] = range.split("-")
    if (more.length > 0) return false
    const start = fieldValue(from, field)
    if (start === undefined) return false
    if (to === undefined) return true
    const end = fieldValue(to, field)
    return end !== undefined && start <= end
}

/**
 * A cron expression a Kubernetes CronJob takes: five fields, or a macro such as `@daily`. Checked here so a
 * schedule the cluster would refuse never reaches the GitOps repository, where the sync would only fail.
 */
export const isValidSchedule = (schedule: string): boolean => {
    const trimmed = schedule.trim()
    if (MACROS.has(trimmed.toLowerCase())) return true
    const parts = trimmed.split(/\s+/)
    return parts.length === FIELDS.length && parts.every((part, index) => part.split(",").every(item => isValidPart(item, FIELDS[index])))
}

/**
 * The IANA name of a time zone as the cluster reads it, e.g. `europe/rome` → `Europe/Rome`; undefined for one it
 * would refuse. Intl takes any case and UTC offsets too, the cluster neither: a name only, written as IANA writes it.
 */
export const canonicalTimeZone = (timeZone: string): string | undefined => {
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return undefined
    try {
        const resolved = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone
        return resolved.toLowerCase() === timeZone.toLowerCase() ? resolved : undefined
    } catch {
        return undefined
    }
}

export interface MaintenanceAgentDTO extends Omit<ServiceDTO, "docsPath" | "openApiPath" | "exposurePath"> {
    kind?: MaintenanceAgentKind
    /** A cron expression; blank or null when it runs only on Play */
    schedule?: string | null
    /** The IANA time zone of the schedule; blank or null for the one of the cluster */
    timeZone?: string | null
    /** A CONTAINER only: the path its CronJob POSTs to */
    runPath?: string
    /** The backend services it maintains */
    serviceIds?: string[]
    /** The frontends it maintains */
    frontendIds?: string[]
}
