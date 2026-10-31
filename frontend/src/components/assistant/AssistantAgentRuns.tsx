import { useQuery } from "@tanstack/react-query"
import { Bot, Coins, Ship } from "lucide-react"
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import { isAiJobActive } from "@/hooks/apiClients/useAiJobsApi"
import useAssistantApi, { AssistantAgentRuns as AgentRuns, AssistantAgentMission, ConversationCostPart, SandboxTotals } from "@/hooks/apiClients/useAssistantApi"
import { AGENT_RUNS_QUERY_KEY } from "@/hooks/useAssistantChat"
import useAssistantJobsStore from "@/store/useAssistantJobsStore"
import useAssistantStore, { isPendingConfirmation } from "@/store/useAssistantStore"
import CostChip from "./CostChip"

/** While an agent works or an update is being written: the card moves on and the server's answer shows up live. */
const POLL_INTERVAL_MS = 5_000
/** While only a mission works: it takes a batch of repositories at a time, minutes each. */
const MISSION_POLL_INTERVAL_MS = 30_000

const tokensOf = (part: Pick<ConversationCostPart, "inputTokens" | "outputTokens">) => part.inputTokens + part.outputTokens

interface AgentRunCardProps {
    projectId: string
    job: AgentRuns["jobs"][number]
}

/** One agent Vega started: what it works on, where it stands, what it cost, and the way to its review. */
const AgentRunCard: React.FC<AgentRunCardProps> = ({ projectId, job }) => {
    const { t, i18n } = useTranslation()
    const stopped = Boolean(job.stoppedAt)
    const files = job.repositories.reduce((sum, repository) => sum + repository.files.length, 0)
    const cost = job.usage.cost ?? job.usage.costUsd
    const minutes = (seconds: number) => (seconds / 60).toLocaleString(i18n.language, { maximumFractionDigits: 1 })

    return (
        <li className="flex flex-col gap-1.5 rounded-md border border-divider p-3 text-sm" data-testid="assistant-agent-run">
            <div className="flex items-center gap-2">
                <Bot className="size-4 shrink-0 text-primary-strong" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{job.title || job.prompt.split("\n")[0]}</span>
                <Badge variant={stopped ? "outline" : job.status === "FAILED" ? "destructive" : job.status === "DONE" ? "accent" : "outline"}>
                    {t(stopped ? "assistant.jobs.status.STOPPED" : `assistant.jobs.status.${job.status}`)}
                </Badge>
            </div>
            <p className="text-xs text-foreground-secondary">
                {job.repositories.map(repository => repository.frontendName || repository.frontendSlug).join(", ")} · {t("assistant.jobs.files", { count: files })}
            </p>
            <div className="flex flex-wrap items-center gap-1 text-xs text-foreground-secondary" title={t("assistant.agent_runs.cost_hint")}>
                <Coins className="size-3" aria-hidden="true" />
                {t("assistant.agent_runs.tokens", { formatted: tokensOf(job.usage).toLocaleString(i18n.language) })} ·{" "}
                {t("assistant.agent_runs.sandbox", { exec: minutes(job.sandbox.execSeconds), lifetime: minutes(job.sandbox.lifetimeSeconds) })}
                {cost !== undefined && <CostChip amount={cost} currency={job.usage.currency ?? "USD"} dataTestId="assistant-agent-run-cost" />}
            </div>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                className="self-start"
                // The tab of its chain: the existing review, with the diff, the follow-ups and the apply.
                onClick={() => useAssistantJobsStore.getState().openJob(projectId, job, true)}
                dataTestId="assistant-agent-run-open"
            >
                {t(isAiJobActive(job.status) ? "assistant.agent_runs.follow" : "assistant.agent_runs.review")}
            </Button>
        </li>
    )
}

/** A mission Vega started: where it stands, how many repositories it is through, and the way to its page. */
const MissionCard: React.FC<{ mission: AssistantAgentMission }> = ({ mission }) => {
    const { t, i18n } = useTranslation()

    return (
        <li className="flex flex-col gap-1.5 rounded-md border border-divider p-3 text-sm" data-testid="assistant-agent-mission">
            <div className="flex items-center gap-2">
                <Ship className="size-4 shrink-0 text-primary-strong" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{mission.prompt.split("\n")[0]}</span>
                <Badge variant={mission.status === "FAILED" ? "destructive" : mission.status === "DONE" ? "accent" : "outline"}>{t(`fleet.status.${mission.status}`)}</Badge>
            </div>
            <p className="flex flex-wrap items-center gap-1 text-xs text-foreground-secondary">
                {t("assistant.agent_runs.mission_progress", { done: mission.done, total: mission.repositories })} ·
                <Coins className="size-3" aria-hidden="true" />
                {t("assistant.agent_runs.tokens", { formatted: tokensOf(mission.usage).toLocaleString(i18n.language) })}
            </p>
            <Button href={`/fleet/${mission._id}`} variant="secondary" size="sm" className="self-start" dataTestId="assistant-agent-mission-open">
                {t("assistant.agent_runs.open_mission")}
            </Button>
        </li>
    )
}

