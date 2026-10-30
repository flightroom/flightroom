import { useQueries } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import useAiChangesApi, { AiChangeEvent, AiChangeStatus } from "@/hooks/apiClients/useAiChangesApi"
import useAiJobsApi from "@/hooks/apiClients/useAiJobsApi"
import { cn } from "@/utils/styleUtils"
import { LIVERIES } from "./vega-scene/constants"
import { WorkshopMood, WorkshopWorker } from "./vega-scene/types"
import { VegaScene } from "./vegaScene"

/** One work of the queue, as the workshop draws it */
export interface WorkshopEntry {
    id: string
    /** Every value of `?change=` that opens it */
    ids: string[]
    title: string
    status: AiChangeStatus
    /** While the agent works on it: the request, or the job, its events are read from */
    live?: { kind: "request" | "job"; id: string }
}

interface VegaWorkshopProps {
    entries: WorkshopEntry[]
    selectedId?: string
    onSelect: (id: string) => void
}

/** Bays drawn at once: past them the row would be too small to read; the classic view lists every work */
const MAX_BAYS = 8
const POLL_INTERVAL_MS = 2000
const CAPTION_LENGTH = 42

const READING_TOOLS = new Set(["read_file", "list_files", "search", "read_api_spec"])
const WRITING_TOOLS = new Set(["write_file", "edit_file", "delete_file"])

/** What comes first in the workshop: the works the agent is on, then the ones to review, then the failed ones */
const PRIORITY: Record<AiChangeStatus, number> = { RUNNING: 0, APPLYING: 0, PENDING: 1, PROPOSED: 2, FAILED: 3, APPLIED: 4, DISCARDED: 5 }

/** The works done with: they have no bay in the workshop */
const GONE = new Set<AiChangeStatus>(["APPLIED", "DISCARDED"])

/** The same work keeps its number and its livery whatever else the queue holds */
const hashOf = (id: string) => {
    let hash = 0
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
    return hash
}

const lastActivity = (events?: AiChangeEvent[]) => [...(events ?? [])].reverse().find(event => event.kind === "tool" || event.kind === "thinking" || event.kind === "text")

const moodOf = (status: AiChangeStatus, events?: AiChangeEvent[]): WorkshopMood => {
    if (status === "PENDING") return "queued"
    if (status === "APPLYING") return "applying"
    if (status === "PROPOSED") return "done"
    if (status === "APPLIED") return "applied"
    if (status === "FAILED") return "failed"
    if (status === "DISCARDED") return "parked"
    const activity = lastActivity(events)
    if (activity?.kind !== "tool") return "thinking"
    const tool = activity.message.split(" ")[0]
    if (READING_TOOLS.has(tool)) return "analyzing"
    if (WRITING_TOOLS.has(tool)) return "coding"
    return tool === "run_script" ? "working" : "thinking"
}

const clip = (text: string) => (text.length > CAPTION_LENGTH ? `${text.slice(0, CAPTION_LENGTH - 1)}…` : text)

/**
 * The other look of Edit with AI: a space workshop where every work of the queue is a Vega in its bay. Its pose
 * says where the work stands, and while the agent runs, what it is doing now: reading, writing code, running a
 * script. A click on a Vega, or on its plate under the deck, opens the work as the classic queue does.
 */
