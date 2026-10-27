import { FastifyInstance } from "fastify"
import fastifyPlugin from "fastify-plugin"
import mongoose from "mongoose"
import { notifyExpiringApiKeys } from "../service/ApiKeyExpiryNoticeService"

const TICK_EVERY_MS = 60 * 60 * 1000
const FIRST_TICK_AFTER_MS = 60 * 1000

/**
 * Emails the administrators of a project when one of its API keys is about to expire. Checked every hour, and
 * once a minute after the start: a replica restarted more often than hourly would otherwise never check.
 */
export default fastifyPlugin(
    async (fastify: FastifyInstance) => {
        let running = false
        const tick = async () => {
            if (running || mongoose.connection.readyState !== mongoose.ConnectionStates.connected) return
            running = true
            try {
                await notifyExpiringApiKeys()
            } catch (error) {
                fastify.log.warn({ err: error }, "API key expiry notices tick failed")
            } finally {
                running = false
            }
        }
        const first = setTimeout(tick, FIRST_TICK_AFTER_MS)
        const interval = setInterval(tick, TICK_EVERY_MS)
        first.unref()
        interval.unref()
        fastify.addHook("onClose", async () => {
            clearTimeout(first)
            clearInterval(interval)
        })
    },
    { name: "apiKeyExpiryNotices", dependencies: ["config", "noSQL"] }
)