/** What the conversation cost: Vega's answers and its agents (tokens and sandbox time), apart and summed. */
const ConversationCost: React.FC<{ cost: AgentRuns["cost"]; sandbox: SandboxTotals }> = ({ cost, sandbox }) => {
    const { t, i18n } = useTranslation()
    const format = (value: number) => value.toLocaleString(i18n.language)
    const minutes = (seconds: number) => (seconds / 60).toLocaleString(i18n.language, { maximumFractionDigits: 1 })

    return (
        <p className="flex flex-wrap items-center gap-1 text-xs text-foreground-secondary" title={t("assistant.agent_runs.cost_hint")} data-testid="assistant-conversation-cost">
            <Coins className="size-3" aria-hidden="true" />
            <span className="font-medium">{t("assistant.agent_runs.cost_title")}:</span>
            {t("assistant.agent_runs.cost_split", { assistant: format(tokensOf(cost.assistant)), agents: format(tokensOf(cost.agents)) })} ·{" "}
            {t("assistant.agent_runs.sandbox", { exec: minutes(sandbox.execSeconds), lifetime: minutes(sandbox.lifetimeSeconds) })} ·{" "}
            {t("assistant.agent_runs.cost_total", { total: format(tokensOf(cost.total)) })}
            {cost.total.costs.map(total => (
                <CostChip key={total.currency} amount={total.amount} currency={total.currency} dataTestId="assistant-conversation-cost-amount" />
            ))}
        </p>
    )
}

interface AssistantAgentRunsProps {
    projectId: string
    isStreaming: boolean
}

/**
 * The agents Vega started in the open conversation, a card each, and what the conversation cost. Polled while
 * something of it is at work; an answer the server wrote meanwhile, when an agent ended, is brought into the chat.
 */
const AssistantAgentRuns: React.FC<AssistantAgentRunsProps> = ({ projectId, isStreaming }) => {
    const { t } = useTranslation()
    const assistantApi = useAssistantApi()
    const conversationId = useAssistantStore(state => state.conversationId)
    const messages = useAssistantStore(state => state.messages)
    // An expired card waits for nothing: it does not hold the server's messages back.
    const awaitingConfirmation = messages.some(message => isPendingConfirmation(message))

    const { data } = useQuery({
        queryKey: [AGENT_RUNS_QUERY_KEY, projectId, conversationId],
        queryFn: () => assistantApi.getAgentRuns(conversationId as string),
        enabled: Boolean(conversationId) && messages.length > 0,
        retry: false,
        refetchInterval: query => {
            const activity = query.state.data?.activity
            return activity === "agents" ? POLL_INTERVAL_MS : activity === "missions" ? MISSION_POLL_INTERVAL_MS : false
        }
    })

    // The server's messages the chat does not show yet, read again once nothing streams nor waits for the user.
    const missing = (data?.serverMessageIds ?? []).filter(id => !messages.some(message => message.id === id)).join(",")
    // biome-ignore lint/correctness/useExhaustiveDependencies: the api client is recreated every render; the missing ids are what trigger this.
    useEffect(() => {
        if (!conversationId || !missing || isStreaming || awaitingConfirmation) return
        assistantApi
            .getConversation(conversationId)
            .then(conversation => useAssistantStore.getState().adoptServerMessages(conversationId, conversation.messages))
            .catch(error => console.error("Could not read the conversation again", error))
    }, [conversationId, missing, isStreaming, awaitingConfirmation])

    if (!data || (data.jobs.length === 0 && data.missions.length === 0)) return null

    return (
        <section aria-label={t("assistant.agent_runs.title")} className="flex flex-col gap-2" data-testid="assistant-agent-runs">
            <h3 className="text-xs font-medium text-foreground-secondary">{t("assistant.agent_runs.title")}</h3>
            <ul className="flex flex-col gap-2">
                {data.jobs.map(job => (
                    <AgentRunCard key={job._id} projectId={projectId} job={job} />
                ))}
                {data.missions.map(mission => (
                    <MissionCard key={mission._id} mission={mission} />
                ))}
            </ul>
            <ConversationCost cost={data.cost} sandbox={data.cost.total.sandbox} />
        </section>
    )
}

export default AssistantAgentRuns
