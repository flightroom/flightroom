import { Card, CardContent, CardHeader, CardTitle } from "@flightroom/design-system"
import { Server } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import { DeployedBackend } from "@/hooks/apiClients/useDeploymentsApi"
import { cn } from "@/utils/styleUtils"
import { BackendTechnology } from "@/utils/technologies"
import DeploymentExposedLink from "./DeploymentExposedLink"
import DeploymentReplicas from "./DeploymentReplicas"

interface DeploymentBackendCardProps {
    backend: DeployedBackend
    /** The technology of the backend as it is now, when known */
    technology?: BackendTechnology
    /** Where it is reached in the environment of the deployment, when it is exposed there */
    url?: string
    /** The pods it runs there, when known */
    replicas?: number
}

export const DeploymentBackendCard: React.FC<DeploymentBackendCardProps> = ({ backend, technology, url, replicas }) => {
    const { t } = useTranslation()
    // Without pods nothing answers on the URL: the card goes grey and the link goes away
    const stopped = replicas === 0
    const shownUrl = stopped ? undefined : url

    return (
        // The name is the link; it stretches over the whole card, so the card opens the backend on a click anywhere.
        <Card
            className={cn(
                "relative border-l-4 transition-colors duration-200 focus-within:border-primary hover:border-primary",
                stopped ? "border-l-divider bg-muted text-foreground-secondary" : "border-l-primary"
            )}
        >
            <CardHeader className={cn("flex-row items-end justify-between flex-wrap-reverse border-0", (shownUrl || replicas !== undefined) && "pb-0")}>
                <div className="min-w-0">
                    <Badge className="mb-2 w-fit">
                        <Server className="size-3" aria-hidden="true" />
                        {t("deployments.kind_backend")}
                    </Badge>
                    <div className="flex min-w-0 items-center gap-2">
                        {technology && <TechnologyLogo technology={technology} />}
                        <CardTitle className="mb-0 text-base truncate" title={backend.name}>
                            <Link to={`/backend/${backend._id}/overview`} className="underline-offset-4 hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
                                {backend.name}
                            </Link>
                        </CardTitle>
                    </div>
                </div>
                <Badge variant="outline" className="shrink-0" title={backend.version ? t("deployments.backend_card.version") : t("deployments.backend_card.no_version")}>
                    {backend.version || "—"}
                </Badge>
            </CardHeader>
            {(shownUrl || replicas !== undefined) && (
                <CardContent className="flex flex-col gap-2 pt-2">
                    {replicas !== undefined && <DeploymentReplicas replicas={replicas} />}
                    {shownUrl && <DeploymentExposedLink url={shownUrl} />}
                </CardContent>
            )}
        </Card>
    )
}

export default DeploymentBackendCard
