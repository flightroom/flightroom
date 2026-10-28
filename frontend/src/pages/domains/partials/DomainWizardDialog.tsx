import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Textarea } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Send, Server, Sparkles } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import * as z from "zod"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Button } from "@/components/atoms"
import TextareaField from "@/components/input/TextareaField.rhf"
import useAiJobsApi, { DomainDraft, DomainDraftMessage, DomainDraftTurn } from "@/hooks/apiClients/useAiJobsApi"
import useDomainsApi, { Domain } from "@/hooks/apiClients/useDomainsApi"
import { errorCodeOf } from "@/hooks/useApiClient"
import { cn } from "@/utils/styleUtils"
import { DomainFormFields, useDomainFormSchema } from "./DomainFormDialog"
import type { ScaffoldItem } from "./DomainScaffoldDialog"

const MAX_MESSAGE_CHARS = 4_000
/** As the backend: the conversation sent with each answer has at most this many messages. */
const MAX_MESSAGES = 40
/** As the prompt of a job. */
const REQUEST_MAX_LENGTH = 8_000

/** What a failed answer tells the user: refused, throttled, the provider down, or anything else. */
const failureMessage = (code?: string) => {
    if (code === "RATE_LIMITED") return "assistant.errors.rate_limited"
    if (code === "AI_PROVIDER_ERROR") return "domains.wizard.provider_error"
    if (code === "AI_CHANGE_FORBIDDEN" || code === "DOMAIN_SCOPE_FORBIDDEN") return "domains.wizard.forbidden"
    return "domains.wizard.error"
}

/** The rows of the creation dialog for the components of the draft: frontends loaded by the chosen host, backends with their path. */
export const draftItems = (draft: DomainDraft): ScaffoldItem[] => {
    const host = draft.exposure.kind === "remote" && draft.exposure.hostId ? { id: draft.exposure.hostId, name: draft.exposure.hostName ?? "" } : undefined
    return [
        ...draft.frontends.map((component, index) => ({ ...component, key: `frontend-${index}`, kind: "frontend" as const, host })),
        ...draft.backends.map(({ exposurePath, ...component }, index) => ({ ...component, key: `backend-${index}`, kind: "backend" as const, exposurePath: exposurePath ?? "" }))
    ]
}

interface DomainWizardDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The user prefers the plain form. */
    onManual: () => void
    /** The domain was created: its components still have to be reviewed, and the agent started on them with the request. */
    onCreated: (domain: Domain, items: ScaffoldItem[], request: string) => void
}

/**
 * The AI way to create a functional domain: a short conversation in which the assistant asks what the application
 * is called, what it does and where it is exposed, proposing its frontends and backends as it goes. Then the user
 * reviews the name, the description, the context and the first request; the domain is created, and its components
 * are reviewed and created by the dialog that follows.
 */
