import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const register = vi.fn()
const getProfile = vi.fn()

vi.mock("../service/UserService", () => ({
    default: class {
        register = register
        getProfile = getProfile
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

/** The console shows the installation page to its administrators only: the profile says who they are. */
describe("UserController profile", () => {
    let app: FastifyInstance

    const profileOf = async (email: string, admins?: string) => {
        app = Fastify()
        app.decorate("config", { INSTALLATION_ADMINS: admins } as unknown as FastifyInstance["config"])
        app.addHook("onRequest", async request => {
            ;(request as unknown as { databaseUser: { _id: string; email: string } }).databaseUser = { _id: "user-1", email }
        })
        await app.register(errorHandler)
        await app.register(UserController)
        await app.ready()
        return (await app.inject({ method: "GET", url: "/users/profile" })).json()
    }

    beforeEach(() => {
        getProfile.mockReset().mockResolvedValue({ _id: "user-1", email: "ops@example.com", role: "admin" })
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given a user among INSTALLATION_ADMINS, when they read their profile, then it says they administer the installation", async () => {
        expect(await profileOf("ops@example.com", "admin@example.com, OPS@example.com")).toMatchObject({ email: "ops@example.com", installationAdmin: true })
    })

    it("Given a user not listed, even with the admin role, or no list at all, when they read their profile, then it says they do not", async () => {
        expect((await profileOf("ops@example.com", "admin@example.com")).installationAdmin).toBe(false)
        await app.close()
        expect((await profileOf("ops@example.com")).installationAdmin).toBe(false)
    })
})
