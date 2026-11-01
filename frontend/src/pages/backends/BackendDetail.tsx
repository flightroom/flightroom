import { Alert, AlertDescription, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Boxes, Info, ScrollText, Variable } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Navigate, useParams, useSearchParams } from "react-router-dom"
import AiUsageSummary from "@/components/ai-usage/AiUsageSummary"
import AiWorkspace from "@/components/ai-workspace/AiWorkspace"
import { workspaceRepositoriesOf } from "@/components/ai-workspace/RepositoryBranches"
import ApplicationLogsSection from "@/components/application-logs/ApplicationLogsSection"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { ApiStatusHandler } from "@/components/organisms"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import useArgoCdInitialized from "@/hooks/useArgoCdInitialized"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import BackendActions from "./partials/BackendActions"
import { BackendEndpointsCard, ContainerComputeCard, ContainerEnvSection } from "./partials/BackendConfigurationSection"
import BackendHeader, { isBackendAiAvailable } from "./partials/BackendHeader"
import BackendResourcesSection from "./partials/BackendResourcesSection"
import BackendVariableMapsSection from "./partials/BackendVariableMapsSection"
import BackendVersionsTable from "./partials/BackendVersionsTable"
import { useProjectEnvironmentsQuery } from "./partials/backendVariables"
import ContainerEnvironmentCard from "./partials/ContainerEnvironmentCard"
import { EnvironmentVersionsCard } from "./partials/EnvironmentVersionFields"
import { LogLevelCard } from "./partials/LogLevelOverrideField"

/**
 * The landing screen of a backend: Edit with AI on its repository, the same workspace as a frontend's.
 * Without AI editing, the overview takes its place. Not inside an ApiStatusHandler: it unmounts its children on every background refetch, and the workspace holds a draft prompt.
 */
const BackendAiSection: React.FC<{ backendQuery: { isPending: boolean; isError: boolean; error: unknown; data?: Backend } }> = ({ backendQuery }) => {
    const { t } = useTranslation()
    const aiModels = useProjectAiModels()

    // The project's AIs decide where the page goes: it waits for them as for the backend.
    if (backendQuery.isPending || aiModels.isPending) {
        return (
            <div className="flex min-h-[200px] items-center justify-center">
                <Spinner size={32} />
            </div>
        )
    }

    if (backendQuery.isError || !backendQuery.data) {
        return (
            <Alert variant="destructive">
                <AlertDescription>{backendQuery.error instanceof Error ? backendQuery.error.message : t("app.error.generic")}</AlertDescription>
            </Alert>
        )
    }

    const backend = backendQuery.data
    if (!isBackendAiAvailable(backend, aiModels.enabled)) return <Navigate to={`/backend/${backend._id}/overview`} replace />

    return (
        <div className="flex min-h-full flex-col gap-6">
            <BackendHeader backend={backend} active="ai" actions={<BackendActions backend={backend} />} />
            {/* Keyed: the route instance is reused across backends, and a draft must not follow the user to another one. */}
            <AiWorkspace key={backend._id} target={{ kind: "backend", id: backend._id! }} name={backend.name} repositories={workspaceRepositoriesOf("backend", backend)} />
        </div>
    )
}

const TABS = ["summary", "resources", "logs", "variables"] as const
type Tab = (typeof TABS)[number]

const TAB_ICONS: Record<Tab, React.ComponentType> = { summary: Info, resources: Boxes, logs: ScrollText, variables: Variable }

interface BackendDetailProps {
    /** The overview of the backend, or its Edit with AI workspace. */
    view?: "overview" | "ai"
}

