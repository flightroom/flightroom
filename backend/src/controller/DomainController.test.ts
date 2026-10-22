import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import domainController from "./DomainController"

const build = vi.fn()
const start = vi.fn()
const getLatest = vi.fn()

vi.mock("../service/DomainService", () => ({
    default: class {
        build = build
    }
}))

vi.mock("../service/DomainReleaseService", () => ({
    default: class {
        start = start
        getLatest = getLatest
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

describe("DomainController build and deploy", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        start.mockReset()
        getLatest.mockReset()
        app = Fastify()
        await app.register(domainController)
        await app.ready()
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given a version, a ref and an environment, when the domain is built and deployed, then all three reach the service with the domain id and the release comes back", async () => {
        const release = { _id: "r1", status: "waiting_ci", version: "1.4.0" }
        start.mockResolvedValue(release)

        const response = await app.inject({ method: "POST", url: `/domains/${DOMAIN}/build-and-deploy`, payload: { version: "1.4.0", ref: "release/1.4", environmentId: "env-1" } })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual(release)
        expect(start).toHaveBeenCalledWith(DOMAIN, "1.4.0", "release/1.4", "env-1")
    })

    it("Given a domain, when its latest release is asked for, then the service answers it", async () => {
        getLatest.mockResolvedValue({ _id: "r1", status: "deployed" })

        const response = await app.inject({ method: "GET", url: `/domains/${DOMAIN}/releases/latest` })

        expect(response.json()).toEqual({ _id: "r1", status: "deployed" })
        expect(getLatest).toHaveBeenCalledWith(DOMAIN)
    })

    it("Given a domain that never had a release, when its latest release is asked for, then the answer is null", async () => {
        getLatest.mockResolvedValue(null)

        const response = await app.inject({ method: "GET", url: `/domains/${DOMAIN}/releases/latest` })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toBeNull()
    })
})
