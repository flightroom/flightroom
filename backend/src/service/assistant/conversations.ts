import { ObjectId, Schema } from "mongoose"
import { createBusinessException } from "../../errors/BusinessException"
import AssistantConversation from "../../models/AssistantConversationModel"
import { AssistantConversationDTO, AssistantConversationMessageDTO, AssistantConversationSummaryDTO } from "../../types/AssistantDTO"
import { toObjectId } from "../../utils/mongooseUtils"
import { redactSecrets } from "../../utils/redactSecrets"
import { LLM_EFFORTS } from "../llm/types"

/** The history shows the most recent ones only. */
export const MAX_LISTED_CONVERSATIONS = 50
/** What the browser keeps of a conversation, and what the server keeps when it adds messages of its own. */
export const MAX_STORED_MESSAGES = 40
/**
 * How long a turn holds its conversation without renewing it: the turn renews it every {@link TURN_HEARTBEAT_MS}
 * while it runs, so one dying with its process frees the conversation within this.
 */
export const TURN_LEASE_MS = 3 * 60_000
export const TURN_HEARTBEAT_MS = 60_000
/** The longest a turn runs, the user's or the server's: it is stopped past it, whatever its lease. */
export const MAX_TURN_MS = 10 * 60_000
/** How long an update waits for the browser to save the turn of the user before running without it. */
export const SAVE_GRACE_MS = 2 * 60_000
/** Saves racing with a message the server adds are read and merged again this many times. */
const SAVE_ATTEMPTS = 3
const MAX_TITLE_CHARS = 80
/** Clipped rather than rejected: one oversized field would stop the conversation from being saved at all. */
const MAX_CONTENT_CHARS = 64_000
const MAX_FIELD_CHARS = 2_000
const MAX_TOOLS = 100
const MAX_DETAILS = 50

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
/** Kept for good: an API key or a password the answer repeated is masked, as in the job logs the tools return. */
const safe = (value: string, max: number) => redactSecrets(clip(value, max))

type UserId = ObjectId | Schema.Types.ObjectId

const withoutUndefined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T

const conversationNotFound = () => createBusinessException({ code: "ASSISTANT_CONVERSATION_NOT_FOUND", message: "Conversation not found", statusCode: 404 })

/**
 * Only the fields the panel shows. Whatever the browser sends, tool inputs and results are never
 * stored: they can carry variable values or the key of an API key just created. What is kept of
 * the text has secrets masked.
 */
export const toStoredMessage = (message: AssistantConversationMessageDTO): AssistantConversationMessageDTO =>
    withoutUndefined({
        id: message.id,
        role: message.role,
        content: safe(message.content, MAX_CONTENT_CHARS),
        origin: message.origin === "server" ? "server" : undefined,
        kind: message.kind === "agent_update" ? "agent_update" : undefined,
        // The reasoning can repeat what the tools returned: masked and clipped like the answer.
        thinking: message.thinking === undefined ? undefined : safe(message.thinking, MAX_CONTENT_CHARS),
        // Left unchecked by the schema, so that an unknown level never stops a save: dropped here.
        effort: message.effort && LLM_EFFORTS.includes(message.effort) ? message.effort : undefined,
        // An answer saved while it streamed reads as finished when reopened.
        status: message.status === "streaming" ? "done" : message.status,
        errorKey: message.errorKey,
        tools: message.tools?.slice(0, MAX_TOOLS).map(tool =>
            withoutUndefined({
                id: tool.id,
                name: tool.name,
                title: tool.title,
                kind: tool.kind,
                status: tool.status === "running" ? "interrupted" : tool.status,
                summary: tool.summary === undefined ? undefined : safe(tool.summary, MAX_FIELD_CHARS)
            })
        ),
        confirmation: message.confirmation && {
            actionId: message.confirmation.actionId,
            callId: message.confirmation.callId,
            name: message.confirmation.name,
            title: message.confirmation.title,
            details: message.confirmation.details.slice(0, MAX_DETAILS).map(({ label, value, lines }) =>
                withoutUndefined({
                    label,
                    value: safe(value, MAX_FIELD_CHARS),
                    // Names, branches and counts the console words: masked like the value, a line per repository at most.
                    lines: lines?.slice(0, MAX_DETAILS).map(line => ({
                        key: line.key,
                        params: line.params && Object.fromEntries(Object.entries(line.params).map(([name, param]) => [name, typeof param === "number" ? param : safe(String(param), MAX_FIELD_CHARS)]))
                    }))
                })
            ),
            expiresAt: message.confirmation.expiresAt,
            status: message.confirmation.status
        },
        usage: message.usage && {
            inputTokens: message.usage.inputTokens,
            cachedInputTokens: message.usage.cachedInputTokens,
            outputTokens: message.usage.outputTokens,
            ...(typeof message.usage.cost === "number" && Number.isFinite(message.usage.cost) && message.usage.cost >= 0
                ? { cost: message.usage.cost, currency: message.usage.currency ?? "USD" }
                : typeof message.usage.costUsd === "number" && Number.isFinite(message.usage.costUsd) && message.usage.costUsd >= 0
                  ? { cost: message.usage.costUsd, currency: "USD" as const }
                  : {})
        }
    })

