import { FastifyInstance } from "fastify"
import fastifyPlugin from "fastify-plugin"
import mongoose from "mongoose"
import { sweepIdleSandboxes } from "../service/aiChange/aiChangeSandboxes"

/** A sandbox lives at most a minute past its idle time: cheap, the sweep is one list call to the gateway. */
const SWEEP_EVERY_MS = 60_000

/**
 * Deletes the sandboxes of the coding agent whose conversation went idle. Every replica sweeps: they
 * agree on what is idle through the database, and deleting a sandbox twice is harmless.
 */
export default fastifyPlugin(
    async (fastify: FastifyInstance) => {
        let running = false
        const sweep = async () => {
            // Without the database nothing can be told idle; a sweep still running is not overlapped
            if (running || mongoose.connection.readyState !== mongoose.ConnectionStates.connected) return
            running = true
            try {
                const deleted = await sweepIdleSandboxes(fastify.config)
                if (deleted) fastify.log.info({ deleted }, "Idle AI sandboxes deleted")
            } catch (error) {
                fastify.log.warn({ err: error }, "AI sandboxes sweep failed")
            } finally {
                running = false
            }
        }
        let interval: NodeJS.Timeout | undefined
        // Without a gateway there are no sandboxes, and nothing to sweep.
        fastify.addHook("onReady", async () => {
            if (!fastify.config.OPENSHELL_GATEWAY_URL) return
            interval = setInterval(sweep, SWEEP_EVERY_MS)
            interval.unref()
        })
        fastify.addHook("onClose", async () => clearInterval(interval))
    },
    { name: "aiSandboxes", dependencies: ["config", "noSQL"] }
)
