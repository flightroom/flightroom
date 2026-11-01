import { useQuery } from "@tanstack/react-query"
import useArgoCdApi from "@/hooks/apiClients/useArgoCdApi"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"

/**
 * Whether the project initialized the Argo CD it deploys with: the logs and the variables of a running container are read through it.
 * Never for a viewer, who reads neither.
 */
const useArgoCdInitialized = () => {
    const projectId = useProjectStore(state => state.project?._id)
    const isViewer = useIsProjectViewer()
    const argoCdApi = useArgoCdApi()
    // The same query as the Argo CD section of the settings, so a new initialization shows at once
    const statusQuery = useQuery({ queryKey: ["argocd", projectId], queryFn: () => argoCdApi.getArgoCd(projectId!), enabled: !!projectId && !isViewer })

    return Boolean(!isViewer && statusQuery.data?.initializedAt)
}

export default useArgoCdInitialized
