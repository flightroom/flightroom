import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const register = vi.fn()

vi.mock("../service/UserService", () => ({
    default: class {
        register = register
    }
}))

import errorHandler from "../plugins/errorHandler"
import UserController from "./UserController"

/**
 * REGISTRATION_ALLOWED used to only hide the Register link in the console: the route itself
 * stayed open, so with registration turned off anyone could still sign up by calling the API.
 */
describe("UserController registration", () => {
    let app: FastifyInstance

    const aRegistration = { email: "newcomer@example.com", password: "a-strong-password" }

    const anInstallation = async (config: { REGISTRATION_ALLOWED: boolean; ALLOW_EMBEDDED_LOGIN: boolean }) => {
        app = Fastify()
        app.decorate("config", config as unknown as FastifyInstance["config"])
        await app.register(errorHandler)
        await app.register(UserController)
        await app.ready()
    }

    beforeEach(() => {
        register.mockReset()
        register.mockResolvedValue({ toFrontendObject: () => ({ _id: "user-1", email: aRegistration.email }) })
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given registration allowed with the embedded login, when a registration is posted, then the user is created", async () => {
        await anInstallation({ REGISTRATION_ALLOWED: true, ALLOW_EMBEDDED_LOGIN: true })

        const response = await app.inject({ method: "POST", url: "/users/registration", payload: aRegistration })

        expect(response.statusCode).toBe(200)
        expect(register).toHaveBeenCalledTimes(1)
    })

    it("Given registration turned off, when a registration is posted, then it is refused and no user is created", async () => {
        await anInstallation({ REGISTRATION_ALLOWED: false, ALLOW_EMBEDDED_LOGIN: true })

        const response = await app.inject({ method: "POST", url: "/users/registration", payload: aRegistration })

        expect(response.statusCode).toBe(403)
        expect(response.json().error.code).toBe("REGISTRATION_NOT_ALLOWED")
        expect(register).not.toHaveBeenCalled()
    })

    it("Given the embedded login turned off, when a registration is posted, then it is refused like in the console", async () => {
        await anInstallation({ REGISTRATION_ALLOWED: true, ALLOW_EMBEDDED_LOGIN: false })

        const response = await app.inject({ method: "POST", url: "/users/registration", payload: aRegistration })

        expect(response.statusCode).toBe(403)
        expect(register).not.toHaveBeenCalled()
    })
})
