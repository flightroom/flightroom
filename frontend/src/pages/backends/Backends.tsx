import { EmptyState, SearchInput, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { CirclePlus, LayoutGrid, Orbit, PackageOpen, SearchX, StretchHorizontal } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import useDomainLinksApi from "@/hooks/apiClients/useDomainLinksApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi, { FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import useProjectStore from "@/store/useProjectStore"
import { ALL_DOMAINS, DomainFilter, matchesDomain } from "../domains/partials/DomainFilter"
import DomainGalaxy from "../domains/partials/DomainGalaxy"
import { BackendsGrid } from "./partials/BackendsGrid"
import { BackendsTable } from "./partials/BackendsTable"

const VIEWS = [
    { value: "galaxy", icon: Orbit, labelKey: "backends.list.viewGalaxy" },
    { value: "grid", icon: LayoutGrid, labelKey: "backends.list.viewGrid" },
    { value: "table", icon: StretchHorizontal, labelKey: "backends.list.viewTable" }
] as const

type View = (typeof VIEWS)[number]["value"]

const ListSection: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({ title, count, children }) => (
    <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
            {title} <span className="font-normal text-foreground-secondary">({count})</span>
        </h2>
        {children}
    </section>
)

const Backends = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const backendsApi = useBackendsApi()
    const frontendsApi = useFrontendsApi()
    const domainsApi = useDomainsApi()
    const domainLinksApi = useDomainLinksApi()
    const [searchTerm, setSearchTerm] = useState("")
    const [domainFilter, setDomainFilter] = useState(ALL_DOMAINS)
    const [view, setView] = useState<View>("galaxy")

    const backendsQuery = useQuery({
        queryKey: ["backends", projectId],
        queryFn: backendsApi.getAll,
        enabled: !!projectId
    })

    // A frontend served by its own container runs like a backend, so it is listed here too
    const frontendsQuery = useQuery({
        queryKey: ["frontends-by-project-id", projectId],
        queryFn: () => frontendsApi.getByProjectId(projectId),
        enabled: !!projectId
    })
    // Only the galaxy needs the domains, their relations and the resources: the grid and the table do not wait for them.
    const isGalaxy = view === "galaxy"
    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll, enabled: !!projectId && isGalaxy })
    const domainLinksQuery = useQuery({ queryKey: ["domain-links", projectId], queryFn: domainLinksApi.getAll, enabled: !!projectId && isGalaxy })
    const resourcesQuery = useResourcesQuery(isGalaxy)
    const dockerFrontends = useMemo(() => (frontendsQuery.data ?? []).filter(frontend => frontend.kind === FrontendKind.DOCKER), [frontendsQuery.data])

    const { filtered, filteredFrontends } = useMemo(() => {
        const term = searchTerm.toLowerCase()
        const matches = (item: { name: string; slug: string; domainId?: string | null }) =>
            (!term || item.name.toLowerCase().includes(term) || item.slug.toLowerCase().includes(term)) && matchesDomain(item.domainId, domainFilter)
        return { filtered: (backendsQuery.data ?? []).filter(matches), filteredFrontends: dockerFrontends.filter(matches) }
    }, [backendsQuery.data, dockerFrontends, searchTerm, domainFilter])

    const isFiltered = Boolean(searchTerm) || domainFilter !== ALL_DOMAINS
    // The galaxy of the backends shows the backends the filters leave; while filtering, only the domains they are in,
    // and the relations between those.
    const galaxy = useMemo(() => {
        const allDomains = domainsQuery.data ?? []
        const domains = isFiltered ? allDomains.filter(domain => filtered.some(backend => backend.domainId === domain._id)) : allDomains
        const ids = new Set(domains.map(domain => domain._id))
        return { domains, links: (domainLinksQuery.data ?? []).filter(link => ids.has(link.sourceDomainId) && ids.has(link.targetDomainId)) }
    }, [domainsQuery.data, domainLinksQuery.data, filtered, isFiltered])

    const totalCount = (backendsQuery.data?.length ?? 0) + dockerFrontends.length
    const filteredCount = filtered.length + filteredFrontends.length
    const hasBackends = totalCount > 0
    const onResetFilters = () => {
        setSearchTerm("")
        setDomainFilter(ALL_DOMAINS)
    }
    // Backends and Docker frontends in two sections, each shown only when the filters leave something in it.
    // Without Docker frontends in the project the list stays a plain list of backends.
    const renderSections = (backendsView: React.ReactNode, frontendsView: React.ReactNode) =>
        dockerFrontends.length === 0 ? (
            backendsView
        ) : (
            <>
                {filtered.length > 0 && (
                    <ListSection title={t("backends.list.backendsSection")} count={filtered.length}>
                        {backendsView}
                    </ListSection>
                )}
                {filteredFrontends.length > 0 && (
                    <ListSection title={t("backends.list.dockerFrontendsSection")} count={filteredFrontends.length}>
                        {frontendsView}
                    </ListSection>
                )}
            </>
        )
    // The form picks the template itself: the library is only one way in
    const onCreate = () => navigate("/backend/new")

    return (
        <Tabs value={view} onValueChange={value => setView(value as View)} className="flex min-h-full flex-col" layoutSize="sm" iconButtons tabsListPosition="end">
            <SinglePageLayout
                title={t("backends.list.title")}
                description={t("backends.list.description")}
                lrContainerClassname="items-end"
                left={
                    hasBackends ? (
                        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <SearchInput
                                    className="max-w-sm"
                                    placeholder={t("backends.list.searchPlaceholder")}
                                    value={searchTerm}
                                    onValueChange={setSearchTerm}
                                    onClear={() => setSearchTerm("")}
                                    clearLabel={t("backends.list.clearSearch")}
                                />
                                <DomainFilter value={domainFilter} onValueChange={setDomainFilter} />
                            </div>
                            <p className="text-sm text-foreground-secondary" aria-live="polite">
                                {isFiltered ? t("backends.list.filteredCount", { count: filteredCount, total: totalCount }) : t("backends.list.totalCount", { count: totalCount })}
                            </p>
                        </div>
                    ) : null
                }
                right={
                    <div className="flex flex-[0_0_auto] items-center gap-2">
                        {hasBackends && (
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
                        <Button variant="primary" onClick={onCreate}>
                            <CirclePlus />
                            {t("backends.add_new")}
                        </Button>
                    </div>
                }
            >
                <ApiStatusHandler queries={[backendsQuery, frontendsQuery]}>
                    {!hasBackends ? (
                        <EmptyState
                            variant="outlined"
                            size="lg"
                            tone="primary"
                            icon={<PackageOpen />}
                            title={t("backends.list.emptyTitle")}
                            description={t("backends.list.emptyDescription")}
                            actions={
                                <Button onClick={onCreate}>
                                    <CirclePlus />
                                    {t("backends.list.createFromTemplate")}
                                </Button>
                            }
                        />
                    ) : (isGalaxy ? isFiltered && filtered.length === 0 : filteredCount === 0) ? (
                        <EmptyState
                            variant="outlined"
                            size="lg"
                            tone="primary"
                            icon={<SearchX />}
                            title={t("backends.list.noResultsTitle")}
                            description={
                                domainFilter === ALL_DOMAINS
                                    ? t("backends.list.noResultsDescription", { searchTerm })
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
                            <TabsContent value="grid" className="mt-0 flex flex-col gap-6">
                                {renderSections(<BackendsGrid backends={filtered} />, <BackendsGrid frontends={filteredFrontends} />)}
                            </TabsContent>
                            <TabsContent value="table" className="mt-0 flex flex-col gap-6">
                                {renderSections(<BackendsTable backends={filtered} />, <BackendsTable frontends={filteredFrontends} />)}
                            </TabsContent>
                            {/* The backends only: the Docker frontends are frontends, on the map of the domains */}
                            <TabsContent value="galaxy" className="mt-0">
                                <ApiStatusHandler queries={[domainsQuery, domainLinksQuery, resourcesQuery]} interceptEmpty={false}>
                                    <DomainGalaxy scope="backend" domains={galaxy.domains} backends={filtered} links={galaxy.links} resources={resourcesQuery.data} />
                                </ApiStatusHandler>
                            </TabsContent>
                        </>
                    )}
                </ApiStatusHandler>
            </SinglePageLayout>
        </Tabs>
    )
}

export default Backends
