import { Card, CardContent } from "@flightroom/design-system"
import { useMutation } from "@tanstack/react-query"
import { format } from "date-fns"
import { RotateCcw, Trash2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router-dom"
import AnswerUsage from "@/components/assistant/AnswerUsage"
import { ApplyAllButton, jobErrorMessage, ReadOnlyNote, sumUsage } from "@/components/assistant/AssistantJobThread"
import { Button } from "@/components/atoms"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import useAiJobsApi, { isAiJobActive } from "@/hooks/apiClients/useAiJobsApi"
import useThemeStore from "@/store/useThemeStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { ConversationCardHeader, LoadingBlock } from "./AiChangeParts"
import { LivePreviews } from "./AiChangeProgress"
import { AiWorkspaceTarget, PROMPT_MAX_LENGTH, turnStatus } from "./aiWorkspaceUtils"
import { FollowUpForm } from "./FollowUpForm"
import { RepositoryProposal } from "./Proposal"
import type { BaseBranches } from "./RepositoryBranches"
import { TurnView } from "./TurnView"
import { useConversation } from "./useConversation"

interface ConversationThreadProps {
    /** Any job of the conversation: its whole chain of follow-ups is fetched from it. */
    jobId: string
    /** The first job of the chain. */
    conversationId: string
    target: AiWorkspaceTarget
    /** Where the agent started from, on a repository. */
    baseBranch?: string
    /** Next to the status: a request of a job over several repositories says so. */
    badge?: React.ReactNode
    onRetry: (prompt: string, baseBranches?: BaseBranches) => void
    /** Something the queue shows has changed: a new message, a proposal ready, applied or discarded. */
    onQueueChanged: () => void
    /** Shown when the conversation cannot be loaded (its jobs expired). */
    fallback: React.ReactNode
}

/**
 * A conversation with the agent: every message with what it did on the repositories of the workspace (the one of a
 * frontend or backend, all those of a domain), the latest proposals to review, and the input to refine them
 * further before applying them.
 */
export const ConversationThread: React.FC<ConversationThreadProps> = ({ jobId, conversationId, target, baseBranch, badge, onRetry, onQueueChanged, fallback }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    const aiJobsApi = useAiJobsApi()
    const notifications = useToastNotificationStore()
    const { chainQuery, turns, first, latest, busy, agentWorking, open, current, changed, onSent, onProposalUpdated, onConflict, onStopped, onApplying } = useConversation({
        jobId,
        conversationId,
        target,
        onQueueChanged
    })
    const labelled = target.kind === "domain"

    const [, setSearchParams] = useSearchParams()
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    // Logical only: the conversation leaves the queue, which then opens what needs attention first.
    const deleteMutation = useMutation({
        mutationFn: () => aiJobsApi.remove(conversationId, { customErrorMessage: error => jobErrorMessage(t, error, "delete") }),
        onSuccess: () => {
            notifications.showInfoNotification({ message: t("frontend.aiChange.deleted_success") })
            setSearchParams(
                current => {
                    const next = new URLSearchParams(current)
                    next.delete("change")
                    return next
                },
                { replace: true }
            )
            changed()
        }
    })

    if (chainQuery.isPending) return <LoadingBlock />

    if (!first || !latest || !current) return fallback

    const status = turnStatus(current)
    const followUpState = open ? "placeholder" : busy ? "running" : status === "FAILED" ? "failed" : "closed"
    const closed = !busy && !open && (status === "FAILED" || status === "DISCARDED")
    const date = format(new Date(first.job.createdAt), "PPp", { locale: themeStore.getLocale() })
    const repositoryCount = new Set(turns.flatMap(turn => turn.repositories.map(repository => repository.frontendId))).size
    // Several proposals open at once: they can go out together, one pull request per repository.
    const applicable = open?.repositories.filter(repository => repository.status === "PROPOSED" && repository.files.length > 0) ?? []
    // The job the agent works on, if any: the send button gives way to the one that stops it.
    const running = turns.find(turn => isAiJobActive(turn.job.status))?.job

    return (
        <Card>
            <ConversationCardHeader
                prompt={first.job.prompt}
                description={
                    baseBranch !== undefined ? t("frontend.aiChange.request_meta", { date, branch: baseBranch }) : t("frontend.aiChange.request_meta_repositories", { date, count: repositoryCount })
                }
                badge={badge}
                status={status}
            />
            <CardContent className="flex flex-col gap-6 pt-3">
                {/* One preview for the whole conversation: the one of the message being worked on or reviewed. */}
                <LivePreviews events={current.job.events ?? []} />

                <ol aria-label={t("frontend.aiChange.conversation_label")} className="flex flex-col gap-8">
                    {turns.map((turn, index) => {
                        const later = turns.slice(index + 1).filter(candidate => candidate.job.status === "DONE")
                        const superseded = new Set(
                            turn.repositories
                                .filter(
                                    repository =>
                                        repository.status === "DISCARDED" &&
                                        later.some(candidate => candidate.repositories.some(next => next.frontendId === repository.frontendId && next.status !== "FAILED"))
                                )
                                .map(repository => repository.requestId)
                        )
                        return (
                            <li key={turn.job._id}>
                                <TurnView
                                    turn={turn}
                                    labelled={labelled}
                                    superseded={superseded}
                                    // Every proposal still open, not only those of the latest message: a follow-up on a domain may go on with some repositories only.
                                    proposalOf={
                                        !agentWorking && turn.job.status === "DONE"
                                            ? repository => <RepositoryProposal requestId={repository.requestId} readOnly={!turn.job.canAct} onUpdated={onProposalUpdated} onConflict={onConflict} />
                                            : undefined
                                    }
                                    actions={
                                        turn === open &&
                                        turn.job.canAct &&
                                        applicable.length > 1 && (
                                            <div className="flex justify-end">
                                                <ApplyAllButton job={turn.job} requestIds={applicable.map(repository => repository.requestId)} onApplying={onApplying} />
                                            </div>
                                        )
                                    }
                                />
                            </li>
                        )
                    })}
                </ol>

                {turns.length > 1 && (
                    <AnswerUsage usage={sumUsage(turns.map(turn => turn.job))} label={t("frontend.aiChange.usage_conversation", { count: turns.length })} hint={t("frontend.aiChange.usage_hint")} />
                )}

                {/* Nothing left to refine: start over with everything asked so far, or delete it. */}
                {closed && (
                    <div className="flex justify-end gap-2">
                        {latest.job.canAct && (
                            <>
                                <Button type="button" variant="secondary" disabled={deleteMutation.isPending} onClick={() => setConfirmingDelete(true)}>
                                    <Trash2 aria-hidden="true" />
                                    {t("frontend.aiChange.delete")}
                                </Button>
                                <DeleteConfirmationDialog
                                    isOpen={confirmingDelete}
                                    onOpenChange={setConfirmingDelete}
                                    title={t("frontend.aiChange.delete_title")}
                                    description={t("frontend.aiChange.delete_description")}
                                    deleteLabel={t("frontend.aiChange.delete")}
                                    deletingLabel={t("frontend.aiChange.deleting")}
                                    // The API client already shows the error: the dialog closes either way.
                                    onDelete={() =>
                                        deleteMutation.mutateAsync().then(
                                            () => undefined,
                                            () => undefined
                                        )
                                    }
                                />
                            </>
                        )}
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() =>
                                onRetry(
                                    turns
                                        .map(turn => turn.job.prompt)
                                        .join("\n\n")
                                        .slice(0, PROMPT_MAX_LENGTH),
                                    Object.fromEntries(first.repositories.map(repository => [repository.frontendId, repository.baseBranch]))
                                )
                            }
                        >
                            <RotateCcw aria-hidden="true" />
                            {t("frontend.aiChange.try_again")}
                        </Button>
                    </div>
                )}

                {/* Stopped while it works, refined once done: by who started it, or an organization administrator, only. */}
                {!(running ?? (open ?? latest).job).canAct ? (
                    <ReadOnlyNote name={(open ?? latest).job.userName} className="border-t border-divider pt-4" />
                ) : (
                    <FollowUpForm
                        target={target}
                        open={open}
                        latest={latest}
                        running={running}
                        onStopped={onStopped}
                        placeholder={t(`frontend.aiChange.follow_up_${followUpState}`)}
                        onSent={onSent}
                        onFailed={() => chainQuery.refetch()}
                    />
                )}
            </CardContent>
        </Card>
    )
}
