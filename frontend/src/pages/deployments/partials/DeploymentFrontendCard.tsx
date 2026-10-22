import { Card, CardContent, CardHeader, CardTitle } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { CanaryDeploymentType, CanaryType, Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { CANARY_DEPLOYMENT_TYPE_LABEL_KEYS, CANARY_TYPE_LABEL_KEYS } from "@/pages/frontends/partials/labels"

interface DeploymentFrontendCardProps {
    frontend: Frontend
}

export const DeploymentFrontendCard: React.FC<DeploymentFrontendCardProps> = ({ frontend }) => {
    const { t } = useTranslation()

    const canary = frontend.canary?.enabled ? frontend.canary : undefined
    const canaryPercentage = Math.min(100, Math.max(0, canary?.percentage ?? 0))
    const isUrlBased = canary?.deploymentType === CanaryDeploymentType.BASED_ON_URL
    const canaryTarget = isUrlBased ? canary?.url : canary?.version
    const canaryTargetLabel = isUrlBased ? t("frontend.canaryUrl") : t("frontend.canaryVersion")

    return (
        <Card>
            <CardHeader className="flex-row items-end justify-between flex-wrap-reverse border-0 pb-0">
                <div className="min-w-0">
                    <CardTitle className="mb-0 text-base truncate" title={frontend.name}>
                        {frontend.name}
                    </CardTitle>
                    <div className="text-sm text-foreground-secondary truncate" title={frontend.slug}>
                        {frontend.slug}
                    </div>
                </div>
                <Badge className="shrink-0" title={t("deployments.frontend_card.stable_version")}>
                    {frontend.version || "—"}
                </Badge>
            </CardHeader>
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