const BackendDetail: React.FC<BackendDetailProps> = ({ view = "overview" }) => {
    const { id } = useParams<{ id: string }>()
    const backendsApi = useBackendsApi()
    const aiModels = useProjectAiModels()
    const argoCdInitialized = useArgoCdInitialized()
    const { t } = useTranslation()
    // The tab lives in the URL (`?tab=logs`) so that a link can point straight to one of them, as in the settings.
    const [searchParams, setSearchParams] = useSearchParams()
    const requestedTab = searchParams.get("tab")
    // The logs and the variables the container received are read through Argo CD, and never by a viewer: no tabs for them otherwise
    const tabs = TABS.filter(value => (value !== "logs" && value !== "variables") || argoCdInitialized)
    const tab: Tab = tabs.includes(requestedTab as Tab) ? (requestedTab as Tab) : "summary"

    const backendQuery = useQuery({ queryKey: ["backend", id], queryFn: () => backendsApi.getSingle(id!), enabled: !!id })
    const versionsQuery = useQuery({ queryKey: ["backend-versions", id], queryFn: () => backendsApi.getVersions(id!), enabled: !!id && view === "overview" })
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")
    const resourcesQuery = useResourcesQuery(view === "overview")

    const backend = backendQuery.data

    if (view === "ai") return <BackendAiSection backendQuery={backendQuery} />

    return (
        <ApiStatusHandler queries={[backendQuery, versionsQuery, environmentsQuery, configMapsQuery, secretsQuery, resourcesQuery]} interceptEmpty={false}>
            {backend && (
                <div className="flex min-h-full flex-col gap-6">
                    <BackendHeader
                        backend={backend}
                        active="overview"
                        // The actions live in Edit with AI: here only when that screen does not exist
                        actions={!aiModels.isPending && !isBackendAiAvailable(backend, aiModels.enabled) && <BackendActions backend={backend} />}
                    />
                    {/* One concern per tab: what the backend is and where it answers, what it uses, what it logs, what the running container received. */}
                    <Tabs value={tab} onValueChange={value => setSearchParams({ tab: value }, { replace: true })}>
                        <TabsList aria-label={t("backends.overview_tabs.label")}>
                            {tabs.map(value => {
                                const Icon = TAB_ICONS[value]
                                return (
                                    <TabsTrigger key={value} value={value} dataTestId={`backend-tab-${value}`}>
                                        <Icon />
                                        {t(`backends.overview_tabs.${value}`)}
                                    </TabsTrigger>
                                )
                            })}
                        </TabsList>

                        <TabsContent value="summary" className="mt-6 flex flex-col gap-6">
                            <EnvironmentVersionsCard entries={backend.environmentVersions} environments={environmentsQuery.data ?? []} container={backend} />
                            <BackendEndpointsCard backend={backend} environments={environmentsQuery.data ?? []} />
                            {/* Above the logs when they have a tab */}
                            {!tabs.includes("logs") && <LogLevelCard value={backend.logLevel} />}
                            <AiUsageSummary target={{ kind: "backend", id: backend._id! }} />
                            <BackendVersionsTable versions={versionsQuery.data ?? []} />
                        </TabsContent>

                        {/* What the container uses: its resources, config maps and secrets, and the variables it declares */}
                        <TabsContent value="resources" className="mt-6 flex flex-col gap-6">
                            <ContainerComputeCard backend={backend} environments={environmentsQuery.data ?? []} />
                            <BackendResourcesSection backend={backend} resources={resourcesQuery.data ?? []} environments={environmentsQuery.data ?? []} />
                            <BackendVariableMapsSection backend={backend} configMaps={configMapsQuery.data ?? []} secrets={secretsQuery.data ?? []} environments={environmentsQuery.data ?? []} />
                            <ContainerEnvSection backend={backend} />
                        </TabsContent>

                        <TabsContent value="logs" className="mt-6 flex flex-col gap-6">
                            <LogLevelCard value={backend.logLevel} />
                            <ApplicationLogsSection slug={backend.slug} environments={environmentsQuery.data ?? []} />
                        </TabsContent>

                        <TabsContent value="variables" className="mt-6 flex flex-col gap-6">
                            <ContainerEnvironmentCard kind="backend" id={backend._id!} environments={environmentsQuery.data ?? []} />
                        </TabsContent>
                    </Tabs>
                </div>
            )}
        </ApiStatusHandler>
    )
}

export default BackendDetail
