import { randomBytes } from "node:crypto"
import { FastifyBaseLogger } from "fastify"
import { fastify } from "../.."
import AiChangeJob, { IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest from "../../models/AiChangeRequestModel"
import AiMission, { AiMissionStatus, IAiMission } from "../../models/AiMissionModel"
import AssistantConversation, { IAssistantConversation } from "../../models/AssistantConversationModel"
import AssistantUsage from "../../models/AssistantUsageModel"
import User, { IUser } from "../../models/UserModel"
import { AssistantChatMessageDTO, AssistantConversationMessageDTO } from "../../types/AssistantDTO"
import { toObjectId } from "../../utils/mongooseUtils"
import { calculateAiUsageCost, ensureWithinTokenLimit, recordAiUsage } from "../AiUsageService"
import { loggable, onAiJobEnded, onAiMissionEnded, STALE_AFTER_MS } from "../aiChange/aiChangeShared"
import { ACTIVE_JOB_STATUSES, failIfStale, fresh } from "../aiChange/aiJobRecords"
import { addUsage, LLM_EFFORTS, LlmConfiguration, LlmEffort, LlmUsage, NO_USAGE } from "../llm"
import AssistantService, { AssistantChatOutcome, AssistantSpentOn } from "./AssistantService"
import { ENDED_JOB_STATUSES, markJobNotified, markMissionNotified, unmarkJobNotified, unmarkMissionNotified } from "./agentRuns"
import { appendMessages, claimServerTurn, countUpdateTurn, holdTurn, MAX_STORED_MESSAGES, MAX_TURN_MS, releaseTurn } from "./conversations"
import { hasPendingAction } from "./pendingActions"

/** As the browser sends it: the whole conversation travels with every turn, each message bounded. */
const MAX_HISTORY_CHARS = 8_000
/** Notes one run answers at most, agents ending while the last answer was written: the next run takes the rest. */
export const MAX_UPDATE_ROUNDS = 3
/** Update turns between two questions of the user: past them only the notes are added, the user decides what next. */
export const MAX_UPDATE_TURNS = 5
/** Conversations the sweep updates at once: each is a turn of a paid model. */
const SWEEP_CONCURRENCY = 3
/** The most an update turn reasons: nobody waits for it, and it reviews more than it builds. */
const MAX_UPDATE_EFFORT: LlmEffort = "high"

const messageId = (kind: string) => `${kind}-${Date.now()}-${randomBytes(4).toString("hex")}`

const endedJobsOf = (conversationId: string) => ({ assistantConversationId: conversationId, status: { $in: ENDED_JOB_STATUSES }, assistantNotifiedAt: { $exists: false } })
const endedMissionsOf = (conversationId: string) => ({ assistantConversationId: conversationId, status: { $ne: AiMissionStatus.RUNNING }, assistantNotifiedAt: { $exists: false } })

/** Put between a question nobody answered and the note after it: the update turn must not take the question up. */
export const NOT_ANSWERED = "(Not answered: the user did not get an answer to this, do not act on it.)"

/**
 * The conversation as the model reads it, as the browser builds it: plain text, failed answers left out, messages of
 * the same side joined, the latest ones only, opening with a user message. A note of the server never joins a
 * question of the user: a question left without an answer (failed, refused while busy, stopped empty) gets
 * {@link NOT_ANSWERED} after it, so the turn answering the note does not run what the user once asked.
 */
export const historyOf = (messages: AssistantConversationMessageDTO[]): AssistantChatMessageDTO[] => {
    const history: (AssistantChatMessageDTO & { note?: boolean })[] = []
    for (const message of messages) {
        if (message.status === "error" || !message.content) continue
        const content = message.content.slice(0, MAX_HISTORY_CHARS)
        const note = message.kind === "agent_update"
        const previous = history[history.length - 1]
        if (note && previous?.role === "user" && !previous.note) history.push({ role: "assistant", content: NOT_ANSWERED })
        const last = history[history.length - 1]
        if (last?.role === message.role) {
            last.content = `${last.content}\n\n${content}`.slice(0, MAX_HISTORY_CHARS)
            // A question joining a note is the user's: what follows answers it.
            if (!note) last.note = false
        } else history.push({ role: message.role, content, ...(note ? { note } : {}) })
    }
    const trimmed = history.slice(-MAX_STORED_MESSAGES)
    while (trimmed[0]?.role === "assistant") trimmed.shift()
    return trimmed.map(({ role, content }) => ({ role, content }))
}

type EndedJob = Pick<IAiChangeJob, "_id" | "status" | "stoppedAt" | "frontendIds" | "backendIds"> & { filesChanged?: number }
type EndedMission = Pick<IAiMission, "_id" | "status" | "repositories">

/** No tag can be opened or closed from what goes into the note. */
const untagged = (value: unknown) => String(value).replace(/[<>]/g, "")

/**
 * The note of the server: which agents ended, how, and how much they changed. Ids, statuses and counts only: what the
 * agents wrote (summaries, errors) is read with agent_run_status, as data.
 */
export const describeEnded = (jobs: EndedJob[], missions: EndedMission[]): string => {
    const lines = [
        ...jobs.map(job => {
            const outcome = job.stoppedAt ? "stopped" : job.status
            const repositories = (job.frontendIds?.length ?? 0) + (job.backendIds?.length ?? 0)
            return `- agent run ${untagged(job._id)}: ${untagged(outcome)}, ${repositories} repositories, ${job.filesChanged ?? 0} files changed`
        }),
        ...missions.map(mission => `- mission ${untagged(mission._id)}: ${untagged(mission.status)}, ${mission.repositories?.length ?? 0} repositories`)
    ]
    return [
        "<agent_update>",
        "Agents started in this conversation ended:",
        ...lines,
        "Read each run with agent_run_status before telling the user what happened and what you propose.",
        "</agent_update>"
    ].join("\n")
}

/** Whether agents of the conversation ended that it has not heard of: checked before taking the conversation. */
const hasEndedWork = async (conversationId: string) => Boolean((await AiChangeJob.exists(endedJobsOf(conversationId))) || (await AiMission.exists(endedMissionsOf(conversationId))))

/**
 * What of the conversation is still to come: `agents` while a job of it works or an update has not run yet, `missions`
 * while only a mission works (slow to move on), `none` otherwise. The panel polls by it.
 */
export const conversationActivity = async (conversationId: string): Promise<"agents" | "missions" | "none"> => {
    if ((await AiChangeJob.exists({ assistantConversationId: conversationId, status: { $in: ACTIVE_JOB_STATUSES }, updatedAt: fresh() })) || (await hasEndedWork(conversationId))) return "agents"
    return (await AiMission.exists({ assistantConversationId: conversationId, status: AiMissionStatus.RUNNING })) ? "missions" : "none"
}

/** The ended agents the conversation has not heard of, each claimed: whichever replica runs, one note tells of it. */
const claimEnded = async (conversationId: string): Promise<{ jobs: EndedJob[]; missions: EndedMission[] }> => {
    const [jobs, missions] = await Promise.all([
        AiChangeJob.find(endedJobsOf(conversationId), { status: 1, stoppedAt: 1, frontendIds: 1, backendIds: 1 }).sort({ createdAt: 1 }).lean(),
        AiMission.find(endedMissionsOf(conversationId), { status: 1, "repositories.id": 1 }).sort({ createdAt: 1 }).lean()
    ])
    const claimedJobs: EndedJob[] = []
    for (const job of jobs) if (await markJobNotified(job._id)) claimedJobs.push(job as EndedJob)
    const claimedMissions: EndedMission[] = []
    for (const mission of missions) if (await markMissionNotified(mission._id)) claimedMissions.push(mission as EndedMission)
    if (claimedJobs.length) {
        const requests = (await AiChangeRequest.find({ jobId: { $in: claimedJobs.map(job => job._id) } }, { jobId: 1, "files.path": 1 }).lean()) as { jobId?: unknown; files?: unknown[] }[]
        for (const job of claimedJobs) {
            job.filesChanged = requests.filter(request => String(request.jobId) === String(job._id)).reduce((sum, request) => sum + (request.files?.length ?? 0), 0)
        }
    }
    return { jobs: claimedJobs, missions: claimedMissions }
}

/** The AI of the user's last question when the project may still use it, else the project's default. */
const aiModelOf = async (service: AssistantService, projectId: string, aiModelId?: string) =>
    aiModelId
        ? service.ensureCanChat(projectId, aiModelId).then(
              () => aiModelId,
              () => undefined
          )
        : undefined

/** The effort of the last answer, never above {@link MAX_UPDATE_EFFORT}. */
const effortOf = (messages: AssistantConversationMessageDTO[]): LlmEffort | undefined => {
    const effort = [...messages].reverse().find(message => message.role === "assistant" && message.effort)?.effort
    return effort && LLM_EFFORTS.indexOf(effort) > LLM_EFFORTS.indexOf(MAX_UPDATE_EFFORT) ? MAX_UPDATE_EFFORT : effort
}

/**
 * Runs one assistant turn answering the note, as the conversation's user with their permissions and limits, and
 * saves the answer as the browser would. Nothing is confirmed: an action needing it is parked with a card that waits
 * for the user. Returns false when the turn could not run.
 */
const answerUpdate = async (
    conversation: Pick<IAssistantConversation, "_id" | "userId" | "projectId" | "messages" | "aiModelId">,
    config: LlmConfiguration,
    log: FastifyBaseLogger,
    signal: AbortSignal
): Promise<boolean> => {
    const user = await User.findById(conversation.userId).lean()
    if (!user) return false
    const projectId = String(conversation.projectId)
    try {
        await ensureWithinTokenLimit(projectId, user._id)
    } catch (error) {
        // The note stays: the user reads it, and the next question tells them about the limit.
        log.info({ error: loggable(error), projectId, conversationId: conversation._id }, "Assistant update turn not run")
        return false
    }

    const service = new AssistantService(user as unknown as IUser, config, log)
    const effort = effortOf(conversation.messages)
    const aiModelId = await aiModelOf(service, projectId, conversation.aiModelId)
    const answer: AssistantConversationMessageDTO & { tools: NonNullable<AssistantConversationMessageDTO["tools"]> } = {
        id: messageId("update-answer"),
        role: "assistant",
        content: "",
        status: "done",
        effort,
        tools: []
    }
    let thinking = ""
    let spent: { usage: LlmUsage; spentOn?: AssistantSpentOn } = { usage: NO_USAGE }
    const toolOf = (id: string) => [...answer.tools].reverse().find(tool => tool.id === id)
    let outcome: AssistantChatOutcome | undefined
    try {
        outcome = await service.chat(
            projectId,
            { messages: historyOf(conversation.messages), effort, aiModelId, conversationId: conversation._id, context: { update: true } },
            {
                onText: delta => {
                    answer.content += delta
                },
                onThinking: delta => {
                    thinking += delta
                },
                onToolCall: ({ id, name, title, kind }) => void answer.tools.push({ id, name, title, kind, status: "running" }),
                onToolResult: ({ id, ok, summary }) => {
                    const tool = toolOf(id)
                    if (tool) Object.assign(tool, { status: ok ? "ok" : "error", summary })
                },
                onConfirm: ({ actionId, callId, name, title, details, expiresAt }) => {
                    answer.confirmation = { actionId, callId, name, title, details, expiresAt, status: "pending" }
                    const tool = toolOf(callId)
                    if (tool) tool.status = "awaiting_confirmation"
                },
                onUsage: (usage, spentOn) => {
                    spent = { usage: addUsage(spent.usage, usage), spentOn }
                }
            },
            AbortSignal.any([signal, AbortSignal.timeout(MAX_TURN_MS)])
        )
        if (outcome.stopReason === "refusal") Object.assign(answer, { status: "error", errorKey: "refusal" })
        else if (outcome.stopReason === "max_tokens" || outcome.stopReason === "max_tool_rounds") answer.errorKey = "incomplete"
    } catch (error) {
        log.error({ error: loggable(error), projectId, conversationId: conversation._id }, "Assistant update turn failed")
        Object.assign(answer, { status: "error", errorKey: "generic" })
    }

    // What the rounds spent, the turn failing midway too: priced, shown under the answer and counted as any answer.
    const spentOn = outcome ?? spent.spentOn
    const usage = outcome?.usage ?? spent.usage
    const cost = spentOn ? await calculateAiUsageCost(spentOn.aiModelId, usage).catch(() => undefined) : undefined
    if (spentOn) answer.usage = { ...usage, ...(cost ? { cost: cost.amount, currency: cost.currency } : {}) }
    if (thinking) answer.thinking = thinking
    // The lease lost, another turn may be writing the conversation: the failed answer is not added after it. What the
    // rounds spent still counts, below.
    if (!signal.aborted) await appendMessages(conversation._id, [answer])

    if (spentOn) {
        const { aiModelId, provider, effort: spentEffort } = spentOn
        const priced = cost ? { cost: cost.amount, currency: cost.currency } : {}
        log.info(
            { audit: "assistant_usage", update: true, userId: String(user._id), projectId, stopReason: outcome?.stopReason, effort: spentEffort, aiModelId, provider, ...priced, ...usage },
            "Assistant answer usage"
        )
        if (outcome) {
            await AssistantUsage.create({ userId: user._id, projectId: toObjectId(projectId), provider, aiModelId, stopReason: outcome.stopReason, effort: spentEffort, ...priced, ...usage }).catch(
                error => log.error({ error: loggable(error), projectId }, "Assistant usage not saved")
            )
        }
        await recordAiUsage({ userId: user._id, projectId, source: "assistant", aiModelId, provider, effort: spentEffort, ...priced, ...usage }).catch(error =>
            log.error({ error: loggable(error), projectId }, "Assistant usage not recorded")
        )
    }
    return outcome !== undefined
}

/**
 * Tells the conversation about its agents that ended: a note in the conversation, then a turn of the assistant
 * answering it, saved like any other, so the supervisor evaluates the outcome while the chat is closed.
 *
 * Never two turns of one conversation at once: the run takes the conversation's lease, renewed while it runs and
 * again before each round; losing it stops the turn. It leaves when a turn holds the conversation: the browser's save
 * after that turn runs this again, and the sweep of the server catches whatever was left. Only the note is added while
 * an action of the conversation waits for the user (read from the store of pending actions, not from the saved
 * conversation, which may not show it yet), and once {@link MAX_UPDATE_TURNS} ran since the user last asked.
 */
export const runAgentUpdates = async (conversationId: string, config: LlmConfiguration, log: FastifyBaseLogger = fastify.log): Promise<void> => {
    if (!(await hasEndedWork(conversationId))) return
    const lease = await claimServerTurn(conversationId)
    if (!lease) {
        // Deleted: nobody reads it any more, and the sweep must not come back to it.
        if (!(await AssistantConversation.exists({ _id: conversationId, deletedAt: null }))) await claimEnded(conversationId)
        return
    }
    const lost = new AbortController()
    const held = holdTurn(conversationId, lease, () => lost.abort())
    try {
        for (let round = 0; round < MAX_UPDATE_ROUNDS; round++) {
            if (round > 0 && !(await held.renew())) return
            const { jobs, missions } = await claimEnded(conversationId)
            if (jobs.length + missions.length === 0) return
            // Claimed first, so that one replica tells of them; given back when the note could not be added, for the next run.
            await appendMessages(conversationId, [{ id: messageId("update"), role: "user", kind: "agent_update", content: describeEnded(jobs, missions) }]).catch(async error => {
                await Promise.all([...jobs.map(job => unmarkJobNotified(job._id)), ...missions.map(mission => unmarkMissionNotified(mission._id))])
                throw error
            })
            const conversation = await AssistantConversation.findOne({ _id: conversationId, deletedAt: null }, { userId: 1, projectId: 1, messages: 1, aiModelId: 1 }).lean()
            if (!conversation) return
            if (await hasPendingAction(String(conversation.userId), String(conversation.projectId), conversationId)) return
            if (!(await countUpdateTurn(conversationId, MAX_UPDATE_TURNS))) return
            if (!(await answerUpdate(conversation, config, log, lost.signal))) return
        }
    } finally {
        held.stop()
        await releaseTurn(conversationId, held.lease()).catch(error => log.warn({ error: loggable(error), conversationId }, "Assistant conversation not released"))
    }
}

/**
 * Catches what the listeners missed: the agents of a conversation that died with their process are failed, and every
 * conversation with ended agents it has not heard of gets its update, {@link SWEEP_CONCURRENCY} at a time. Detached:
 * a turn takes a while, the sweep of the missions does not wait for it.
 */
export const sweepAgentUpdates = async (config: LlmConfiguration): Promise<void> => {
    const stale = await AiChangeJob.find(
        { assistantConversationId: { $exists: true }, status: { $in: ACTIVE_JOB_STATUSES }, updatedAt: { $lte: new Date(Date.now() - STALE_AFTER_MS) } },
        { status: 1, updatedAt: 1 }
    )
    for (const job of stale) await failIfStale(job)
    const queue = [
        ...new Set(
            [
                ...(await AiChangeJob.distinct("assistantConversationId", {
                    assistantConversationId: { $exists: true },
                    status: { $in: ENDED_JOB_STATUSES },
                    assistantNotifiedAt: { $exists: false }
                })),
                ...(await AiMission.distinct("assistantConversationId", {
                    assistantConversationId: { $exists: true },
                    status: { $ne: AiMissionStatus.RUNNING },
                    assistantNotifiedAt: { $exists: false }
                }))
            ].map(String)
        )
    ]
    const worker = async () => {
        for (let conversationId = queue.shift(); conversationId; conversationId = queue.shift()) {
            await runAgentUpdates(conversationId, config).catch(error => fastify.log.error({ error: loggable(error), conversationId }, "Assistant update failed"))
        }
    }
    void Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, queue.length) }, worker))
}

const updateDetached = (conversationId: string, config: LlmConfiguration) =>
    void runAgentUpdates(conversationId, config).catch(error => fastify.log.error({ error: loggable(error), conversationId }, "Assistant update failed"))

// A job of a conversation ended: the conversation hears of it. A mission's jobs are told by the mission, once it ends.
onAiJobEnded("assistant", async (job, { config }) => {
    if (job.missionId) return
    const ended = await AiChangeJob.findById(job._id, { assistantConversationId: 1 }).lean()
    if (ended?.assistantConversationId) updateDetached(ended.assistantConversationId, config)
})

// Told by whoever ended the mission, whatever order the jobs' listeners run in.
onAiMissionEnded("assistant", async (mission, { config }) => {
    if (mission.assistantConversationId) updateDetached(mission.assistantConversationId, config)
})
