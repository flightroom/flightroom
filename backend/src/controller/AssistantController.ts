import { FastifyInstance, FastifyRequest } from "fastify"
import { createBusinessException } from "../errors/BusinessException"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import AiMission from "../models/AiMissionModel"
import AssistantUsage from "../models/AssistantUsageModel"
import { calculateAiUsageCost, ensureWithinTokenLimit, recordAiUsage } from "../service/AiUsageService"
import AiChangeJobService from "../service/aiChange/AiChangeJobService"
import AiMissionService from "../service/aiChange/AiMissionService"
import AssistantService, { AssistantSpentOn } from "../service/assistant/AssistantService"
import { conversationCost, sandboxByJob } from "../service/assistant/agentRuns"
import { conversationActivity, runAgentUpdates } from "../service/assistant/agentUpdates"
import { claimTurn, conversationForRuns, deleteConversation, getConversation, holdTurn, listConversations, MAX_TURN_MS, releaseTurn, saveConversation } from "../service/assistant/conversations"
import { addUsage, isRateLimitError, LLM_EFFORTS, LlmEffort, LlmProvider, LlmUsage, NO_USAGE } from "../service/llm"
import { AssistantChatRequestDTO, AssistantConversationSaveDTO, AssistantProjectDraftRequestDTO } from "../types/AssistantDTO"
import AuthenticationMethod from "../types/AuthenticationMethod"
import { openEventStream, sendEvent } from "../utils/eventStream"
import { toObjectId } from "../utils/mongooseUtils"
import { getProjectIdFromRequest } from "../utils/requestUtils"

/** Bounds on what the browser may send: the whole conversation travels on every question. */
const MAX_MESSAGES = 40
const MAX_MESSAGE_CHARS = 8_000
const HEARTBEAT = ": ping\n\n"
/** An id of the organization's AIs, or `system`. */
const AI_MODEL_ID = { type: "string", minLength: 1, maxLength: 64 }
const HEARTBEAT_INTERVAL_MS = 15_000
/** The missions of a conversation shown, newest first. */
const MAX_MISSION_CARDS = 10
/** The id the browser names a conversation with. */
const CONVERSATION_ID = { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" }

const chatBodySchema = {
    type: "object",
    // Every turn belongs to a saved conversation: it takes the conversation's lease, so no two turns of it overlap.
    required: ["messages", "conversationId"],
    additionalProperties: false,
    properties: {
        messages: {
            type: "array",
            minItems: 1,
            maxItems: MAX_MESSAGES,
            items: {
                type: "object",
                required: ["role", "content"],
                additionalProperties: false,
                properties: {
                    role: { type: "string", enum: ["user", "assistant"] },
                    content: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS }
                }
            }
        },
        effort: { type: "string", enum: LLM_EFFORTS },
        aiModelId: AI_MODEL_ID,
        conversationId: CONVERSATION_ID,
        context: {
            type: "object",
            additionalProperties: false,
            properties: {
                page: { type: "string", maxLength: 500 },
                environmentId: { type: "string", maxLength: 100 },
                locale: { type: "string", maxLength: 20 },
                timeZone: { type: "string", maxLength: 64 },
                voice: { type: "boolean" }
            }
        },
        confirmation: {
            type: "object",
            required: ["actionId", "approved"],
            additionalProperties: false,
            properties: {
                actionId: { type: "string", minLength: 1, maxLength: 100 },
                approved: { type: "boolean" }
            }
        }
    }
}

const draftBodySchema = {
    type: "object",
    required: ["organizationId", "messages"],
    additionalProperties: false,
    properties: {
        organizationId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
        messages: chatBodySchema.properties.messages,
        locale: { type: "string", maxLength: 20 },
        aiModelId: AI_MODEL_ID
    }
}

// Lengths are not bounded here: an oversized field is clipped when stored (see conversations.ts),
// as rejecting it would stop the conversation from being saved for good. The body limit caps the whole.
const CONVERSATION_BODY_LIMIT = 4 * 1024 * 1024
const SHORT_STRING = { type: "string", maxLength: 200 }

const conversationParamsSchema = {
    type: "object",
    required: ["conversationId"],
    properties: { conversationId: CONVERSATION_ID }
}

