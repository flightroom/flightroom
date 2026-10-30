import { Alert, AlertDescription, AlertTitle, CardDescription, CardHeader, CardTitle, Spinner } from "@flightroom/design-system"
import { AlertTriangle, CheckCircle2, ExternalLink, GitBranch } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import type { AiChangeEvent, AiChangeRequest, AiChangeStatus } from "@/hooks/apiClients/useAiChangesApi"
import { ProgressLog, StatusBadge } from "./AiChangeProgress"
import { firstLine } from "./aiWorkspaceUtils"

/** Set on the requests of a job over several repositories: the request is one part of a wider change. */
export const JobBadge: React.FC<{ request: AiChangeRequest }> = ({ request }) => {
    const { t } = useTranslation()
    if (!request.jobId || !request.jobRepositoryCount || request.jobRepositoryCount <= 1) return null
    return <Badge variant="outline">{t("frontend.aiChange.job_badge", { count: request.jobRepositoryCount })}</Badge>
}

export const WarningAlert: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <Alert variant="warning">
        <AlertTriangle className="size-4" aria-hidden="true" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="whitespace-pre-wrap break-words">{children}</AlertDescription>
    </Alert>
)

/** The agent could not get through: its error, else a generic one. */
export const FailedAlert: React.FC<{ error?: string }> = ({ error }) => {
    const { t } = useTranslation()
    return (
        <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden="true" />
            <AlertTitle>{t("frontend.aiChange.failed_title")}</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap break-words">{error || t("frontend.aiChange.errors.generic")}</AlertDescription>
        </Alert>
    )
}

export const LoadErrorAlert: React.FC = () => {
    const { t } = useTranslation()
    return (
        <Alert variant="destructive">
            <AlertDescription>{t("frontend.aiChange.errors.load")}</AlertDescription>
        </Alert>
    )
}

export const LoadingBlock: React.FC = () => {
    const { t } = useTranslation()
    return (
        <div className="flex justify-center py-6">
            <Spinner size={24} centerScreen={false} label={t("common.loading")} />
        </div>
    )
}

/** What the agent does now, while it works. */
export const ActiveStatus: React.FC<{ status: AiChangeStatus }> = ({ status }) => {
    const { t } = useTranslation()
    return (
        <output className="flex items-center gap-2 text-sm">
            <Spinner size={16} centerScreen={false} />
            <span>{t(`frontend.aiChange.status_description.${status}`)}</span>
        </output>
    )
}

/** The log of the agent: live while it works, folded away once it is done. */
export const ProgressSection: React.FC<{ events?: AiChangeEvent[]; live: boolean }> = ({ events, live }) => {
    const { t } = useTranslation()
    if (live) return <ProgressLog events={events ?? []} live />
    if (!events?.length) return null
    return (
        <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{t("frontend.aiChange.show_progress_log")}</summary>
            <div className="mt-2">
                <ProgressLog events={events} live={false} />
            </div>
        </details>
    )
}

export const PullRequestLink: React.FC<{ url: string }> = ({ url }) => {
    const { t } = useTranslation()
    return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary-strong underline-offset-4 hover:underline">
            {t("frontend.aiChange.view_pull_request")}
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("frontend.aiChange.opens_new_tab")}</span>
        </a>
    )
}

export const AppliedAlert: React.FC<{ baseBranch: string; commit?: string; pullRequestUrl?: string }> = ({ baseBranch, commit, pullRequestUrl }) => {
    const { t } = useTranslation()
    return (
        <Alert>
            <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
            <AlertTitle>{t("frontend.aiChange.applied_title")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
                <span>
                    {t("frontend.aiChange.applied_onto")} <code className="font-mono text-xs">{baseBranch}</code>
                    {commit && <code className="ml-2 font-mono text-xs text-muted-foreground">{commit.slice(0, 7)}</code>}
                </span>
                {pullRequestUrl && <PullRequestLink url={pullRequestUrl} />}
            </AlertDescription>
        </Alert>
    )
}

/** Where the proposal is in the repository already: its feature branch, or why it is not there. */
export const BranchStatus: React.FC<{ request: AiChangeRequest }> = ({ request }) => {
    const { t } = useTranslation()
    if (request.pushError) return <WarningAlert title={t("frontend.aiChange.push_error_title")}>{request.pushError}</WarningAlert>
    if (!request.branch || !request.commit) return null
    return (
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground-secondary">
            <GitBranch className="size-4 shrink-0" aria-hidden="true" />
            {t("frontend.aiChange.pushed_on")} <code className="break-all font-mono text-xs">{request.branch}</code>
        </p>
    )
}

interface ConversationCardHeaderProps {
    /** The first request: its first line is the title. */
    prompt: string
    description: string
    /** Next to the status. */
    badge?: React.ReactNode
    status: AiChangeStatus
}

/** The head of a request or of a conversation: what it is about, when and where it started, and where it stands. */
export const ConversationCardHeader: React.FC<ConversationCardHeaderProps> = ({ prompt, description, badge, status }) => (
    <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
                {/* A prompt is often one long line: clamp it, the whole text is one click away under "Show the full request". */}
                <CardTitle className="mb-0 line-clamp-3 break-words text-base leading-snug" title={firstLine(prompt)}>
                    {firstLine(prompt)}
                </CardTitle>
                <CardDescription>{description}</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                {badge}
                <StatusBadge status={status} />
            </div>
        </div>
    </CardHeader>
)
