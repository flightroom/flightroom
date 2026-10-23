import { EmptyState, SearchInput, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { CirclePlus, LayoutGrid, SearchX, StretchHorizontal, Warehouse, Wrench } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import { ALL_DOMAINS, DomainFilter, matchesDomain } from "../domains/partials/DomainFilter"
import MaintenanceAgentsGrid from "./partials/MaintenanceAgentsGrid"
import MaintenanceAgentsTable from "./partials/MaintenanceAgentsTable"
import MaintenanceBay from "./partials/MaintenanceBay"
import MaintenanceRunDialog from "./partials/MaintenanceRunDialog"
import { useMaintenanceAgentsQuery } from "./partials/maintenance"

const VIEWS = [
    { value: "room", icon: Warehouse, labelKey: "maintenance.list.viewRoom" },
    { value: "grid", icon: LayoutGrid, labelKey: "maintenance.list.viewGrid" },
    { value: "table", icon: StretchHorizontal, labelKey: "maintenance.list.viewTable" }
] as const

type View = (typeof VIEWS)[number]["value"]

const MaintenanceAgents = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const isViewer = useIsProjectViewer()
    const backendsApi = useBackendsApi()
    const frontendsApi = useFrontendsApi()
    const [searchTerm, setSearchTerm] = useState("")
    const [domainFilter, setDomainFilter] = useState(ALL_DOMAINS)
    const [view, setView] = useState<View>("room")
    const [running, setRunning] = useState<MaintenanceAgent>()

    const agentsQuery = useMaintenanceAgentsQuery()
    // Only the room draws the worlds and the canisters: the grid and the table do not wait for them.
    const isRoom = view === "room"
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId && isRoom })
    const frontendsQuery = useQuery({ queryKey: ["frontends-by-project-id", projectId], queryFn: () => frontendsApi.getByProjectId(projectId), enabled: !!projectId && isRoom })
    const resourcesQuery = useResourcesQuery(isRoom)

    const filtered = useMemo(() => {
        const term = searchTerm.toLowerCase()
        return (agentsQuery.data ?? []).filter(agent => (!term || agent.name.toLowerCase().includes(term) || agent.slug.toLowerCase().includes(term)) && matchesDomain(agent.domainId, domainFilter))
    }, [agentsQuery.data, searchTerm, domainFilter])

    const totalCount = agentsQuery.data?.length ?? 0
    const hasAgents = totalCount > 0
    const isFiltered = Boolean(searchTerm) || domainFilter !== ALL_DOMAINS
    const onRun = isViewer ? undefined : setRunning
    const onCreate = () => navigate("/maintenance-agent/new")
    const onResetFilters = () => {
        setSearchTerm("")
        setDomainFilter(ALL_DOMAINS)
    }

    return (
        <Tabs value={view} onValueChange={value => setView(value as View)} className="flex min-h-full flex-col" layoutSize="sm" iconButtons tabsListPosition="end">
            <SinglePageLayout
                title={t("maintenance.list.title")}
                description={t("maintenance.list.description")}
                lrContainerClassname="items-end"
                left={
                    hasAgents ? (
                        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <SearchInput
                                    className="max-w-sm"
                                    placeholder={t("maintenance.list.searchPlaceholder")}
                                    value={searchTerm}
                                    onValueChange={setSearchTerm}
                                    onClear={() => setSearchTerm("")}
                                    clearLabel={t("maintenance.list.clearSearch")}
                                />
                                <DomainFilter value={domainFilter} onValueChange={setDomainFilter} />
                            </div>
                            <p className="text-sm text-foreground-secondary" aria-live="polite">
                                {isFiltered ? t("maintenance.list.filteredCount", { count: filtered.length, total: totalCount }) : t("maintenance.list.totalCount", { count: totalCount })}
                            </p>
                        </div>
                    ) : null
                }
                right={
                    <div className="flex flex-[0_0_auto] items-center gap-2">
                        {hasAgents && (
                            <TabsList>
                                {VIEWS.map(({ value, icon: Icon, labelKey }) => (
                                    <TabsTrigger
                                        key={value}
                                        value={value}
                                        aria-label={t(labelKey)}
                                        title={t(labelKey)}
                                        className="data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground hover:data-[state=active]:bg-primary/85 focus-visible:data-[state=active]:bg-primary/85"
                                    >
                                        <Icon />
                                    </TabsTrigger>
                                ))}
                            </TabsList>
                        )}
                        {!isViewer && (
                            <Button variant="primary" onClick={onCreate}>
                                <CirclePlus />
                                {t("maintenance.add_new")}
                            </Button>
                        )}
                    </div>
                }
            >
                <ApiStatusHandler queries={[agentsQuery]} interceptEmpty={false}>
                    {!hasAgents ? (
                        <EmptyState
                            variant="outlined"
                            size="lg"
                            tone="primary"
                            icon={<Wrench />}
                            title={t("maintenance.list.emptyTitle")}
                            description={t("maintenance.list.emptyDescription")}
                            actions={
                                !isViewer && (
                                    <Button onClick={onCreate}>
                                        <CirclePlus />
                                        {t("maintenance.add_new")}
                                    </Button>
                                )
                            }
                        />
                    ) : filtered.length === 0 ? (
                        <EmptyState
                            variant="outlined"
                            size="lg"
                            tone="primary"
                            icon={<SearchX />}
                            title={t("maintenance.list.noResultsTitle")}
                            description={
                                domainFilter === ALL_DOMAINS
                                    ? t("maintenance.list.noResultsDescription", { searchTerm })
                                    : searchTerm
                                      ? t("domains.filter.no_results_search_description", { searchTerm })
                                      : t("domains.filter.no_results_description")
                            }
                            actions={
                                <Button variant="secondary" onClick={onResetFilters}>
                                    {t("domains.filter.reset")}
                                </Button>
                            }
                        />
                    ) : (
                        <>
                            <TabsContent value="room" className="mt-0">
                                <ApiStatusHandler queries={[backendsQuery, frontendsQuery, resourcesQuery]} interceptEmpty={false}>
                                    <MaintenanceBay agents={filtered} backends={backendsQuery.data ?? []} frontends={frontendsQuery.data ?? []} resources={resourcesQuery.data} onRun={onRun} />
                                </ApiStatusHandler>
                            </TabsContent>
                            <TabsContent value="grid" className="mt-0">
                                <MaintenanceAgentsGrid agents={filtered} onRun={onRun} />
                            </TabsContent>
                            <TabsContent value="table" className="mt-0">
                                <MaintenanceAgentsTable agents={filtered} onRun={onRun} />
                            </TabsContent>
                        </>
                    )}
                </ApiStatusHandler>
            </SinglePageLayout>
            <MaintenanceRunDialog agent={running} onOpenChange={open => !open && setRunning(undefined)} />
        </Tabs>
    )
}

export default MaintenanceAgents
