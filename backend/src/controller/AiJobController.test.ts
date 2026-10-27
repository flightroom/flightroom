import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import aiJobController from "./AiJobController"

const create = vi.fn()
const followUp = vi.fn()

vi.mock("../service/aiChange/AiChangeJobService", () => ({
    default: class {
        create = create
        followUp = followUp
    }
}))

vi.mock("../service/aiChange/DomainPlanService", () => ({ default: class {} }))

const JOB = "aaaaaaaaaaaaaaaaaaaaaaaa"
const DOMAIN = "bbbbbbbbbbbbbbbbbbbbbbbb"
const image = (mediaType = "image/png", data = "aGk=") => ({ mediaType, data })

describe("AiJobController images", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        create.mockReset().mockResolvedValue({ _id: JOB })
        followUp.mockReset().mockResolvedValue({ _id: JOB })
        app = Fastify()
        app.decorate("config", { ASSISTANT_RATE_LIMIT_MAX: 20 } as never)
        await app.register(aiJobController)
        await app.ready()
    })

    afterEach(async () => {
        await app.close()
    })

    const createJob = (payload: Record<string, unknown>) =>
        app.inject({ method: "POST", url: "/ai-jobs", headers: { "project-id": "project-1" }, payload: { prompt: "Like this", scope: "domain", domainId: DOMAIN, ...payload } })

    it("Given images attached to a new job, then they reach the service", async () => {
        const response = await createJob({ images: [image(), image("image/jpeg")] })

        expect(response.statusCode).toBe(202)
        expect(create).toHaveBeenCalledWith("project-1", expect.objectContaining({ images: [image(), image("image/jpeg")] }))
    })

    it("Given a screenshot of a few MB, then the body is accepted beyond Fastify's default limit", async () => {
        const response = await createJob({ images: [image("image/png", "A".repeat(2_700_000))] })

        expect(response.statusCode).toBe(202)
    })

    it("Given an image of another type, more than five images or data that is not base64, then the job is refused before the service", async () => {
        expect((await createJob({ images: [image("image/svg+xml")] })).statusCode).toBe(400)
        expect((await createJob({ images: Array.from({ length: 6 }, () => image()) })).statusCode).toBe(400)
        expect((await createJob({ images: [image("image/png", "data:image/png;base64,aGk=")] })).statusCode).toBe(400)
        expect(create).not.toHaveBeenCalled()
    })

    it("Given images attached to a follow-up, then they reach the service; a bad one is refused", async () => {
        const ok = await app.inject({ method: "POST", url: `/ai-jobs/${JOB}/follow-ups`, payload: { prompt: "Closer", images: [image("image/webp")] } })
        const bad = await app.inject({ method: "POST", url: `/ai-jobs/${JOB}/follow-ups`, payload: { prompt: "Closer", images: [{ mediaType: "image/png" }] } })

        expect(ok.statusCode).toBe(202)
        expect(followUp).toHaveBeenCalledWith(JOB, expect.objectContaining({ images: [image("image/webp")] }))
        expect(bad.statusCode).toBe(400)
        expect(followUp).toHaveBeenCalledTimes(1)
    })
})
