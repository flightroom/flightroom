import { format } from "date-fns"
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, LoaderCircle, Trash2 } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import useThemeStore from "@/store/useThemeStore"
import { cn } from "@/utils/styleUtils"
import { StatusBadge } from "./AiChangeProgress"
import type { QueueEntry, QueueGroup } from "./queueEntries"

const GROUP_ICON: Record<QueueGroup, React.FC<{ className?: string }>> = {
    review: ClipboardCheck,
    active: LoaderCircle,
    discarded: Trash2,
    applied: CheckCircle2,
    failed: AlertTriangle
}

const QueueItem: React.FC<{ entry: QueueEntry; selected: boolean; onSelect: () => void }> = ({ entry, selected, onSelect }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    return (
        <li>
            <button
                type="button"
                aria-current={selected ? "true" : undefined}
                // The label replaces the content of the button: it has to carry the status the badges show.
                aria-label={`${t("frontend.aiChange.open_request", { prompt: entry.title })} · ${t(`frontend.aiChange.status.${entry.status}`)}`}
                onClick={onSelect}
                className={cn(
                    "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-primary bg-primary/5" : "border-divider hover:border-primary/50 hover:bg-muted/40"
                )}
            >
                <span className="line-clamp-2 break-words text-sm font-medium" title={entry.prompt}>
                    {entry.title}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <time dateTime={entry.at}>{format(new Date(entry.at), "PPp", { locale: themeStore.getLocale() })}</time>
                    {entry.turns !== undefined && entry.turns > 1 && <span>· {t("frontend.aiChange.turns_count", { count: entry.turns })}</span>}
                    {Boolean(entry.files) && <span>· {t("frontend.aiChange.files_count", { count: entry.files })}</span>}
                    {Boolean(entry.repositories) && <span>· {t("frontend.aiChange.repositories_count", { count: entry.repositories })}</span>}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={entry.status} />
                    {entry.badge}
                </span>
            </button>
        </li>
    )
}

interface QueueSectionProps {
    group: QueueGroup
    entries: QueueEntry[]
    selectedId: string
    onSelect: (id: string) => void
}

export const QueueSection: React.FC<QueueSectionProps> = ({ group, entries, selectedId, onSelect }) => {
    const { t } = useTranslation()
    const headingId = useId()
    const Icon = GROUP_ICON[group]
    const containsSelected = entries.some(entry => entry.ids.includes(selectedId))
    // Applied and failed requests are done with: keep them out of the way unless one of them is open.
    const [open, setOpen] = useState(containsSelected || (group !== "applied" && group !== "failed"))

    // A conversation of the group opened from elsewhere (a deep link): unfold it. Never fold it back on the user.
    useEffect(() => {
        if (containsSelected) setOpen(true)
    }, [containsSelected])
    const heading = (
        <span className="flex items-center justify-between gap-2">
            <span id={headingId} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
                <ChevronRight className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
                <Icon className={cn("size-3.5", group === "active" && entries.length > 0 && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
                {t(`frontend.aiChange.groups.${group}`)}
            </span>
            <Badge variant={group === "review" && entries.length > 0 ? "accent" : "outline"}>{entries.length}</Badge>
        </span>
    )
    const list =
        entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t(`frontend.aiChange.group_empty.${group}`)}</p>
        ) : (
            <ul aria-labelledby={headingId} className="flex flex-col gap-1.5">
                {entries.map(entry => (
                    <QueueItem
                        key={entry.ids[entry.ids.length - 1]}
                        entry={entry}
                        selected={entry.ids.includes(selectedId)}
                        // Already open: any request of it shows the whole conversation, and reopening it would drop the draft.
                        onSelect={() => !entry.ids.includes(selectedId) && onSelect(entry.id)}
                    />
                ))}
            </ul>
        )

    return (
        <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer list-none rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">{heading}</summary>
            <div className="mt-2">{list}</div>
        </details>
    )
}
