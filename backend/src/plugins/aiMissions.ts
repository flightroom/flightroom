import { FastifyInstance } from "fastify"
import fastifyPlugin from "fastify-plugin"
import mongoose from "mongoose"
import { sweepRunningMissions } from "../service/aiChange/AiMissionService"

/** Often enough to keep a mission whose last job died moving, rarely enough to cost nothing: a stale job is only declared dead after 20 minutes. */
const SWEEP_EVERY_MS = 5 * 60_000

/**
 * Moves on the running AI missions once the server is ready, then every few minutes: a mission waits for its
 * jobs to tell it they ended, and a job that died with the previous process never will.
 */
export default fastifyPlugin(
    async (fastify: FastifyInstance) => {
        let running = false
        const sweep = async () => {
            // Without the database there is nothing to move on; a sweep still running is not overlapped
            if (running || mongoose.connection.readyState !== mongoose.ConnectionStates.connected) return
            running = true
            try {
                await sweepRunningMissions(fastify.config)
            } catch (error) {
                fastify.log.warn({ err: error }, "AI missions sweep failed")
            } finally {
                running = false
            }
        }
        const interval = setInterval(sweep, SWEEP_EVERY_MS)
        interval.unref()
        // Detached: the server does not wait for the sweep to start answering.
        fastify.addHook("onReady", async () => void sweep())
        fastify.addHook("onClose", async () => clearInterval(interval))
    },
    { name: "aiMissions", dependencies: ["config", "noSQL"] }
)
