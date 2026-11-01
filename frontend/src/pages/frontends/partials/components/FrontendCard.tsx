import { DescriptionItem, DescriptionList, EntityCard, Meter } from "@flightroom/design-system"
import { GitBranch, Info, Settings, Sparkles, UsersRound } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import WorkingAgentsIndicator, { useWorkingAgents } from "@/components/ai-agents/WorkingAgentsIndicator"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge, Button } from "@/components/atoms"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import { CanaryType, Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { cn } from "@/utils/styleUtils"
import { frontendTechnologyOf } from "@/utils/technologies"
import CloneRepositoryPopover from "./CloneRepositoryPopover"
import { isAiEditAvailable } from "./FrontendHeader"
import FrontendKindBadge from "./FrontendKindBadge"

interface FrontendCardProps {
    mfe: Frontend
}

export const FrontendCard: React.FC<FrontendCardProps> = ({ mfe }) => {
    const { t } = useTranslation("platform")
    const navigate = useNavigate()

    const canary = mfe.canary?.enabled ? mfe.canary : undefined
    const canaryPercentage = Math.min(100, Math.max(0, canary?.percentage ?? 0))
    // On User has no traffic share: the canary goes to the enrolled users, so a bar at 0% would read
    // as "nobody sees it".
    const showCanaryShare = Boolean(canary) && canary?.type !== CanaryType.ON_USER
    const hasRepository = Boolean(mfe.codeRepository?.enabled)
    const agents = useWorkingAgents(mfe._id)
    const aiAvailable = isAiEditAvailable(mfe, useProjectAiModels().enabled)
    const technology = frontendTechnologyOf(mfe)

    return (
        <EntityCard
            name={mfe.name}
            subtitle={mfe.slug}
            logo={technology && <TechnologyLogo technology={technology} />}
            status={agents > 0 && <WorkingAgentsIndicator agents={agents} className="max-w-full" />}
            badges={
                <>
                    <Badge>{mfe.version || "—"}</Badge>
                    <FrontendKindBadge frontend={mfe} />
                </>
            }
            className={cn(agents > 0 && "animate-agent-glow border-primary motion-reduce:animate-none")}
            // The screens of the frontend, as in its header, and the clone of its repository
            primaryAction={
                aiAvailable && (
                    <Button variant="primary" size="sm" onClick={() => navigate(`/frontend/${mfe._id}`)}>
                        <Sparkles />
                        {t("frontend.workspace.nav_ai")}
                    </Button>
                )
            }
            actions={
                <>
                    <Button variant="secondary" size="sm" onClick={() => navigate(`/frontend/${mfe._id}/overview`)}>
                        <Info />
                        {t("frontend.workspace.nav_overview")}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => navigate(`/frontend/${mfe._id}/settings`)}>
                        <Settings />
                        {t("frontend.workspace.nav_settings")}
                    </Button>
                </>
            }
            footer={<CloneRepositoryPopover frontend={mfe} />}
        >
            {hasRepository && (
                <DescriptionList orientation="inline">
                    <DescriptionItem
                        className="flex-nowrap items-center"
                        label={
                            <>
                                <GitBranch className="size-4 shrink-0" aria-hidden="true" />
                                <span className="sr-only">{t("frontend.card.repository")}</span>
                            </>
                        }
                    >
                        <span className="block truncate" title={mfe.codeRepository?.name}>
                            {mfe.codeRepository?.name || t("frontend.card.repository")}
                        </span>
                    </DescriptionItem>
                </DescriptionList>
            )}

            {canary && (
                <div className="rounded-md border border-divider bg-primary/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-primary-strong">
                            <UsersRound className="size-4 shrink-0" aria-hidden="true" />
                            <span className="truncate">{t("frontend.card.canary")}</span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">{showCanaryShare ? `${canaryPercentage}%` : t("frontend.canary_enrolled_users")}</span>
                    </div>
                    {showCanaryShare && <Meter className="mt-2" value={canaryPercentage} label={t("frontend.canaryReleaseActive")} />}
                    {canary.version && (
                        <p className="mt-2 truncate text-xs text-foreground-secondary">
                            {t("frontend.canaryVersion")}: {canary.version}
                        </p>
                    )}
                    {canary.url && (
                        <p className="mt-1 truncate text-xs text-foreground-secondary" title={canary.url}>
                            {canary.url}
                        </p>
                    )}
                </div>
            )}
        </EntityCard>
    )
}

export default FrontendCard