const VegaWorkshop: React.FC<VegaWorkshopProps> = ({ entries, selectedId, onSelect }) => {
    const { t } = useTranslation()
    const aiChangesApi = useAiChangesApi()
    const aiJobsApi = useAiJobsApi()
    const containerRef = useRef<HTMLDivElement>(null)
    const sceneRef = useRef<VegaScene | null>(null)
    const onSelectRef = useRef(onSelect)
    onSelectRef.current = onSelect
    const [unsupported, setUnsupported] = useState(false)

    // A work applied or discarded leaves the workshop: only the classic queue keeps it
    const open = entries.filter(entry => !GONE.has(entry.status))
    const shown = [...open].sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]).slice(0, MAX_BAYS)
    const hidden = open.length - shown.length
    // How a Vega goes when its work leaves: off with its rocket once applied, fading away once discarded
    const departures = Object.fromEntries(entries.filter(entry => GONE.has(entry.status)).map(entry => [entry.id, entry.status === "APPLIED" ? "launch" : "fade"] as const))

    // Only the works the agent is on are read in full: their events say what it is doing
    const liveQueries = useQueries({
        // Keys of their own: the detail views cache these same requests whole, under theirs
        queries: shown.map(entry => ({
            queryKey: ["ai-workshop", entry.live?.kind, entry.live?.id],
            queryFn: async (): Promise<AiChangeEvent[]> =>
                (entry.live?.kind === "job" ? (await aiJobsApi.get(entry.live.id, { silent: true })).events : (await aiChangesApi.getSingle(entry.live!.id)).events) ?? [],
            enabled: Boolean(entry.live),
            refetchInterval: POLL_INTERVAL_MS
        }))
    })

    const workers: WorkshopWorker[] = shown.map((entry, index) => {
        const events = entry.live ? liveQueries[index]?.data : undefined
        const mood = moodOf(entry.status, events)
        const activity = lastActivity(events)
        const hash = hashOf(entry.id)
        return {
            id: entry.id,
            callsign: `VEGA·${String((hash % 99) + 1).padStart(2, "0")}`,
            livery: hash % LIVERIES.length,
            title: clip(entry.title),
            mood,
            caption: entry.status === "RUNNING" && activity?.kind === "tool" ? clip(activity.message) : t(`frontend.aiChange.workshop.mood.${mood}`)
        }
    })

    useEffect(() => {
        if (!containerRef.current) return
        try {
            sceneRef.current = new VegaScene(containerRef.current, id => onSelectRef.current(id))
        } catch {
            setUnsupported(true)
        }
        return () => {
            sceneRef.current?.dispose()
            sceneRef.current = null
        }
    }, [])

    const signature = JSON.stringify([workers, departures])
    // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for the workers and their departures
    useEffect(() => {
        sceneRef.current?.setWorkers(workers, departures)
    }, [signature])

    const selectedEntry = shown.find(entry => selectedId && entry.ids.includes(selectedId))
    useEffect(() => {
        sceneRef.current?.setSelected(selectedEntry?.id)
    }, [selectedEntry?.id])

    let overlay = <span className="absolute bottom-2 right-3 font-mono text-[11px] text-[#9db2c0]">{t("frontend.aiChange.workshop.hint")}</span>
    if (open.length === 0) overlay = <p className="absolute inset-x-0 bottom-6 px-6 text-center text-sm text-[#9db2c0]">{t("frontend.aiChange.workshop.empty")}</p>
    if (unsupported) overlay = <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-[#9db2c0]">{t("frontend.aiChange.workshop.no_webgl")}</p>

    return (
        <section aria-label={t("frontend.aiChange.workshop.label")} className="flex flex-col gap-3">
            <div ref={containerRef} className="relative h-[clamp(440px,75vh,960px)] cursor-grab touch-pan-y overflow-hidden rounded-xl border border-divider bg-[#04121a] active:cursor-grabbing">
                {overlay}
            </div>
            {/* The plates of the bays: what a keyboard and a screen reader open the works with */}
            {shown.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label={t("frontend.aiChange.workshop.plates")}>
                    {shown.map((entry, index) => {
                        const worker = workers[index]
                        const selected = entry.id === selectedEntry?.id
                        return (
                            <li key={entry.id} className="min-w-0">
                                <button
                                    type="button"
                                    aria-current={selected ? "true" : undefined}
                                    onClick={() => !selected && onSelect(entry.id)}
                                    className={cn(
                                        "flex max-w-[18rem] items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        selected ? "border-primary bg-primary/5" : "border-divider hover:border-primary/50"
                                    )}
                                >
                                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: LIVERIES[worker.livery][1] }} aria-hidden="true" />
                                    <span className="shrink-0 font-mono text-foreground-secondary">{worker.callsign}</span>
                                    <span className="min-w-0 truncate font-medium">{entry.title}</span>
                                    <span className="shrink-0 text-foreground-secondary">· {t(`frontend.aiChange.status.${entry.status}`)}</span>
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}
            {hidden > 0 && <p className="text-xs text-muted-foreground">{t("frontend.aiChange.workshop.more", { count: hidden })}</p>}
        </section>
    )
}

export default VegaWorkshop
