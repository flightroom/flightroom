import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import errorHandler from "../plugins/errorHandler"
import containerEnvironmentController from "./ContainerEnvironmentController"

const get = vi.fn()

vi.mock("../service/ArgoCdService", () => ({
    default: class {
        runningEnvironment = get
    }
}))

const PROJECT = "64b7f0c2a1b2c3d4e5f60718"
const CONTAINER = "64b7f0c2a1b2c3d4e5f60717"
const ENVIRONMENT = "64b7f0c2a1b2c3d4e5f60716"

describe("ContainerEnvironmentController", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        get.mockReset().mockResolvedValue({ state: "running", pod: "orders-abc", variables: [{ name: "PUBLIC_URL", source: "platform", value: "https://dev.example.com/orders" }] })
        app = Fastify()
        app.decorate("config", {} as never)
        app.decorateRequest("databaseUser", null as never)
        app.addHook("onRequest", async request => {
            request.databaseUser = { _id: "user-1" } as never
        })
        await app.register(errorHandler)
        await app.register(containerEnvironmentController)
    })

    afterEach(async () => {
        await app.close()
    })

    it.each([
        ["backends", "backend"],
        ["frontends", "frontend"]
    ])("given a %s container, when the variables of its running container are read, then the service answers for that kind", async (path, kind) => {
        const response = await app.inject({ method: "GET", url: `/${path}/${CONTAINER}/environments/${ENVIRONMENT}/variables`, headers: { "project-id": PROJECT } })

        expect(response.statusCode).toBe(200)
        expect(get).toHaveBeenCalledWith(PROJECT, { kind, id: CONTAINER }, ENVIRONMENT)
        expect(response.json().variables).toEqual([{ name: "PUBLIC_URL", source: "platform", value: "https://dev.example.com/orders" }])
    })

    it("given no project header, when the variables are read, then it is refused before the service is asked", async () => {
        const response = await app.inject({ method: "GET", url: `/backends/${CONTAINER}/environments/${ENVIRONMENT}/variables` })

        expect(response.statusCode).toBeGreaterThanOrEqual(400)
        expect(get).not.toHaveBeenCalled()
    })
})
