import { createBusinessException } from "../../errors/BusinessException"
import { McpToolContext } from "../../mcp/toolDefinition"
import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest, { IAiChangeEvent, IAiChangeFile } from "../../models/AiChangeRequestModel"
import AiMission, { AiMissionStatus, IAiMission } from "../../models/AiMissionModel"
import AiUsage from "../../models/AiUsageModel"
import AssistantConversation from "../../models/AssistantConversationModel"
import SandboxUsage from "../../models/SandboxUsageModel"
import { AssistantConversationMessageDTO } from "../../types/AssistantDTO"
import { toObjectId } from "../../utils/mongooseUtils"
import { AiUsageCost, SandboxUsageTotals } from "../AiUsageService"
import { ACTIVE_JOB_STATUSES, fresh } from "../aiChange/aiJobRecords"
import { AiJobView } from "../aiChange/aiJobViews"
import { LlmUsage } from "../llm"
import { changedLines, unifiedDiff } from "./lineDiff"

/** Agents of one conversation at work at once: jobs queued or running, a running mission counting as its jobs at work. */
export const MAX_ACTIVE_AGENT_RUNS = 3
/** Follow-ups the assistant starts on one chain of jobs before the user says something again: an update turn cannot loop. */
export const MAX_AUTOMATIC_FOLLOW_UPS = 3
/** Agents (jobs, follow-ups and missions) the assistant starts in a conversation between two questions of the user. */
export const MAX_RUNS_PER_QUESTION = 6
/** A file's diff, when asked: it is sent again on every later round of the turn. */
export const MAX_DIFF_CHARS = 20_000
const MAX_LISTED_FILES = 100
const RECENT_EVENTS = 10
const RECENT_CHECKS = 10
const MAX_EVENT_CHARS = 300
const MAX_SUMMARY_CHARS = 4_000
const MAX_PROMPT_CHARS = 500

export const clip = (value: string | undefined, max: number) => (value && value.length > max ? `${value.slice(0, max)}…` : value)

/** The statuses of a job that is over: how it ended is final. */
export const ENDED_JOB_STATUSES = [AiJobStatus.DONE, AiJobStatus.FAILED]

const tooMany = (code: string, message: string) => createBusinessException({ code, message, statusCode: 429 })

const noUpdateStarts = () =>
    createBusinessException({
        code: "AGENT_RUN_NOT_IN_UPDATE",
        message: "Nobody is at the console in an update turn: do not start agents now. Tell the user what you propose and let them ask for it",
        statusCode: 409
    })

/** Refuses to start an agent in a turn the server runs on its own: it may read, follow up within its limits, or propose. */
export const ensureNotUpdateTurn = (context: McpToolContext) => {
    if (context.update) throw noUpdateStarts()
}

/** Since when the conversation's agents are counted: the user's last question, or the beginning. */
const sinceQuestion = async (conversationId: string) => {
    const conversation = await AssistantConversation.findById(conversationId, { askedAt: 1 }).lean()
    return conversation?.askedAt ? { createdAt: { $gt: conversation.askedAt } } : {}
}

export const noConversation = () => createBusinessException({ code: "AGENT_RUN_NO_CONVERSATION", message: "Agents can only be started and followed from a saved conversation", statusCode: 409 })

const notLinked = () => createBusinessException({ code: "AGENT_RUN_NOT_LINKED", message: "This agent run was not started in this conversation", statusCode: 404 })

/** The conversation of the call: the agents are linked to it, and only it drives them. */
export const conversationOf = (context: McpToolContext): string => {
    if (!context.conversationId) throw noConversation()
    return context.conversationId
}

/** The job, refused unless this conversation started it (or followed it up) in this project. */
export const linkedJob = async (context: McpToolContext, jobId: string): Promise<Pick<IAiChangeJob, "_id" | "rootJobId" | "status">> => {
    const conversationId = conversationOf(context)
    const job = await AiChangeJob.findOne({ _id: toObjectId(jobId), projectId: toObjectId(context.projectId), assistantConversationId: conversationId }, { _id: 1, rootJobId: 1, status: 1 }).lean()
    if (!job) throw notLinked()
    return job as Pick<IAiChangeJob, "_id" | "rootJobId" | "status">
}

