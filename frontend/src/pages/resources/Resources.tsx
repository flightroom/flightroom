import { EmptyState, SearchInput, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Boxes, CirclePlus, SearchX } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import ResourceIcon from "@/components/resource/ResourceIcon"
import SinglePageLayout from "@/components/SinglePageLayout"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import useProjectStore from "@/store/useProjectStore"
import { resourcePath, typeLabel, useResourcesQuery, variantLabel } from "./partials/resources"

/** The resources of the project, with the backends attaching each one */
const Resources: React.FC = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const backendsApi = useBackendsApi()
    const [searchTerm, setSearchTerm] = useState("")

    const resourcesQuery = useResourcesQuery()
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })

    const backendsOf = useCallback((resourceId: string) => (backendsQuery.data ?? []).filter(backend => backend.resourceIds?.includes(resourceId)), [backendsQuery.data])

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
                ...backendsOf(resource._id!).map(backend => backend.name)
            ].some(text => text.toLowerCase().includes(term))
        )
    }, [resourcesQuery.data, searchTerm, backendsOf, t])

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
            <ApiStatusHandler queries={[resourcesQuery, backendsQuery]}>
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
                                    <TableHead>{t("resources.used_by.title")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map(resource => {
                                    const backends = backendsOf(resource._id!)
                                    return (
                                        <TableRow key={resource._id} className="cursor-pointer border-divider hover:bg-primary/5" onClick={() => navigate(resourcePath(resource._id!))}>
                                            <TableCell className="max-w-[16rem] font-mono font-medium" title={resource.name}>
                                                <span className="flex items-center gap-2">
                                                    <ResourceIcon resource={resource} />
                                                    <span className="truncate">{resource.name}</span>
                                                </span>
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
                                            <TableCell>
                                                {backends.length > 0 ? (
                                                    <div className="flex flex-wrap gap-1">
                                                        {backends.map(backend => (
                                                            <Link key={backend._id} to={`/backend/${backend._id}`} onClick={event => event.stopPropagation()}>
                                                                <Badge variant="outline">{backend.name}</Badge>
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
