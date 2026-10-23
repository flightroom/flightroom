import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBusinessException } from "../errors/BusinessException"
import projectUserController from "./ProjectUserController"

const updateUserRole = vi.fn()
const removeUserFromProject = vi.fn()
const addUserToProjectByEmail = vi.fn()
const resendInvitation = vi.fn()

vi.mock("../service/UserProjectService", () => ({
    PROJECT_LAST_OWNER: "PROJECT_LAST_OWNER",
    default: class {
        updateUserRole = updateUserRole
        removeUserFromProject = removeUserFromProject
        addUserToProjectByEmail = addUserToProjectByEmail
        resendInvitation = resendInvitation
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const MEMBER = "bbbbbbbbbbbbbbbbbbbbbbbb"

describe("ProjectUserController", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        updateUserRole.mockReset()
        removeUserFromProject.mockReset()
        addUserToProjectByEmail.mockReset()
        resendInvitation.mockReset()
        app = Fastify()
        await app.register(projectUserController)
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given a role change, when it succeeds, then the backend's membership comes back with the usual message", async () => {
        updateUserRole.mockResolvedValue({ userId: MEMBER, role: "VIEWER" })

        const response = await app.inject({ method: "PUT", url: `/projects/${PROJECT}/users/${MEMBER}`, payload: { role: "VIEWER" } })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: "User role updated successfully",
            userProject: { userId: MEMBER, role: "VIEWER", domainIds: [], domainScoped: false, invitationPending: false, aiTokenLimit: null }
        })
        expect(updateUserRole).toHaveBeenCalledWith(PROJECT, MEMBER, "VIEWER", undefined, undefined)
    })

    it("Given a monthly AI token limit with the role, when saved, then it reaches the service; null to take it away", async () => {
        updateUserRole.mockResolvedValue({ userId: MEMBER, role: "MEMBER", aiTokenLimit: 100000 })

        await app.inject({ method: "PUT", url: `/projects/${PROJECT}/users/${MEMBER}`, payload: { role: "MEMBER", aiTokenLimit: 100000 } })
        await app.inject({ method: "PUT", url: `/projects/${PROJECT}/users/${MEMBER}`, payload: { role: "MEMBER", aiTokenLimit: null } })

        expect(updateUserRole).toHaveBeenNthCalledWith(1, PROJECT, MEMBER, "MEMBER", undefined, 100000)
        expect(updateUserRole).toHaveBeenNthCalledWith(2, PROJECT, MEMBER, "MEMBER", undefined, null)
    })

    /** Whoever holds the token can accept the invitation, set the password of the invited account and sign in as them. */
    it("Given a pending invitation, when its role changes, then the answer never carries the invitation token", async () => {
        updateUserRole.mockResolvedValue({ userId: MEMBER, role: "VIEWER", invitationToken: "secret-token", inviationTokenExpiresAt: new Date("2027-01-01") })

        const response = await app.inject({ method: "PUT", url: `/projects/${PROJECT}/users/${MEMBER}`, payload: { role: "VIEWER" } })

        expect(response.json().userProject).toMatchObject({ invitationPending: true })
        expect(response.body).not.toContain("secret-token")
    })

    it("Given an invitation, when it is sent or sent again, then the answer never carries the invitation token", async () => {
        const invitation = { userId: MEMBER, role: "MEMBER", invitationToken: "secret-token" }
        addUserToProjectByEmail.mockResolvedValue(invitation)
        resendInvitation.mockResolvedValue(invitation)

        const invited = await app.inject({ method: "POST", url: `/projects/${PROJECT}/users`, payload: { email: "new@example.com", role: "MEMBER" } })
        const resent = await app.inject({ method: "POST", url: `/projects/${PROJECT}/users/${MEMBER}/resend-invitation` })

        for (const response of [invited, resent]) {
            expect(response.statusCode).toBe(200)
            expect(response.json()).toMatchObject({ userId: MEMBER, invitationPending: true })
            expect(response.body).not.toContain("secret-token")
        }
    })

    it("Given a removal, when it succeeds, then the answer is empty", async () => {
        removeUserFromProject.mockResolvedValue(undefined)

        const response = await app.inject({ method: "DELETE", url: `/projects/${PROJECT}/users/${MEMBER}` })

        expect(response.statusCode).toBe(204)
        expect(removeUserFromProject).toHaveBeenCalledWith(PROJECT, MEMBER)
    })

    /** The console toasts `message` of the answer as it is. */
    it("Given the last owner, when removed, then the refusal keeps the shape the console reads", async () => {
        removeUserFromProject.mockRejectedValue(createBusinessException({ code: "PROJECT_LAST_OWNER", message: "Cannot remove the last owner of the project." }))

        const response = await app.inject({ method: "DELETE", url: `/projects/${PROJECT}/users/${MEMBER}` })

        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({ message: "Cannot remove the last owner of the project." })
    })

    it("Given a user who does not own the project, when they remove a member, then the refusal is not swallowed", async () => {
        removeUserFromProject.mockRejectedValue(createBusinessException({ code: "PROJECT_OWNER_REQUIRED", message: "Only an owner", statusCode: 403 }))

        const response = await app.inject({ method: "DELETE", url: `/projects/${PROJECT}/users/${MEMBER}` })

        expect(response.statusCode).toBe(403)
    })
})
