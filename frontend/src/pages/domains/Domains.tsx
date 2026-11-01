import { AddTile, EmptyState, EntityCard, SearchInput, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CirclePlus, FolderOpen, Info, LayoutGrid, Orbit, Plus, SearchX, Settings, Sparkles, Workflow } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Button } from "@/components/atoms"
import EntityCardActions, { HIDE_EMPTY_CARD_BODY } from "@/components/EntityCardActions"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import TechnologyLogo from "@/components/technology/TechnologyLogo"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import useBackendsApi from "@/hooks/apiClients/useBackendsApi"
import useDomainLinksApi, { DomainLink } from "@/hooks/apiClients/useDomainLinksApi"
import useDomainsApi, { Domain } from "@/hooks/apiClients/useDomainsApi"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import useProjectStore from "@/store/useProjectStore"
import { backendTechnologyOf, frontendTechnologyOf, type Technology } from "@/utils/technologies"
import DomainBackendLinks from "./partials/DomainBackendLinks"
import DomainGalaxy from "./partials/DomainGalaxy"
import DomainLinkDialog from "./partials/DomainLinkDialog"
import DomainScaffoldDialog, { ScaffoldItem } from "./partials/DomainScaffoldDialog"
import DomainStepsWizardDialog from "./partials/DomainStepsWizardDialog"
import DomainWizardDialog from "./partials/DomainWizardDialog"

/** Mirrors the backend: a job works on at most this many repositories. */
const MAX_REPOSITORIES = 10
const NO_IMAGES: never[] = []

const VIEWS = [
    { value: "galaxy", icon: Orbit, labelKey: "domains.viewGalaxy" },
    { value: "cards", icon: LayoutGrid, labelKey: "domains.viewCards" },
    { value: "links", icon: Workflow, labelKey: "domains.viewLinks" }
] as const

type View = (typeof VIEWS)[number]["value"]

