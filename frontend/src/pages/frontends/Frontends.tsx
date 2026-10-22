import { SearchInput, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { CirclePlus, DownloadCloud, LayoutGrid, Server, StretchHorizontal, Workflow } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useCodeRepositoriesApi from "@/hooks/apiClients/useCodeRepositoriesApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import useProjectStore from "@/store/useProjectStore"
import { ALL_DOMAINS, DomainFilter, matchesDomain } from "../domains/partials/DomainFilter"
import { FrontendsEmptyState, ImportRepositoriesDialog } from "./partials/components"
import { FrontendFlow, FrontendsBackendFlow, FrontendsGrid, FrontendsTable } from "./partials/views"

const VIEWS = [
    { value: "flow", icon: Workflow, labelKey: "frontend.dashboard.viewFlow" },
    { value: "grid", icon: LayoutGrid, labelKey: "frontend.dashboard.viewGrid" },
    { value: "table", icon: StretchHorizontal, labelKey: "frontend.dashboard.viewTable" },
    { value: "backend", icon: Server, labelKey: "frontend.dashboard.viewBackend" }
] as const

type View = (typeof VIEWS)[number]["value"]

const Frontends = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()

    const projectStore = useProjectStore()
    const projectId = projectStore.project?._id

    const codeRepositoriesApi = useCodeRepositoriesApi()
    const frontendsApi = useFrontendsApi()

    const [searchTerm, setSearchTerm] = useState("")
    const [domainFilter, setDomainFilter] = useState(ALL_DOMAINS)
    const [view, setView] = useState<View>("flow")
    const [importDialogOpen, setImportDialogOpen] = useState(false)

    const onResetFilters = () => {
        setSearchTerm("")
        setDomainFilter(ALL_DOMAINS)
    }

    const frontendListQuery = useQuery({
        queryKey: ["frontends-by-project-id", projectId],
        queryFn: () => frontendsApi.getByProjectId(projectId),
        enabled: !!projectId
    })

    const codeRepositoriesQuery = useQuery({
        queryKey: ["repositories", projectId],
        queryFn: () => codeRepositoriesApi.getRepositoriesByProjectId(projectId!),
        enabled: !!projectId
    })

    const codeRepositories = codeRepositoriesQuery.data ?? []
    // Importing repositories only makes sense once at least one provider connection exists.
    const canImportRepositories = codeRepositories.length > 0

    const frontendsList = useMemo(() => {
        const data = frontendListQuery?.data

        if (!data) {
            return null
        }

        if (!searchTerm && domainFilter === ALL_DOMAINS) return data

        const filteredData = data.filter(mfe => {
            const nameMatch = searchTerm ? mfe.name.toLowerCase().includes(searchTerm.toLowerCase()) : true
            return nameMatch && matchesDomain(mfe.domainId, domainFilter)
        })

        return filteredData
    }, [frontendListQuery?.data, searchTerm, domainFilter])

    const totalCount = frontendListQuery.data?.length ?? 0
    const filteredCount = frontendsList?.length ?? 0
    // The toolbar is only useful once the project actually has something to search through or switch views on.
    const hasFrontends = totalCount > 0
    const isFiltered = Boolean(searchTerm) || domainFilter !== ALL_DOMAINS

    const onAddNewFrontend = async (parentId?: string) => {
        const repositories = await codeRepositoriesApi.getRepositoriesByProjectId(projectStore.project?._id!)
        if (repositories && repositories.length > 0) {
            if (parentId) {
                navigate(`/templates-library?parentId=${parentId}`)
            } else {
                navigate(`/templates-library`)
            }
        } else {
            if (parentId) {
                navigate(`/frontend/new?parentId=${parentId}`)
            } else {
                navigate(`/frontend/new`)
            }
        }
    }

    return (
        // The Tabs root wraps the whole layout so the view switcher can live in the page header, next to the primary action.
        // `layoutSize="sm"` is what keeps the switcher aligned with those buttons: TabsList adds its own border and padding
        // around the triggers, so at the default size the group totals 48px against the 40px of a default Button.
        <Tabs value={view} onValueChange={value => setView(value as View)} className="flex min-h-full flex-col" layoutSize="sm" iconButtons tabsListPosition="end">
            <SinglePageLayout
                title={t("frontend.dashboard.title")}
                description={t("frontend.dashboard.description")}
                lrContainerClassname="items-end"
                left={
                    hasFrontends ? (
                        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <SearchInput
                                    className="max-w-sm"
                                    placeholder={t("frontend.dashboard.searchPlaceholder")}
                                    value={searchTerm}
                                    onValueChange={setSearchTerm}
                                    onClear={() => setSearchTerm("")}
                                    clearLabel={t("frontend.dashboard.clearSearch")}
                                />
                                <DomainFilter value={domainFilter} onValueChange={setDomainFilter} />
                            </div>
                            <p className="text-sm text-foreground-secondary" aria-live="polite">
                                {isFiltered ? t("frontend.dashboard.filteredCount", { count: filteredCount, total: totalCount }) : t("frontend.dashboard.totalCount", { count: totalCount })}
                            </p>
                        </div>
                    ) : null
                }
                right={
                    <div className="flex flex-[0_0_auto] items-center gap-2">
                        {hasFrontends && (
                            <TabsList>
                                {VIEWS.map(({ value, icon: Icon, labelKey }) => (
                                    // Labelled via aria-label/title rather than a Radix Tooltip: TooltipTrigger would
                                    // overwrite the trigger's own `data-state`, which is what drives the active styling.
                                    // The shared `accent` active state is a pale wash on this theme, so the selected
                                    // view gets the stronger primary fill.
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
                        {canImportRepositories && (
                            <Button variant="secondary" onClick={() => setImportDialogOpen(true)}>
                                <DownloadCloud />
                                {t("frontend.import.action")}
                            </Button>
                        )}
                        <Button variant="primary" onClick={() => onAddNewFrontend()}>
                            <CirclePlus />
                            {t("frontend.add_new")}
                        </Button>
                    </div>
                }
            >
                <ApiStatusHandler queries={[frontendListQuery]}>
                    {!hasFrontends ? (
                        <FrontendsEmptyState variant="empty" onAddNewFrontend={() => onAddNewFrontend()} onImportRepositories={canImportRepositories ? () => setImportDialogOpen(true) : undefined} />
                    ) : filteredCount === 0 ? (
                        <FrontendsEmptyState
                            variant="no-results"
                            searchTerm={searchTerm}
                            onResetFilters={onResetFilters}
                            noResultsDescription={
                                domainFilter === ALL_DOMAINS ? undefined : searchTerm ? t("domains.filter.no_results_search_description", { searchTerm }) : t("domains.filter.no_results_description")
                            }
                        />
                    ) : (
                        <>
                            <TabsContent value="flow" className="mt-0">
                                <FrontendFlow frontends={frontendsList} onAddNewFrontend={onAddNewFrontend} />
                            </TabsContent>
                            <TabsContent value="grid" className="mt-0">
                                <FrontendsGrid frontends={frontendsList} onAddNewFrontend={onAddNewFrontend} />
                            </TabsContent>
                            <TabsContent value="table" className="mt-0">
                                <FrontendsTable frontends={frontendsList} />
                            </TabsContent>
                            <TabsContent value="backend" className="mt-0">
                                <FrontendsBackendFlow frontends={frontendsList} />
                            </TabsContent>
                        </>
                    )}
                </ApiStatusHandler>

                {canImportRepositories && <ImportRepositoriesDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} codeRepositories={codeRepositories} />}
            </SinglePageLayout>
        </Tabs>
    )
}

export default Frontends