/** The agents of the conversation at work: its jobs, and each running mission as its jobs at work, one at least. */
export const activeAgentRuns = async (conversationId: string): Promise<number> => {
    const [jobs, missions] = await Promise.all([
        AiChangeJob.countDocuments({ assistantConversationId: conversationId, status: { $in: ACTIVE_JOB_STATUSES }, updatedAt: fresh() }),
        AiMission.find({ assistantConversationId: conversationId, status: AiMissionStatus.RUNNING }, { _id: 1 }).lean()
    ])
    const missionJobs = await Promise.all(
        missions.map(async mission => Math.max(1, await AiChangeJob.countDocuments({ missionId: mission._id, status: { $in: ACTIVE_JOB_STATUSES }, updatedAt: fresh() })))
    )
    return jobs + missionJobs.reduce((sum, count) => sum + count, 0)
}

/**
 * Refuses another agent once the conversation has as many at work as it may, or the assistant started as many as
 * it may since the user last asked something (jobs, follow-ups and missions together).
 */
export const ensureRoomForAgentRun = async (conversationId: string): Promise<void> => {
    if ((await activeAgentRuns(conversationId)) >= MAX_ACTIVE_AGENT_RUNS) {
        throw tooMany("AGENT_RUN_TOO_MANY", `At most ${MAX_ACTIVE_AGENT_RUNS} agents work at once for one conversation: wait for one to end (agent_run_wait) or stop one`)
    }
    const since = await sinceQuestion(conversationId)
    const [jobs, missions] = await Promise.all([
        AiChangeJob.countDocuments({ assistantConversationId: conversationId, ...since }),
        AiMission.countDocuments({ assistantConversationId: conversationId, ...since })
    ])
    if (jobs + missions >= MAX_RUNS_PER_QUESTION) {
        throw tooMany("AGENT_RUN_TOO_MANY_STARTED", `${MAX_RUNS_PER_QUESTION} agents were started since the user last wrote: tell the user where things stand and ask before starting more`)
    }
}

/** Refuses a follow-up once the assistant started as many on the chain since the user last asked something. */
export const ensureFollowUpAllowed = async (conversationId: string, rootJobId: IAiChangeJob["rootJobId"]): Promise<void> => {
    const followUps = await AiChangeJob.countDocuments({ rootJobId, assistantConversationId: conversationId, parentJobId: { $exists: true }, ...(await sinceQuestion(conversationId)) })
    if (followUps >= MAX_AUTOMATIC_FOLLOW_UPS) {
        throw tooMany(
            "AGENT_RUN_TOO_MANY_FOLLOW_UPS",
            `${MAX_AUTOMATIC_FOLLOW_UPS} follow-ups of this job were started since the user last wrote: tell the user where it stands and ask before going on`
        )
    }
}

/**
 * Marks an ended job as heard of by its conversation: the supervisor read how it ended, so no update turn is run
 * for it. Claimed once: only the first marking counts.
 */
export const markJobNotified = async (jobId: IAiChangeJob["_id"]): Promise<boolean> => {
    const { modifiedCount } = await AiChangeJob.updateOne({ _id: jobId, status: { $in: ENDED_JOB_STATUSES }, assistantNotifiedAt: { $exists: false } }, { $set: { assistantNotifiedAt: new Date() } })
    return modifiedCount > 0
}

export const markMissionNotified = async (missionId: IAiMission["_id"]): Promise<boolean> => {
    const { modifiedCount } = await AiMission.updateOne(
        { _id: missionId, status: { $ne: AiMissionStatus.RUNNING }, assistantNotifiedAt: { $exists: false } },
        { $set: { assistantNotifiedAt: new Date() } }
    )
    return modifiedCount > 0
}

/** Gives a claim back, when telling of the end failed: the next run tells of it. */
export const unmarkJobNotified = async (jobId: IAiChangeJob["_id"]): Promise<void> => {
    await AiChangeJob.updateOne({ _id: jobId }, { $unset: { assistantNotifiedAt: 1 } })
}

export const unmarkMissionNotified = async (missionId: IAiMission["_id"]): Promise<void> => {
    await AiMission.updateOne({ _id: missionId }, { $unset: { assistantNotifiedAt: 1 } })
}

const NO_SANDBOX: SandboxUsageTotals = { commands: 0, execSeconds: 0, lifetimeSeconds: 0 }

/** The sandbox time of each job: the commands it ran, how long they ran, how long its sandboxes lived. */
export const sandboxByJob = async (jobIds: unknown[]): Promise<Map<string, SandboxUsageTotals>> => {
    if (jobIds.length === 0) return new Map()
    const groups = await SandboxUsage.aggregate<SandboxUsageTotals & { _id: unknown }>([
        { $match: { jobId: { $in: jobIds } } },
        { $group: { _id: "$jobId", commands: { $sum: "$commands" }, execSeconds: { $sum: "$execSeconds" }, lifetimeSeconds: { $sum: "$lifetimeSeconds" } } }
    ])
    return new Map(groups.map(({ _id, commands, execSeconds, lifetimeSeconds }) => [String(_id), { commands, execSeconds, lifetimeSeconds }]))
}

