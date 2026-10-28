import { Card, CardHeader, CardTitle } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import ResourceIcon from "@/components/resource/ResourceIcon"
import { DeployedVariableMap } from "@/hooks/apiClients/useDeploymentsApi"
import { Resource } from "@/hooks/apiClients/useResourcesApi"
import { resourcePath, typeLabel } from "@/pages/resources/partials/resources"

interface DeploymentResourceCardProps {
    deployed: DeployedVariableMap
    /** The resource as it is now, for its type and icon: none once it is deleted */
    resource?: Resource
}

export const DeploymentResourceCard: React.FC<DeploymentResourceCardProps> = ({ deployed, resource }) => {
    const { t } = useTranslation()

    return (
        // The name is the link; it stretches over the whole card, so the card opens the resource on a click anywhere.
        <Card className="relative border-l-4 border-l-accent transition-colors duration-200 focus-within:border-primary hover:border-primary">
            <CardHeader className="border-0">
                <Badge variant="accent" className="mb-2 w-fit">
                    {resource && <ResourceIcon resource={resource} size={12} decorative />}
                    {resource ? typeLabel(t, resource.type) : t("deployments.kind_resource")}
                </Badge>
                <CardTitle className="mb-0 text-base truncate" title={deployed.name}>
                    <Link to={resourcePath(deployed._id)} className="underline-offset-4 hover:underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">
                        {deployed.name}
                    </Link>
                </CardTitle>
            </CardHeader>
        </Card>
    )
}

export default DeploymentResourceCard
