import { createBusinessException } from "../errors/BusinessException"
import { CONNECTION_TEST_ROUTE_CONFIG } from "./connectionTest"

const WINDOW_MS = 60_000
const MAX_CALLS = CONNECTION_TEST_ROUTE_CONFIG.rateLimit.max

/** The calls of each principal in the last minute, oldest first */
const calls = new Map<string, number[]>()

/**
 * The budget of the MCP tools and of the console assistant that reach a server outside the console (a MongoDB
 * server, Atlas, Azure), by principal: the same allowance as the connection-test routes (10 a minute), counted
 * apart from them. Those routes are limited by @fastify/rate-limit, which a tool, run inside one /mcp request or
 * in process by the assistant, never goes through. Kept in memory: each instance of the backend counts its own.
 */
export const takeExternalCall = (principalId: string, now = Date.now()): void => {
    const recent = (calls.get(principalId) ?? []).filter(at => now - at < WINDOW_MS)
    if (recent.length >= MAX_CALLS) {
        calls.set(principalId, recent)
        throw createBusinessException({
            code: "EXTERNAL_CALLS_RATE_LIMITED",
            message: `At most ${MAX_CALLS} operations reaching an outside server a minute: wait a minute and try again`,
            statusCode: 429
        })
    }
    recent.push(now)
    calls.set(principalId, recent)
}

/** Only for tests: the counts are kept for the life of the process */
export const resetExternalCalls = (): void => {
    calls.clear()
}
