import { useQuery } from "@tanstack/react-query"
import useArgoCdApi from "@/hooks/apiClients/useArgoCdApi"
import useProjectStore from "@/store/useProjectStore"

/**
 * Whether the project initialized the Argo CD it deploys with, for every member, viewers included: config maps, secrets
 * and resources reach a container only through the manifests it applies, so without it they are not shown at all.
 * `loading` until the status is known: what depends on it stays hidden meanwhile rather than flashing.
 */
const useArgoCdStatus = () => {
    const projectId = useProjectStore(state => state.project?._id)
    const argoCdApi = useArgoCdApi()
    // The same query as the Argo CD section of the settings, so a new initialization shows at once
    const statusQuery = useQuery({ queryKey: ["argocd", projectId], queryFn: () => argoCdApi.getArgoCd(projectId!), enabled: !!projectId })

    return { initialized: Boolean(statusQuery.data?.initializedAt), loading: statusQuery.isPending }
}

export default useArgoCdStatus
