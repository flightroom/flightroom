import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import type { AiChangeRequest } from "@/hooks/apiClients/useAiChangesApi"
import useAiJobsApi, { AiJob, isAiJobActive } from "@/hooks/apiClients/useAiJobsApi"
import { AI_USAGE_QUERY_KEY } from "@/hooks/apiClients/useAiUsageApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { AiWorkspaceTarget, isJobBusy, isTurnActive, POLL_INTERVAL_MS, Turn } from "./aiWorkspaceUtils"

interface UseConversationOptions {
    /** Any job of the conversation: its whole chain of follow-ups is fetched from it. */
    jobId: string
    /** The first job of the chain. */
    conversationId: string
    target: AiWorkspaceTarget
    /** Something the queue shows has changed: a new message, a proposal ready, applied or discarded. */
    onQueueChanged: () => void
}

/** The chain of jobs of a conversation, polled while the agent works, as the messages of the workspace and where they stand. */
export const useConversation = ({ jobId, conversationId, target, onQueueChanged }: UseConversationOptions) => {
    const { t } = useTranslation()
    const aiJobsApi = useAiJobsApi()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    // By conversation: any of its requests opens the same thread, from the same cache.
    const chainQueryKey = ["ai-change-thread", conversationId]

    const chainQuery = useQuery({
        queryKey: chainQueryKey,
        queryFn: () => aiJobsApi.chain(jobId, { silent: true }),
        refetchInterval: query => (query.state.data?.some(isJobBusy) ? POLL_INTERVAL_MS : false),
        // Not polled once settled: a follow-up sent from the assistant or another tab shows up when the user comes back.
        refetchOnWindowFocus: true
    })

    // A conversation started on a domain may go on with other repositories only: on a repository, keep the messages that worked on it.
    const turns: Turn[] = (chainQuery.data ?? []).flatMap(job => {
        if (target.kind === "domain") return [{ job, repositories: job.repositories }]
        const repositories = job.repositories.filter(candidate => candidate.frontendId === target.id)
        return repositories.length > 0 ? [{ job, repositories }] : []
    })
    const first = turns[0]
    const latest = turns[turns.length - 1]
    const busy = turns.some(isTurnActive)
    // Nothing is reviewed or refined while the agent works; a push holds back only its own repository, not the other proposals of a domain.
    const agentWorking = turns.some(turn => isAiJobActive(turn.job.status))
    // A failed follow-up leaves the proposal before it open: the latest one still proposed is refined.
    const open = agentWorking ? undefined : [...turns].reverse().find(turn => turn.job.status === "DONE" && turn.repositories.some(repository => repository.status === "PROPOSED"))
    // Where the conversation stands: what the agent does, else the open proposal, else what is pushed or was applied (a later failed follow-up does not undo it).
    const current = agentWorking ? latest : (open ?? turns.find(turn => turn.repositories.some(repository => repository.status === "APPLYING" || repository.status === "APPLIED")) ?? latest)
    // An apply of all the proposals of a job: its outcome is told once, when polling sees the last of its repositories settle.
    const pendingApply = useRef<{ jobId: string; requestIds: string[] } | undefined>(undefined)

    // The queue only shows statuses; the assistant panel follows the same jobs from a cache of its own.
    const changed = () => {
        onQueueChanged()
        queryClient.invalidateQueries({ queryKey: ["ai-job-chain"] })
    }

    // Refresh them once the agent is done.
    const wasBusy = useRef(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: only the end of the work decides, the callback is new on every render
    useEffect(() => {
        if (busy) wasBusy.current = true
        else if (wasBusy.current) {
            wasBusy.current = false
            changed()
            // What the agent spent is final now: the AI usage of the page counts it.
            queryClient.invalidateQueries({ queryKey: [AI_USAGE_QUERY_KEY] })
        }
    }, [busy])

    // biome-ignore lint/correctness/useExhaustiveDependencies: new data is what may end the apply; the toast store and t are stable enough for this.
    useEffect(() => {
        const pending = pendingApply.current
        if (!pending || !chainQuery.data) return
        const repositories = chainQuery.data.find(job => job._id === pending.jobId)?.repositories.filter(repository => pending.requestIds.includes(repository.requestId)) ?? []
        if (repositories.some(repository => repository.status === "APPLYING")) return
        pendingApply.current = undefined
        // A repository that could not be applied goes back to its proposal, with the error on it.
        const failed = repositories.filter(repository => repository.status !== "APPLIED").length
        if (failed === 0) notifications.showSuccessNotification({ message: t("assistant.jobs.apply_all_success") })
        else notifications.showWarningNotification({ message: t("assistant.jobs.apply_all_failed", { count: failed, total: pending.requestIds.length }) })
        // The pages of the frontends and backends show the same requests.
        queryClient.invalidateQueries({ queryKey: ["ai-change"] })
    }, [chainQuery.data])

    const onSent = (child: AiJob) => {
        // Shown at once, then followed by polling: the new message is active.
        queryClient.setQueryData<AiJob[]>(chainQueryKey, chain => (chain ? [...chain, child] : chain))
        queryClient.invalidateQueries({ queryKey: chainQueryKey })
        changed()
    }

    const onProposalUpdated = (updated: AiChangeRequest) => {
        queryClient.setQueryData(["ai-change", updated._id], updated)
        chainQuery.refetch()
        changed()
    }

    const onConflict = () => {
        chainQuery.refetch()
        changed()
    }

    // Shown stopped at once; a follow-up stopped leaves the proposal it refined open again.
    const onStopped = (stopped?: AiJob) => {
        if (stopped) queryClient.setQueryData<AiJob[]>(chainQueryKey, chain => chain?.map(job => (job._id === stopped._id ? stopped : job)))
        chainQuery.refetch()
        changed()
    }

    // Pushed in the background: polling follows each repository onto its base branch, or back to its proposal with the error.
    const onApplying = async (applied: AiJob, requestIds: string[]) => {
        notifications.showInfoNotification({ message: t("assistant.jobs.apply_all_started") })
        // A poll that left before the apply would bring back the proposals as they were, and end the wait too early.
        await queryClient.cancelQueries({ queryKey: chainQueryKey })
        pendingApply.current = { jobId: applied._id, requestIds }
        queryClient.setQueryData<AiJob[]>(chainQueryKey, chain => chain?.map(job => (job._id === applied._id ? { ...applied, events: applied.events ?? job.events } : job)))
        changed()
    }

    return { chainQuery, turns, first, latest, busy, agentWorking, open, current, changed, onSent, onProposalUpdated, onConflict, onStopped, onApplying }
}
