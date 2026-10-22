import { EmptyState, SearchInput, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { CirclePlus, LayoutGrid, PackageOpen, SearchX, StretchHorizontal } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useFrontendsApi, { FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import useServicesApi from "@/hooks/apiClients/useServicesApi"
import useProjectStore from "@/store/useProjectStore"
import { ALL_DOMAINS, DomainFilter, matchesDomain } from "../domains/partials/DomainFilter"
import { ServicesGrid } from "./partials/ServicesGrid"
import { ServicesTable } from "./partials/ServicesTable"

const VIEWS = [
    { value: "grid", icon: LayoutGrid, labelKey: "services.list.viewGrid" },
    { value: "table", icon: StretchHorizontal, labelKey: "services.list.viewTable" }
] as const

type View = (typeof VIEWS)[number]["value"]

const Services = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const servicesApi = useServicesApi()
    const frontendsApi = useFrontendsApi()
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
    const dockerFrontends = useMemo(() => (frontendsQuery.data ?? []).filter(frontend => frontend.kind === FrontendKind.DOCKER), [frontendsQuery.data])

    const { filtered, filteredFrontends } = useMemo(() => {
        const term = searchTerm.toLowerCase()
        const matches = (item: { name: string; slug: string; domainId?: string | null }) =>
            (!term || item.name.toLowerCase().includes(term) || item.slug.toLowerCase().includes(term)) && matchesDomain(item.domainId, domainFilter)
        return { filtered: (servicesQuery.data ?? []).filter(matches), filteredFrontends: dockerFrontends.filter(matches) }
    }, [servicesQuery.data, dockerFrontends, searchTerm, domainFilter])

    const totalCount = (servicesQuery.data?.length ?? 0) + dockerFrontends.length
    const filteredCount = filtered.length + filteredFrontends.length
    const hasServices = totalCount > 0
    const isFiltered = Boolean(searchTerm) || domainFilter !== ALL_DOMAINS
    const onResetFilters = () => {
        setSearchTerm("")
        setDomainFilter(ALL_DOMAINS)
    }
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
                    ) : filteredCount === 0 ? (
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
                            <TabsContent value="grid" className="mt-0">
                                <ServicesGrid services={filtered} frontends={filteredFrontends} />
                            </TabsContent>
                            <TabsContent value="table" className="mt-0">
                                <ServicesTable services={filtered} frontends={filteredFrontends} />
                            </TabsContent>
                        </>
                    )}
                </ApiStatusHandler>
            </SinglePageLayout>
        </Tabs>
    )
}

export default Services
