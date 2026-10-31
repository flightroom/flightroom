import { Card, CardContent, CardHeader, CardTitle } from "@flightroom/design-system"
import { LayoutDashboard } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import { CanaryDeploymentType, CanaryType, Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { CANARY_DEPLOYMENT_TYPE_LABEL_KEYS, CANARY_TYPE_LABEL_KEYS } from "@/pages/frontends/partials/labels"
import { cn } from "@/utils/styleUtils"
import { frontendTechnologyOf } from "@/utils/technologies"
import DeploymentExposedLink from "./DeploymentExposedLink"
import DeploymentReplicas from "./DeploymentReplicas"

interface DeploymentFrontendCardProps {
    frontend: Frontend
    /** Where it is reached in the environment of the deployment, when it is exposed there */
    url?: string
    /** The pods it runs there, when known: a static frontend runs none of its own */
    replicas?: number
}

export const DeploymentFrontendCard: React.FC<DeploymentFrontendCardProps> = ({ frontend, url, replicas }) => {
    const { t } = useTranslation()
    // Without pods nothing answers on the URL: the card goes grey and the link goes away
    const stopped = replicas === 0
    const shownUrl = stopped ? undefined : url

    const canary = frontend.canary?.enabled ? frontend.canary : undefined
    const canaryPercentage = Math.min(100, Math.max(0, canary?.percentage ?? 0))
    const isUrlBased = canary?.deploymentType === CanaryDeploymentType.BASED_ON_URL
    const canaryTarget = isUrlBased ? canary?.url : canary?.version
    const canaryTargetLabel = isUrlBased ? t("frontend.canaryUrl") : t("frontend.canaryVersion")
    const technology = frontendTechnologyOf(frontend)

    return (
        // The name is the link; it stretches over the whole card, so the card opens the frontend on a click anywhere.
        <Card
            className={cn(
                "relative border-l-4 transition-colors duration-200 focus-within:border-primary hover:border-primary",
                stopped ? "border-l-divider bg-muted text-foreground-secondary" : "border-l-info"
            )}
        >
            <CardHeader className="flex-row items-end justify-between flex-wrap-reverse border-0 pb-0">
                <div className="min-w-0">
                    <Badge variant="info" className="mb-2 w-fit">
                        <LayoutDashboard className="size-3" aria-hidden="true" />
                        {t("deployments.kind_frontend")}
                    </Badge>
                    <div className="flex min-w-0 items-center gap-2">
                        {technology && <TechnologyLogo technology={technology} />}
                        <CardTitle className="mb-0 text-base truncate" title={frontend.name}>
                            <Link to={`/frontend/${frontend._id}/overview`} className="underline-offset-4 hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
                                {frontend.name}
                            </Link>
                        </CardTitle>
                    </div>
                </div>
                <Badge variant="outline" className="shrink-0" title={t("deployments.frontend_card.stable_version")}>
                    {frontend.version || "—"}
                </Badge>
            </CardHeader>
            {(shownUrl || replicas !== undefined) && (
                <CardContent className="flex flex-col gap-2 pt-2">
                    {replicas !== undefined && <DeploymentReplicas replicas={replicas} />}
                    {shownUrl && <DeploymentExposedLink url={shownUrl} />}
                </CardContent>
            )}
            {canary && (
                <CardContent className="pt-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="accent" title={t("frontend.canaryReleaseActive")}>
                            {/* On User enrols named users instead of splitting traffic, so there is no share to quote. */}
                            {canary.type === CanaryType.ON_USER ? t("frontend.canary_enrolled_users") : t("deployments.frontend_card.canary_traffic", { percentage: canaryPercentage })}
                        </Badge>
                        {canary.type && <Badge variant="outline">{t(CANARY_TYPE_LABEL_KEYS[canary.type])}</Badge>}
                        {canary.deploymentType && <Badge variant="outline">{t(CANARY_DEPLOYMENT_TYPE_LABEL_KEYS[canary.deploymentType])}</Badge>}
                    </div>
                    <p className="mt-2 truncate text-xs text-foreground-secondary" title={canaryTarget}>
                        {canaryTargetLabel}: {canaryTarget || t("deployments.frontend_card.canary_target_missing")}
                    </p>
                </CardContent>
            )}
        </Card>
    )
}

export default DeploymentFrontendCard