const addSandbox = (a: SandboxUsageTotals, b: SandboxUsageTotals): SandboxUsageTotals => ({
    commands: a.commands + b.commands,
    execSeconds: a.execSeconds + b.execSeconds,
    lifetimeSeconds: a.lifetimeSeconds + b.lifetimeSeconds
})

/** The commands the agent ran and how each ended, read from its progress lines: the check before finishing among them. */
const checksOf = (events: Pick<IAiChangeEvent, "kind" | "message">[]) => {
    const checks: { command: string; exitCode?: number }[] = []
    let command: string | undefined
    for (const entry of events) {
        if (entry.kind === "tool") command = /^run_(script|command)\b/.test(entry.message) ? entry.message : undefined
        if (entry.kind === "output" && command) {
            const exitCode = /exit code (-?\d+)/.exec(entry.message)?.[1]
            checks.push({ command: clip(command, 160) ?? "", ...(exitCode === undefined ? {} : { exitCode: Number(exitCode) }) })
            command = undefined
        }
    }
    return checks.slice(-RECENT_CHECKS)
}

/** One file of a proposal, with the lines it adds and removes; unknown when the original was too large to keep. */
const fileLines = (file: { action: string; originalContent?: string; proposedContent?: string }): { added?: number; removed?: number } => {
    if (file.action === "update" && file.originalContent === undefined) return {}
    return changedLines(file.action === "create" ? undefined : file.originalContent, file.action === "delete" ? undefined : file.proposedContent)
}

/**
 * A job as its supervisor reads it: where it stands, its latest steps and the commands it ran, per repository the
 * files it changed with their line counts, and what it spent. The diff of one file only when `path` asks for it,
 * cut at {@link MAX_DIFF_CHARS}.
 */
export const describeAgentRun = async (view: AiJobView, diffOf?: { path: string; repositoryId?: string }) => {
    const requests = (await AiChangeRequest.find(
        { jobId: toObjectId(view._id) },
        { "files.path": 1, "files.action": 1, "files.originalContent": 1, "files.proposedContent": 1 }
    ).lean()) as unknown as {
        _id: unknown
        files?: Pick<IAiChangeFile, "path" | "action" | "originalContent" | "proposedContent">[]
    }[]
    const sandbox = (await sandboxByJob([toObjectId(view._id)])).get(view._id) ?? NO_SANDBOX
    const events = view.events ?? []
    let diff: { repositoryId: string; path: string; diff: string; truncated: boolean } | undefined

    const repositories = view.repositories.map(repository => {
        const request = requests.find(candidate => String(candidate._id) === repository.requestId)
        const files = (request?.files ?? []).map(file => ({ path: file.path, action: file.action, ...fileLines(file) }))
        if (diffOf && !diff && (!diffOf.repositoryId || diffOf.repositoryId === repository.frontendId)) {
            const file = request?.files?.find(candidate => candidate.path === diffOf.path)
            if (file) {
                diff = {
                    repositoryId: repository.frontendId,
                    path: file.path,
                    ...unifiedDiff(file.path, file.action === "create" ? undefined : file.originalContent, file.action === "delete" ? undefined : file.proposedContent, MAX_DIFF_CHARS)
                }
            }
        }
        return {
            kind: repository.kind,
            id: repository.frontendId,
            name: repository.frontendName,
            status: repository.status,
            baseBranch: repository.baseBranch,
            branch: repository.branch,
            pullRequestUrl: repository.pullRequestUrl,
            pullRequestError: repository.pullRequestError,
            pushError: repository.pushError,
            error: repository.error,
            filesChanged: files.length,
            linesAdded: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
            linesRemoved: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
            files: files.slice(0, MAX_LISTED_FILES),
            ...(files.length > MAX_LISTED_FILES ? { moreFiles: files.length - MAX_LISTED_FILES } : {})
        }
    })

    return {
        jobId: view._id,
        rootJobId: view.rootJobId,
        parentJobId: view.parentJobId,
        status: view.status,
        title: view.title,
        prompt: clip(view.prompt, MAX_PROMPT_CHARS),
        summary: clip(view.summary, MAX_SUMMARY_CHARS),
        error: view.error,
        startedAt: view.startedAt,
        finishedAt: view.finishedAt,
        repositories,
        checks: checksOf(events),
        recentEvents: events
            .filter(entry => entry.kind !== "thinking" && entry.kind !== "output")
            .slice(-RECENT_EVENTS)
            .map(entry => ({ at: entry.at, kind: entry.kind, message: clip(entry.message, MAX_EVENT_CHARS) })),
        usage: view.usage,
        sandbox,
        ...(diffOf ? { diff: diff ?? { path: diffOf.path, error: "No file with this path in the proposals of this job" } } : {})
    }
}

