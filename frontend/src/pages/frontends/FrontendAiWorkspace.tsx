import { Alert, AlertDescription, Spinner } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Navigate, useParams, useSearchParams } from "react-router-dom"
import AiWorkspace from "@/components/ai-workspace/AiWorkspace"
import { workspaceRepositoriesOf } from "@/components/ai-workspace/RepositoryBranches"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import useFrontendsApi from "@/hooks/apiClients/useFrontendsApi"
import { FrontendActions, FrontendHeader, isAiEditAvailable } from "@/pages/frontends/partials/components"

/** The landing screen of a frontend: Edit with AI. Without AI editing, the overview takes its place. */
const FrontendAiWorkspacePage: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const [searchParams] = useSearchParams()
    const aiModels = useProjectAiModels()
    const frontendsApi = useFrontendsApi()

    const frontendQuery = useQuery({
        queryKey: ["mfe", id],
        queryFn: () => frontendsApi.getSingle(id)
    })

    // Links made when every section was a tab of this page: `?tab=hosting` and the like now belong to the details screen.
    const legacyTab = searchParams.get("tab")
    if (legacyTab && legacyTab !== "aiChange") return <Navigate to={`/frontend/${id}/settings?tab=${encodeURIComponent(legacyTab)}`} replace />

    // Not an ApiStatusHandler: it unmounts its children on every background refetch, and the workspace holds a draft prompt.
    // The project's AIs decide where the page goes: it waits for them as for the frontend.
    if (frontendQuery.isPending || aiModels.isPending) {
        return (
            <div className="flex min-h-[200px] items-center justify-center">
                <Spinner size={32} />
            </div>
        )
    }

    if (frontendQuery.isError) {
        return (
            <Alert variant="destructive">
                <AlertDescription>{frontendQuery.error instanceof Error ? frontendQuery.error.message : t("app.error.generic")}</AlertDescription>
            </Alert>
        )
    }

    const frontend = frontendQuery.data
    if (!isAiEditAvailable(frontend, aiModels.enabled)) return <Navigate to={`/frontend/${id}/overview`} replace />

    return (
        <div className="flex min-h-full flex-col gap-6">
            <FrontendHeader frontend={frontend} active="ai" aiAvailable actions={<FrontendActions frontend={frontend} />} />
            {/* Keyed: the route instance is reused across frontends, and a draft must not follow the user to another one. */}
            <AiWorkspace key={id} target={{ kind: "frontend", id: id! }} name={frontend.name} repositories={workspaceRepositoriesOf("frontend", frontend)} />
        </div>
    )
}

export default FrontendAiWorkspacePage
