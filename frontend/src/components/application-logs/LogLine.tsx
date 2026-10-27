import { format, isValid } from "date-fns"
import type { ArgoCdLogLine } from "@/hooks/apiClients/useArgoCdApi"
import { cn } from "@/utils/styleUtils"

/** The numeric levels of pino and bunyan */
const NUMERIC_LEVELS: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" }
/** The fields the summary shows on their own, or that only repeat what the line already says */
const SUMMARY_FIELDS = new Set(["level", "severity", "lvl", "log.level", "msg", "message", "time", "timestamp", "@timestamp", "ts", "pid", "hostname", "v"])
const SUMMARY_FIELD_LENGTH = 80

type JsonObject = Record<string, unknown>

/** The line as an object, when the application logs JSON; anything else stays text. */
const parseJsonLine = (content: string): JsonObject | undefined => {
    const trimmed = content.trim()
    if (!trimmed.startsWith("{")) return undefined
    try {
        const value: unknown = JSON.parse(trimmed)
        return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined
    } catch {
        return undefined
    }
}

const levelOf = (entry: JsonObject) => {
    const level = entry.level ?? entry.severity ?? entry.lvl ?? entry["log.level"]
    if (typeof level === "number") return NUMERIC_LEVELS[level] ?? String(level)
    return typeof level === "string" ? level.toLowerCase() : undefined
}

const levelClass = (level: string) => {
    if (["error", "fatal", "critical", "crit", "alert", "emergency", "panic"].includes(level)) return "text-destructive"
    if (["warn", "warning"].includes(level)) return "text-warning"
    if (["debug", "trace"].includes(level)) return "text-foreground-secondary"
    return "text-primary-strong"
}

const fieldText = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    return text.length > SUMMARY_FIELD_LENGTH ? `${text.slice(0, SUMMARY_FIELD_LENGTH)}…` : text
}

const Timestamp: React.FC<{ value?: string }> = ({ value }) =>
    value && isValid(new Date(value)) ? <span className="text-foreground-secondary select-none">{format(new Date(value), "yyyy-MM-dd HH:mm:ss")} </span> : null

/**
 * One line of the logs. With `formatJson`, a JSON line reads as its level, its message and the other fields,
 * and opens on the whole object, indented; the text of the line stays what the pod wrote, for the download.
 */
export const LogLine: React.FC<{ line: ArgoCdLogLine; formatJson: boolean }> = ({ line, formatJson }) => {
    const entry = formatJson ? parseJsonLine(line.content) : undefined
    if (!entry) {
        return (
            <span className="block">
                <Timestamp value={line.timestamp} />
                {line.content}
            </span>
        )
    }

    const level = levelOf(entry)
    const message = entry.msg ?? entry.message
    const fields = Object.entries(entry).filter(([key]) => !SUMMARY_FIELDS.has(key))

    return (
        <details className="block">
            <summary className="cursor-pointer list-none hover:bg-background/60 [&::-webkit-details-marker]:hidden">
                <Timestamp value={line.timestamp} />
                {level && <span className={cn("font-semibold uppercase", levelClass(level))}>{level} </span>}
                {message !== undefined && <span>{fieldText(message)} </span>}
                {fields.map(([key, value]) => (
                    <span key={key} className="text-foreground-secondary">
                        {key}={fieldText(value)}{" "}
                    </span>
                ))}
            </summary>
            <span className="block border-l-2 border-divider pl-3 text-foreground-secondary">{JSON.stringify(entry, null, 2)}</span>
        </details>
    )
}

export default LogLine
