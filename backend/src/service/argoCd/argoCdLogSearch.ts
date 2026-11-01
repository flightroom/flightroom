import { ArgoCdLogLine, ArgoCdPod } from "../../client/ArgoCdClient"
import { isLogLevel, LOG_LEVELS, LogLevel } from "../../types/RuntimeVariables"

/** Lines read from the end of each pod when the search says none */
export const DEFAULT_SEARCH_TAIL_LINES = 200
/** Lines a search answers with when it says none: the newest */
export const DEFAULT_SEARCH_MAX_LINES = 300
export const MAX_SEARCH_LINES = 5000
/** Lines a search answers with at most: they all reach the context of a model */
export const MAX_SEARCH_ANSWER_LINES = 1000
/** Applications one search reads at most, all environments together, and pods */
export const MAX_SEARCH_TARGETS = 40
export const MAX_SEARCHED_PODS = 60
/** The applications whose pods are read at once */
export const SEARCH_CONCURRENCY = 4
/** A line longer than this is cut: a JSON line may carry a whole payload */
export const MAX_LINE_LENGTH = 2000

/** What application_logs_search is asked for */
export interface LogSearchInput {
    environmentIds: string[]
    /** Every backend and container frontend each environment runs when left out */
    slugs?: string[]
    tailLines?: number
    sinceSeconds?: number
    /** Only the lines holding this text, whatever its case */
    filter?: string
    /** Without the lines holding this text, whatever its case */
    exclude?: string
    minLevel?: LogLevel
    /** false: not the lines of the container before the restart of a pod that restarted */
    previous?: boolean
    maxLines?: number
}

/** What one application gave in one environment */
export interface LogSearchSource {
    environment: string
    application: string
    pods: number
    /** Lines kept, before the cut to maxLines */
    matched: number
    error?: string
}

export interface LogSearchDTO {
    /** Oldest first, each as `<time> <environment>/<pod> <text>`, `(previous)` after the pod for those of the container before its restart */
    lines: string[]
    /** Lines kept in all, before the cut to maxLines */
    matched: number
    /** More lines were kept than maxLines: the oldest were left out */
    truncated: boolean
    sources: LogSearchSource[]
    notes?: string[]
}

/** The lines of one container of one pod */
export interface LogStream {
    environment: string
    pod: string
    previous: boolean
    lines: ArgoCdLogLine[]
}

/** The numbers pino and bunyan write: 10 trace to 60 fatal */
const numericLevel = (value: number): LogLevel => LOG_LEVELS[Math.min(Math.max(Math.floor(value / 10) - 1, 0), LOG_LEVELS.length - 1)]

/** Other names of the levels, those of .NET (Information, and fail: or dbug: in its console) among them */
const LEVEL_ALIASES: Record<string, LogLevel> = {
    warning: "warn",
    err: "error",
    fail: "error",
    critical: "fatal",
    crit: "fatal",
    panic: "fatal",
    notice: "info",
    information: "info",
    verbose: "debug",
    dbug: "debug",
    trce: "trace"
}
/** A level word as a line of text writes it: INFO, [warn], level=error, fail:. Not one of a path, as GET /api/info */
const LEVEL_WORD = /(?<![/\w.-])(trace|trce|debug|dbug|verbose|information|info|notice|warn|warning|error|err|fail|fatal|critical|crit|panic)\b/i
/** Where a line of text says its level: a level word past it belongs to the message */
const LEVEL_PREFIX_LENGTH = 80

const toLevel = (value: unknown): LogLevel | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) return numericLevel(value)
    if (typeof value !== "string") return undefined
    const name = value.trim().toLowerCase()
    return isLogLevel(name) ? name : LEVEL_ALIASES[name]
}

/** The level a line was written at: the `level` (or `severity`) of a JSON line, else a level word at the start of the text */
export const levelOf = (content: string): LogLevel | undefined => {
    const text = content.trim()
    if (text.startsWith("{")) {
        try {
            const entry = JSON.parse(text) as Record<string, unknown>
            return toLevel(entry.level ?? entry.severity ?? entry.lvl ?? entry["log.level"])
        } catch {
            // Not JSON after all: read as text
        }
    }
    const word = LEVEL_WORD.exec(text.slice(0, LEVEL_PREFIX_LENGTH))
    return word ? toLevel(word[1]) : undefined
}

/**
 * The lines of one stream a search keeps. `filter` and `exclude` ignore case. With `minLevel`, a line with no level of
 * its own takes that of the line before it, as a stack trace takes that of the error it follows; one with none before it
 * is left out.
 */
export const keptLines = (lines: ArgoCdLogLine[], { filter, exclude, minLevel }: Pick<LogSearchInput, "filter" | "exclude" | "minLevel">): ArgoCdLogLine[] => {
    const wanted = filter?.toLowerCase()
    const unwanted = exclude?.toLowerCase()
    const least = minLevel ? LOG_LEVELS.indexOf(minLevel) : -1
    let current: LogLevel | undefined
    return lines.filter(line => {
        if (least >= 0) current = levelOf(line.content) ?? current
        const text = line.content.toLowerCase()
        if (wanted && !text.includes(wanted)) return false
        if (unwanted && text.includes(unwanted)) return false
        return least < 0 || (current !== undefined && LOG_LEVELS.indexOf(current) >= least)
    })
}

/**
 * The lines of every stream in one list, oldest first, the newest `maxLines` of them. A line without a time keeps the place
 * of the line before it in its stream.
 */
export const mergedLines = (streams: LogStream[], maxLines: number): { lines: string[]; matched: number } => {
    const all: Array<{ at: number; order: number; text: string }> = []
    for (const stream of streams) {
        let at = 0
        for (const line of stream.lines) {
            const time = Date.parse(line.timestamp ?? "")
            if (!Number.isNaN(time)) at = time
            const where = `${stream.environment}/${stream.pod}${stream.previous ? " (previous)" : ""}`
            all.push({ at, order: all.length, text: `${line.timestamp ?? "-"} ${where} ${line.content.slice(0, MAX_LINE_LENGTH)}` })
        }
    }
    all.sort((a, b) => a.at - b.at || a.order - b.order)
    return { lines: all.slice(-maxLines).map(line => line.text), matched: all.length }
}

/** A pod whose containers are not all ready, or that restarted: one a crash or a failing probe holds */
export const isTroubled = (pod: ArgoCdPod): boolean => (pod.restarts ?? 0) > 0 || (pod.containers !== undefined && !/^(\d+)\/\1$/.test(pod.containers))

/** `run` on every item, `size` at a time: so many pods must not open as many requests to Argo CD at once */
export const inBatches = async <T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = []
    for (let start = 0; start < items.length; start += size) results.push(...(await Promise.all(items.slice(start, start + size).map(run))))
    return results
}
