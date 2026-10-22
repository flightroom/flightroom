import { EmptyState, SearchInput, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { CirclePlus, LayoutGrid, Orbit, PackageOpen, SearchX, StretchHorizontal } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useDomainLinksApi from "@/hooks/apiClients/useDomainLinksApi"
import useDomainsApi from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi, { FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import useServicesApi from "@/hooks/apiClients/useServicesApi"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import useProjectStore from "@/store/useProjectStore"
import { ALL_DOMAINS, DomainFilter, matchesDomain } from "../domains/partials/DomainFilter"
import DomainGalaxy from "../domains/partials/DomainGalaxy"
import { ServicesGrid } from "./partials/ServicesGrid"
import { ServicesTable } from "./partials/ServicesTable"

const VIEWS = [
    { value: "grid", icon: LayoutGrid, labelKey: "services.list.viewGrid" },
    { value: "table", icon: StretchHorizontal, labelKey: "services.list.viewTable" },
    { value: "galaxy", icon: Orbit, labelKey: "services.list.viewGalaxy" }
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

const Services = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const servicesApi = useServicesApi()
    const frontendsApi = useFrontendsApi()
    const domainsApi = useDomainsApi()
    const domainLinksApi = useDomainLinksApi()
    const [searchTerm, setSearchTerm] = useState("")
    const [domainFilter, setDomainFilter] = useState(ALL_DOMAINS)
    const [view, setView] = useState<View>("grid")

    const servicesQuery = useQuery({
        queryKey: ["services", projectId],
        queryFn: servicesApi.getAll,
        enabled: !!projectId
    })

    // A frontend served by its own container runs like a service, so it is listed here too
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
        return { filtered: (servicesQuery.data ?? []).filter(matches), filteredFrontends: dockerFrontends.filter(matches) }
    }, [servicesQuery.data, dockerFrontends, searchTerm, domainFilter])

    const isFiltered = Boolean(searchTerm) || domainFilter !== ALL_DOMAINS
    // The galaxy of the backends shows the services the filters leave; while filtering, only the domains they are in,
    // and the relations between those.
    const galaxy = useMemo(() => {
        const allDomains = domainsQuery.data ?? []
        const domains = isFiltered ? allDomains.filter(domain => filtered.some(service => service.domainId === domain._id)) : allDomains
        const ids = new Set(domains.map(domain => domain._id))
        return { domains, links: (domainLinksQuery.data ?? []).filter(link => ids.has(link.sourceDomainId) && ids.has(link.targetDomainId)) }
    }, [domainsQuery.data, domainLinksQuery.data, filtered, isFiltered])

    const totalCount = (servicesQuery.data?.length ?? 0) + dockerFrontends.length
    const filteredCount = filtered.length + filteredFrontends.length
    const hasServices = totalCount > 0
    const onResetFilters = () => {
        setSearchTerm("")
        setDomainFilter(ALL_DOMAINS)
    }
    // Backends and Docker frontends in two sections, each shown only when the filters leave something in it.
    // Without Docker frontends in the project the list stays a plain list of services.
    const renderSections = (servicesView: React.ReactNode, frontendsView: React.ReactNode) =>
        dockerFrontends.length === 0 ? (
            servicesView
        ) : (
            <>
                {filtered.length > 0 && (
                    <ListSection title={t("services.list.backendsSection")} count={filtered.length}>
                        {servicesView}
                    </ListSection>
                )}
                {filteredFrontends.length > 0 && (
                    <ListSection title={t("services.list.dockerFrontendsSection")} count={filteredFrontends.length}>
                        {frontendsView}
                    </ListSection>
                )}
            </>
        )
    // The form picks the template itself: the library is only one way in
    const onCreate = () => navigate("/service/new")

    return (
        <Tabs value={view} onValueChange={value => setView(value as View)} className="flex min-h-full flex-col" layoutSize="sm" iconButtons tabsListPosition="end">
            <SinglePageLayout
                title={t("services.list.title")}
                description={t("services.list.description")}
                lrContainerClassname="items-end"
                left={
                    hasServices ? (
                        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <SearchInput
                                    className="max-w-sm"
                                    placeholder={t("services.list.searchPlaceholder")}
                                    value={searchTerm}
                                    onValueChange={setSearchTerm}
                                    onClear={() => setSearchTerm("")}
                                    clearLabel={t("services.list.clearSearch")}
                                />
                                <DomainFilter value={domainFilter} onValueChange={setDomainFilter} />
                            </div>
                            <p className="text-sm text-foreground-secondary" aria-live="polite">
                                {isFiltered ? t("services.list.filteredCount", { count: filteredCount, total: totalCount }) : t("services.list.totalCount", { count: totalCount })}
                            </p>
                        </div>
                    ) : null
                }
                right={
                    <div className="flex flex-[0_0_auto] items-center gap-2">
                        {hasServices && (
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
                            {t("services.add_new")}
                        </Button>
                    </div>
                }
            >
                <ApiStatusHandler queries={[servicesQuery, frontendsQuery]}>
                    {!hasServices ? (
                        <EmptyState
                            variant="outlined"
                            size="lg"
                            tone="primary"
                            icon={<PackageOpen />}
                            title={t("services.list.emptyTitle")}
                            description={t("services.list.emptyDescription")}
                            actions={
                                <Button onClick={onCreate}>
                                    <CirclePlus />
                                    {t("services.list.createFromTemplate")}
                                </Button>
                            }
                        />
                    ) : (isGalaxy ? isFiltered && filtered.length === 0 : filteredCount === 0) ? (
                        <EmptyState
                            variant="outlined"
                            size="lg"
                            tone="primary"
                            icon={<SearchX />}
                            title={t("services.list.noResultsTitle")}
                            description={
                                domainFilter === ALL_DOMAINS
                                    ? t("services.list.noResultsDescription", { searchTerm })
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
                                {renderSections(<ServicesGrid services={filtered} />, <ServicesGrid frontends={filteredFrontends} />)}
                            </TabsContent>
                            <TabsContent value="table" className="mt-0 flex flex-col gap-6">
                                {renderSections(<ServicesTable services={filtered} />, <ServicesTable frontends={filteredFrontends} />)}
                            </TabsContent>
                            {/* The backends only: the Docker frontends are frontends, on the map of the domains */}
                            <TabsContent value="galaxy" className="mt-0">
                                <ApiStatusHandler queries={[domainsQuery, domainLinksQuery, resourcesQuery]} interceptEmpty={false}>
                                    <DomainGalaxy scope="backend" domains={galaxy.domains} services={filtered} links={galaxy.links} resources={resourcesQuery.data} />
                                </ApiStatusHandler>
                            </TabsContent>
                        </>
                    )}
                </ApiStatusHandler>
            </SinglePageLayout>
        </Tabs>
    )
}

export default Services
