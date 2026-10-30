import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Spinner, Textarea } from "@flightroom/design-system"
import { Sparkles } from "lucide-react"
import { useEffect, useId } from "react"
import { useTranslation } from "react-i18next"
import AiModelSelect from "@/components/assistant/AiModelSelect"
import EffortSelect from "@/components/assistant/EffortSelect"
import { useEffort } from "@/components/assistant/useEffort"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Button } from "@/components/atoms"
import Mascot from "@/components/mascot/Mascot"
import type { PromptImage } from "@/hooks/apiClients/useAiChangesApi"
import type { AiJob } from "@/hooks/apiClients/useAiJobsApi"
import { cn } from "@/utils/styleUtils"
import { AiWorkspaceTarget, PROMPT_MAX_LENGTH } from "./aiWorkspaceUtils"
import { AttachImageButton, PromptImageList, PromptImagesState } from "./PromptImages"
import { AiWorkspaceRepository, BaseBranches, RepositoryBranches } from "./RepositoryBranches"

/** What a page adds to the composer of its workspace: a domain lists the repositories the agent will see, and may need them created first. */
export interface AiWorkspaceComposerExtension {
    /** Above the prompt. */
    context?: React.ReactNode
    /** Generate is refused while set: the request cannot run as it stands. */
    blocked?: boolean
    /** The page works on the request before it is sent. */
    pending?: boolean
    /** In place of the keyboard shortcut while `pending`. */
    pendingLabel?: string
    /**
     * Called with the prompt and its images before the request is created; returning true takes the request over. The
     * page calls `started` with the job it starts in the end, and the workspace opens it.
     */
    intercept?: (prompt: string, images: PromptImage[], started: (job: AiJob) => void) => boolean
}

interface ComposerProps {
    name: string
    /** Picks the wording where it differs (`_backend` and `_domain` keys). */
    kind: AiWorkspaceTarget["kind"]
    prompt: string
    repositories: AiWorkspaceRepository[]
    baseBranches: BaseBranches
    onPromptChange: (value: string) => void
    onBaseBranchesChange: (value: BaseBranches) => void
    onSubmit: () => void
    pending: boolean
    error?: string
    promptRef: React.RefObject<HTMLTextAreaElement | null>
    images: PromptImagesState
    /** Set when "New change" or "Try again" asked for the composer before it was on screen. */
    focusOnMount: React.RefObject<boolean>
    extension?: AiWorkspaceComposerExtension
}

export const Composer: React.FC<ComposerProps> = ({
    name,
    kind,
    prompt,
    repositories,
    baseBranches,
    onPromptChange,
    onBaseBranchesChange,
    onSubmit,
    pending,
    error,
    promptRef,
    images,
    focusOnMount,
    extension
}) => {
    const { t } = useTranslation()
    const [effort, setEffort] = useEffort("code")
    const { selected: aiModel, setSelected: setAiModel } = useProjectAiModels()
    const promptId = useId()
    const context = kind === "frontend" ? undefined : kind
    const busy = pending || Boolean(extension?.pending)

    // biome-ignore lint/correctness/useExhaustiveDependencies: only the mount decides
    useEffect(() => {
        if (!focusOnMount.current) return
        focusOnMount.current = false
        promptRef.current?.focus()
    }, [])

    return (
        <form
            noValidate
            onSubmit={event => {
                event.preventDefault()
                onSubmit()
            }}
        >
            <Card className="border-primary/40 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
                <CardHeader>
                    {/* Vega, ready to code: it picks up the wrench once the request is on its way */}
                    <Mascot mood={busy ? "working" : "coding"} className="mx-auto size-56 max-sm:size-36" />
                    <CardTitle className="mb-0 flex items-center gap-2 break-words text-xl">
                        <Sparkles className="size-5 shrink-0 text-primary-strong" aria-hidden="true" />
                        {t("frontend.aiChange.composer_title", { name })}
                    </CardTitle>
                    <CardDescription>{t("frontend.aiChange.description", { context })}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4 pt-3">
                    {extension?.context}
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={promptId} className="sr-only">
                            {t("frontend.aiChange.prompt_label")}
                        </Label>
                        <Textarea
                            id={promptId}
                            ref={promptRef}
                            value={prompt}
                            rows={8}
                            maxLength={PROMPT_MAX_LENGTH}
                            required
                            aria-invalid={Boolean(error)}
                            aria-describedby={`${promptId}-hint`}
                            placeholder={t("frontend.aiChange.prompt_placeholder", { context: kind === "domain" ? kind : undefined })}
                            disabled={busy}
                            className={cn(images.dragging && "ring-2 ring-primary")}
                            {...images.fieldProps}
                            onChange={event => onPromptChange(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                    event.preventDefault()
                                    onSubmit()
                                }
                            }}
                            dataTestId="ai-change-prompt"
                        />
                        <div id={`${promptId}-hint`} className="flex justify-between gap-2 text-xs">
                            <span className="text-destructive">{error}</span>
                            <span className="text-muted-foreground">{t("frontend.aiChange.prompt_counter", { count: prompt.length, max: PROMPT_MAX_LENGTH })}</span>
                        </div>
                        <PromptImageList state={images} disabled={busy} />
                    </div>
                    <RepositoryBranches repositories={repositories} value={baseBranches} onChange={onBaseBranchesChange} disabled={busy} />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground" aria-live="polite">
                            {extension?.pending && extension.pendingLabel ? extension.pendingLabel : t("frontend.aiChange.composer_shortcut")}
                        </span>
                        <div className="flex items-center gap-2">
                            <AttachImageButton state={images} disabled={busy} dataTestId="ai-change-attach" />
                            <AiModelSelect value={aiModel?.id} onChange={setAiModel} disabled={busy} dataTestId="ai-change-ai-model" />
                            <EffortSelect value={effort} onChange={setEffort} disabled={busy} dataTestId="ai-change-effort" />
                            <Button type="submit" disabled={busy || extension?.blocked} dataTestId="ai-change-generate">
                                {busy ? <Spinner size={16} centerScreen={false} /> : <Sparkles aria-hidden="true" />}
                                {t("frontend.aiChange.generate")}
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </form>
    )
}
