import { Card, CardContent, CardFooter, CardHeader, CardTitle, DescriptionItem, DescriptionList, Meter } from "@flightroom/design-system"
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
        <Card className={cn("flex h-full flex-col transition-colors duration-200 hover:border-primary", agents > 0 && "animate-agent-glow border-primary motion-reduce:animate-none")}>
            <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        {technology && <TechnologyLogo technology={technology} />}
                        <CardTitle className="mb-0 truncate" title={mfe.name}>
                            {mfe.name}
                        </CardTitle>
                    </div>
                    <p className="truncate text-sm text-foreground-secondary" title={mfe.slug}>
                        {mfe.slug}
                    </p>
                    <WorkingAgentsIndicator agents={agents} className="mt-2 max-w-full" />
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge>{mfe.version || "—"}</Badge>
                    <FrontendKindBadge frontend={mfe} />
                </div>
            </CardHeader>

            <CardContent className="flex flex-grow flex-col gap-3 py-3">
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
            </CardContent>

            {/* The screens of the frontend, as in its header, and the clone of its repository */}
            <CardFooter className="flex-wrap gap-2 border-t border-divider pt-3">
                {aiAvailable && (
                    <Button variant="primary" size="sm" className="basis-full" onClick={() => navigate(`/frontend/${mfe._id}`)}>
                        <Sparkles />
                        {t("frontend.workspace.nav_ai")}
                    </Button>
                )}
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => navigate(`/frontend/${mfe._id}/overview`)}>
                    <Info />
                    {t("frontend.workspace.nav_overview")}
                </Button>
                <Button variant="secondary" size="sm" className="flex-1" onClick={() => navigate(`/frontend/${mfe._id}/settings`)}>
                    <Settings />
                    {t("frontend.workspace.nav_settings")}
                </Button>
                <CloneRepositoryPopover frontend={mfe} className="basis-full" />
            </CardFooter>
        </Card>
    )
}

export default FrontendCard
