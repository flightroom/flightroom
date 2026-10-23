import { Card, Spinner } from "@flightroom/design-system"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, GitBranch, LayoutDashboard, MessageSquare, Server, Square } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import useOpenAgentJob from "@/components/ai-agents/useOpenAgentJob"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import AnswerUsage from "@/components/assistant/AnswerUsage"
import { ReadOnlyNote } from "@/components/assistant/AssistantJobThread"
import { Badge, Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import { DeleteConfirmationDialog } from "@/components/ui/DeleteConfirmationDialog"
import useAiMissionsApi, { AiMissionRepositoryView, AiMissionView, isAiMissionBusy, MISSIONS_POLL_INTERVAL_MS } from "@/hooks/apiClients/useAiMissionsApi"
import { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { MissionAuthor, MissionCounts, MissionModeBadge, MissionProgress, MissionStatusBadge, missionErrorMessage, RepositoryStateBadge, repositoryState } from "./partials/missionShared"

const RepositoryRow: React.FC<{ repository: AiMissionRepositoryView; missionRunning: boolean }> = ({ repository, missionRunning }) => {
    const { t } = useTranslation()
    const openAgentJob = useOpenAgentJob()
    const state = repositoryState(repository, missionRunning)
    const Icon = repository.kind === "service" ? Server : LayoutDashboard

    return (
        <li className="flex flex-col gap-1 border-b border-divider px-3 py-2.5 last:border-b-0" data-testid={`fleet-repository-${repository.id}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex min-w-0 flex-[1_1_200px] items-center gap-2">
                    <Icon className="size-4 shrink-0 text-foreground-secondary" aria-hidden="true" />
                    <span className="sr-only">{t(repository.kind === "service" ? "domains.galaxy.kind_service" : "domains.galaxy.kind_frontend")}</span>
                    <span className="min-w-0 truncate font-medium text-foreground" title={repository.name}>
                        {repository.name}
                    </span>
                </span>
                <RepositoryStateBadge state={state} />
                {repository.filesChanged !== undefined && repository.filesChanged > 0 && (
                    <span className="text-xs text-foreground-secondary">{t("assistant.jobs.files", { count: repository.filesChanged })}</span>
                )}
                {repository.pullRequestUrl && (
                    <a
                        href={repository.pullRequestUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary-strong underline-offset-4 hover:underline"
                    >
                        {t("frontend.aiChange.pull_request")}
                        <ExternalLink className="size-3" aria-hidden="true" />
                        <span className="sr-only">{t("frontend.aiChange.opens_new_tab")}</span>
                    </a>
                )}
                {/* Only once the job exists: a repository being started has an id reserved, not a job to open yet. */}
                {repository.jobId && repository.jobStatus && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        aria-label={t("fleet.detail.open_job_label", { name: repository.name })}
                        onClick={() => openAgentJob(repository.jobId!)}
                        dataTestId={`fleet-open-job-${repository.id}`}
                    >
                        <MessageSquare aria-hidden="true" />
                        {t("fleet.detail.open_job")}
                    </Button>
                )}
            </div>
            {repository.error && <p className="whitespace-pre-wrap break-words text-xs text-destructive">{repository.error}</p>}
        </li>
    )
}

const MissionActions: React.FC<{ mission: AiMissionView }> = ({ mission }) => {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const notifications = useToastNotificationStore()
    const aiMissionsApi = useAiMissionsApi()
    const [confirming, setConfirming] = useState<"stop" | "apply" | null>(null)
    // Proposals without files count as no changes: there is nothing of theirs to apply. Those being pushed are not counted again.
    const proposals = mission.counts.proposed
    const applying = mission.counts.applying

    const onUpdated = (updated: AiMissionView) => {
        queryClient.setQueryData(["ai-mission", mission._id], updated)
        queryClient.invalidateQueries({ queryKey: ["ai-missions"] })
    }
    const stopMutation = useMutation({
        mutationFn: () => aiMissionsApi.stop(mission._id, { customErrorMessage: error => missionErrorMessage(t, error, "stop") }),
        onSuccess: updated => {
            onUpdated(updated)
            notifications.showInfoNotification({ message: t("fleet.stopped_success") })
        }
    })
    const applyMutation = useMutation({
        mutationFn: () => aiMissionsApi.apply(mission._id, { customErrorMessage: error => missionErrorMessage(t, error, "apply") }),
        onSuccess: updated => {
            onUpdated(updated)
            notifications.showSuccessNotification({ message: t("assistant.jobs.apply_all_started") })
        }
    })
    // The API client already shows the error: the dialog closes either way.
    const settle = (promise: Promise<unknown>) =>
        promise.then(
            () => undefined,
            () => undefined
        )

    return (
        <>
            {mission.status === "RUNNING" && (
                <Button variant="secondary" disabled={stopMutation.isPending} onClick={() => setConfirming("stop")} dataTestId="fleet-mission-stop">
                    {stopMutation.isPending ? <Spinner size={16} centerScreen={false} /> : <Square aria-hidden="true" />}
                    {t("fleet.stop")}
                </Button>
            )}
            {(proposals > 0 || applying > 0) && (
                <Button
                    variant="primary"
                    disabled={applyMutation.isPending || applying > 0}
                    aria-busy={applying > 0 || undefined}
                    onClick={() => setConfirming("apply")}
                    dataTestId="fleet-mission-apply-all"
                >
                    {applyMutation.isPending || applying > 0 ? <Spinner size={16} centerScreen={false} /> : <GitBranch aria-hidden="true" />}
                    {applying > 0 ? t("fleet.applying_label", { count: applying }) : t("assistant.jobs.apply_all", { count: proposals })}
                </Button>
            )}
            <DeleteConfirmationDialog
                isOpen={confirming === "stop"}
                onOpenChange={open => setConfirming(open ? "stop" : null)}
                title={t("fleet.stop_title")}
                description={t("fleet.stop_description")}
                deleteLabel={t("fleet.stop")}
                deletingLabel={t("fleet.stopping")}
                onDelete={() => settle(stopMutation.mutateAsync())}
            />
            <DeleteConfirmationDialog
                isOpen={confirming === "apply"}
                onOpenChange={open => setConfirming(open ? "apply" : null)}
                title={t("assistant.jobs.apply_all_title")}
                description={t("assistant.jobs.apply_all_description", { count: proposals })}
                deleteLabel={t("assistant.jobs.apply_all_confirm")}
                deletingLabel={t("assistant.jobs.apply_all_applying")}
                onDelete={() => settle(applyMutation.mutateAsync())}
            />
        </>
    )
}

const MissionDetail: React.FC<{ mission: AiMissionView }> = ({ mission }) => {
    const { t } = useTranslation()
    const isViewer = useIsProjectViewer()
    const running = mission.status === "RUNNING"
    const batches = Array.from({ length: mission.batchCount }, (_, index) => mission.repositories.filter(repository => repository.batch === index))

    return (
        <div className="flex flex-col gap-6">
            <WorkspaceHeader
                back={{ to: "/fleet", label: t("fleet.detail.back") }}
                title={t("fleet.detail.title")}
                pageTitle={t("fleet.title")}
                meta={
                    <>
                        <MissionStatusBadge status={mission.status} />
                        <MissionModeBadge mode={mission.mode} />
                        {mission.mode === "perRepository" && <span>{t("fleet.detail.concurrency", { count: mission.concurrency })}</span>}
                        <MissionAuthor mission={mission} />
                    </>
                }
                navLabel={t("fleet.title")}
                tabs={[]}
                actions={!isViewer && (mission.canAct ? <MissionActions mission={mission} /> : <ReadOnlyNote name={mission.userName} />)}
            />

            <Card className="flex flex-col gap-3 p-4">
                <h2 className="text-sm font-semibold text-foreground">{t("fleet.detail.prompt")}</h2>
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">{mission.prompt}</p>
                <MissionProgress mission={mission} />
                <MissionCounts counts={mission.counts} />
                <AnswerUsage usage={mission.usage} label={t("fleet.usage_label")} hint={t("fleet.usage_hint")} />
            </Card>

            {batches.map((repositories, index) => {
                let batchState: "done" | "current" | "upcoming" | "not_started" = "done"
                if (index === mission.currentBatch && running) batchState = "current"
                // A mission stopped, or failed, before a batch began: that batch never will.
                else if (index > mission.currentBatch) batchState = running ? "upcoming" : "not_started"
                const headingId = `fleet-batch-${index}`
                return (
                    <section key={headingId} aria-labelledby={headingId} className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 id={headingId} className="text-base font-semibold text-foreground">
                                {t("fleet.detail.batch", { number: index + 1, total: mission.batchCount })}
                            </h2>
                            <Badge variant={batchState === "current" ? "info" : "outline"}>{t(`fleet.detail.batch_state.${batchState}`)}</Badge>
                        </div>
                        <ul className="overflow-hidden rounded-lg border-2 border-border bg-card text-sm">
                            {repositories.map(repository => (
                                <RepositoryRow key={`${repository.kind}-${repository.id}`} repository={repository} missionRunning={running} />
                            ))}
                        </ul>
                    </section>
                )
            })}
        </div>
    )
}

/** One mission: its repositories batch by batch, what each agent did, and the actions on all of them. */
const FleetMissionPage: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const aiMissionsApi = useAiMissionsApi()

    const missionQuery = useQuery({
        queryKey: ["ai-mission", id],
        queryFn: () => aiMissionsApi.get(id!, { customErrorMessage: error => missionErrorMessage(t, error, "load") }),
        enabled: Boolean(id),
        refetchInterval: query => (query.state.data && isAiMissionBusy(query.state.data) ? MISSIONS_POLL_INTERVAL_MS : false)
    })

    // Only the first load goes through the handler: it takes a background refetch for a load and would blink at every poll.
    return missionQuery.data ? <MissionDetail mission={missionQuery.data} /> : <ApiStatusHandler queries={[missionQuery]}>{null}</ApiStatusHandler>
}

export default FleetMissionPage
