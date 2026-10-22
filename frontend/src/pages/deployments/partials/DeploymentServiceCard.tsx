import { Card, CardContent, CardHeader, CardTitle } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { DeployedService } from "@/hooks/apiClients/useDeploymentsApi"
import DeploymentExposedLink from "./DeploymentExposedLink"

interface DeploymentServiceCardProps {
    service: DeployedService
    /** Where it is reached in the environment of the deployment, when it is exposed there */
    url?: string
}

export const DeploymentServiceCard: React.FC<DeploymentServiceCardProps> = ({ service, url }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader className={`flex-row items-end justify-between flex-wrap-reverse border-0${url ? " pb-0" : ""}`}>
                <div className="min-w-0">
                    <CardTitle className="mb-0 text-base truncate" title={service.name}>
                        {service.name}
                    </CardTitle>
                    <div className="text-sm text-foreground-secondary truncate" title={service.slug}>
                        {service.slug}
                    </div>
                </div>
                <Badge className="shrink-0" title={service.version ? t("deployments.service_card.version") : t("deployments.service_card.no_version")}>
                    {service.version || "—"}
                </Badge>
            </CardHeader>
            {url && (
                <CardContent className="pt-2">
                    <DeploymentExposedLink url={url} />
                </CardContent>
            )}
        </Card>
    )
}

export default DeploymentServiceCard
