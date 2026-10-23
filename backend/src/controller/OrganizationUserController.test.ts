import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import organizationUserController from "./OrganizationUserController"

const addUserToOrganizationByEmail = vi.fn()
const updateRole = vi.fn()
const resendInvitation = vi.fn()

vi.mock("../service/UserOrganizationService", () => ({
    default: class {
        addUserToOrganizationByEmail = addUserToOrganizationByEmail
        updateRole = updateRole
        resendInvitation = resendInvitation
    }
}))

const ORGANIZATION = "aaaaaaaaaaaaaaaaaaaaaaaa"
const MEMBER = "bbbbbbbbbbbbbbbbbbbbbbbb"

describe("OrganizationUserController", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        const invitation = { userId: MEMBER, organizationId: ORGANIZATION, role: "MEMBER", invitationToken: "secret-token" }
        for (const mock of [addUserToOrganizationByEmail, updateRole, resendInvitation]) mock.mockReset().mockResolvedValue(invitation)
        app = Fastify()
        await app.register(organizationUserController)
    })

    afterEach(async () => {
        await app.close()
    })

    /** Whoever holds the token can accept the invitation, set the password of the invited account and sign in as them. */
    it("Given a pending invitation, when it is sent, sent again or its role changes, then the answer never carries the invitation token", async () => {
        const responses = [
            await app.inject({ method: "POST", url: `/organizations/${ORGANIZATION}/users`, payload: { email: "new@example.com", role: "MEMBER" } }),
            await app.inject({ method: "POST", url: `/organizations/${ORGANIZATION}/users/${MEMBER}/resend-invitation` }),
            await app.inject({ method: "PUT", url: `/organizations/${ORGANIZATION}/users/${MEMBER}`, payload: { role: "ADMIN" } })
        ]

        for (const response of responses) {
            expect(response.statusCode).toBe(200)
            expect(response.json()).toEqual({ userId: MEMBER, organizationId: ORGANIZATION, role: "MEMBER", invitationPending: true })
            expect(response.body).not.toContain("secret-token")
        }
    })
})
