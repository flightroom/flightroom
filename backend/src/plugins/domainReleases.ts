import { FastifyInstance } from "fastify"
import fastifyPlugin from "fastify-plugin"
import mongoose from "mongoose"
import { advanceDomainReleases } from "../service/DomainReleaseService"

const TICK_EVERY_MS = 15_000

/**
 * Takes every build and deploy of a domain one step further every few seconds: waits for the CI, sets the
 * versions, deploys. The state is in the database, so a release goes on after a restart or with no browser open.
 */
export default fastifyPlugin(
    async (fastify: FastifyInstance) => {
        let running = false
        const tick = async () => {
            // Before the database is up, or without one, there is nothing to advance; a tick still deploying is not overlapped
            if (running || mongoose.connection.readyState !== mongoose.ConnectionStates.connected) return
            running = true
            try {
                await advanceDomainReleases()
            } catch (error) {
                fastify.log.warn({ err: error }, "Domain releases tick failed")
            } finally {
                running = false
            }
        }
        const interval = setInterval(tick, TICK_EVERY_MS)
        interval.unref()
        fastify.addHook("onClose", async () => clearInterval(interval))
    },
    { name: "domainReleases", dependencies: ["config", "noSQL"] }
)
