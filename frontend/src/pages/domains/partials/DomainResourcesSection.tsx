import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import ResourceIcon from "@/components/resource/ResourceIcon"
import type { Service } from "@/hooks/apiClients/useServicesApi"
import { resourcePath, typeLabel, useResourcesQuery } from "@/pages/resources/partials/resources"

/**
 * The resources the services of the domain attach, each with the services using it: what the agent is told
 * the domain can reach. Only services attach resources, so a domain without one has nothing to show.
 */
export const DomainResourcesSection: React.FC<{ services: Service[] }> = ({ services }) => {
    const { t } = useTranslation()
    const resourcesQuery = useResourcesQuery(services.length > 0)

    // A list that cannot be read hides the section: the workspace is the point of the page, not this
    if (services.length === 0 || !resourcesQuery.data) return null

    const used = resourcesQuery.data.flatMap(resource => {
        const usedBy = services.filter(service => service.resourceIds?.includes(resource._id!))
        return usedBy.length > 0 ? [{ resource, usedBy }] : []
    })

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("domains.resources.title")}</CardTitle>
                <CardDescription>{t("domains.resources.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                {used.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("domains.resources.none")}</p>
                ) : (
                    <ul className="flex flex-col divide-y divide-divider">
                        {used.map(({ resource, usedBy }) => (
                            <li key={resource._id} className="flex flex-wrap items-center gap-2 py-2">
                                <ResourceIcon resource={resource} />
                                <Link to={resourcePath(resource._id!)} className="font-mono text-sm font-semibold underline-offset-4 hover:underline">
                                    {resource.name}
                                </Link>
                                <Badge variant="outline">{typeLabel(t, resource.type)}</Badge>
                                <span className="text-xs text-foreground-secondary">{t("domains.resources.used_by", { services: usedBy.map(service => service.name).join(", ") })}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    )
}

export default DomainResourcesSection
