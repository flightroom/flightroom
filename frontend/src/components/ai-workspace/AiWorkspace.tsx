import { Spinner } from "@flightroom/design-system"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router-dom"
import { JOB_ERROR_CODES, jobErrorMessage } from "@/components/assistant/AssistantJobThread"
import { useEffort } from "@/components/assistant/useEffort"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Button } from "@/components/atoms"
import useAiChangesApi from "@/hooks/apiClients/useAiChangesApi"
import useAiJobsApi, { AiJob } from "@/hooks/apiClients/useAiJobsApi"
import { errorCodeOf } from "@/hooks/useApiClient"
import { cn } from "@/utils/styleUtils"
import { LoadErrorAlert } from "./AiChangeParts"
import { AiWorkspaceTarget, isRepositoryTarget, PROMPT_MAX_LENGTH } from "./aiWorkspaceUtils"
import { AiWorkspaceComposerExtension, Composer } from "./Composer"
import { ConversationThread } from "./ConversationThread"
import { usePromptImages } from "./PromptImages"
import { QueueSection } from "./QueueSection"
import { defaultSelection, groupOf, NEW_CHANGE, QUEUE_GROUPS } from "./queueEntries"
import { AiWorkspaceRepository, BaseBranches, pickedBaseBranches } from "./RepositoryBranches"
import { RequestSelection } from "./RequestSelection"
import { useWorkspaceQueue } from "./useWorkspaceQueue"
import { useWorkspaceView, ViewSwitch } from "./WorkspaceView"

export type { AiWorkspaceTarget } from "./aiWorkspaceUtils"
export type { AiWorkspaceComposerExtension } from "./Composer"

// three.js comes with it: only the users who open the workshop load it
const VegaWorkshop = lazy(() => import("./workshop/VegaWorkshop"))

/** Error codes of the create endpoint that have a message of their own. */
const CREATE_ERROR_CODES = new Set(["ASSISTANT_DISABLED", "AI_CHANGE_FORBIDDEN", "WORKSPACE_NO_REPOSITORY", "AI_MODEL_NOT_AVAILABLE"])

interface AiWorkspaceProps {
    target: AiWorkspaceTarget
    name: string
    /** The repositories the agent works on, shown in the composer with the branch each starts from. */
    repositories: AiWorkspaceRepository[]
    composer?: AiWorkspaceComposerExtension
}

/**
 * "Edit with AI", the same workspace on a frontend, a backend and a domain: the queue of the conversations with
 * the agent on one side (waiting for review, in progress, discarded, done) and the selected one, or a new request, on
 * the other. A frontend or a backend works on its own repository, a domain on all of its repositories at once.
 * The selection lives in `?change=`, so the assistant can link a job straight to its diff.
 */
