import { Check, Circle, Loader2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import type { RolloutApplication, RolloutState } from "@/hooks/apiClients/useArgoCdApi"
import { cn } from "@/utils/styleUtils"

const VARIANTS: Record<RolloutState, "success" | "outline" | "info" | "destructive"> = {
    waiting: "outline",
    syncing: "info",
    progressing: "info",
    healthy: "success",
    degraded: "destructive",
    failed: "destructive"
}

const StateIcon: React.FC<{ state: RolloutState }> = ({ state }) => {
    if (state === "healthy") return <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
    if (state === "failed" || state === "degraded") return <X className="size-4 shrink-0 text-destructive" aria-hidden="true" />
    if (state === "waiting") return <Circle className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    return <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
}

/**
 * The frontends and backends a deploy shipped, each with where Argo CD says its rollout stands: what it is
 * waiting for, why it is broken and, while its pods are being replaced, which of them are ready.
 */
export const RolloutApplications: React.FC<{ applications: RolloutApplication[]; className?: string }> = ({ applications, className }) => {
    const { t } = useTranslation()

    if (applications.length === 0) return <p className={cn("text-sm text-foreground-secondary", className)}>{t("deployments.rollout.empty")}</p>

    return (
        <ul className={cn("flex flex-col gap-2", className)} data-testid="rollout-applications">
            {applications.map(application => (
                <li key={application._id} className="flex flex-col gap-1 rounded-md border border-divider bg-background p-3 text-left" data-testid={`rollout-application-${application.slug}`}>
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <StateIcon state={application.state} />
                            <span className="truncate text-sm">{application.name}</span>
                            <span className="shrink-0 text-xs text-foreground-secondary">{t(`deployments.rollout.kinds.${application.kind}`)}</span>
                        </div>
                        <Badge variant={VARIANTS[application.state]} data-testid={`rollout-application-state-${application.slug}`}>
                            {t(`deployments.rollout.states.${application.state}`)}
                        </Badge>
                    </div>
                    {application.message && application.state !== "healthy" && <p className="break-words text-xs text-foreground-secondary">{application.message}</p>}
                    {application.pods && application.pods.length > 0 && (
                        <ul className="flex flex-col gap-0.5 text-xs text-foreground-secondary">
                            {application.pods.map(pod => (
                                <li key={pod.name} className="flex flex-wrap items-center gap-x-2">
                                    <span className="truncate font-mono">{pod.name}</span>
                                    {pod.containers && <span className="tabular-nums">{pod.containers}</span>}
                                    {(pod.status ?? pod.health) && <span>{pod.status ?? pod.health}</span>}
                                    {Boolean(pod.restarts) && <span>{t("deployments.rollout.restarts", { count: pod.restarts })}</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                </li>
            ))}
        </ul>
    )
}

export default RolloutApplications