/** Tokens, and what they cost per currency: rates may be set in more than one currency. */
export interface AgentRunCostPart extends LlmUsage {
    costs: AiUsageCost[]
}

/** What a conversation cost: the assistant's answers, the agents it started (tokens and sandbox), and both summed. */
export interface ConversationCost {
    assistant: AgentRunCostPart
    agents: AgentRunCostPart & { sandbox: SandboxUsageTotals }
    total: AgentRunCostPart & { sandbox: SandboxUsageTotals }
}

const NO_COST: AgentRunCostPart = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costs: [] }

const addCosts = (a: AiUsageCost[], b: AiUsageCost[]): AiUsageCost[] => {
    const byCurrency = new Map<string, number>()
    for (const cost of [...a, ...b]) byCurrency.set(cost.currency, (byCurrency.get(cost.currency) ?? 0) + cost.amount)
    return [...byCurrency].map(([currency, amount]) => ({ currency: currency as AiUsageCost["currency"], amount }))
}

const addParts = (a: AgentRunCostPart, b: AgentRunCostPart): AgentRunCostPart => ({
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costs: addCosts(a.costs, b.costs)
})

/** The answers of the conversation as saved: each carries what it cost. */
const assistantCostOf = (messages: Pick<AssistantConversationMessageDTO, "usage">[]): AgentRunCostPart =>
    messages.reduce(
        (sum, { usage }) =>
            usage
                ? addParts(sum, {
                      inputTokens: usage.inputTokens ?? 0,
                      cachedInputTokens: usage.cachedInputTokens ?? 0,
                      outputTokens: usage.outputTokens ?? 0,
                      costs: typeof usage.cost === "number" ? [{ amount: usage.cost, currency: usage.currency ?? "USD" }] : []
                  })
                : sum,
        NO_COST
    )

/**
 * Every job the conversation started, its follow-ups and the jobs of its missions included: their tokens read from
 * the AI usage ledger and their sandbox time from the sandbox ledger, both of which outlive the jobs.
 */
export const conversationCost = async (conversationId: string, messages: Pick<AssistantConversationMessageDTO, "usage">[]): Promise<ConversationCost> => {
    const missions = await AiMission.find({ assistantConversationId: conversationId }, { _id: 1 }).lean()
    const jobs = await AiChangeJob.find(
        { $or: [{ assistantConversationId: conversationId }, ...(missions.length ? [{ missionId: { $in: missions.map(mission => mission._id) } }] : [])] },
        { _id: 1 }
    ).lean()
    const jobIds = jobs.map(job => job._id)
    const [usage, sandboxes] = await Promise.all([
        jobIds.length
            ? AiUsage.aggregate<LlmUsage & { _id: string | null; cost: number }>([
                  { $match: { jobId: { $in: jobIds } } },
                  {
                      $group: {
                          _id: "$currency",
                          inputTokens: { $sum: "$inputTokens" },
                          cachedInputTokens: { $sum: "$cachedInputTokens" },
                          outputTokens: { $sum: "$outputTokens" },
                          cost: { $sum: "$cost" }
                      }
                  }
              ])
            : [],
        sandboxByJob(jobIds)
    ])
    const agentTokens = usage.reduce<AgentRunCostPart>(
        (sum, group) =>
            addParts(sum, {
                inputTokens: group.inputTokens,
                cachedInputTokens: group.cachedInputTokens,
                outputTokens: group.outputTokens,
                costs: group._id && group.cost > 0 ? [{ amount: group.cost, currency: group._id as AiUsageCost["currency"] }] : []
            }),
        NO_COST
    )
    const sandbox = [...sandboxes.values()].reduce(addSandbox, NO_SANDBOX)
    const assistant = assistantCostOf(messages)
    return { assistant, agents: { ...agentTokens, sandbox }, total: { ...addParts(assistant, agentTokens), sandbox } }
}
