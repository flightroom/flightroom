import { EmptyState, SearchInput, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Boxes, CirclePlus, SearchX } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useServicesApi from "@/hooks/apiClients/useServicesApi"
import useProjectStore from "@/store/useProjectStore"
import { resourcePath, typeLabel, useResourcesQuery, variantLabel } from "./partials/resources"

/** The resources of the project, with the services attaching each one */
const Resources: React.FC = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const servicesApi = useServicesApi()
    const [searchTerm, setSearchTerm] = useState("")

    const resourcesQuery = useResourcesQuery()
    const servicesQuery = useQuery({ queryKey: ["services", projectId], queryFn: servicesApi.getAll, enabled: !!projectId })

    const servicesOf = useCallback((resourceId: string) => (servicesQuery.data ?? []).filter(service => service.resourceIds?.includes(resourceId)), [servicesQuery.data])

    const filtered = useMemo(() => {
        const term = searchTerm.trim().toLowerCase()
        if (!term) return resourcesQuery.data ?? []
        return (resourcesQuery.data ?? []).filter(resource =>
            [
                resource.name,
                resource.description ?? "",
                typeLabel(t, resource.type),
                variantLabel(t, resource.type, resource.variant),
                ...resource.env.map(key => key.key),
                ...servicesOf(resource._id!).map(service => service.name)
            ].some(text => text.toLowerCase().includes(term))
        )
    }, [resourcesQuery.data, searchTerm, servicesOf, t])

    const hasResources = (resourcesQuery.data?.length ?? 0) > 0
    const onCreate = () => navigate(resourcePath("new"))

    return (
        <SinglePageLayout
            title={t("resources.list_title")}
            description={t("resources.list_description")}
            lrContainerClassname="items-end"
            left={
                hasResources ? (
                    <SearchInput
                        className="max-w-sm"
                        placeholder={t("resources.list.search_placeholder")}
                        value={searchTerm}
                        onValueChange={setSearchTerm}
                        onClear={() => setSearchTerm("")}
                        clearLabel={t("resources.list.clear_search")}
                    />
                ) : null
            }
            right={
                <Button variant="primary" onClick={onCreate}>
                    <CirclePlus />
                    {t("resources.add_new")}
                </Button>
            }
        >
            <ApiStatusHandler queries={[resourcesQuery, servicesQuery]}>
                {!hasResources ? (
                    <EmptyState
                        variant="outlined"
                        size="lg"
                        tone="primary"
                        icon={<Boxes />}
                        title={t("resources.empty_title")}
                        description={t("resources.empty_description")}
                        actions={
                            <Button onClick={onCreate}>
                                <CirclePlus />
                                {t("resources.add_new")}
                            </Button>
                        }
                    />
                ) : filtered.length === 0 ? (
                    <EmptyState
                        variant="outlined"
                        size="lg"
                        tone="primary"
                        icon={<SearchX />}
                        title={t("resources.list.no_results_title")}
                        description={t("resources.list.no_results_description", { searchTerm })}
                        actions={
                            <Button variant="secondary" onClick={() => setSearchTerm("")}>
                                {t("resources.list.clear_search")}
                            </Button>
                        }
                    />
                ) : (
                    <div className="overflow-hidden rounded-lg border-2 border-border bg-card">
                        <Table>
                            <TableHeader>
                                <TableRow className="bg-muted/60 hover:bg-muted/60">
                                    <TableHead>{t("resources.name")}</TableHead>
                                    <TableHead>{t("resources.type")}</TableHead>
                                    <TableHead>{t("resources.description")}</TableHead>
                                    <TableHead>{t("resources.list.keys")}</TableHead>
                                    <TableHead>{t("resources.used_by.title")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map(resource => {
                                    const services = servicesOf(resource._id!)
                                    return (
                                        <TableRow key={resource._id} className="cursor-pointer border-divider hover:bg-primary/5" onClick={() => navigate(resourcePath(resource._id!))}>
                                            <TableCell className="max-w-[16rem] truncate font-mono font-medium" title={resource.name}>
                                                {resource.name}
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex flex-wrap items-center gap-1">
                                                    <Badge variant="outline">{typeLabel(t, resource.type)}</Badge>
                                                    <span className="text-xs text-foreground-secondary">{variantLabel(t, resource.type, resource.variant)}</span>
                                                </div>
                                            </TableCell>
                                            <TableCell className="max-w-[20rem] truncate text-foreground-secondary" title={resource.description}>
                                                {resource.description || "—"}
                                            </TableCell>
                                            <TableCell className="max-w-[18rem] truncate font-mono text-xs" title={resource.env.map(key => key.key).join(", ")}>
                                                {resource.env.length}
                                            </TableCell>
                                            <TableCell>
                                                {services.length > 0 ? (
                                                    <div className="flex flex-wrap gap-1">
                                                        {services.map(service => (
                                                            <Link key={service._id} to={`/service/${service._id}`} onClick={event => event.stopPropagation()}>
                                                                <Badge variant="outline">{service.name}</Badge>
                                                            </Link>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <span className="text-foreground-secondary">{t("resources.used_by.none")}</span>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </ApiStatusHandler>
        </SinglePageLayout>
    )
}

export default Resources
