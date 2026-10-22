import { Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import ResourceIcon from "@/components/resource/ResourceIcon"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import type { Resource, ResourceEnvKey } from "@/hooks/apiClients/useResourcesApi"
import type { Service } from "@/hooks/apiClients/useServicesApi"
import { resourcePath, typeLabel, variantLabel } from "@/pages/resources/partials/resources"

/** What a variable of the resource is in one environment: the override there, the value of all otherwise; a credential is only set or not */
const valueIn = (resource: Resource, key: ResourceEnvKey, environmentId?: string): { value?: string; set: boolean } => {
    if (key.field === undefined) return { value: key.value, set: true }
    const field = resource.fields[key.field]
    const value = field?.overrides.find(override => override.environmentId === environmentId)?.value || field?.value
    return key.secret ? { set: Boolean(value) } : { value, set: Boolean(value) }
}

/** What the service receives from the resources it attaches, a table per resource: a column per environment, a credential never shown */
export const ServiceResourcesSection: React.FC<{ service: Service; resources: Resource[]; environments: EnvironmentDTO[] }> = ({ service, resources, environments }) => {
    const { t } = useTranslation()
    const attached = resources.filter(resource => service.resourceIds?.includes(resource._id!))

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("resources.attach.title")}</CardTitle>
                <CardDescription>{t("resources.attach.detail_description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6 pt-3">
                {attached.length === 0 && <p className="text-sm text-foreground-secondary">{t("resources.attach.none")}</p>}
                {attached.map(resource => (
                    <div key={resource._id} className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <ResourceIcon resource={resource} />
                            <Link to={resourcePath(resource._id!)} className="font-mono font-semibold underline-offset-4 hover:underline">
                                {resource.name}
                            </Link>
                            <Badge variant="outline">{typeLabel(t, resource.type)}</Badge>
                            <span className="text-xs text-foreground-secondary">{variantLabel(t, resource.type, resource.variant)}</span>
                        </div>
                        <div className="overflow-x-auto rounded-lg border-2 border-border bg-card">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                                        <TableHead>{t("resources.keys.key")}</TableHead>
                                        {environments.map(environment => (
                                            <TableHead key={environment._id}>{environment.name}</TableHead>
                                        ))}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {resource.env.map(key => (
                                        <TableRow key={key.key} className="border-divider hover:bg-primary/5">
                                            <TableCell className="font-mono font-medium">{key.key}</TableCell>
                                            {environments.map(environment => {
                                                const { value, set } = valueIn(resource, key, environment._id)
                                                return (
                                                    <TableCell key={environment._id} className="max-w-[16rem] truncate font-mono text-xs" title={value}>
                                                        {!set ? (
                                                            <span className="text-foreground-secondary">—</span>
                                                        ) : key.secret ? (
                                                            <span className="text-foreground-secondary">{t("resources.values.set")}</span>
                                                        ) : (
                                                            value
                                                        )}
                                                    </TableCell>
                                                )
                                            })}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </div>
                ))}
            </CardContent>
        </Card>
    )
}

export default ServiceResourcesSection
