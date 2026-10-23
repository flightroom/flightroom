import { useQuery } from "@tanstack/react-query"
import { Bot } from "lucide-react"
import { useTranslation } from "react-i18next"
import useAiJobsApi, { AiWorkingJob } from "@/hooks/apiClients/useAiJobsApi"
import useProjectStore from "@/store/useProjectStore"
import { cn } from "@/utils/styleUtils"

/** Slower than the job panel: this only says whether someone is at work, not what the agent is doing. */
const POLL_INTERVAL_MS = 5000

const NO_JOBS: AiWorkingJob[] = []

/**
 * Every agent at work in the project. Every card, node, row and ship reads the same query, so the
 * page asks once per interval however many components it shows; `select` narrows it per reader.
 */
const useWorkingAgentsQuery = <T,>(select: (working: AiWorkingJob[]) => T) => {
    const projectId = useProjectStore(state => state.project?._id)
    const aiJobsApi = useAiJobsApi()

    return useQuery({
        queryKey: ["ai-agents-working", projectId],
        queryFn: () => aiJobsApi.working({ silent: true }),
        enabled: Boolean(projectId),
        refetchInterval: POLL_INTERVAL_MS,
        select
    })
}

/** The agents at work right now, with the frontends and backends each works on. */
export const useWorkingAgentJobs = (): AiWorkingJob[] => useWorkingAgentsQuery(working => working).data ?? NO_JOBS

/** How many agents are at work on the frontend or backend right now. */
export const useWorkingAgents = (componentId?: string): number =>
    useWorkingAgentsQuery(working => (componentId ? working.filter(entry => entry.componentIds.includes(componentId)).length : 0)).data ?? 0

interface WorkingAgentsIndicatorProps {
    agents: number
    /** The dot and the count only, for the flow nodes and the tables where the full label does not fit. */
    compact?: boolean
    /**
     * Announces changes as a live region: for a single indicator on a page (a header). Left off in lists and
     * cards, where every row would announce itself at each poll.
     */
    live?: boolean
    className?: string
}

/** A pulsing dot and how many agents are at work; nothing at all while none is. */
export const WorkingAgentsIndicator: React.FC<WorkingAgentsIndicatorProps> = ({ agents, compact = false, live = false, className }) => {
    const { t } = useTranslation("platform")

    if (agents <= 0) return null

    const label = t("frontend.card.workingAgents", { count: agents })

    return (
        <span
            role={live ? "status" : undefined}
            title={label}
            className={cn("inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary-strong", className)}
        >
            <span className="relative flex size-2 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            <Bot className="size-3.5 shrink-0" aria-hidden="true" />
            {compact ? (
                <>
                    <span className="tabular-nums" aria-hidden="true">
                        {agents}
                    </span>
                    <span className="sr-only">{label}</span>
                </>
            ) : (
                <span className="truncate">{label}</span>
            )}
        </span>
    )
}

/** The indicator of one component, for lists that render their items inline and cannot call the hook per item. */
export const ComponentWorkingAgents: React.FC<{ componentId?: string } & Omit<WorkingAgentsIndicatorProps, "agents">> = ({ componentId, ...props }) => (
    <WorkingAgentsIndicator agents={useWorkingAgents(componentId)} {...props} />
)

export default WorkingAgentsIndicator
