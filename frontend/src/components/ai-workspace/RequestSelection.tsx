import { Card, CardContent } from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { format } from "date-fns"
import { RotateCcw } from "lucide-react"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import AnswerUsage from "@/components/assistant/AnswerUsage"
import AssistantMessageText from "@/components/assistant/AssistantMessageText"
import { Button } from "@/components/atoms"
import useAiChangesApi, { AiChangeRequest, AiChangeTarget } from "@/hooks/apiClients/useAiChangesApi"
import useThemeStore from "@/store/useThemeStore"
import { ActiveStatus, AppliedAlert, ConversationCardHeader, FailedAlert, JobBadge, LoadErrorAlert, LoadingBlock, ProgressSection, WarningAlert } from "./AiChangeParts"
import { LivePreviews } from "./AiChangeProgress"
import { isActive, POLL_INTERVAL_MS } from "./aiWorkspaceUtils"
import { ConversationThread } from "./ConversationThread"
import { Proposal } from "./Proposal"
import type { BaseBranches } from "./RepositoryBranches"

/** A request made before requests became conversations: it has no job to follow up on. */
interface RequestViewProps {
    request: AiChangeRequest
    onRetry: (prompt: string, baseBranches?: BaseBranches) => void
    onUpdated: (request: AiChangeRequest) => void
    onConflict: () => void
}

const RequestView: React.FC<RequestViewProps> = ({ request, onRetry, onUpdated, onConflict }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    const active = isActive(request.status)
    const finished = !active

    return (
        <Card>
            <ConversationCardHeader
                prompt={request.prompt}
                description={t("frontend.aiChange.request_meta", {
                    date: format(new Date(request.createdAt), "PPp", { locale: themeStore.getLocale() }),
                    branch: request.baseBranch
                })}
                badge={<JobBadge request={request} />}
                status={request.status}
            />
            <CardContent className="flex flex-col gap-4 pt-3">
                <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">{t("frontend.aiChange.show_prompt")}</summary>
                    <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3">{request.prompt}</p>
                </details>

                {active && <ActiveStatus status={request.status} />}

                <LivePreviews events={request.events ?? []} />

                {request.error && request.status === "PROPOSED" && <WarningAlert title={t("frontend.aiChange.proposal_warning")}>{request.error}</WarningAlert>}

                {request.status === "FAILED" && <FailedAlert error={request.error} />}

                {request.status === "APPLIED" && <AppliedAlert baseBranch={request.baseBranch} commit={request.commit} pullRequestUrl={request.pullRequestUrl} />}

                {request.status === "DISCARDED" && <p className="text-sm text-muted-foreground">{t("frontend.aiChange.discarded_description")}</p>}

                {request.summary && finished && (
                    <div className="flex flex-col gap-1">
                        <h4 className="text-sm font-semibold">{t("frontend.aiChange.summary")}</h4>
                        <AssistantMessageText text={request.summary} className="text-sm" />
                    </div>
                )}

                {request.status === "PROPOSED" && <Proposal key={request.updatedAt} request={request} onApplied={onUpdated} onDiscarded={onUpdated} onConflict={onConflict} />}

                {(request.status === "FAILED" || request.status === "DISCARDED") && (
                    <div className="flex justify-end">
                        <Button type="button" variant="secondary" onClick={() => onRetry(request.prompt, { [request.frontendId ?? request.backendId ?? ""]: request.baseBranch })}>
                            <RotateCcw aria-hidden="true" />
                            {t("frontend.aiChange.try_again")}
                        </Button>
                    </div>
                )}

                <ProgressSection events={request.events} live={active} />

                {/* Live while the agent works: the cost of the job grows with every round. */}
                {(finished || request.usage.inputTokens > 0) && (
                    <div className="flex flex-col gap-0.5">
                        <AnswerUsage
                            usage={{ ...request.usage, cachedInputTokens: request.usage.cachedInputTokens ?? 0 }}
                            label={t("frontend.aiChange.usage_label")}
                            hint={t("frontend.aiChange.usage_hint")}
                            effort={request.effort}
                        />
                        {request.jobRepositoryCount !== undefined && request.jobRepositoryCount > 1 && (
                            <p className="text-xs text-muted-foreground">{t("frontend.aiChange.usage_shared", { count: request.jobRepositoryCount })}</p>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

interface RequestSelectionProps {
    requestId: string
    target: AiChangeTarget
    onRetry: (prompt: string, baseBranches?: BaseBranches) => void
    onQueueChanged: () => void
}

/** A request opened on a repository: the conversation of its job, or the request alone when it was made before jobs. */
export const RequestSelection: React.FC<RequestSelectionProps> = ({ requestId, target, onRetry, onQueueChanged }) => {
    const aiChangesApi = useAiChangesApi()
    const queryClient = useQueryClient()

    const requestQuery = useQuery({
        queryKey: ["ai-change", requestId],
        queryFn: () => aiChangesApi.getSingle(requestId),
        // A request of a job is followed through its conversation: only one made before jobs is polled here.
        refetchInterval: query => (!query.state.data?.jobId && isActive(query.state.data?.status) ? POLL_INTERVAL_MS : false)
    })

    // The queue only shows statuses: refresh it when the polled request settles, not on every finished request opened.
    const status = requestQuery.data?.status
    const wasActive = useRef(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: only the status decides, the callback is new on every render
    useEffect(() => {
        if (isActive(status)) wasActive.current = true
        else if (status && wasActive.current) {
            wasActive.current = false
            onQueueChanged()
        }
    }, [status])

    const onUpdated = (request: AiChangeRequest) => {
        queryClient.setQueryData(["ai-change", request._id], request)
        onQueueChanged()
    }

    const onConflict = () => {
        requestQuery.refetch()
        onQueueChanged()
    }

    if (requestQuery.isPending) return <LoadingBlock />

    if (requestQuery.isError) return <LoadErrorAlert />

    const request = requestQuery.data
    const view = <RequestView request={request} onRetry={onRetry} onUpdated={onUpdated} onConflict={onConflict} />
    if (!request.jobId) return view

    return (
        <ConversationThread
            key={request.conversationId}
            jobId={request.jobId}
            conversationId={request.conversationId}
            target={target}
            baseBranch={request.baseBranch}
            badge={<JobBadge request={request} />}
            onRetry={onRetry}
            onQueueChanged={onQueueChanged}
            fallback={view}
        />
    )
}