/** The first question of the user, never a note of the server. */
const titleOf = (messages: AssistantConversationMessageDTO[]) => {
    const question = messages.find(message => message.role === "user" && message.kind !== "agent_update")?.content ?? ""
    const oneLine = question.replace(/\s+/g, " ").trim()
    return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1)}…` : oneLine
}

/** The user's conversations on the project, most recent first. */
export const listConversations = async (userId: UserId, projectId: string): Promise<AssistantConversationSummaryDTO[]> => {
    const conversations = await AssistantConversation.find({ userId, projectId: toObjectId(projectId), deletedAt: null }, { title: 1, updatedAt: 1 })
        .sort({ updatedAt: -1 })
        .limit(MAX_LISTED_CONVERSATIONS)
        .lean()
    return conversations.map(conversation => ({ id: conversation._id, title: conversation.title, updatedAt: conversation.updatedAt }))
}

export const getConversation = async (userId: UserId, projectId: string, conversationId: string): Promise<AssistantConversationDTO> => {
    const conversation = await AssistantConversation.findOne({ _id: conversationId, userId, projectId: toObjectId(projectId), deletedAt: null }).lean()
    if (!conversation) {
        throw conversationNotFound()
    }
    const busy = Boolean(conversation.turnUntil && new Date(conversation.turnUntil).getTime() > Date.now())
    return { id: conversation._id, title: conversation.title, updatedAt: conversation.updatedAt, messages: conversation.messages, ...(busy ? { busy } : {}) }
}

/**
 * `incoming` with the messages the server added that it has not seen yet, each after the message it followed. Those
 * older than the oldest message `incoming` holds are left out: the browser trimmed them, it did not miss them.
 */
export const withServerMessages = (current: AssistantConversationMessageDTO[], incoming: AssistantConversationMessageDTO[]): AssistantConversationMessageDTO[] => {
    const ids = new Set(incoming.map(message => message.id))
    const oldestKnown = current.findIndex(message => ids.has(message.id))
    const merged = [...incoming]
    current.forEach((message, index) => {
        if (message.origin !== "server" || ids.has(message.id) || index < oldestKnown) return
        const previous = index > 0 ? merged.findIndex(candidate => candidate.id === current[index - 1].id) : -1
        merged.splice(previous < 0 ? merged.length : previous + 1, 0, message)
    })
    return merged
}

const conversationConflict = () => createBusinessException({ code: "ASSISTANT_CONVERSATION_CONFLICT", message: "The conversation changed while it was saved: save it again", statusCode: 409 })

const isDuplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === 11000)

/**
 * Creates the conversation or replaces its messages. A conversation stays with its user and project,
 * and a deleted one is not brought back. The messages the server added since the browser last read the
 * conversation are kept: each write is guarded on the version read, and merged again when the version moved
 * meanwhile. Past the last attempt the save is refused rather than written over a message of the server.
 */
export const saveConversation = async (userId: UserId, projectId: string, conversationId: string, messages: AssistantConversationMessageDTO[]): Promise<void> => {
    const stored = messages.map(toStoredMessage)
    const filter = { _id: conversationId, userId, projectId: toObjectId(projectId), deletedAt: null }
    // A save with the answer finished holds the whole turn: the updates of the agents may run on it from now on.
    const saved = messages.some(message => message.status === "streaming") ? {} : { $unset: { savePendingSince: 1 } }
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
        const current = await AssistantConversation.findOne(filter, { messages: 1, version: 1 }).lean()
        if (!current) {
            try {
                await AssistantConversation.updateOne(filter, { $set: { messages: stored, title: titleOf(stored) }, $inc: { version: 1 }, ...saved }, { upsert: true })
                return
            } catch (error) {
                if (!isDuplicateKey(error)) throw error
                // Inserted meanwhile by the question's own turn: read again. Or the id exists for another user or
                // project, or was deleted, and the upsert tried to insert it again.
                if (attempt >= SAVE_ATTEMPTS) throw conversationNotFound()
                continue
            }
        }
        const merged = withServerMessages(current.messages ?? [], stored).slice(-MAX_STORED_MESSAGES)
        const { matchedCount } = await AssistantConversation.updateOne(
            { ...filter, version: current.version ?? null },
            { $set: { messages: merged, title: titleOf(merged) }, $inc: { version: 1 }, ...saved }
        )
        if (matchedCount > 0) return
    }
    throw conversationConflict()
}

/** A logical delete: the conversation leaves the history, the document stays. */
export const deleteConversation = async (userId: UserId, projectId: string, conversationId: string): Promise<void> => {
    const { matchedCount } = await AssistantConversation.updateOne({ _id: conversationId, userId, projectId: toObjectId(projectId), deletedAt: null }, { $set: { deletedAt: new Date() } })
    if (matchedCount === 0) {
        throw conversationNotFound()
    }
}

const turnFree = (now: Date) => ({ $or: [{ turnUntil: null }, { turnUntil: { $lte: now } }] })

const leaseFrom = (now = Date.now()) => new Date(now + TURN_LEASE_MS)

/**
 * Takes the conversation for one turn of the user until `releaseTurn`, renewed by `holdTurn`: undefined when another
 * turn holds it. A question asked before the browser saved the conversation creates it, empty: its save fills it.
 * `asked` marks a new question, from which the agents the assistant starts and the update turns are counted again,
 * and keeps the AI it was asked of for the update turns. Returns the lease, which only its holder renews and releases.
 */
export const claimTurn = async (userId: UserId, projectId: string, conversationId: string, { asked = false, aiModelId }: { asked?: boolean; aiModelId?: string } = {}): Promise<Date | undefined> => {
    // Twice: the browser's first save may insert the conversation at the same moment.
    for (let attempt = 0; attempt < 2; attempt++) {
        const now = new Date()
        const until = leaseFrom(now.getTime())
        const question = asked ? { askedAt: now, updateTurns: 0, ...(aiModelId ? { aiModelId } : {}) } : {}
        try {
            await AssistantConversation.findOneAndUpdate(
                { _id: conversationId, userId, projectId: toObjectId(projectId), deletedAt: null, ...turnFree(now) },
                // Until the browser saves the answer, no update runs on a conversation that lacks it.
                { $set: { turnUntil: until, savePendingSince: now, ...question }, $setOnInsert: { title: "", messages: [] } },
                { upsert: true, projection: { _id: 1 } }
            )
            return until
        } catch (error) {
            if (!isDuplicateKey(error)) throw error
        }
    }
    // Inserting failed twice: the conversation exists and another turn holds it, or it is not this user's.
    if (await AssistantConversation.exists({ _id: conversationId, userId, projectId: toObjectId(projectId), deletedAt: null })) return undefined
    throw conversationNotFound()
}

/** Extends the lease its holder has: undefined when it was lost meanwhile, run out and taken by another turn. */
export const renewTurn = async (conversationId: string, lease: Date): Promise<Date | undefined> => {
    const until = leaseFrom()
    const renewed = await AssistantConversation.findOneAndUpdate({ _id: conversationId, turnUntil: lease }, { $set: { turnUntil: until } }, { projection: { _id: 1 } })
    return renewed ? until : undefined
}

/**
 * Keeps the lease while the turn runs: renewed every {@link TURN_HEARTBEAT_MS}, and by `renew` when the turn moves
 * on, guarded on the lease held. Once it cannot be renewed, `onLost` stops the turn: another may hold the
 * conversation by then.
 */
export const holdTurn = (conversationId: string, lease: Date, onLost: () => void): { lease: () => Date; renew: () => Promise<boolean>; stop: () => void } => {
    let held = lease
    let lost = false
    const renew = async () => {
        if (lost) return false
        const renewed = await renewTurn(conversationId, held).catch(() => held)
        if (renewed) {
            held = renewed
            return true
        }
        lost = true
        clearInterval(heartbeat)
        onLost()
        return false
    }
    const heartbeat = setInterval(() => void renew(), TURN_HEARTBEAT_MS)
    heartbeat.unref?.()
    return { lease: () => held, renew, stop: () => clearInterval(heartbeat) }
}

/** Frees the conversation for the next turn, unless the lease ran out and another turn took it since. */
export const releaseTurn = async (conversationId: string, lease: Date): Promise<void> => {
    await AssistantConversation.updateOne({ _id: conversationId, turnUntil: lease }, { $unset: { turnUntil: 1 } })
}

/**
 * Takes the conversation for a turn of the server, as `claimTurn` does, but never creates it, and not while the
 * browser has yet to save the user's last turn (for {@link SAVE_GRACE_MS} at most). Returns the lease.
 */
export const claimServerTurn = async (conversationId: string): Promise<Date | undefined> => {
    const now = new Date()
    const lease = leaseFrom(now.getTime())
    const saved = { $or: [{ savePendingSince: null }, { savePendingSince: { $lte: new Date(now.getTime() - SAVE_GRACE_MS) } }] }
    const claimed = await AssistantConversation.findOneAndUpdate({ _id: conversationId, deletedAt: null, $and: [turnFree(now), saved] }, { $set: { turnUntil: lease } }, { projection: { _id: 1 } })
    return claimed ? lease : undefined
}

/** Counts one more update turn, unless as many ran since the user last asked as may: false then, and no turn runs. */
export const countUpdateTurn = async (conversationId: string, max: number): Promise<boolean> => {
    const counted = await AssistantConversation.findOneAndUpdate(
        { _id: conversationId, $or: [{ updateTurns: null }, { updateTurns: { $lt: max } }] },
        { $inc: { updateTurns: 1 } },
        { projection: { _id: 1 } }
    )
    return Boolean(counted)
}

/** Adds messages of the server at the end of the conversation, the oldest dropped past what is kept. */
export const appendMessages = async (conversationId: string, messages: AssistantConversationMessageDTO[]): Promise<void> => {
    const stored = messages.map(message => toStoredMessage({ ...message, origin: "server" }))
    await AssistantConversation.updateOne({ _id: conversationId, deletedAt: null }, { $push: { messages: { $each: stored, $slice: -MAX_STORED_MESSAGES } }, $inc: { version: 1 } })
}

/** What the cards of the agents read of a conversation: whose messages are the server's and what they cost, no text. */
export const conversationForRuns = async (userId: UserId, projectId: string, conversationId: string) => {
    const conversation = await AssistantConversation.findOne(
        { _id: conversationId, userId, projectId: toObjectId(projectId), deletedAt: null },
        { "messages.id": 1, "messages.origin": 1, "messages.usage": 1, turnUntil: 1 }
    ).lean()
    if (!conversation) throw conversationNotFound()
    return {
        messages: ((conversation as { messages?: unknown[] }).messages ?? []) as Pick<AssistantConversationMessageDTO, "id" | "origin" | "usage">[],
        busy: Boolean(conversation.turnUntil && new Date(conversation.turnUntil).getTime() > Date.now())
    }
}
