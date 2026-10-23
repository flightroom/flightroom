import { Meter } from "@flightroom/design-system"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import { JOB_ERROR_CODES, jobErrorMessage } from "@/components/assistant/AssistantJobThread"
import { Badge, type IBadgeProps } from "@/components/atoms"
import type { AiMissionCounts, AiMissionRepositoryView, AiMissionStatus, AiMissionView } from "@/hooks/apiClients/useAiMissionsApi"
import { errorCodeOf } from "@/hooks/useApiClient"

/** Error codes of the mission endpoints with a message of their own; the job ones keep the assistant's. */
const MISSION_ERROR_CODES = new Set([
    "AI_MISSION_TOO_MANY_REPOSITORIES",
    "AI_MISSION_NOT_RUNNING",
    "AI_MISSION_INVALID_SELECTION",
    "AI_MISSION_EMPTY_PROMPT",
    "AI_CHANGE_TOO_MANY",
    "AI_JOB_NOT_OWNER",
    "DOMAIN_SCOPE_FORBIDDEN"
])

/** The translated message of a failed mission call; `fallback` is a key under `fleet.errors`. */
export const missionErrorMessage = (t: TFunction, error: Error, fallback: "load" | "create" | "stop" | "apply") => {
    const code = errorCodeOf(error)
    if (code && MISSION_ERROR_CODES.has(code)) return t(`fleet.errors.${code}`)
    if (code === "RATE_LIMITED" || (code && JOB_ERROR_CODES.has(code))) return jobErrorMessage(t, error, fallback)
    return t(`fleet.errors.${fallback}`)
}

const MISSION_STATUS_VARIANT: Record<AiMissionStatus, IBadgeProps["variant"]> = {
    RUNNING: "info",
    DONE: "success",
    FAILED: "destructive",
    STOPPED: "warning"
}

export const MissionStatusBadge: React.FC<{ status: AiMissionStatus }> = ({ status }) => {
    const { t } = useTranslation()
    return <Badge variant={MISSION_STATUS_VARIANT[status]}>{t(`fleet.status.${status}`)}</Badge>
}

export const MissionModeBadge: React.FC<{ mode: AiMissionView["mode"] }> = ({ mode }) => {
    const { t } = useTranslation()
    return <Badge variant="outline">{t(`fleet.mode.${mode}`)}</Badge>
}

/** Where one repository of the mission stands, from its job and its change request. */
export type RepositoryState = "queued" | "notStarted" | "running" | "proposed" | "applying" | "applied" | "failed" | "noChanges"

/** In the same order as the backend's counts, so a row's badge and the counts always agree. */
export const repositoryState = (repository: AiMissionRepositoryView, missionRunning: boolean): RepositoryState => {
    if (!repository.jobStatus) {
        // No job: it could not be started, it is being started, or it waits for its batch (never to come once the mission is over).
        if (repository.error) return "failed"
        return repository.jobId || missionRunning ? "queued" : "notStarted"
    }
    if (repository.requestStatus === "APPLIED") return "applied"
    if (repository.requestStatus === "APPLYING") return "applying"
    // A proposal without files leaves nothing to apply.
    if (repository.requestStatus === "PROPOSED") return repository.filesChanged ? "proposed" : "noChanges"
    if (repository.jobStatus === "FAILED" || repository.requestStatus === "FAILED") return "failed"
    // An expired request or a discarded one leave nothing to apply either.
    if (repository.jobStatus === "DONE") return "noChanges"
    if (repository.jobStatus === "PENDING") return "queued"
    return "running"
}

const REPOSITORY_STATE_VARIANT: Record<RepositoryState, IBadgeProps["variant"]> = {
    queued: "outline",
    notStarted: "outline",
    running: "info",
    proposed: "accent",
    applying: "outline",
    applied: "success",
    failed: "destructive",
    noChanges: "outline"
}

export const RepositoryStateBadge: React.FC<{ state: RepositoryState }> = ({ state }) => {
    const { t } = useTranslation()
    return <Badge variant={REPOSITORY_STATE_VARIANT[state]}>{t(`fleet.repository_status.${state}`)}</Badge>
}

const COUNT_KEYS: (keyof AiMissionCounts)[] = ["queued", "running", "proposed", "applying", "applied", "failed", "noChanges"]

/** The repositories by outcome; those with none are left out. */
export const MissionCounts: React.FC<{ counts: AiMissionCounts }> = ({ counts }) => {
    const { t } = useTranslation()
    return (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-secondary">
            {COUNT_KEYS.filter(key => counts[key] > 0).map(key => (
                <li key={key} className={key === "failed" ? "font-medium text-destructive" : key === "proposed" ? "font-medium text-foreground" : undefined}>
                    {t(`fleet.counts.${key}`, { count: counts[key] })}
                </li>
            ))}
        </ul>
    )
}

/** How many repositories are through, out of all of them, and the batch at work. */
export const MissionProgress: React.FC<{ mission: AiMissionView }> = ({ mission }) => {
    const { t } = useTranslation()
    const { proposed, applying, applied, failed, noChanges } = mission.counts
    const total = mission.repositories.length
    const done = proposed + applying + applied + failed + noChanges
    const label = t("fleet.progress_label", { done, total })
    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-secondary">
                <span>{t("fleet.batch_progress", { current: Math.min(mission.currentBatch + 1, mission.batchCount), total: mission.batchCount })}</span>
                <span className="tabular-nums">{label}</span>
            </div>
            <Meter value={done} max={Math.max(total, 1)} label={label} animated={false} />
        </div>
    )
}

/** Who started the mission and when. */
export const MissionAuthor: React.FC<{ mission: AiMissionView }> = ({ mission }) => {
    const { t, i18n } = useTranslation()
    const date = new Date(mission.createdAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" })
    return (
        <span className="text-xs text-foreground-secondary">
            {t("fleet.started_by", { name: mission.userName ?? t("fleet.someone") })} · <time dateTime={mission.createdAt}>{date}</time>
        </span>
    )
}
