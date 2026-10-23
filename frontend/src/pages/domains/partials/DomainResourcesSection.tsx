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
import { Plus, X } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import ResourceIcon from "@/components/resource/ResourceIcon"
import useBackendsApi, { type Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import { resourcePath, typeLabel, useDetachResource, useResourcesQuery } from "@/pages/resources/partials/resources"
import { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

interface AttachResourceDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    resources: Resource[]
    backends: Backend[]
}

/** Attaches a resource of the project to backends of the domain: only backends attach resources, a frontend would ship their secrets */
const AttachResourceDialog: React.FC<AttachResourceDialogProps> = ({ open, onOpenChange, resources, backends }) => {
    const { t } = useTranslation()
    const backendsApi = useBackendsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const idPrefix = useId()
    const [resourceId, setResourceId] = useState<string>()
    const [selected, setSelected] = useState<string[]>([])
    const [saving, setSaving] = useState(false)

    const attaches = (backend: Backend) => Boolean(resourceId && backend.resourceIds?.includes(resourceId))
    const toAttach = backends.filter(backend => selected.includes(backend._id!) && !attaches(backend))

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
            for (const backend of toAttach) {
                // Read again: the list may predate another attach, which the PUT would otherwise drop
                const current = await backendsApi.getSingle(backend._id!)
                if (current.resourceIds?.includes(resourceId)) continue
                await backendsApi.update(backend._id!, { resourceIds: [...(current.resourceIds ?? []), resourceId] })
                queryClient.invalidateQueries({ queryKey: ["backend", backend._id] })
            }
            const resource = resources.find(candidate => candidate._id === resourceId)
            notifications.showSuccessNotification({ message: t("domains.resources.attach.success", { resource: resource?.name, count: toAttach.length }) })
            setSaving(false)
            changeOpen(false)
        } catch {
            setSaving(false)
        } finally {
            queryClient.invalidateQueries({ queryKey: ["backends"] })
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
                                <legend className="mb-2 text-sm font-medium">{t("domains.resources.attach.backends")}</legend>
                                {backends.map(backend => {
                                    const checkboxId = `${idPrefix}-${backend._id}`
                                    const attached = attaches(backend)
                                    return (
                                        <div key={backend._id} className="flex items-center gap-2">
                                            <Checkbox
                                                id={checkboxId}
                                                checked={attached || selected.includes(backend._id!)}
                                                disabled={saving || !resourceId || attached}
                                                onCheckedChange={checked => setSelected(current => (checked === true ? [...current, backend._id!] : current.filter(id => id !== backend._id)))}
                                                dataTestId={`domain-attach-resource-backend-${backend.slug}`}
                                            />
                                            <Label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer truncate">
                                                {backend.name}
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
 * Each backend of the domain with the resources it attaches: what the agent is told the domain can reach.
 * Only backends attach resources, so a domain without one has nothing to show. An editor detaches each one from here.
 */
export const DomainResourcesSection: React.FC<{ backends: Backend[] }> = ({ backends }) => {
    const { t } = useTranslation()
    const resourcesQuery = useResourcesQuery(backends.length > 0)
    const isViewer = useIsProjectViewer()
    const detach = useDetachResource()
    const [attachOpen, setAttachOpen] = useState(false)

    // A list that cannot be read hides the section: the rest of the overview does not depend on it
    if (backends.length === 0 || !resourcesQuery.data) return null
    const resources = resourcesQuery.data

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1.5">
                    <CardTitle className="mb-0">{t("domains.resources.title")}</CardTitle>
                    <CardDescription>{t("domains.resources.description")}</CardDescription>
                </div>
                {/* A viewer may look, not change what the backends receive */}
                {!isViewer && (
                    <Button variant="secondary" onClick={() => setAttachOpen(true)} dataTestId="domain-attach-resource">
                        <Plus />
                        {t("domains.resources.attach.action")}
                    </Button>
                )}
            </CardHeader>
            <CardContent className="pt-3">
                <ul className="flex flex-col divide-y divide-divider">
                    {backends.map(backend => {
                        const attached = resources.filter(resource => backend.resourceIds?.includes(resource._id!))
                        return (
                            <li key={backend._id} className="flex flex-col gap-2 py-3" data-testid={`domain-resources-backend-${backend.slug}`}>
                                <Link to={`/backend/${backend._id}/overview`} className="w-fit text-sm font-semibold underline-offset-4 hover:underline">
                                    {backend.name}
                                </Link>
                                {attached.length === 0 ? (
                                    <p className="text-sm text-foreground-secondary">{t("domains.resources.backend_none")}</p>
                                ) : (
                                    <ul className="flex flex-col gap-1">
                                        {attached.map(resource => (
                                            <li key={resource._id} className="flex flex-wrap items-center gap-2">
                                                <ResourceIcon resource={resource} />
                                                <Link to={resourcePath(resource._id!)} className="font-mono text-sm underline-offset-4 hover:underline">
                                                    {resource.name}
                                                </Link>
                                                <Badge variant="outline">{typeLabel(t, resource.type)}</Badge>
                                                {!isViewer && (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon-sm"
                                                        className="ml-auto"
                                                        disabled={detach.isPending}
                                                        aria-label={t("domains.resources.detach", { resource: resource.name, backend: backend.name })}
                                                        title={t("domains.resources.detach", { resource: resource.name, backend: backend.name })}
                                                        onClick={() => detach.mutate({ backend, resource })}
                                                        dataTestId={`domain-detach-resource-${backend.slug}-${resource._id}`}
                                                    >
                                                        <X />
                                                    </Button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        )
                    })}
                </ul>
            </CardContent>
            {!isViewer && <AttachResourceDialog open={attachOpen} onOpenChange={setAttachOpen} resources={resources} backends={backends} />}
        </Card>
    )
}

export default DomainResourcesSection