const conversationBodySchema = {
    type: "object",
    required: ["messages"],
    additionalProperties: false,
    properties: {
        messages: {
            type: "array",
            minItems: 1,
            maxItems: MAX_MESSAGES,
            items: {
                type: "object",
                required: ["id", "role", "content"],
                properties: {
                    id: { type: "string", minLength: 1, maxLength: 100 },
                    role: { type: "string", enum: ["user", "assistant"] },
                    content: { type: "string" },
                    origin: { type: "string", enum: ["server"] },
                    kind: { type: "string", enum: ["agent_update"] },
                    thinking: { type: "string" },
                    effort: SHORT_STRING,
                    status: { type: "string", enum: ["streaming", "done", "error"] },
                    errorKey: SHORT_STRING,
                    tools: {
                        type: "array",
                        items: {
                            type: "object",
                            required: ["id", "name", "title", "kind", "status"],
                            properties: { id: SHORT_STRING, name: SHORT_STRING, title: SHORT_STRING, kind: SHORT_STRING, status: SHORT_STRING, summary: { type: "string" } }
                        }
                    },
                    confirmation: {
                        type: "object",
                        required: ["actionId", "callId", "name", "title", "details", "expiresAt", "status"],
                        properties: {
                            actionId: SHORT_STRING,
                            callId: SHORT_STRING,
                            name: SHORT_STRING,
                            title: SHORT_STRING,
                            details: {
                                type: "array",
                                items: {
                                    type: "object",
                                    required: ["label", "value"],
                                    properties: {
                                        label: SHORT_STRING,
                                        value: { type: "string" },
                                        lines: { type: "array", items: { type: "object", required: ["key"], properties: { key: SHORT_STRING, params: { type: "object" } } } }
                                    }
                                }
                            },
                            expiresAt: SHORT_STRING,
                            status: SHORT_STRING
                        }
                    },
                    usage: {
                        type: "object",
                        required: ["inputTokens", "cachedInputTokens", "outputTokens"],
                        properties: {
                            inputTokens: { type: "number" },
                            cachedInputTokens: { type: "number" },
                            outputTokens: { type: "number" },
                            cost: { type: "number", minimum: 0 },
                            currency: { type: "string", enum: ["USD", "EUR"] }
                        }
                    }
                }
            }
        }
    }
}

