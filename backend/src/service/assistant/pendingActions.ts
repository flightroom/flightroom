import { randomBytes } from "node:crypto"
import { createBusinessException } from "../../errors/BusinessException"
import { redisClient } from "../../plugins/redis"
import { LlmMessage } from "../llm"

/** How long the user has to confirm a destructive action before it has to be asked again. */
export const PENDING_ACTION_TTL_MS = 15 * 60_000
/** An action parked by an update turn, which the server ran while nobody was at the console: the user answers it later. */
export const UPDATE_ACTION_TTL_MS = 24 * 60 * 60_000

/**
 * A destructive tool call the assistant wanted to make, parked until the user confirms or declines
 * it in the console. It is bound to the user and the project of the conversation it came from and
 * can be taken exactly once.
 */
export interface PendingAssistantAction {
    /** Random and unguessable: the browser holds it only to say yes or no. */
    id: string
    userId: string
    projectId: string
    tool: string
    /** The input exactly as the model sent it: it is validated again when the action runs. */
    args: Record<string, unknown>
    /** The model's id for the call, so the conversation can carry on from it. */
    callId: string
    /** The saved conversation the turn belongs to: while the action waits, the server runs no turn of it. */
    conversationId?: string
    /**
     * What the model said and got back in this turn after the user's last message, as the provider
     * returned it (thinking blocks and thought signatures included) and with this call's result as a
     * placeholder: the turn resumes from it. Missing when the turn was too large to keep.
     */
    turn?: LlmMessage[]
    createdAt: number
    expiresAt: number
}

/** Fallback when Redis is not configured: enough for the single process such an installation runs. */
const localActions = new Map<string, PendingAssistantAction>()

const redisAvailable = () => Boolean(redisClient?.isOpen)

/**
 * User and project are part of the key, so taking an action of someone else, or of another
 * project, finds nothing rather than consuming it: a leaked id cannot be burnt by another user.
 */
const keyOf = (id: string, userId: string, projectId: string) => `assistant-action:${userId}:${projectId}:${id}`
/** The ids of the actions of a user in a project, to tell whether one waits in a conversation. */
const indexOf = (userId: string, projectId: string) => `assistant-actions:${userId}:${projectId}`

const dropExpiredLocal = (now: number) => {
    for (const [key, action] of localActions) {
        if (action.expiresAt <= now) localActions.delete(key)
    }
}

export const createPendingAction = async (input: Omit<PendingAssistantAction, "id" | "createdAt" | "expiresAt">, ttlMs = PENDING_ACTION_TTL_MS): Promise<PendingAssistantAction> => {
    const now = Date.now()
    const action: PendingAssistantAction = { ...input, id: randomBytes(24).toString("base64url"), createdAt: now, expiresAt: now + ttlMs }
    const key = keyOf(action.id, action.userId, action.projectId)
    if (redisAvailable()) {
        await redisClient.set(key, JSON.stringify(action), { PX: ttlMs })
        const index = indexOf(action.userId, action.projectId)
        await redisClient.sAdd(index, action.id)
        // Kept as long as its longest action: an index outliving them all only lists ids that are gone.
        await redisClient.pExpire(index, UPDATE_ACTION_TTL_MS)
    } else {
        dropExpiredLocal(now)
        localActions.set(key, action)
    }
    return action
}

/** Get and delete in one step: two confirmations racing for the same action cannot both get it. */
const TAKE_SCRIPT = "local value = redis.call('get', KEYS[1]) if value then redis.call('del', KEYS[1]) end return value"

/**
 * Takes the action out of the store, whatever the user then decides: confirming or declining both
 * use it up. Unknown, expired, already used, or belonging to another user or project all read the
 * same, so the answer tells nothing about actions the caller does not own.
 */
export const takePendingAction = async (id: string, userId: string, projectId: string, conversationId?: string): Promise<PendingAssistantAction> => {
    const key = keyOf(id, userId, projectId)
    let action: PendingAssistantAction | undefined
    if (redisAvailable()) {
        const stored = await redisClient.eval(TAKE_SCRIPT, { keys: [key], arguments: [] })
        action = typeof stored === "string" ? (JSON.parse(stored) as PendingAssistantAction) : undefined
    }
    // Also the local map: an action parked while Redis was down lives there, whatever Redis does now.
    const local = localActions.get(key)
    localActions.delete(key)
    action ??= local

    // An action of another conversation is taken all the same, and refused: answered from elsewhere, it is used up.
    if (!action || action.expiresAt <= Date.now() || action.userId !== userId || action.projectId !== projectId || (action.conversationId && action.conversationId !== conversationId)) {
        throw createBusinessException({ code: "ASSISTANT_ACTION_NOT_FOUND", message: "This confirmation has expired or was already answered", statusCode: 409 })
    }
    return action
}

/**
 * Whether an action of the user waits for them in the conversation, not taken nor expired: the stores are read, not
 * the conversation the browser saves, which may not hold the card yet.
 */
export const hasPendingAction = async (userId: string, projectId: string, conversationId: string): Promise<boolean> => {
    const now = Date.now()
    dropExpiredLocal(now)
    const prefix = keyOf("", userId, projectId)
    for (const [key, action] of localActions) {
        if (key.startsWith(prefix) && action.conversationId === conversationId) return true
    }
    // Configured but down: what waits there cannot be read, so something is taken to wait.
    if (redisClient && !redisClient.isOpen) return true
    if (!redisAvailable()) return false
    const index = indexOf(userId, projectId)
    for (const id of await redisClient.sMembers(index)) {
        const stored = await redisClient.get(keyOf(id, userId, projectId))
        if (!stored) {
            // Taken or expired: its id leaves the index.
            await redisClient.sRem(index, id)
            continue
        }
        const action = JSON.parse(stored) as PendingAssistantAction
        if (action.conversationId === conversationId && action.expiresAt > now) return true
    }
    return false
}
