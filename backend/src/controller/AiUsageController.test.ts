import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import UserCannotAccessThisOrganizationError from "../errors/UserCannotAccessThisOrganizationError"
import errorHandler from "../plugins/errorHandler"
import aiUsageController from "./AiUsageController"

const forDomain = vi.fn()
const forFrontend = vi.fn()
const forBackend = vi.fn()
const forProject = vi.fn()
const forOrganization = vi.fn()

vi.mock("../service/AiUsageService", () => ({
    AI_USAGE_PERIODS: ["30d", "month", "90d", "all"],
    default: class {
        forDomain = forDomain
        forFrontend = forFrontend
        forBackend = forBackend
        forProject = forProject
        forOrganization = forOrganization
    }
}))

const ID = "64b7f0c2a1b2c3d4e5f60718"
const summary = { period: "30d", total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }

describe("AiUsageController", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        for (const mock of [forDomain, forFrontend, forBackend, forProject, forOrganization]) mock.mockReset().mockResolvedValue(summary)
        app = Fastify()
        app.decorateRequest("databaseUser", null as never)
        app.addHook("onRequest", async request => {
            request.databaseUser = { _id: "user-1" } as never
        })
        await app.register(errorHandler)
        await app.register(aiUsageController)
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given no period, when a domain's usage is asked, then the last 30 days are summed", async () => {
        const response = await app.inject({ method: "GET", url: `/domains/${ID}/ai-usage` })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual(summary)
        expect(forDomain).toHaveBeenCalledWith(ID, "30d")
    })

    it("Given each level, when its usage is asked for a period, then the period reaches the backend of that level", async () => {
        await app.inject({ method: "GET", url: `/frontends/${ID}/ai-usage?period=month` })
        await app.inject({ method: "GET", url: `/backends/${ID}/ai-usage?period=90d` })
        await app.inject({ method: "GET", url: `/projects/${ID}/ai-usage?period=all` })
        await app.inject({ method: "GET", url: `/organizations/${ID}/ai-usage?period=30d` })

        expect(forFrontend).toHaveBeenCalledWith(ID, "month")
        expect(forBackend).toHaveBeenCalledWith(ID, "90d")
        expect(forProject).toHaveBeenCalledWith(ID, "all")
        expect(forOrganization).toHaveBeenCalledWith(ID, "30d")
    })

    it("Given a period the console does not offer, when it is asked, then the schema rejects it", async () => {
        const response = await app.inject({ method: "GET", url: `/projects/${ID}/ai-usage?period=7d` })

        expect(response.statusCode).toBe(400)
        expect(forProject).not.toHaveBeenCalled()
    })

    it("Given an id that is not one, when a usage is asked, then the schema rejects it", async () => {
        const response = await app.inject({ method: "GET", url: "/backends/not-an-id/ai-usage" })

        expect(response.statusCode).toBe(400)
        expect(forBackend).not.toHaveBeenCalled()
    })

    // The error handler answers this error as the AI models endpoints do: refused, with no figure in the body.
    it("Given a user who does not administer the organization, when its usage is asked, then it is refused and nothing is sent", async () => {
        forOrganization.mockRejectedValue(new UserCannotAccessThisOrganizationError())

        const response = await app.inject({ method: "GET", url: `/organizations/${ID}/ai-usage` })

        expect(response.statusCode).toBe(403)
        expect(response.body).not.toContain("inputTokens")
    })
})
