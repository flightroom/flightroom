import { useQuery } from "@tanstack/react-query"
import useAiChangesApi from "@/hooks/apiClients/useAiChangesApi"
import useAiJobsApi from "@/hooks/apiClients/useAiJobsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { aiShellPreviewUrlFrom } from "@/utils/livePreview"

/** Resolves the OpenShell frontend preview from the latest relevant AI conversation. */
const useAiShellPreviewUrl = (target: { kind: "domain"; id: string } | { kind: "frontend"; frontend: Frontend }) => {
    const aiChangesApi = useAiChangesApi()
    const aiJobsApi = useAiJobsApi()
    const domainId = target.kind === "domain" ? target.id : target.frontend.domainId
    const frontendId = target.kind === "frontend" ? target.frontend._id : undefined

    const requestsQuery = useQuery({
        queryKey: ["ai-changes", frontendId],
        queryFn: () => aiChangesApi.getByTarget({ kind: "frontend", id: frontendId! }),
        enabled: Boolean(frontendId)
    })
    const jobsQuery = useQuery({
        queryKey: ["ai-jobs", "domain", domainId],
        queryFn: () => aiJobsApi.list({ domainId }),
        enabled: target.kind === "domain"
    })
    const frontendRequest = requestsQuery.data?.filter(request => request.frontendId === frontendId && request.jobId).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    const domainJob = jobsQuery.data?.find(job => job.repositories.some(repository => repository.kind === "frontend"))
    const jobId = target.kind === "frontend" ? frontendRequest?.jobId : domainJob?._id
    const chainQuery = useQuery({
        queryKey: ["ai-shell-preview", jobId],
        queryFn: () => aiJobsApi.chain(jobId!),
        enabled: Boolean(jobId)
    })
    const previewUrl = chainQuery.data ? aiShellPreviewUrlFrom(chainQuery.data, frontendId) : undefined
    const isPending = target.kind === "frontend" ? requestsQuery.isPending || Boolean(jobId && chainQuery.isPending) : jobsQuery.isPending || Boolean(jobId && chainQuery.isPending)

    return { url: previewUrl, isPending }
}

export default useAiShellPreviewUrl
