import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import useAiChangesApi from "@/hooks/apiClients/useAiChangesApi"
import useAiJobsApi from "@/hooks/apiClients/useAiJobsApi"
import { AiWorkspaceTarget, isActive, isJobBusy, isRepositoryTarget, POLL_INTERVAL_MS } from "./aiWorkspaceUtils"
import { jobEntries, requestEntries } from "./queueEntries"

/** The conversations of a workspace, as the entries of its queue. */
export const useWorkspaceQueue = (target: AiWorkspaceTarget) => {
    const aiChangesApi = useAiChangesApi()
    const aiJobsApi = useAiJobsApi()
    const queryClient = useQueryClient()
    const repository = isRepositoryTarget(target) ? target : undefined

    // A repository lists its requests, a domain its jobs: either way, conversations with the agent.
    // Jobs started from the assistant land here too: keep the queue moving while any agent works.
    const requestsQuery = useQuery({
        queryKey: ["ai-changes", target.id],
        queryFn: () => aiChangesApi.getByTarget(repository!),
        enabled: Boolean(repository),
        refetchInterval: query => (query.state.data?.some(request => isActive(request.status)) ? POLL_INTERVAL_MS * 2 : false)
    })
    const jobsQuery = useQuery({
        queryKey: ["ai-jobs", "domain", target.id],
        queryFn: () => aiJobsApi.list({ domainId: target.id }),
        enabled: !repository,
        refetchInterval: query => (query.state.data?.some(isJobBusy) ? POLL_INTERVAL_MS * 2 : false)
    })
    const queueQuery = repository ? requestsQuery : jobsQuery

    // Built once per answer of the queue, not again on every keystroke in the composer of the same page.
    const isRepository = Boolean(repository)
    const requests = requestsQuery.data
    const jobs = jobsQuery.data
    const entries = useMemo(() => (isRepository ? requestEntries(requests ?? []) : jobEntries(jobs ?? [])), [isRepository, requests, jobs])

    const invalidateQueue = () => queryClient.invalidateQueries({ queryKey: repository ? ["ai-changes", target.id] : ["ai-jobs", "domain", target.id] })

    return { queueQuery, entries, invalidateQueue }
}