const DomainWizardDialog: React.FC<DomainWizardDialogProps> = ({ open, onOpenChange, onManual, onCreated }) => {
    const { t, i18n } = useTranslation()
    const queryClient = useQueryClient()
    const aiJobsApi = useAiJobsApi()
    const domainsApi = useDomainsApi()
    const aiModelId = useProjectAiModels().selected?.id
    const [step, setStep] = useState<"chat" | "review">("chat")
    const [messages, setMessages] = useState<DomainDraftMessage[]>([])
    const [turn, setTurn] = useState<DomainDraftTurn>()
    const [input, setInput] = useState("")
    const [loading, setLoading] = useState(false)
    // The key of the message of the last failure, if any.
    const [failed, setFailed] = useState<string>()
    const bottomRef = useRef<HTMLDivElement>(null)
    // The turn the review form was filled from: going back to the conversation keeps the edits until a new answer
    const reviewedTurn = useRef<DomainDraftTurn>(undefined)

    const domainSchema = useDomainFormSchema()
    const schema = useMemo(() => domainSchema.extend({ request: z.string().max(REQUEST_MAX_LENGTH).optional() }), [domainSchema])
    const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) })

    // Every opening starts a new conversation.
    useEffect(() => {
        if (!open) return
        setStep("chat")
        setMessages([{ role: "assistant", content: t("domains.wizard.greeting") }])
        setTurn(undefined)
        setInput("")
        setFailed(undefined)
        reviewedTurn.current = undefined
    }, [open, t])

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new message or the answer being prepared is what must trigger the scroll
    useEffect(() => {
        bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" })
    }, [messages, loading])

    const send = async (text: string) => {
        const content = text.trim()
        if (!content || loading || messages.length + 1 > MAX_MESSAGES) return
        const conversation: DomainDraftMessage[] = [...messages, { role: "user", content }]
        setMessages(conversation)
        setInput("")
        setLoading(true)
        setFailed(undefined)
        try {
            const next = await aiJobsApi.draftDomain({ messages: conversation, locale: i18n.language, aiModelId }, { silent: true })
            setTurn(next)
            setMessages([...conversation, { role: "assistant", content: next.reply }])
        } catch (error) {
            const code = errorCodeOf(error as Error)
            setFailed(failureMessage(code))
            // The answer goes back in the box so that it can be sent again.
            setMessages(messages)
            setInput(content)
        } finally {
            setLoading(false)
        }
    }

    const draft = turn?.draft

    const review = () => {
        if (!draft) return
        if (reviewedTurn.current !== turn) form.reset({ name: draft.name, description: draft.description, context: draft.context, request: draft.request })
        reviewedTurn.current = turn
        setStep("review")
    }

    // One more answer and the conversation would be longer than the backend takes
    const full = messages.length + 1 > MAX_MESSAGES

    const create = async (values: z.infer<typeof schema>) => {
        if (!draft) return
        const { request, ...fields } = values
        const domain = await domainsApi.create(fields)
        await queryClient.invalidateQueries({ queryKey: ["domains"] })
        onOpenChange(false)
        onCreated(domain, draftItems(draft), request?.trim() || fields.description?.trim() || fields.name)
    }

    const busy = loading || form.formState.isSubmitting

    return (
        <Dialog open={open} onOpenChange={next => !busy && onOpenChange(next)}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t(step === "chat" ? "domains.wizard.title" : "domains.wizard.review_title")}</DialogTitle>
                    <DialogDescription>{t(step === "chat" ? "domains.wizard.description" : "domains.wizard.review_description")}</DialogDescription>
                </DialogHeader>

                {step === "chat" ? (
                    <div className="mt-2 flex flex-col gap-3">
                        <div className="flex max-h-[22rem] flex-col gap-3 overflow-y-auto pr-1" data-testid="domain-wizard-chat" aria-live="polite">
                            {messages.map((message, index) => (
                                <div
                                    key={index}
                                    className={cn(
                                        "max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-2 text-sm",
                                        message.role === "user" ? "self-end bg-primary text-primary-foreground" : "self-start bg-accent/60 text-foreground"
                                    )}
                                >
                                    {message.content}
                                </div>
                            ))}
                            {loading && <div className="self-start rounded-lg bg-accent/60 px-4 py-2 text-sm text-muted-foreground">{t("domains.wizard.loading")}</div>}
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
                        {full && <p className="text-sm text-foreground-secondary">{t("domains.wizard.full")}</p>}

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
                                disabled={full}
                                rows={2}
                                className="flex-1"
                                placeholder={t(turn ? "domains.wizard.reply_placeholder" : "domains.wizard.placeholder")}
                                aria-label={t("domains.wizard.input_label")}
                                dataTestId="domain-wizard-input"
                                onChange={event => setInput(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault()
                                        send(input)
                                    }
                                }}
                            />
                            <Button type="submit" variant="primary" size="icon" disabled={!input.trim() || loading || full} aria-label={t("domains.wizard.send")} dataTestId="domain-wizard-send">
                                <Send />
                            </Button>
                        </form>

                        {draft?.name && <DraftSummary draft={draft} />}

                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={onManual} disabled={loading} dataTestId="domain-wizard-manual">
                                {t("domains.wizard.manual")}
                            </Button>
                            <Button type="button" variant={turn?.ready ? "primary" : "secondary"} onClick={review} disabled={!draft?.name || loading} dataTestId="domain-wizard-continue">
                                {t("domains.wizard.continue")}
                            </Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <FormProvider {...form}>
                        <form onSubmit={form.handleSubmit(create)}>
                            <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto py-4 pr-1">
                                <DomainFormFields disabled={busy} />
                                <TextareaField
                                    name="request"
                                    maxLength={REQUEST_MAX_LENGTH}
                                    label={t("domains.wizard.request_label")}
                                    description={t("domains.wizard.request_hint")}
                                    rows={5}
                                    disabled={busy}
                                    dataTestId="domain-wizard-request"
                                />
                                {draft && <DraftSummary draft={draft} components />}
                            </div>
                            <DialogFooter>
                                <Button type="button" variant="secondary" onClick={() => setStep("chat")} disabled={busy}>
                                    {t("domains.wizard.back")}
                                </Button>
                                <Button type="submit" loading={form.formState.isSubmitting} disabled={busy} dataTestId="domain-wizard-create">
                                    {t("domains.wizard.create")}
                                </Button>
                            </DialogFooter>
                        </form>
                    </FormProvider>
                )}
            </DialogContent>
        </Dialog>
    )
}

/** The proposal so far: in the conversation all of it, in the review only where it is exposed and what will be created next. */
const DraftSummary: React.FC<{ draft: DomainDraft; components?: boolean }> = ({ draft, components }) => {
    const { t } = useTranslation()
    const exposure = t(`domains.wizard.exposure.${draft.exposure.kind}`, { host: draft.exposure.hostName })
    const rows = [
        ...draft.frontends.map(frontend => ({ key: `frontend-${frontend.slug}`, kind: "frontend" as const, name: frontend.name, detail: undefined as string | undefined })),
        ...draft.backends.map(backend => ({
            key: `backend-${backend.slug}`,
            kind: "backend" as const,
            name: backend.name,
            detail: backend.exposurePath ? t("domains.wizard.public_at", { path: backend.exposurePath }) : t("domains.wizard.internal")
        }))
    ]

    return (
        <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm" data-testid="domain-wizard-summary">
            <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary-strong" aria-hidden="true" />
                <span className="font-semibold text-foreground">{t(components ? "domains.wizard.next_title" : "domains.wizard.proposal_title")}</span>
            </div>
            {!components && (
                <div>
                    <p className="font-medium text-foreground">{draft.name}</p>
                    {draft.description && <p className="text-foreground-secondary">{draft.description}</p>}
                </div>
            )}
            <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("domains.wizard.exposure_label")}</span>
                <span className="text-foreground">{exposure}</span>
            </div>
            {rows.length > 0 && (
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("domains.wizard.components_label")}</span>
                    <ul className="flex flex-col gap-1">
                        {rows.map(row => (
                            <li key={row.key} className="flex items-center gap-2">
                                {row.kind === "backend" ? (
                                    <Server className="size-4 shrink-0" aria-label={t("domains.ai.scaffold.backends")} />
                                ) : (
                                    <LayoutDashboard className="size-4 shrink-0" aria-label={t("domains.ai.scaffold.frontends")} />
                                )}
                                <span className="font-medium text-foreground">{row.name}</span>
                                {row.detail && <span className="text-foreground-secondary">— {row.detail}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

export default DomainWizardDialog
