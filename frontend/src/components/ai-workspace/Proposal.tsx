import { Alert, AlertDescription, AlertTitle, Spinner } from "@flightroom/design-system"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { TFunction } from "i18next"
import { CheckCircle2, ChevronDown, ChevronRight, GitMerge, GitPullRequest, Trash2 } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import type { IBadgeProps } from "@/components/atoms"
import { Badge, Button } from "@/components/atoms"
import useAiChangesApi, { AiChangeFile, AiChangeRequest } from "@/hooks/apiClients/useAiChangesApi"
import { errorCodeOf } from "@/hooks/useApiClient"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { AiChangeDiff } from "./AiChangeDiff"
import { BranchStatus, LoadErrorAlert, PullRequestLink, WarningAlert } from "./AiChangeParts"
import { conflictsOf } from "./aiWorkspaceUtils"

const ACTION_VARIANT: Record<AiChangeFile["action"], IBadgeProps["variant"]> = {
    create: "accent",
    update: "outline",
    delete: "destructive"
}

/** The errors an apply and a pull request share; anything else gets the message of the action. */
const proposalErrorMessage = (t: TFunction, error: Error, fallback: string) => {
    const code = errorCodeOf(error)
    if (code === "AI_CHANGE_CONFLICT") return t("frontend.aiChange.errors.AI_CHANGE_CONFLICT", { files: conflictsOf(error).join(", ") })
    if (code === "AI_CHANGE_NOT_PROPOSED") return t("frontend.aiChange.errors.AI_CHANGE_NOT_PROPOSED")
    if (code === "AI_JOB_NOT_OWNER") return t("assistant.jobs.errors.AI_JOB_NOT_OWNER")
    return t(fallback)
}

const toggle = (set: Set<string>, path: string) => {
    const next = new Set(set)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
}

interface ProposalProps {
    request: AiChangeRequest
    /** Someone else's proposal: its files are shown, its actions are not. */
    readOnly?: boolean
    onApplied: (request: AiChangeRequest) => void
    onConflict: () => void
    onDiscarded: (request: AiChangeRequest) => void
}

