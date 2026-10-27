import { Card, CardContent, CardHeader, CardTitle } from "@flightroom/design-system"
import { Server } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import { DeployedBackend } from "@/hooks/apiClients/useDeploymentsApi"
import DeploymentExposedLink from "./DeploymentExposedLink"

interface DeploymentBackendCardProps {
    backend: DeployedBackend
    /** Where it is reached in the environment of the deployment, when it is exposed there */
    url?: string
}

export const DeploymentBackendCard: React.FC<DeploymentBackendCardProps> = ({ backend, url }) => {
    const { t } = useTranslation()

    return (
        // The name is the link; it stretches over the whole card, so the card opens the backend on a click anywhere.
        <Card className="relative border-l-4 border-l-primary transition-colors duration-200 focus-within:border-primary hover:border-primary">
            <CardHeader className={`flex-row items-end justify-between flex-wrap-reverse border-0${url ? " pb-0" : ""}`}>
                <div className="min-w-0">
                    <Badge className="mb-2 w-fit">
                        <Server className="size-3" aria-hidden="true" />
                        {t("deployments.kind_backend")}
                    </Badge>
                    <CardTitle className="mb-0 text-base truncate" title={backend.name}>
                        <Link to={`/backend/${backend._id}/overview`} className="underline-offset-4 hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
                            {backend.name}
                        </Link>
                    </CardTitle>
                    <div className="text-sm text-foreground-secondary truncate" title={backend.slug}>
                        {backend.slug}
                    </div>
                </div>
                <Badge variant="outline" className="shrink-0" title={backend.version ? t("deployments.backend_card.version") : t("deployments.backend_card.no_version")}>
                    {backend.version || "—"}
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

export default DeploymentBackendCard
