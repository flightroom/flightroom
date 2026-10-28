import Fastify, { FastifyInstance } from "fastify"
import fastifyPlugin from "fastify-plugin"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AuthenticationError from "../errors/AuthenticationError"
import authorization from "../plugins/autorization"
import errorHandler from "../plugins/errorHandler"
import maintenanceAgentRuntimeController from "./MaintenanceAgentRuntimeController"

const resolveRuntimeToken = vi.fn()
const callers: unknown[] = []
const logs = vi.fn()
const targets = vi.fn()

vi.mock("../service/MaintenanceAgentRuntimeService", () => ({
    resolveRuntimeToken: (token: unknown) => resolveRuntimeToken(token),
    default: class {
        constructor(caller: unknown) {
            callers.push(caller)
        }
        logs = logs
        targets = targets
    }
}))

const TOKEN = `fra_${"1".repeat(24)}_${"2".repeat(24)}_${"a".repeat(64)}`
const caller = { agent: { slug: "cleaner" }, environment: { slug: "production" } }

describe("MaintenanceAgentRuntimeController", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        callers.length = 0
        resolveRuntimeToken.mockReset().mockImplementation(async (token: unknown) => {
            if (token !== TOKEN) throw new AuthenticationError("Missing or invalid maintenance agent token")
            return caller
        })
        logs.mockReset().mockResolvedValue([{ content: "started" }])
        targets.mockReset().mockResolvedValue([])
        app = Fastify()
        // The authorization plugin waits for the one named config: nothing of it is read here
        await app.register(fastifyPlugin(async () => undefined, { name: "config" }))
        await app.register(errorHandler)
        await app.register(authorization)
        await app.register(maintenanceAgentRuntimeController)
    })

    afterEach(async () => {
        await app.close()
    })

    it("given the token of the agent as bearer, when it reads the logs of a target, then the service reads them as that agent in its environment", async () => {
        const response = await app.inject({
            method: "GET",
            url: "/maintenance-agent-runtime/targets/orders/logs?pod=orders-1&tailLines=50",
            headers: { authorization: `Bearer ${TOKEN}` }
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual([{ content: "started" }])
        expect(callers).toEqual([caller])
        expect(logs).toHaveBeenCalledWith("orders", { pod: "orders-1", tailLines: "50" })
    })

    it("given no token, when it lists its targets, then it is refused before the service is reached", async () => {
        const response = await app.inject({ method: "GET", url: "/maintenance-agent-runtime/targets" })

        expect(response.statusCode).toBe(401)
        expect(targets).not.toHaveBeenCalled()
    })

    it("given a token that is not the one stored, when it lists its targets, then it is refused", async () => {
        const response = await app.inject({ method: "GET", url: "/maintenance-agent-runtime/targets", headers: { authorization: `Bearer ${TOKEN.replace(/a$/, "b")}` } })

        expect(response.statusCode).toBe(401)
        expect(targets).not.toHaveBeenCalled()
    })
})