export const AiWorkspace: React.FC<AiWorkspaceProps> = ({ target, name, repositories, composer }) => {
    const { t } = useTranslation()
    const aiChangesApi = useAiChangesApi()
    const aiJobsApi = useAiJobsApi()
    const queryClient = useQueryClient()
    const [prompt, setPrompt] = useState("")
    const [baseBranches, setBaseBranches] = useState<BaseBranches>({})
    const images = usePromptImages()
    // Picked in the composer, sent from here.
    const [effort] = useEffort("code")
    const aiModelId = useProjectAiModels().selected?.id
    const [submitted, setSubmitted] = useState(false)
    const [searchParams, setSearchParams] = useSearchParams()
    const promptRef = useRef<HTMLTextAreaElement>(null)
    const focusComposer = useRef(false)
    const linkedId = searchParams.get("change") ?? undefined
    const repository = isRepositoryTarget(target) ? target : undefined
    const [view, changeView] = useWorkspaceView()
    const { queueQuery, entries, invalidateQueue } = useWorkspaceQueue(target)

    const select = (id: string) =>
        setSearchParams(
            current => {
                const next = new URLSearchParams(current)
                next.delete("tab")
                next.set("change", id)
                return next
            },
            { replace: true }
        )

    // Nothing linked: open what needs attention first. Pinned in the URL, so the selection does not jump when the queue moves.
    // biome-ignore lint/correctness/useExhaustiveDependencies: only the arrival of the queue decides the default
    useEffect(() => {
        if (!linkedId && queueQuery.data) select(defaultSelection(entries))
    }, [linkedId, queueQuery.data])

    const selectedId = linkedId && linkedId !== NEW_CHANGE ? linkedId : undefined

    const reset = () => {
        setPrompt("")
        setBaseBranches({})
        images.clear()
        setSubmitted(false)
        invalidateQueue()
    }

    const createMutation = useMutation({
        mutationFn: async (): Promise<string> => {
            const attached = images.images.length ? images.images : undefined
            if (!repository) {
                const job = await aiJobsApi.create(
                    { prompt: prompt.trim(), scope: "domain", domainId: target.id, baseBranches: pickedBaseBranches(repositories, baseBranches), effort, aiModelId, images: attached },
                    { customErrorMessage: error => jobErrorMessage(t, error, "create") }
                )
                return job.rootJobId
            }
            const created = await aiChangesApi.create(
                repository,
                { prompt: prompt.trim(), baseBranch: baseBranches[repository.id]?.trim() || undefined, effort, aiModelId, images: attached },
                {
                    customErrorMessage: error => {
                        const code = errorCodeOf(error)
                        if (code && CREATE_ERROR_CODES.has(code)) return t(`frontend.aiChange.errors.${code}`, { context: repository.kind === "backend" ? "backend" : undefined })
                        // The monthly AI token limit, among others: said as the jobs say it
                        if (code && JOB_ERROR_CODES.has(code)) return jobErrorMessage(t, error, "create")
                        return t("frontend.aiChange.errors.create")
                    }
                }
            )
            queryClient.setQueryData(["ai-change", created._id], created)
            return created._id
        },
        onSuccess: reset
    })

    /** A job the page started itself (a domain that needed its repositories created first): open it like one created here. */
    const started = (job: AiJob) => {
        reset()
        select(repository ? (job.repositories.find(candidate => candidate.frontendId === repository.id)?.requestId ?? NEW_CHANGE) : job.rootJobId)
    }

    const promptError = submitted && prompt.trim().length === 0 ? t("frontend.aiChange.prompt_required") : undefined

    const generate = () => {
        setSubmitted(true)
        if (prompt.trim().length === 0 || prompt.length > PROMPT_MAX_LENGTH) {
            promptRef.current?.focus()
            return
        }
        if (composer?.blocked || composer?.intercept?.(prompt.trim(), images.images, started)) return
        // Navigation goes in the call options: they are skipped once the page is left, the hook-level callback is not.
        createMutation.mutate(undefined, { onSuccess: select })
    }

    const startNew = () => {
        select(NEW_CHANGE)
        if (promptRef.current) promptRef.current.focus()
        else focusComposer.current = true
    }

    const retry = (retriedPrompt: string, retriedBaseBranches?: BaseBranches) => {
        setPrompt(retriedPrompt)
        setBaseBranches(retriedBaseBranches ?? {})
        startNew()
    }

    const workshop = view === "workshop"

    const newChangeButton = (
        <Button type="button" variant={linkedId === NEW_CHANGE ? "secondary" : "primary"} onClick={startNew} dataTestId="ai-change-new">
            <Plus aria-hidden="true" />
            {t("frontend.aiChange.new_change")}
        </Button>
    )
    const viewSwitch = <ViewSwitch view={view} onChange={changeView} />
    const queueStatus = (
        <>
            {queueQuery.isPending && <Spinner size={24} centerScreen={false} label={t("common.loading")} />}
            {queueQuery.isError && <p className="text-sm text-destructive">{t("frontend.aiChange.errors.history")}</p>}
        </>
    )
    const queueSections =
        queueQuery.data &&
        QUEUE_GROUPS.map(group => <QueueSection key={group} group={group} entries={entries.filter(entry => groupOf(entry.status) === group)} selectedId={linkedId ?? ""} onSelect={select} />)

    return (
        // The classic view keeps the queue in a column on the left; the workshop takes the whole width, under a bar with the same controls
        <div className={cn("grid items-start gap-6", !workshop && "lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]")}>
            {workshop ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    {newChangeButton}
                    {viewSwitch}
                    {queueStatus}
                </div>
            ) : (
                <aside aria-label={t("frontend.aiChange.queue_label")} className="flex flex-col gap-5 lg:sticky lg:top-4">
                    {newChangeButton}
                    {viewSwitch}
                    {queueStatus}
                    {queueSections}
                </aside>
            )}

            <div className="flex min-w-0 flex-col gap-6">
                {workshop && queueQuery.data && (
                    <Suspense
                        fallback={
                            <div className="flex h-[clamp(380px,65vh,820px)] items-center justify-center rounded-xl border border-divider">
                                <Spinner size={24} centerScreen={false} label={t("common.loading")} />
                            </div>
                        }
                    >
                        <VegaWorkshop entries={entries} selectedId={linkedId} onSelect={select} />
                    </Suspense>
                )}
                {(linkedId === NEW_CHANGE || (!linkedId && queueQuery.data?.length === 0)) && (
                    <Composer
                        name={name}
                        kind={target.kind}
                        prompt={prompt}
                        repositories={repositories}
                        baseBranches={baseBranches}
                        onPromptChange={setPrompt}
                        onBaseBranchesChange={setBaseBranches}
                        onSubmit={generate}
                        pending={createMutation.isPending}
                        error={promptError}
                        promptRef={promptRef}
                        images={images}
                        focusOnMount={focusComposer}
                        extension={composer}
                    />
                )}
                {selectedId &&
                    (repository ? (
                        <RequestSelection requestId={selectedId} target={repository} onRetry={retry} onQueueChanged={invalidateQueue} />
                    ) : (
                        <ConversationThread
                            key={selectedId}
                            jobId={selectedId}
                            conversationId={selectedId}
                            target={target}
                            onRetry={retry}
                            onQueueChanged={invalidateQueue}
                            fallback={<LoadErrorAlert />}
                        />
                    ))}
                {/* Applied and discarded works leave the scene: the queue under it still reaches them */}
                {workshop && queueSections && (
                    <section aria-label={t("frontend.aiChange.queue_label")} className="grid items-start gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                        {queueSections}
                    </section>
                )}
            </div>
        </div>
    )
}

export default AiWorkspace