export const Proposal: React.FC<ProposalProps> = ({ request, readOnly = false, onApplied, onConflict, onDiscarded }) => {
    const { t } = useTranslation()
    const aiChangesApi = useAiChangesApi()
    const notifications = useToastNotificationStore()
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(request.files.slice(0, 1).map(file => file.path)))
    const idPrefix = useId()

    const applyMutation = useMutation({
        mutationFn: () =>
            aiChangesApi.apply(request._id, {
                customErrorMessage: error =>
                    errorCodeOf(error) === "AI_CHANGE_PUSH_REFUSED"
                        ? t("frontend.aiChange.errors.AI_CHANGE_PUSH_REFUSED", { branch: request.baseBranch })
                        : proposalErrorMessage(t, error, "frontend.aiChange.errors.apply")
            }),
        onSuccess: applied => {
            notifications.showSuccessNotification({ message: t("frontend.aiChange.applied_success", { branch: request.baseBranch }) })
            onApplied(applied)
        },
        onError: () => onConflict()
    })

    const pullRequestMutation = useMutation({
        mutationFn: () => aiChangesApi.openPullRequest(request._id, { customErrorMessage: error => proposalErrorMessage(t, error, "frontend.aiChange.errors.pull_request") }),
        onSuccess: opened => {
            // A provider refusing it answers with the error on the proposal: it shows there.
            if (opened.pullRequestUrl) notifications.showSuccessNotification({ message: t("frontend.aiChange.pull_request_opened") })
            onApplied(opened)
        },
        onError: () => onConflict()
    })

    const discardMutation = useMutation({
        mutationFn: () => aiChangesApi.discard(request._id),
        onSuccess: discarded => {
            notifications.showInfoNotification({ message: t("frontend.aiChange.discarded_success") })
            onDiscarded(discarded)
        }
    })

    const busy = applyMutation.isPending || discardMutation.isPending || pullRequestMutation.isPending

    const discardButton = (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => discardMutation.mutate()}>
            <Trash2 aria-hidden="true" />
            {t("frontend.aiChange.discard")}
        </Button>
    )

    if (request.files.length === 0) {
        return (
            <div className="flex flex-col gap-3">
                <Alert>
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                    <AlertTitle>{t("frontend.aiChange.no_changes_title")}</AlertTitle>
                    <AlertDescription>{t("frontend.aiChange.no_changes_description")}</AlertDescription>
                </Alert>
                {!readOnly && <div className="flex justify-end">{discardButton}</div>}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">{t("frontend.aiChange.files_title")}</h4>
                <span className="text-xs text-muted-foreground">{t("frontend.aiChange.files_count", { count: request.files.length })}</span>
            </div>
            <ul className="flex flex-col gap-2">
                {request.files.map(file => {
                    const diffId = `${idPrefix}-diff-${file.path}`
                    const isExpanded = expanded.has(file.path)
                    return (
                        <li key={file.path} className="overflow-hidden rounded-md border border-divider">
                            <div className="flex items-center gap-2 bg-muted/40 px-3 py-2">
                                <span className="min-w-0 flex-1 break-all font-mono text-xs">{file.path}</span>
                                <Badge variant={ACTION_VARIANT[file.action]}>{t(`frontend.aiChange.action.${file.action}`)}</Badge>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    aria-expanded={isExpanded}
                                    aria-controls={diffId}
                                    aria-label={t(isExpanded ? "frontend.aiChange.hide_diff" : "frontend.aiChange.show_diff", { path: file.path })}
                                    onClick={() => setExpanded(current => toggle(current, file.path))}
                                >
                                    {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                                </Button>
                            </div>
                            {isExpanded && (
                                <div id={diffId} className="border-t border-divider">
                                    <AiChangeDiff file={file} />
                                </div>
                            )}
                        </li>
                    )
                })}
            </ul>
            <BranchStatus request={request} />
            {request.pullRequestError && <WarningAlert title={t("frontend.aiChange.pull_request_error_title")}>{request.pullRequestError}</WarningAlert>}
            {!readOnly && <p className="text-sm text-foreground-secondary">{t("frontend.aiChange.apply_description", { branch: request.baseBranch })}</p>}
            {readOnly ? (
                request.pullRequestUrl && (
                    <div className="flex justify-end">
                        <PullRequestLink url={request.pullRequestUrl} />
                    </div>
                )
            ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {discardButton}
                    {request.pullRequestUrl ? (
                        <PullRequestLink url={request.pullRequestUrl} />
                    ) : (
                        <Button type="button" variant="secondary" disabled={busy} onClick={() => pullRequestMutation.mutate()}>
                            {pullRequestMutation.isPending ? <Spinner size={16} centerScreen={false} /> : <GitPullRequest aria-hidden="true" />}
                            {t("frontend.aiChange.open_pull_request")}
                        </Button>
                    )}
                    <Button type="button" disabled={busy} onClick={() => applyMutation.mutate()}>
                        {applyMutation.isPending ? <Spinner size={16} centerScreen={false} /> : <GitMerge aria-hidden="true" />}
                        {t("frontend.aiChange.apply", { branch: request.baseBranch })}
                    </Button>
                </div>
            )}
        </div>
    )
}

interface RepositoryProposalProps {
    requestId: string
    readOnly: boolean
    onUpdated: (request: AiChangeRequest) => void
    onConflict: () => void
}

/** The open proposal of one repository: the job only lists its files, the request carries their contents. */
export const RepositoryProposal: React.FC<RepositoryProposalProps> = ({ requestId, readOnly, onUpdated, onConflict }) => {
    const { t } = useTranslation()
    const aiChangesApi = useAiChangesApi()
    const proposalQuery = useQuery({ queryKey: ["ai-change", requestId], queryFn: () => aiChangesApi.getSingle(requestId) })

    // The cache may still hold the request as it was while the agent worked: wait for the proposal itself.
    if (proposalQuery.data?.status === "PROPOSED") {
        return (
            <Proposal
                key={proposalQuery.data.updatedAt}
                request={proposalQuery.data}
                readOnly={readOnly}
                onApplied={onUpdated}
                onDiscarded={onUpdated}
                onConflict={() => {
                    proposalQuery.refetch()
                    onConflict()
                }}
            />
        )
    }
    if (proposalQuery.isError) return <LoadErrorAlert />
    return <Spinner size={24} centerScreen={false} label={t("common.loading")} />
}
