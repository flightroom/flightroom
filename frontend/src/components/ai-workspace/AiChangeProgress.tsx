import { Tabs, TabsList, TabsTrigger } from "@flightroom/design-system"
import { format } from "date-fns"
import { Brain, ChevronDown, ExternalLink, Monitor, Server } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { IBadgeProps } from "@/components/atoms"
import { Badge } from "@/components/atoms"
import type { AiChangeEvent, AiChangeStatus } from "@/hooks/apiClients/useAiChangesApi"

const STATUS_VARIANT: Record<AiChangeStatus, IBadgeProps["variant"]> = {
    PENDING: "outline",
    RUNNING: "outline",
    APPLYING: "outline",
    PROPOSED: "accent",
    APPLIED: "default",
    DISCARDED: "outline",
    FAILED: "destructive"
}

/** The status of an AI change request, shared by the frontend page and the job tabs of the assistant. */
export const StatusBadge: React.FC<{ status: AiChangeStatus }> = ({ status }) => {
    const { t } = useTranslation()
    return <Badge variant={STATUS_VARIANT[status]}>{t(`frontend.aiChange.status.${status}`)}</Badge>
}

const previewOf = (message: string): { kind: "frontend" | "backend"; slug: string; url: string } | undefined => {
    const match = /^preview-ready\|(frontend|backend)\|([a-z0-9-]+)\|(.+)$/.exec(message)
    if (!match) return undefined
    try {
        const url = new URL(decodeURIComponent(match[3]))
        return url.protocol === "http:" || url.protocol === "https:" ? { kind: match[1] === "frontend" ? "frontend" : "backend", slug: match[2], url: url.toString() } : undefined
    } catch {
        return undefined
    }
}

/** The live frontend and API endpoints made available by the OpenShell gateway. */
export const LivePreviews: React.FC<{ events: AiChangeEvent[] }> = ({ events }) => {
    const { t } = useTranslation()
    const [selectedFrontend, setSelectedFrontend] = useState<string>()
    const previews = new Map<string, { kind: "frontend" | "backend"; slug: string; url: string }>()
    for (const event of events) {
        const preview = previewOf(event.message)
        if (preview) previews.set(`${preview.kind}:${preview.slug}`, preview)
    }
    const frontend = [...previews.values()].filter(preview => preview.kind === "frontend")
    const backend = [...previews.values()].filter(preview => preview.kind === "backend")
    const activeFrontend = frontend.find(preview => preview.slug === selectedFrontend) ?? frontend[0]
    const unavailable = events.some(event => event.message === "preview-failed|frontend" || event.message === "preview-failed|backend")
    if (frontend.length === 0 && backend.length === 0 && !unavailable) return null

    return (
        <details open className="group overflow-hidden rounded-lg border border-divider bg-card">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2 text-sm font-semibold">
                    <Monitor className="size-4" aria-hidden="true" />
                    {t("frontend.aiChange.preview.title")}
                    {frontend.length > 0 && <span className="text-xs font-normal text-muted-foreground">{t("frontend.aiChange.preview.frontend_count", { count: frontend.length })}</span>}
                </span>
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="flex flex-col gap-3 border-t border-divider p-3 sm:p-4">
                {backend.length > 0 && (
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {backend.map(preview => (
                            <a
                                key={preview.slug}
                                href={preview.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-primary-strong underline-offset-4 hover:underline"
                            >
                                <Server className="size-3.5" aria-hidden="true" />
                                {t("frontend.aiChange.preview.api_for", { name: preview.slug })}
                                <ExternalLink className="size-3" aria-hidden="true" />
                            </a>
                        ))}
                    </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{t("frontend.aiChange.preview.access_warning")}</p>
                    {activeFrontend && (
                        <a
                            href={activeFrontend.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary-strong underline-offset-4 hover:underline"
                        >
                            {t("frontend.aiChange.preview.open_for", { name: activeFrontend.slug })}
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                        </a>
                    )}
                </div>
                {unavailable && (
                    <p role="status" className="text-sm text-warning">
                        {t("frontend.aiChange.preview.unavailable")}
                    </p>
                )}
                {frontend.length > 1 && (
                    <Tabs value={activeFrontend?.slug} onValueChange={setSelectedFrontend} layoutSize="sm">
                        <TabsList aria-label={t("frontend.aiChange.preview.frontends_label")} className="max-w-full">
                            {frontend.map(preview => (
                                <TabsTrigger key={preview.slug} value={preview.slug} className="max-w-48">
                                    <span className="truncate">{preview.slug}</span>
                                </TabsTrigger>
                            ))}
                        </TabsList>
                    </Tabs>
                )}
                {activeFrontend && (
                    <iframe
                        key={activeFrontend.slug}
                        src={activeFrontend.url}
                        title={t("frontend.aiChange.preview.for", { name: activeFrontend.slug })}
                        sandbox="allow-scripts allow-same-origin allow-forms"
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        className="h-[min(65vh,44rem)] min-h-72 w-full rounded-md border border-divider bg-background"
                    />
                )}
            </div>
        </details>
    )
}

/** What the agent did, step by step: `live` announces new steps to screen readers. */
export const ProgressLog: React.FC<{ events: AiChangeEvent[]; live: boolean }> = ({ events, live }) => {
    const { t } = useTranslation()
    const containerRef = useRef<HTMLDivElement>(null)

    // Newest last, as in a terminal: keep the latest step in view while the agent works.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new event is what must trigger the scroll
    useEffect(() => {
        if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight
    }, [events.length])

    return (
        <div
            ref={containerRef}
            role="log"
            aria-live={live ? "polite" : "off"}
            aria-label={t("frontend.aiChange.progress_log")}
            className="max-h-64 overflow-auto rounded-md border border-divider bg-muted/40 p-3 text-xs"
        >
            {events.length === 0 ? (
                <p className="text-muted-foreground">{t("frontend.aiChange.progress_empty")}</p>
            ) : (
                <ol className="flex flex-col gap-1">
                    {events.map((event, index) => (
                        <li key={`${event.at}-${index}`} className="flex gap-2">
                            <time dateTime={event.at} className="shrink-0 font-mono text-muted-foreground">
                                {format(new Date(event.at), "HH:mm:ss")}
                            </time>
                            {event.kind === "info" && <span className="font-medium">{t(`frontend.aiChange.events.${event.message}`, { defaultValue: event.message })}</span>}
                            {event.kind === "tool" && <span className="break-all font-mono text-muted-foreground">{event.message}</span>}
                            {/* Folded: a build log would push the steps out of view, it is opened when needed. */}
                            {event.kind === "output" && (
                                <details className="min-w-0 flex-1">
                                    <summary className="cursor-pointer text-muted-foreground">{t("frontend.aiChange.script_output")}</summary>
                                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono">{event.message}</pre>
                                </details>
                            )}
                            {event.kind === "text" && <span className="whitespace-pre-wrap break-words">{event.message}</span>}
                            {/* Muted and apart from what the agent said: how it reasoned, not what it did. */}
                            {event.kind === "thinking" && (
                                <span className="flex min-w-0 gap-1 italic text-muted-foreground">
                                    <Brain className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                                    <span className="sr-only">{t("assistant.reasoning")}:</span>
                                    <span className="whitespace-pre-wrap break-words">{event.message}</span>
                                </span>
                            )}
                        </li>
                    ))}
                </ol>
            )}
        </div>
    )
}
