import { FastifyInstance } from "fastify"
import fastifyPlugin from "fastify-plugin"
import mongoose from "mongoose"
import { ensureConversationRetention } from "../service/assistant/conversations"

/**
 * Keeps the assistant conversations for ASSISTANT_CONVERSATION_RETENTION_DAYS after their last write, by the TTL index
 * `ensureConversationRetention` creates or changes. A failure only costs the expiry, not the boot: it is logged.
 */
export default fastifyPlugin(
    async (fastify: FastifyInstance) => {
        if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) return
        const days = fastify.config.ASSISTANT_CONVERSATION_RETENTION_DAYS
        try {
            await ensureConversationRetention(days)
        } catch (error) {
            fastify.log.warn({ err: error, days }, "Assistant conversations retention not applied")
        }
    },
    { name: "assistantConversations", dependencies: ["config", "noSQL"] }
)
