import { Label, Spinner, Textarea } from "@flightroom/design-system"
import { useMutation } from "@tanstack/react-query"
import { ArrowUp } from "lucide-react"
import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import AiModelSelect from "@/components/assistant/AiModelSelect"
import { jobErrorMessage, StopJobButton } from "@/components/assistant/AssistantJobThread"
import EffortSelect from "@/components/assistant/EffortSelect"
import { useFollowUpAiModel, useFollowUpEffort } from "@/components/assistant/useEffort"
import { Button } from "@/components/atoms"
import useAiJobsApi, { AiJob } from "@/hooks/apiClients/useAiJobsApi"
import { effortsOf } from "@/hooks/apiClients/useAiModelsApi"
import { cn } from "@/utils/styleUtils"
import { AiWorkspaceTarget, followUpScope, PROMPT_MAX_LENGTH, Turn } from "./aiWorkspaceUtils"
import { AttachImageButton, PromptImageList, usePromptImages } from "./PromptImages"

interface FollowUpFormProps {
    target: AiWorkspaceTarget
    /** The message whose proposal a follow-up refines: none while the agent works or once nothing is left to refine. */
    open?: Turn
    /** The latest message: while nothing is open, its effort is shown, the one the running follow-up was sent with. */
    latest?: Turn
    /** The job the agent works on: the send button gives way to the one that stops it. */
    running?: AiJob
    onStopped: (stopped?: AiJob) => void
    placeholder: string
    onSent: (child: AiJob) => void
    /** Refused: the conversation most likely moved on elsewhere (the assistant, another tab). */
    onFailed: () => void
}

/** Goes on with the conversation: a follow-up starts from the open proposal and replaces it once it proposes. */
export const FollowUpForm: React.FC<FollowUpFormProps> = ({ target, open, latest, running, onStopped, placeholder, onSent, onFailed }) => {
    const { t } = useTranslation()
    const aiJobsApi = useAiJobsApi()
    const [draft, setDraft] = useState("")
    const [aiModel, setAiModel] = useFollowUpAiModel((open ?? latest)?.job)
    const [effort, setEffort] = useFollowUpEffort((open ?? latest)?.job, aiModel)
    const promptId = useId()
    const locked = !open
    const images = usePromptImages()

    const followUpMutation = useMutation({
        mutationFn: ({ jobId, prompt }: { jobId: string; prompt: string }) =>
            aiJobsApi.followUp(
                jobId,
                { prompt, effort, aiModelId: aiModel?.id, ...followUpScope(target), images: images.images.length ? images.images : undefined },
                { customErrorMessage: error => jobErrorMessage(t, error, "follow_up") }
            ),
        onSuccess: child => {
            setDraft("")
            images.clear()
            onSent(child)
        },
        onError: onFailed
    })

    // Nothing to refine, or a follow-up on its way: the field and its controls wait.
    const frozen = locked || followUpMutation.isPending

    const submit = () => {
        if (!draft.trim() || frozen) return
        followUpMutation.mutate({ jobId: open.job._id, prompt: draft.trim() })
    }

    return (
        <form
            className="flex flex-col gap-2 border-t border-divider pt-4"
            onSubmit={event => {
                event.preventDefault()
                submit()
            }}
        >
            <PromptImageList state={images} disabled={frozen} />
            <div className="flex items-end gap-2">
                <Label htmlFor={promptId} className="sr-only">
                    {t("frontend.aiChange.follow_up_label")}
                </Label>
                <Textarea
                    id={promptId}
                    value={draft}
                    maxLength={PROMPT_MAX_LENGTH}
                    rows={2}
                    className={cn("min-h-[44px] resize-none", locked && "cursor-not-allowed opacity-60", images.dragging && !locked && "ring-2 ring-primary")}
                    // Read-only rather than disabled: the field keeps the focus while the agent works on what was just sent.
                    readOnly={frozen}
                    aria-disabled={locked || undefined}
                    aria-describedby={`${promptId}-state`}
                    placeholder={placeholder}
                    dataTestId="ai-change-follow-up"
                    {...(frozen ? {} : images.fieldProps)}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            submit()
                        }
                    }}
                />
                {/* A placeholder is not read out: the state of the conversation is, as the field's description. */}
                <span id={`${promptId}-state`} className="sr-only" aria-live="polite">
                    {placeholder}
                </span>
                <AttachImageButton state={images} disabled={frozen} dataTestId="ai-change-follow-up-attach" />
                <AiModelSelect value={aiModel?.id} onChange={setAiModel} disabled={frozen} dataTestId="ai-change-follow-up-ai-model" />
                <EffortSelect value={effort} onChange={setEffort} efforts={effortsOf(aiModel)} disabled={frozen} dataTestId="ai-change-follow-up-effort" />
                {running ? (
                    <StopJobButton job={running} onStopped={onStopped} dataTestId="ai-change-stop" />
                ) : (
                    <Button type="submit" size="icon" aria-label={t("frontend.aiChange.follow_up_send")} disabled={!draft.trim() || frozen} dataTestId="ai-change-follow-up-send">
                        {followUpMutation.isPending ? <Spinner size={16} centerScreen={false} /> : <ArrowUp aria-hidden="true" />}
                    </Button>
                )}
            </div>
        </form>
    )
}
