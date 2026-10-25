import { useQuery } from "@tanstack/react-query"
import useDomainDeploymentsApi from "@/hooks/apiClients/useDomainDeploymentsApi"
import useFrontendsApi, { type Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import useProjectStore from "@/store/useProjectStore"
import { domainLivePreviewUrl, frontendLivePreviewUrl } from "@/utils/livePreview"

type LivePreviewTarget = { kind: "domain"; id: string } | { kind: "frontend"; frontend: Frontend }

/** Resolves the deployed, browser-reachable URL shown by a domain or frontend workspace. */
const useLivePreviewUrl = (target: LivePreviewTarget) => {
    const projectId = useProjectStore(state => state.project?._id)
    const exposure = useProjectStore(state => state.project?.exposure)
    const domainId = target.kind === "domain" ? target.id : target.frontend.domainId
    const deploymentsApi = useDomainDeploymentsApi()
    const frontendsApi = useFrontendsApi()
    const deploymentsQuery = useQuery({
        queryKey: ["domain-deployments", domainId],
        queryFn: () => deploymentsApi.getByDomain(domainId!),
        enabled: Boolean(domainId)
    })
    const frontendsQuery = useQuery({
        queryKey: ["frontends-by-project-id", projectId],
        queryFn: () => frontendsApi.getByProjectId(projectId!),
        enabled: Boolean(projectId)
    })
    const environmentsQuery = useProjectEnvironmentsQuery()
    const frontends = frontendsQuery.data ?? []
    const environments = environmentsQuery.data ?? []
    const url =
        target.kind === "frontend"
            ? frontendLivePreviewUrl(target.frontend, frontends, deploymentsQuery.data, environments, exposure)
            : domainLivePreviewUrl(frontends, deploymentsQuery.data, environments, exposure)

    return {
        url,
        isPending: (Boolean(domainId) && deploymentsQuery.isPending) || (Boolean(projectId) && (frontendsQuery.isPending || environmentsQuery.isPending))
    }
}

export default useLivePreviewUrl