const Domains = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const projectId = useProjectStore(state => state.project?._id)
    const domainsApi = useDomainsApi()
    const frontendsApi = useFrontendsApi()
    const backendsApi = useBackendsApi()
    const domainLinksApi = useDomainLinksApi()

    const [view, setView] = useState<View>("galaxy")
    const [searchTerm, setSearchTerm] = useState("")
    const [isWizardOpen, setIsWizardOpen] = useState(false)
    const [isStepsOpen, setIsStepsOpen] = useState(false)
    // A domain the wizard just created, with the components it proposed and the first request for the agent
    const [scaffold, setScaffold] = useState<{ domain: Domain; items: ScaffoldItem[]; request: string } | null>(null)
    const aiModels = useProjectAiModels()
    const [linkToCreate, setLinkToCreate] = useState<{ sourceDomainId: string; targetDomainId: string } | null>(null)
    const [linkToDelete, setLinkToDelete] = useState<DomainLink | null>(null)

    const domainsQuery = useQuery({
        queryKey: ["domains", projectId],
        queryFn: domainsApi.getAll,
        enabled: !!projectId
    })
    // The galaxy and the links draw the members; the cards show their technologies, without waiting for them.
    const frontendsQuery = useQuery({
        queryKey: ["frontends-by-project-id", projectId],
        queryFn: () => frontendsApi.getByProjectId(projectId!),
        enabled: !!projectId
    })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })
    const domainLinksQuery = useQuery({ queryKey: ["domain-links", projectId], queryFn: domainLinksApi.getAll, enabled: !!projectId && view === "galaxy" })
    // The galaxy draws the resources of the backends it shows
    const resourcesQuery = useResourcesQuery(view === "galaxy")

    const deleteLinkMutation = useMutation({
        mutationFn: domainLinksApi.deleteSingle,
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["domain-links"] })
    })

    // A new domain is designed with the AI when the project has one, step by step otherwise.
    const openCreate = () => (aiModels.enabled ? setIsWizardOpen(true) : setIsStepsOpen(true))

    // Without an AI its workspace has nothing to offer: the overview instead.
    const openDomain = (domainId: string) => navigate(aiModels.enabled ? `/domain/${domainId}/ai` : `/domain/${domainId}/overview`)

    const domains = domainsQuery.data ?? []
    const domainNamed = (id: string) => ({ id, name: domains.find(domain => domain._id === id)?.name ?? "" })

    const filteredDomains = useMemo(() => {
        const term = searchTerm.trim().toLowerCase()
        if (!term) return domains
        return domains.filter(domain => [domain.name, domain.slug, domain.description].some(value => value?.toLowerCase().includes(term)))
    }, [domains, searchTerm])
    // The technologies of the frontends then of the backends of each domain, once each, beside the name of its card.
    const technologiesByDomain = useMemo(() => {
        const byDomain = new Map<string, Set<Technology>>()
        const add = (domainId: string | undefined, technology: Technology | undefined) => {
            if (!domainId || !technology) return
            byDomain.set(domainId, (byDomain.get(domainId) ?? new Set()).add(technology))
        }
        for (const mfe of frontendsQuery.data ?? []) add(mfe.domainId, frontendTechnologyOf(mfe))
        for (const backend of backendsQuery.data ?? []) add(backend.domainId, backendTechnologyOf(backend))
        return byDomain
    }, [frontendsQuery.data, backendsQuery.data])

    // While searching, the galaxy and the links show only the matching domains: their members and the relations between them.
    const galaxy = useMemo(() => {
        const frontends = frontendsQuery.data ?? []
        const backends = backendsQuery.data ?? []
        const links = domainLinksQuery.data ?? []
        if (!searchTerm.trim()) return { frontends, backends, links }
        const ids = new Set(filteredDomains.map(domain => domain._id))
        return {
            frontends: frontends.filter(mfe => mfe.domainId && ids.has(mfe.domainId)),
            backends: backends.filter(backend => backend.domainId && ids.has(backend.domainId)),
            links: links.filter(link => ids.has(link.sourceDomainId) && ids.has(link.targetDomainId))
        }
    }, [frontendsQuery.data, backendsQuery.data, domainLinksQuery.data, filteredDomains, searchTerm])

    return (
        <>
            {/* The Tabs root wraps the layout so the view switcher can live in the page header, as on the domain page. */}
            <Tabs value={view} onValueChange={value => setView(value as View)} className="flex min-h-full flex-col" layoutSize="sm" iconButtons tabsListPosition="end">
                <SinglePageLayout
                    title={t("domains.title")}
                    description={t("domains.description")}
                    lrContainerClassname="items-end"
                    left={
                        domains.length > 0 && (
                            <div className="flex min-w-0 flex-[1_1_280px]">
                                <SearchInput
                                    className="max-w-sm"
                                    placeholder={t("domains.search_placeholder")}
                                    value={searchTerm}
                                    onValueChange={setSearchTerm}
                                    onClear={() => setSearchTerm("")}
                                    clearLabel={t("domains.clear_search")}
                                />
                            </div>
                        )
                    }
                    right={
                        domains.length > 0 && (
                            <div className="flex flex-[0_0_auto] items-center gap-2">
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
                                <Button variant="primary" onClick={openCreate} dataTestId="domain-create">
                                    <CirclePlus />
                                    {t("domains.add_new")}
                                </Button>
                            </div>
                        )
                    }
                >
                    <ApiStatusHandler queries={[domainsQuery]}>
                        {domains.length === 0 ? (
                            <EmptyState
                                variant="outlined"
                                size="lg"
                                tone="primary"
                                icon={<FolderOpen />}
                                title={t("domains.empty_title")}
                                description={t("domains.empty_description")}
                                actions={
                                    <Button onClick={openCreate}>
                                        <CirclePlus />
                                        {t("domains.add_new")}
                                    </Button>
                                }
                            />
                        ) : filteredDomains.length === 0 ? (
                            <EmptyState
                                variant="outlined"
                                size="lg"
                                tone="primary"
                                icon={<SearchX />}
                                title={t("domains.no_results_title")}
                                description={t("domains.no_results_description", { searchTerm })}
                                actions={
                                    <Button variant="secondary" onClick={() => setSearchTerm("")}>
                                        {t("domains.clear_search")}
                                    </Button>
                                }
                            />
                        ) : (
                            <>
                                <TabsContent value="galaxy" className="mt-0">
                                    <ApiStatusHandler queries={[frontendsQuery, backendsQuery, domainLinksQuery, resourcesQuery]} interceptEmpty={false}>
                                        <DomainGalaxy
                                            domains={filteredDomains}
                                            frontends={galaxy.frontends}
                                            backends={galaxy.backends}
                                            links={galaxy.links}
                                            resources={resourcesQuery.data}
                                            onLink={(sourceDomainId, targetDomainId) => setLinkToCreate({ sourceDomainId, targetDomainId })}
                                            onUnlink={setLinkToDelete}
                                        />
                                    </ApiStatusHandler>
                                </TabsContent>
                                <TabsContent value="links" className="mt-0">
                                    <ApiStatusHandler queries={[frontendsQuery, backendsQuery]} interceptEmpty={false}>
                                        <DomainBackendLinks domains={filteredDomains} frontends={galaxy.frontends} backends={galaxy.backends} />
                                    </ApiStatusHandler>
                                </TabsContent>
                                <TabsContent value="cards" className="mt-0">
                                    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
                                        {filteredDomains.map(domain => (
                                            <EntityCard
                                                key={domain._id}
                                                name={domain.name}
                                                logo={
                                                    technologiesByDomain.has(domain._id) && (
                                                        <span className="flex shrink-0 items-center gap-1">
                                                            {[...(technologiesByDomain.get(domain._id) ?? [])].map(technology => (
                                                                <TechnologyLogo key={technology} technology={technology} />
                                                            ))}
                                                        </span>
                                                    )
                                                }
                                                dataTestId={`domain-card-${domain.slug}`}
                                                className={HIDE_EMPTY_CARD_BODY}
                                                // The screens of the domain, as in its header. Edit with AI says why it cannot run when no AI provider is configured.
                                                actions={
                                                    <EntityCardActions
                                                        actions={[
                                                            { label: t("domains.ai.open"), icon: <Sparkles />, onClick: () => navigate(`/domain/${domain._id}`), primary: true },
                                                            { label: t("domains.workspace.nav_overview"), icon: <Info />, onClick: () => navigate(`/domain/${domain._id}/overview`) },
                                                            { label: t("domains.workspace.nav_settings"), icon: <Settings />, onClick: () => navigate(`/domain/${domain._id}/settings`) }
                                                        ]}
                                                    />
                                                }
                                            >
                                                {domain.description && <p className="line-clamp-3 text-foreground-secondary">{domain.description}</p>}
                                            </EntityCard>
                                        ))}
                                        <AddTile aspect="auto" onClick={openCreate} icon={<Plus />} label={t("domains.add_new")} description={t("domains.click_to_create")} />
                                    </div>
                                </TabsContent>
                            </>
                        )}
                    </ApiStatusHandler>
                </SinglePageLayout>
            </Tabs>
            <DomainWizardDialog
                open={isWizardOpen}
                onOpenChange={setIsWizardOpen}
                onManual={() => {
                    setIsWizardOpen(false)
                    setIsStepsOpen(true)
                }}
                onCreated={(domain, items, request) => (items.length > 0 ? setScaffold({ domain, items, request }) : openDomain(domain._id))}
            />
            <DomainStepsWizardDialog open={isStepsOpen} onOpenChange={setIsStepsOpen} onCreated={(domain, items) => setScaffold({ domain, items, request: "" })} />
            {scaffold && (
                <DomainScaffoldDialog
                    open
                    // Closed without starting the agent: the domain exists all the same, and its page can propose the components again
                    onOpenChange={open => {
                        if (open) return
                        setScaffold(null)
                        openDomain(scaffold.domain._id)
                    }}
                    domainId={scaffold.domain._id}
                    domainName={scaffold.domain.name}
                    prompt={scaffold.request}
                    images={NO_IMAGES}
                    items={scaffold.items}
                    maxRepositories={MAX_REPOSITORIES}
                    // Called right after the dialog closes: the job replaces the domain page it opened
                    onCreated={job => navigate(`/domain/${scaffold.domain._id}/ai?change=${job.rootJobId}`, { replace: true })}
                />
            )}
            <DomainLinkDialog link={linkToCreate && { source: domainNamed(linkToCreate.sourceDomainId), target: domainNamed(linkToCreate.targetDomainId) }} onClose={() => setLinkToCreate(null)} />
            <DeleteConfirmationDialog
                isOpen={Boolean(linkToDelete)}
                onOpenChange={open => !open && setLinkToDelete(null)}
                onDelete={async () => {
                    if (linkToDelete) {
                        await deleteLinkMutation.mutateAsync(linkToDelete._id)
                    }
                }}
                onDeleteSuccess={() => setLinkToDelete(null)}
                title={t("domains.galaxy.link_delete")}
                description={
                    linkToDelete ? t("domains.galaxy.link_delete_description", { source: domainNamed(linkToDelete.sourceDomainId).name, target: domainNamed(linkToDelete.targetDomainId).name }) : ""
                }
            />
        </>
    )
}

export default Domains
