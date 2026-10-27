import { Textarea } from "@flightroom/design-system"
import { Send, Sparkles } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useAssistantApi, { ProjectDraft, ProjectDraftMessage, ProjectDraftTurn } from "@/hooks/apiClients/useAssistantApi"
import { errorCodeOf } from "@/hooks/useApiClient"
import { cn } from "@/utils/styleUtils"
import { StepShell } from "./wizardShared"

const MAX_MESSAGE_CHARS = 4_000

interface ProjectDraftAssistantProps {
    organizationId: string
    aiModelId?: string
    /** The user accepted the proposal: the wizard opens with it */
    onUse: (draft: ProjectDraft) => void
    /** The user prefers to fill the wizard by hand */
    onManual: () => void
}

/**
 * The alternative to filling the wizard by hand: a short conversation in which the assistant asks how many
 * environments the project needs and which functional domains it covers, proposing them as it goes.
 * Nothing is created from it: the proposal prefills the wizard, whose steps still have to be confirmed.
 */
const ProjectDraftAssistant: React.FC<ProjectDraftAssistantProps> = ({ organizationId, aiModelId, onUse, onManual }) => {
    const { t, i18n } = useTranslation()
    const assistantApi = useAssistantApi()
    const [messages, setMessages] = useState<ProjectDraftMessage[]>([{ role: "assistant", content: t("newProjectWizard.ai_draft.greeting") }])
    const [turn, setTurn] = useState<ProjectDraftTurn>()
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(false)
    // The key of the message of the last failure, if any.
    const [failed, setFailed] = useState<string>()
    const bottomRef = useRef<HTMLDivElement>(null)

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new message or the answer being prepared is what must trigger the scroll
    useEffect(() => {
        bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" })
    }, [messages, loading])

    const send = async (text: string) => {
        const content = text.trim()
        if (!content || loading) return
        const conversation: ProjectDraftMessage[] = [...messages, { role: "user", content }]
        setMessages(conversation)
        setInput("")
        setLoading(true)
        setFailed(undefined)
        try {
            const next = await assistantApi.draftProject(conversation, i18n.language, organizationId, aiModelId)
            setTurn(next)
            setMessages([...conversation, { role: "assistant", content: next.reply }])
        } catch (error) {
            const code = errorCodeOf(error as Error)
            setFailed(code === "RATE_LIMITED" ? "assistant.errors.rate_limited" : code === "AI_PROVIDER_ERROR" ? "newProjectWizard.ai_draft.provider_error" : "newProjectWizard.ai_draft.error")
            // The question goes back in the box so that it can be sent again.
            setMessages(messages)
            setInput(content)
        } finally {
            setLoading(false)
        }
    }

    const draft = turn?.draft
    const canUse = Boolean(draft?.name.trim()) && !loading

    return (
        <StepShell
            title={t("newProjectWizard.ai_draft.title")}
            description={t("newProjectWizard.ai_draft.description")}
            footer={
                <>
                    <Button type="button" variant="ghost" onClick={onManual} disabled={loading} dataTestId="wizard-ai-draft-manual">
                        {t("newProjectWizard.ai_draft.manual")}
                    </Button>
                    <Button type="button" variant={turn?.ready ? "primary" : "secondary"} onClick={() => draft && onUse(draft)} disabled={!canUse} dataTestId="wizard-ai-draft-use">
                        {t("newProjectWizard.ai_draft.use")}
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3 max-h-[26rem] overflow-y-auto pr-1" data-testid="wizard-ai-draft" aria-live="polite">
                {messages.map((message, index) => (
                    <div
                        key={index}
                        className={cn(
                            "max-w-[85%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap",
                            message.role === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-accent/60 text-foreground"
                        )}
                    >
                        {message.content}
                    </div>
                ))}
                {loading && <div className="self-start rounded-lg bg-accent/60 px-4 py-2 text-sm text-muted-foreground">{t("newProjectWizard.ai_draft.loading")}</div>}
                {!loading && turn && turn.options.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {turn.options.map(option => (
                            <Button key={option} type="button" variant="secondary" size="sm" onClick={() => send(option)}>
                                {option}
                            </Button>
                        ))}
                    </div>
                )}
                <div ref={bottomRef} />
            </div>

            {failed && <p className="text-sm text-destructive">{t(failed)}</p>}

            <form
                className="flex items-end gap-2"
                onSubmit={event => {
                    event.preventDefault()
                    send(input)
                }}
            >
                <Textarea
                    value={input}
                    maxLength={MAX_MESSAGE_CHARS}
                    rows={2}
                    className="flex-1"
                    placeholder={t(turn ? "newProjectWizard.ai_draft.reply_placeholder" : "newProjectWizard.ai_draft.placeholder")}
                    aria-label={t("newProjectWizard.ai_draft.input_label")}
                    dataTestId="wizard-ai-draft-input"
                    onChange={event => setInput(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault()
                            send(input)
                        }
                    }}
                />
                <Button type="submit" variant="primary" size="icon" disabled={!input.trim() || loading} aria-label={t("newProjectWizard.ai_draft.send")} dataTestId="wizard-ai-draft-submit">
                    <Send />
                </Button>
            </form>

            {draft?.name.trim() && <DraftSummary draft={draft} />}
        </StepShell>
    )
}

/** The proposal so far, as it will prefill the wizard */
const DraftSummary: React.FC<{ draft: ProjectDraft }> = ({ draft }) => {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm" data-testid="wizard-ai-draft-result">
            <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary-strong" aria-hidden="true" />
                <span className="font-semibold text-foreground">{t("newProjectWizard.ai_draft.proposal_title")}</span>
            </div>
            <div>
                <p className="font-medium text-foreground">{draft.name}</p>
                {draft.description && <p className="text-foreground-secondary">{draft.description}</p>}
            </div>
            {draft.environments.length > 0 && (
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("newProjectWizard.steps.environments")}</span>
                    <div className="flex flex-wrap gap-2">
                        {draft.environments.map(environment => (
                            <span key={environment.slug} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-foreground">
                                <span className="size-2 rounded-full" style={{ backgroundColor: environment.color }} aria-hidden="true" />
                                {environment.name}
                            </span>
                        ))}
                    </div>
                </div>
            )}
            {draft.domains.length > 0 && (
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("newProjectWizard.steps.domains")}</span>
                    <ul className="flex flex-col gap-1">
                        {draft.domains.map(domain => (
                            <li key={domain.name}>
                                <span className="font-medium text-foreground">{domain.name}</span>
                                {domain.description && <span className="text-foreground-secondary"> — {domain.description}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {draft.codeRepository !== "NONE" && (
                <span className="text-foreground-secondary">
                    {t("newProjectWizard.ai_draft.suggested_repository", { repository: t(`newProjectWizard.ai_draft.repository.${draft.codeRepository}`) })}
                </span>
            )}
        </div>
    )
}

export default ProjectDraftAssistant
