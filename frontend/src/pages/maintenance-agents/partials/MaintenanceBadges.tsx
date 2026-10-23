import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import type { MaintenanceAgent, MaintenanceAgentKind } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { cn } from "@/utils/styleUtils"
import { describeCron, type MaintenanceStatus } from "./maintenance"

/** The hovering drone of an always-on container, as the bay draws it, small enough for a badge. */
export const DroneGlyph: React.FC<{ className?: string }> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
        <path d="M12 1.5v4" />
        <rect x="7" y="6" width="10" height="8" rx="3.2" fill="currentColor" stroke="none" />
        <circle cx="12" cy="10" r="1.6" className="fill-card" stroke="none" />
        <path d="M7 10H4M17 10h3" />
        <ellipse cx="3.5" cy="10" rx="2" ry="1.4" fill="currentColor" stroke="none" />
        <ellipse cx="20.5" cy="10" rx="2" ry="1.4" fill="currentColor" stroke="none" />
        <path d="M3.5 13v3M20.5 13v3" className="stroke-primary" strokeWidth={2} />
        <path d="M10 15.5 9 18.5M14 15.5l1 3" />
    </svg>
)

/** The shuttle of a job, docked under its crane hook. */
export const ShuttleGlyph: React.FC<{ className?: string }> = ({ className }) => (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
        <path d="M12 1v4.5" />
        <path d="M10.5 5.5a1.5 1.5 0 1 0 3 0" />
        <path d="M4 14.5c0-2.8 3.6-5 9-5 4.4 0 7.5 2.2 8.5 5-1 2.8-4.1 5-8.5 5-5.4 0-9-2.2-9-5Z" fill="currentColor" stroke="none" />
        <circle cx="16.5" cy="14.5" r="1.7" className="fill-card" stroke="none" />
        <path d="M6 10.5 3.5 8M6 18.5 3.5 21" />
        <path d="M2 14.5h1.5" className="stroke-sunglow-600 dark:stroke-sunglow-200" />
    </svg>
)

export const KindGlyph: React.FC<{ kind: MaintenanceAgentKind; className?: string }> = ({ kind, className }) =>
    kind === "job" ? <ShuttleGlyph className={className} /> : <DroneGlyph className={className} />

export const KindBadge: React.FC<{ kind: MaintenanceAgentKind }> = ({ kind }) => {
    const { t } = useTranslation()
    return (
        <Badge variant="outline" className="gap-1.5">
            <KindGlyph kind={kind} className="size-3.5" />
            {t(`maintenance.kind.${kind}`)}
        </Badge>
    )
}

/** The colours of the status lights, the same on the bays, the cards and the tables */
export const STATUS_DOT_CLASS: Record<MaintenanceStatus, string> = {
    failed: "bg-destructive",
    recent: "bg-primary animate-pulse motion-reduce:animate-none",
    scheduled: "bg-olivine-600 dark:bg-olivine-300",
    standby: "bg-sunglow-600 dark:bg-sunglow-200"
}

export const StatusLight: React.FC<{ status: MaintenanceStatus; className?: string }> = ({ status, className }) => {
    const { t } = useTranslation()
    return (
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", className)}>
            <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT_CLASS[status])} aria-hidden="true" />
            {t(`maintenance.status.${status}`)}
        </span>
    )
}

/** The schedule in words when it is a common one, the cron next to it; "manual" without one */
export const ScheduleLabel: React.FC<{ agent: Pick<MaintenanceAgent, "schedule" | "timeZone">; withCron?: boolean; className?: string }> = ({ agent, withCron = true, className }) => {
    const { t, i18n } = useTranslation()
    if (!agent.schedule?.trim()) return <span className={cn("text-foreground-secondary", className)}>{t("maintenance.schedule.manual_only")}</span>
    const described = describeCron(agent.schedule, t, i18n.language)
    return (
        <span className={cn("inline-flex flex-wrap items-baseline gap-x-2", className)}>
            {described && <span>{described}</span>}
            {(withCron || !described) && <code className="font-mono text-xs text-foreground-secondary">{agent.schedule}</code>}
            {agent.timeZone && <span className="text-xs text-foreground-secondary">{agent.timeZone}</span>}
        </span>
    )
}
