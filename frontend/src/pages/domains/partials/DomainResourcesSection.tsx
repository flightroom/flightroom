import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from "@flightroom/design-system"
import { useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import ResourceIcon from "@/components/resource/ResourceIcon"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import useServicesApi, { type Service } from "@/hooks/apiClients/useServicesApi"
import { resourcePath, typeLabel, useResourcesQuery } from "@/pages/resources/partials/resources"
import { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

interface AttachResourceDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    resources: Resource[]
    services: Service[]
}

/** Attaches a resource of the project to services of the domain: only backends attach resources, a frontend would ship their secrets */
const AttachResourceDialog: React.FC<AttachResourceDialogProps> = ({ open, onOpenChange, resources, services }) => {
    const { t } = useTranslation()
    const servicesApi = useServicesApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const idPrefix = useId()
    const [resourceId, setResourceId] = useState<string>()
    const [selected, setSelected] = useState<string[]>([])
    const [saving, setSaving] = useState(false)

    const attaches = (service: Service) => Boolean(resourceId && service.resourceIds?.includes(resourceId))
    const toAttach = services.filter(service => selected.includes(service._id!) && !attaches(service))

    const changeOpen = (value: boolean) => {
        if (saving) return
        onOpenChange(value)
        if (!value) {
            setResourceId(undefined)
            setSelected([])
        }
    }

    const onSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        if (!resourceId || toAttach.length === 0) return
        setSaving(true)
        try {
            // One at a time: a refusal (e.g. a variable clash) stops before the next one, and its toast says why
            for (const service of toAttach) {
                // Read again: the list may predate another attach, which the PUT would otherwise drop
                const current = await servicesApi.getSingle(service._id!)
                if (current.resourceIds?.includes(resourceId)) continue
                await servicesApi.update(service._id!, { resourceIds: [...(current.resourceIds ?? []), resourceId] })
                queryClient.invalidateQueries({ queryKey: ["service", service._id] })
            }
            const resource = resources.find(candidate => candidate._id === resourceId)
            notifications.showSuccessNotification({ message: t("domains.resources.attach.success", { resource: resource?.name, count: toAttach.length }) })
            setSaving(false)
            changeOpen(false)
        } catch {
            setSaving(false)
        } finally {
            queryClient.invalidateQueries({ queryKey: ["services"] })
        }
    }

    return (
        <Dialog open={open} onOpenChange={changeOpen}>
            <DialogContent>
                <form onSubmit={onSubmit}>
                    <DialogHeader>
                        <DialogTitle>{t("domains.resources.attach.title")}</DialogTitle>
                        <DialogDescription>{t("domains.resources.attach.description")}</DialogDescription>
                    </DialogHeader>
                    {resources.length === 0 ? (
                        <p className="my-4 text-sm text-foreground-secondary">
                            {t("domains.resources.attach.no_resources")}{" "}
                            <Link to="/resource/new" className="font-medium underline underline-offset-4">
                                {t("domains.resources.attach.create")}
                            </Link>
                        </p>
                    ) : (
                        <div className="my-4 flex flex-col gap-4">
                            <div className="flex flex-col gap-2">
                                <Label htmlFor={`${idPrefix}-resource`}>{t("domains.resources.attach.resource")}</Label>
                                <Select value={resourceId} onValueChange={setResourceId} disabled={saving}>
                                    <SelectTrigger id={`${idPrefix}-resource`} dataTestId="domain-attach-resource-select">
                                        <SelectValue placeholder={t("domains.resources.attach.resource_placeholder")} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {resources.map(resource => (
                                            <SelectItem key={resource._id} value={resource._id!}>
                                                {resource.name} · {typeLabel(t, resource.type)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <fieldset className="flex flex-col gap-2">
                                <legend className="mb-2 text-sm font-medium">{t("domains.resources.attach.services")}</legend>
                                {services.map(service => {
                                    const checkboxId = `${idPrefix}-${service._id}`
                                    const attached = attaches(service)
                                    return (
                                        <div key={service._id} className="flex items-center gap-2">
                                            <Checkbox
                                                id={checkboxId}
                                                checked={attached || selected.includes(service._id!)}
                                                disabled={saving || !resourceId || attached}
                                                onCheckedChange={checked => setSelected(current => (checked === true ? [...current, service._id!] : current.filter(id => id !== service._id)))}
                                                dataTestId={`domain-attach-resource-service-${service.slug}`}
                                            />
                                            <Label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer truncate">
                                                {service.name}
                                            </Label>
                                            {attached && <Badge variant="outline">{t("domains.resources.attach.already_attached")}</Badge>}
                                        </div>
                                    )
                                })}
                            </fieldset>
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => changeOpen(false)} disabled={saving}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" disabled={saving || toAttach.length === 0} loading={saving} dataTestId="domain-attach-resource-confirm">
                            {t("domains.resources.attach.confirm", { count: toAttach.length })}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}

/**
 * The resources the services of the domain attach, each with the services using it: what the agent is told
 * the domain can reach. Only services attach resources, so a domain without one has nothing to show.
 */
export const DomainResourcesSection: React.FC<{ services: Service[] }> = ({ services }) => {
    const { t } = useTranslation()
    const resourcesQuery = useResourcesQuery(services.length > 0)
    const isViewer = useIsProjectViewer()
    const [attachOpen, setAttachOpen] = useState(false)

    // A list that cannot be read hides the section: the rest of the overview does not depend on it
    if (services.length === 0 || !resourcesQuery.data) return null

    const used = resourcesQuery.data.flatMap(resource => {
        const usedBy = services.filter(service => service.resourceIds?.includes(resource._id!))
        return usedBy.length > 0 ? [{ resource, usedBy }] : []
    })

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1.5">
                    <CardTitle className="mb-0">{t("domains.resources.title")}</CardTitle>
                    <CardDescription>{t("domains.resources.description")}</CardDescription>
                </div>
                {/* A viewer may look, not change what the services receive */}
                {!isViewer && (
                    <Button variant="secondary" onClick={() => setAttachOpen(true)} dataTestId="domain-attach-resource">
                        <Plus />
                        {t("domains.resources.attach.action")}
                    </Button>
                )}
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
            {!isViewer && <AttachResourceDialog open={attachOpen} onOpenChange={setAttachOpen} resources={resourcesQuery.data} services={services} />}
        </Card>
    )
}

export default DomainResourcesSection
