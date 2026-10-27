import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import aiChangeController from "./AiChangeController"

const create = vi.fn()

vi.mock("../service/aiChange/AiChangeService", () => ({
    default: class {
        create = create
    }
}))

const FRONTEND = "aaaaaaaaaaaaaaaaaaaaaaaa"

describe("AiChangeController images", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        create.mockReset().mockResolvedValue({ _id: "request-1" })
        app = Fastify()
        app.decorate("config", { ASSISTANT_RATE_LIMIT_MAX: 20 } as never)
        await app.register(aiChangeController)
        await app.ready()
    })

    afterEach(async () => {
        await app.close()
    })

    const createChange = (images: unknown) => app.inject({ method: "POST", url: `/frontends/${FRONTEND}/ai-changes`, payload: { prompt: "Like this", images } })

    it("Given an image a few MB large, then it reaches the service with the prompt", async () => {
        const images = [{ mediaType: "image/png", data: "A".repeat(2_700_000) }]

        const response = await createChange(images)

        expect(response.statusCode).toBe(202)
        expect(create).toHaveBeenCalledWith({ kind: "frontend", id: FRONTEND }, { prompt: "Like this", images })
    })

    it("Given an image of another type or more than five, then the request is refused before the service", async () => {
        expect((await createChange([{ mediaType: "image/bmp", data: "aGk=" }])).statusCode).toBe(400)
        expect((await createChange(Array.from({ length: 6 }, () => ({ mediaType: "image/png", data: "aGk=" })))).statusCode).toBe(400)
        expect(create).not.toHaveBeenCalled()
    })
})
