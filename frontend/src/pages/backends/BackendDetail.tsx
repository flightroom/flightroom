import { Alert, AlertDescription, Card, CardContent, CardHeader, CardTitle, Spinner } from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Hammer, Tag } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Navigate, useParams } from "react-router-dom"
import AiUsageSummary from "@/components/ai-usage/AiUsageSummary"
import AiWorkspace from "@/components/ai-workspace/AiWorkspace"
import { workspaceRepositoriesOf } from "@/components/ai-workspace/RepositoryBranches"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import RepositoryLink from "@/components/RepositoryLink"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import { useIsProjectViewer } from "@/store/useProjectStore"
import BackendBuildDialog from "./partials/BackendBuildDialog"
import BackendConfigurationSection from "./partials/BackendConfigurationSection"
import BackendHeader, { isBackendAiAvailable } from "./partials/BackendHeader"
import BackendReleaseDialog from "./partials/BackendReleaseDialog"
import BackendResourcesSection from "./partials/BackendResourcesSection"
import BackendVariableMapsSection from "./partials/BackendVariableMapsSection"
import BackendVersionsTable from "./partials/BackendVersionsTable"
import { useProjectEnvironmentsQuery } from "./partials/backendVariables"

const BackendRepositorySection: React.FC<{ backend: Backend }> = ({ backend }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.code_repository")}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3 text-sm">
                {backend.codeRepository?.enabled ? <RepositoryLink repository={backend.codeRepository} /> : <p className="text-foreground-secondary">{t("backends.no_repository")}</p>}
            </CardContent>
        </Card>
    )
}

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
            <BackendHeader backend={backend} active="ai" />
            {/* Keyed: the route instance is reused across backends, and a draft must not follow the user to another one. */}
            <AiWorkspace key={backend._id} target={{ kind: "backend", id: backend._id! }} name={backend.name} repositories={workspaceRepositoriesOf("backend", backend)} />
        </div>
    )
}

interface BackendDetailProps {
    /** The overview of the backend, or its Edit with AI workspace. */
    view?: "overview" | "ai"
}

const BackendDetail: React.FC<BackendDetailProps> = ({ view = "overview" }) => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const backendsApi = useBackendsApi()
    const queryClient = useQueryClient()
    const [buildOpen, setBuildOpen] = useState(false)
    const [releaseOpen, setReleaseOpen] = useState(false)
    const isViewer = useIsProjectViewer()

    const backendQuery = useQuery({ queryKey: ["backend", id], queryFn: () => backendsApi.getSingle(id!), enabled: !!id })
    const versionsQuery = useQuery({ queryKey: ["backend-versions", id], queryFn: () => backendsApi.getVersions(id!), enabled: !!id && view === "overview" })
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")
    const resourcesQuery = useResourcesQuery(view === "overview")

    const backend = backendQuery.data
    // A viewer may look, not release: the version is created by those who can write
    const canBuild = Boolean(backend?.codeRepository?.enabled) && !isViewer

    if (view === "ai") return <BackendAiSection backendQuery={backendQuery} />

    return (
        <ApiStatusHandler queries={[backendQuery, versionsQuery, environmentsQuery, configMapsQuery, secretsQuery, resourcesQuery]} interceptEmpty={false}>
            {backend && (
                <div className="flex min-h-full flex-col gap-6">
                    <BackendHeader
                        backend={backend}
                        active="overview"
                        actions={
                            !isViewer && (
                                <>
                                    {/* For an image pushed without the CI registration call: the deploy runs the tag set here */}
                                    <Button variant="secondary" onClick={() => setReleaseOpen(true)}>
                                        <Tag />
                                        {t("backends.release.action")}
                                    </Button>
                                    {canBuild && (
                                        <Button variant="primary" onClick={() => setBuildOpen(true)}>
                                            <Hammer />
                                            {t("backends.build.action")}
                                        </Button>
                                    )}
                                </>
                            )
                        }
                    />
                    {/* Sections are siblings so further ones (e.g. AI) can be added next to them. */}
                    <BackendRepositorySection backend={backend} />
                    <AiUsageSummary target={{ kind: "backend", id: backend._id! }} />
                    <BackendVersionsTable versions={versionsQuery.data ?? []} />
                    <BackendConfigurationSection backend={backend} environments={environmentsQuery.data ?? []} />
                    <BackendVariableMapsSection backend={backend} configMaps={configMapsQuery.data ?? []} secrets={secretsQuery.data ?? []} environments={environmentsQuery.data ?? []} />
                    <BackendResourcesSection backend={backend} resources={resourcesQuery.data ?? []} environments={environmentsQuery.data ?? []} canDetach={!isViewer} />
                    {!isViewer && (
                        <BackendReleaseDialog open={releaseOpen} onOpenChange={setReleaseOpen} backend={backend} onSaved={() => queryClient.invalidateQueries({ queryKey: ["backend", id] })} />
                    )}
                    {canBuild && (
                        <BackendBuildDialog
                            open={buildOpen}
                            onOpenChange={setBuildOpen}
                            backend={backend}
                            onBuilt={() => {
                                queryClient.invalidateQueries({ queryKey: ["backend-versions", id] })
                                queryClient.invalidateQueries({ queryKey: ["backend", id] })
                            }}
                        />
                    )}
                </div>
            )}
        </ApiStatusHandler>
    )
}

export default BackendDetail