export default async function assistantController(fastify: FastifyInstance) {
    // Every question is a paid call to the model, so the assistant gets a ceiling of its own,
    // well below the one that applies to the rest of the API.
    // Keyed by user, not IP: behind the bundled nginx every request comes from 127.0.0.1, and a
    // per-IP ceiling would be shared by the whole installation. Hence the preHandler hook, which
    // runs after authentication has resolved the user.
    const rateLimit = {
        max: fastify.config.ASSISTANT_RATE_LIMIT_MAX,
        timeWindow: "1 minute",
        hook: "preHandler" as const,
        keyGenerator: (request: FastifyRequest) => request.databaseUser?._id?.toString() ?? request.ip
    }

    /**
     * Answers a question about the current project, or carries on after the user answered a
     * confirmation, as a Server-Sent Events stream: `text` frames carry the answer as it is
     * written, `thinking` frames the summary of the model's reasoning, `tool_call` /
     * `tool_result` frames what the tools do, `confirm` a destructive action waiting for the user,
     * and a final `done` (or `error`) frame closes the stream. The frames are described in
     * `service/assistant/assistantActions.ts`.
     */
    fastify.post<{ Body: AssistantChatRequestDTO }>("/assistant/chat", { schema: { body: chatBodySchema }, config: { authMethod: AuthenticationMethod.JWT, rateLimit } }, async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        const { confirmation } = request.body
        // Answering a confirmation resumes the assistant's own turn, which may end with its message.
        if (!confirmation && request.body.messages[request.body.messages.length - 1].role !== "user") {
            throw createBusinessException({ code: "ASSISTANT_INVALID_CONVERSATION", message: "The last message must come from the user" })
        }

        const service = new AssistantService(request.databaseUser, fastify.config, request.log)
        await service.ensureCanChat(projectId, request.body.aiModelId)
        // Here, not in ensureCanChat: reading or saving the conversations spends no token, and stays open past the limit
        if (request.databaseUser) await ensureWithinTokenLimit(projectId, request.databaseUser._id)
        // One turn of a conversation at a time: an update turn the server runs when an agent ends holds it
        // meanwhile. Claimed before the confirmation is taken, which a busy conversation must not use up.
        const conversationId = request.body.conversationId as string
        const lease = await claimTurn(request.databaseUser._id, projectId, conversationId, { asked: !confirmation, aiModelId: request.body.aiModelId })
        if (!lease) {
            throw createBusinessException({ code: "ASSISTANT_CONVERSATION_BUSY", message: "The assistant is answering an update of this conversation: ask again in a moment", statusCode: 409 })
        }
        // Renewed while the turn runs; lost (it ran out and another turn took it), the turn stops.
        const lost = new AbortController()
        const held = holdTurn(conversationId, lease, () => lost.abort())
        // The updates of the agents that ended meanwhile run once the browser has saved this turn: see the save below.
        const release = async () => {
            held.stop()
            await releaseTurn(conversationId, held.lease()).catch(error => fastify.log.warn({ err: error, projectId }, "Assistant conversation not released"))
        }
        // Taken before the stream opens, so an expired or foreign action is an HTTP error, and only
        // once: a second answer to the same card finds nothing.
        let action: Awaited<ReturnType<typeof service.takeConfirmation>> | undefined
        try {
            action = confirmation ? await service.takeConfirmation(projectId, confirmation.actionId, conversationId) : undefined
        } catch (error) {
            await release()
            throw error
        }

        openEventStream(reply)

        // The response, not the request: on a POST the request emits "close" as soon as its
        // body has been read, long before the user goes away.
        const abortController = new AbortController()
        reply.raw.on("close", () => {
            if (!reply.raw.writableEnded) abortController.abort()
        })
        if (reply.raw.destroyed) abortController.abort()

        // Tool calls (a dependency scan, several job logs) and the model's first token can leave
        // the stream silent for longer than a proxy's idle timeout; comment frames keep it open.
        const heartbeat = setInterval(() => reply.raw.write(HEARTBEAT), HEARTBEAT_INTERVAL_MS)

        let answered: { stopReason: string; usage: LlmUsage; cost?: number; currency?: "USD" | "EUR"; effort: LlmEffort; aiModelId: string; provider: LlmProvider } | undefined
        // What the rounds spent so far: an answer stopped or failing midway returns no outcome, its tokens still count.
        let spent: { usage: LlmUsage; spentOn?: AssistantSpentOn; cost?: number; currency?: "USD" | "EUR" } = { usage: NO_USAGE }
        try {
            const { stopReason, wrote, usage, effort, aiModelId, provider } = await service.chat(
                projectId,
                request.body,
                {
                    onText: delta => sendEvent(reply, "text", { delta }),
                    onThinking: delta => sendEvent(reply, "thinking", { delta }),
                    onToolCall: frame => sendEvent(reply, "tool_call", frame),
                    onToolResult: frame => sendEvent(reply, "tool_result", frame),
                    onConfirm: frame => sendEvent(reply, "confirm", frame),
                    onUsage: (usage, spentOn) => {
                        spent = { usage: addUsage(spent.usage, usage), spentOn }
                    }
                },
                // The user leaving, the lease lost, or the turn running past what any turn may.
                AbortSignal.any([abortController.signal, lost.signal, AbortSignal.timeout(MAX_TURN_MS)]),
                action && confirmation ? { action, approved: confirmation.approved } : undefined
            )
            let cost: Awaited<ReturnType<typeof calculateAiUsageCost>> = undefined
            try {
                cost = await calculateAiUsageCost(aiModelId, usage)
            } catch (error) {
                fastify.log.error({ err: error, projectId, aiModelId }, "Assistant interaction cost could not be calculated")
            }
            const usageCost = cost ? { cost: cost.amount, currency: cost.currency } : {}
            sendEvent(reply, "done", { stopReason, wrote, ...(usage ? { usage: { ...usage, ...usageCost } } : {}) })
            answered = { stopReason, usage, ...usageCost, effort, aiModelId, provider }
        } catch (error) {
            if (!abortController.signal.aborted) {
                fastify.log.error({ err: error, projectId }, "Assistant chat failed")
                const hasUsage = spent.usage.inputTokens + spent.usage.cachedInputTokens + spent.usage.outputTokens > 0
                if (hasUsage && spent.spentOn) {
                    try {
                        const cost = await calculateAiUsageCost(spent.spentOn.aiModelId, spent.usage)
                        if (cost) Object.assign(spent, { cost: cost.amount, currency: cost.currency })
                    } catch (costError) {
                        fastify.log.error({ err: costError, projectId, aiModelId: spent.spentOn.aiModelId }, "Failed assistant interaction cost could not be calculated")
                    }
                }
                sendEvent(reply, "error", {
                    code: isRateLimitError(error) ? "RATE_LIMITED" : "ASSISTANT_ERROR",
                    ...(hasUsage ? { usage: { ...spent.usage, ...(spent.cost === undefined ? {} : { cost: spent.cost, currency: spent.currency }) } } : {})
                })
            }
        } finally {
            clearInterval(heartbeat)
        }
        reply.raw.end()
        await release()

        if (answered) {
            const { stopReason, usage, cost, currency, effort, aiModelId, provider } = answered
            // One line and one document per answer: what the assistant costs, per user and project, on which AI and at which effort.
            fastify.log.info(
                { audit: "assistant_usage", userId: request.databaseUser?._id?.toString(), projectId, stopReason, effort, aiModelId, provider, cost, currency, ...usage },
                "Assistant answer usage"
            )
            // Once the stream is closed and not awaited: the browser does not wait on the write, and a failed one cannot become an error frame.
            void (async () => {
                try {
                    await AssistantUsage.create({ userId: request.databaseUser?._id, projectId: toObjectId(projectId), provider, aiModelId, stopReason, effort, cost, currency, ...usage })
                } catch (error) {
                    fastify.log.error({ err: error, projectId }, "Assistant usage not saved")
                }
            })()
        }
        // The ledger counts every answer, stopped and failed ones included, apart from the document above: one failing
        // must not lose the other. No component is credited, the assistant works on the whole project.
        const ledger = answered ?? (spent.spentOn && { ...spent.spentOn, usage: spent.usage, cost: spent.cost, currency: spent.currency })
        if (ledger) {
            const { usage, effort, aiModelId, provider } = ledger
            const cost = "cost" in ledger ? ledger.cost : undefined
            const currency = "currency" in ledger ? ledger.currency : undefined
            void recordAiUsage({ userId: request.databaseUser?._id, projectId, source: "assistant", aiModelId, provider, effort, cost, currency, ...usage }).catch(error =>
                fastify.log.error({ err: error, projectId }, "Assistant usage not recorded")
            )
        }
    })

    /** The next answer of the conversation that drafts a new project, used to prefill the wizard. */
    fastify.post<{ Body: AssistantProjectDraftRequestDTO }>(
        "/assistant/project-draft",
        { schema: { body: draftBodySchema }, config: { authMethod: AuthenticationMethod.JWT, rateLimit } },
        async (request, reply) => {
            const { organizationId, messages, locale, aiModelId } = request.body
            const turn = await new AssistantService(request.databaseUser, fastify.config, request.log).draftProject(organizationId, messages, locale, aiModelId)
            if (!turn) {
                throw createBusinessException({ code: "ASSISTANT_NO_DRAFT", message: "The model returned no usable draft", statusCode: 422 })
            }
            return reply.send(turn)
        }
    )

    /**
     * The user's own conversations on the project open in the console, so that one can be reopened.
     * The panel saves the conversation after every answer.
     */
    const conversationProjectId = async (request: FastifyRequest) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        await new AssistantService(request.databaseUser, fastify.config).ensureCanChat(projectId)
        return projectId
    }

    fastify.get("/assistant/conversations", { config: { authMethod: AuthenticationMethod.JWT } }, async (request, reply) => {
        const projectId = await conversationProjectId(request)
        return reply.send(await listConversations(request.databaseUser._id, projectId))
    })

    fastify.get<{ Params: { conversationId: string } }>(
        "/assistant/conversations/:conversationId",
        { schema: { params: conversationParamsSchema }, config: { authMethod: AuthenticationMethod.JWT } },
        async (request, reply) => {
            const projectId = await conversationProjectId(request)
            return reply.send(await getConversation(request.databaseUser._id, projectId, request.params.conversationId))
        }
    )

    /**
     * The agents the assistant started in the conversation, a card each (its jobs, its missions), and what the
     * conversation cost: the assistant's answers and its agents (tokens and sandbox time), apart and summed. Reads no
     * text of the conversation. `serverMessageIds` lists the messages the server added when agents ended: the panel
     * reloads the conversation when it misses one. `activity` says how often to poll: `agents` while a turn holds the
     * conversation, a job works or an update is to come, `missions` while only a mission works, `none` after.
     */
    fastify.get<{ Params: { conversationId: string } }>(
        "/assistant/conversations/:conversationId/agent-runs",
        { schema: { params: conversationParamsSchema }, config: { authMethod: AuthenticationMethod.JWT } },
        async (request, reply) => {
            const projectId = await conversationProjectId(request)
            const { conversationId } = request.params
            const conversation = await conversationForRuns(request.databaseUser._id, projectId, conversationId)
            const missionIds = await AiMission.find({ projectId: toObjectId(projectId), assistantConversationId: conversationId }, { _id: 1 })
                .sort({ createdAt: -1 })
                .limit(MAX_MISSION_CARDS)
                .lean()
            const missionService = new AiMissionService(request.databaseUser, fastify.config)
            const [jobs, missions, cost, activity] = await Promise.all([
                new AiChangeJobService(request.databaseUser, fastify.config).conversationJobs(projectId, conversationId),
                // One out of the caller's domains is left out, as on the Fleet page.
                Promise.all(missionIds.map(mission => missionService.get(String(mission._id)).catch(() => undefined))),
                conversationCost(conversationId, conversation.messages),
                conversationActivity(conversationId)
            ])
            const sandboxes = await sandboxByJob(jobs.map(job => toObjectId(job._id)))
            return reply.send({
                jobs: jobs.map(job => ({ ...job, sandbox: sandboxes.get(job._id) ?? { commands: 0, execSeconds: 0, lifetimeSeconds: 0 } })),
                missions: missions.flatMap(mission =>
                    mission
                        ? [
                              {
                                  _id: mission._id,
                                  prompt: mission.prompt,
                                  status: mission.status,
                                  repositories: mission.repositories.length,
                                  done: mission.repositories.length - mission.counts.queued - mission.counts.running,
                                  usage: mission.usage,
                                  createdAt: mission.createdAt
                              }
                          ]
                        : []
                ),
                cost,
                serverMessageIds: conversation.messages.filter(message => message.origin === "server").map(message => message.id),
                activity: conversation.busy ? "agents" : activity
            })
        }
    )

    fastify.put<{ Params: { conversationId: string }; Body: AssistantConversationSaveDTO }>(
        "/assistant/conversations/:conversationId",
        { bodyLimit: CONVERSATION_BODY_LIMIT, schema: { params: conversationParamsSchema, body: conversationBodySchema }, config: { authMethod: AuthenticationMethod.JWT } },
        async (request, reply) => {
            const projectId = await conversationProjectId(request)
            const { conversationId } = request.params
            await saveConversation(request.databaseUser._id, projectId, conversationId, request.body.messages)
            // The turn is saved: the agents that ended meanwhile get their update after it, never before. Not on the
            // save of a question, whose answer is about to stream and would find the conversation taken.
            if (!request.body.messages.some(message => message.status === "streaming")) {
                void runAgentUpdates(conversationId, fastify.config, request.log).catch(error => fastify.log.error({ err: error, projectId }, "Assistant update failed"))
            }
            return reply.code(204).send()
        }
    )

    fastify.delete<{ Params: { conversationId: string } }>(
        "/assistant/conversations/:conversationId",
        { schema: { params: conversationParamsSchema }, config: { authMethod: AuthenticationMethod.JWT } },
        async (request, reply) => {
            const projectId = await conversationProjectId(request)
            await deleteConversation(request.databaseUser._id, projectId, request.params.conversationId)
            return reply.code(204).send()
        }
    )
}
