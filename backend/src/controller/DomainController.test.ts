import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import domainController from "./DomainController"

const build = vi.fn()

vi.mock("../service/DomainService", () => ({
    default: class {
        build = build
    }
}))

const DOMAIN = "bbbbbbbbbbbbbbbbbbbbbbbb"

describe("DomainController build", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        build.mockReset()
        app = Fastify()
        await app.register(domainController)
        await app.ready()
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given a version and a ref, when the domain is built, then both reach the service with the domain id and the result comes back", async () => {
        const result = { version: "1.4.0", ref: "release/1.4", repositories: [] }
        build.mockResolvedValue(result)

        const response = await app.inject({ method: "POST", url: `/domains/${DOMAIN}/build`, payload: { version: "1.4.0", ref: "release/1.4" } })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual(result)
        expect(build).toHaveBeenCalledWith(DOMAIN, "1.4.0", "release/1.4")
    })

    it("Given no body, when the domain is built, then the service decides: it gets no version and no ref", async () => {
        build.mockResolvedValue({})

        await app.inject({ method: "POST", url: `/domains/${DOMAIN}/build` })

        expect(build).toHaveBeenCalledWith(DOMAIN, undefined, undefined)
    })
})
