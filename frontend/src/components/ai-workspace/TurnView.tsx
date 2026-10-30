import { Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { AlertTriangle, CheckCircle2, LayoutDashboard, LoaderCircle, Server } from "lucide-react"
import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import AnswerUsage from "@/components/assistant/AnswerUsage"
import AssistantMessageText from "@/components/assistant/AssistantMessageText"
import RepositoryLink from "@/components/RepositoryLink"
import type { AiJob, AiJobRepository } from "@/hooks/apiClients/useAiJobsApi"
import { ActiveStatus, AppliedAlert, FailedAlert, ProgressSection, WarningAlert } from "./AiChangeParts"
import { StatusBadge } from "./AiChangeProgress"
import { firstTab, isActive, isTurnActive, repositoryPath, Turn } from "./aiWorkspaceUtils"

interface RepositoryResultProps {
    job: AiJob
    repository: AiJobRepository
    /** Over several repositories, each result says whose it is. */
    labelled: boolean
    /** Refined by a later message: its files went on into the next proposal. */
    superseded: boolean
    /** The diff and its actions, while its proposal is open for review. */
    proposal?: React.ReactNode
}

/** What the agent did with a message on one repository. */
const RepositoryResult: React.FC<RepositoryResultProps> = ({ job, repository, labelled, superseded, proposal }) => {
    const { t } = useTranslation()

    const result = (
        <>
            {isActive(repository.status) && <ActiveStatus status={repository.status} />}

            {repository.status === "FAILED" && <FailedAlert error={repository.error || job.error} />}

            {repository.status === "PROPOSED" && repository.error && <WarningAlert title={t("frontend.aiChange.proposal_warning")}>{repository.error}</WarningAlert>}

            {proposal}

            {repository.status === "APPLIED" && <AppliedAlert baseBranch={repository.baseBranch} commit={repository.commit} pullRequestUrl={repository.pullRequestUrl} />}

            {repository.status === "DISCARDED" && (
                <p className="text-sm text-muted-foreground">
                    {t(superseded ? "frontend.aiChange.superseded" : job.stoppedAt ? "frontend.aiChange.stopped_description" : "frontend.aiChange.discarded_description")}
                </p>
            )}
        </>
    )

    if (!labelled) return result

    const Icon = repository.kind === "backend" ? Server : LayoutDashboard
    return (
        <section aria-label={repository.frontendName} className="flex flex-col gap-3 rounded-md border border-divider p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <Icon className="size-4 shrink-0 text-foreground-secondary" aria-hidden="true" />
                <Link to={repositoryPath(repository)} className="min-w-0 flex-1 truncate font-medium underline-offset-4 hover:underline">
                    {repository.frontendName}
                    <span className="sr-only"> ({t(`frontend.aiChange.kind.${repository.kind}`)})</span>
                </Link>
                <StatusBadge status={repository.status} />
            </div>
            {/* Where the agent works: the repository on its provider, the branch it started from and the one it pushes on. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-secondary">
                {repository.repository && <RepositoryLink repository={{ enabled: true, ...repository.repository }} />}
                <span className="flex min-w-0 items-center gap-1">
                    <code className="font-mono">{repository.baseBranch}</code>
                    {repository.branch && (
                        <>
                            <span aria-hidden="true">→</span>
                            <span className="sr-only">{t("frontend.aiChange.feature_branch")}</span>
                            <code className="break-all font-mono">{repository.branch}</code>
                        </>
                    )}
                </span>
            </div>
            {result}
        </section>
    )
}

/** The tab of one repository, over several: whose it is, how many files it changes, and whether it still moves, failed or went out. */
const RepositoryTab: React.FC<{ repository: AiJobRepository }> = ({ repository }) => {
    const { t } = useTranslation()
    const Icon = repository.kind === "backend" ? Server : LayoutDashboard
    const count = repository.files.length
    return (
        <TabsTrigger value={repository.requestId} className="min-w-0 max-w-[16rem]" title={repository.frontendName} dataTestId="ai-change-repository-tab">
            <Icon className="shrink-0" aria-hidden="true" />
            <span className="truncate">{repository.frontendName}</span>
            {count > 0 && (
                <span aria-hidden="true" className="shrink-0 rounded-full bg-muted px-1.5 tabular-nums text-foreground">
                    {count}
                </span>
            )}
            {isActive(repository.status) && <LoaderCircle className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {repository.status === "FAILED" && <AlertTriangle className="shrink-0 text-destructive" aria-hidden="true" />}
            {repository.status === "APPLIED" && <CheckCircle2 className="shrink-0 text-success" aria-hidden="true" />}
            <span className="sr-only">
                {count > 0 && `, ${t("frontend.aiChange.files_count", { count })}`}, {t(`frontend.aiChange.status.${repository.status}`)}
            </span>
        </TabsTrigger>
    )
}

interface TurnViewProps {
    turn: Turn
    /** Over several repositories, each result says whose it is. */
    labelled: boolean
    /** The repositories whose result a later message refined. */
    superseded: Set<string>
    /** The diff and its actions of a repository, on the message whose proposals are open for review. */
    proposalOf?: (repository: AiJobRepository) => React.ReactNode
    /** After the results: actions on all of them at once. */
    actions?: React.ReactNode
}

export const TurnView: React.FC<TurnViewProps> = ({ turn, labelled, superseded, proposalOf, actions }) => {
    const { t } = useTranslation()
    const { job, repositories } = turn
    const active = isTurnActive(turn)
    // Over several repositories, one tab each: the files of one repository are never mixed with those of another.
    const tabbed = labelled && repositories.length > 1
    // Follows the repository to review until the user picks one: the proposals land after the tabs are on screen.
    const [selectedTab, setSelectedTab] = useState<string>()

    const resultOf = (repository: AiJobRepository) => (
        <RepositoryResult
            job={job}
            repository={repository}
            labelled={labelled}
            superseded={superseded.has(repository.requestId)}
            proposal={repository.status === "PROPOSED" ? proposalOf?.(repository) : undefined}
        />
    )

    return (
        <div className="flex flex-col gap-3">
            <p className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-lg bg-primary/10 px-3 py-2 text-sm">{job.prompt}</p>

            {/* A job that failed before any repository could tell its own outcome. */}
            {job.status === "FAILED" && !job.stoppedAt && !repositories.some(repository => repository.status === "FAILED") && <FailedAlert error={job.error} />}

            {job.summary && !active && <AssistantMessageText text={job.summary} className="text-sm" />}

            {tabbed ? (
                <Tabs value={selectedTab ?? firstTab(repositories)} onValueChange={setSelectedTab} layoutSize="sm">
                    <TabsList aria-label={t("frontend.aiChange.repositories_tabs_label")} className="max-w-full">
                        {repositories.map(repository => (
                            <RepositoryTab key={repository.requestId} repository={repository} />
                        ))}
                    </TabsList>
                    {repositories.map(repository => (
                        // Kept mounted: switching tab keeps the diffs the user unfolded.
                        <TabsContent key={repository.requestId} value={repository.requestId} forceMount className="mt-3">
                            {resultOf(repository)}
                        </TabsContent>
                    ))}
                </Tabs>
            ) : (
                repositories.map(repository => <Fragment key={repository.requestId}>{resultOf(repository)}</Fragment>)
            )}

            {actions}

            <ProgressSection events={job.events} live={active} />

            {/* Live while the agent works: the cost of the job grows with every round. */}
            {(!active || job.usage.inputTokens > 0) && (
                <div className="flex flex-col gap-0.5">
                    <AnswerUsage usage={job.usage} label={t("frontend.aiChange.usage_label")} hint={t("frontend.aiChange.usage_hint")} effort={job.effort} />
                    {/* Part of a wider job: the repositories not shown here share its cost. */}
                    {repositories.length < job.repositories.length && <p className="text-xs text-muted-foreground">{t("frontend.aiChange.usage_shared", { count: job.repositories.length })}</p>}
                </div>
            )}
        </div>
    )
}
