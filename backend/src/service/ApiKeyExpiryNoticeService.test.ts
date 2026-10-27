import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"

const { log } = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("..", () => ({ fastify: { log, config: {} } }))

import ApiKey from "../models/ApiKeyModel"
import Project from "../models/ProjectModel"
import User from "../models/UserModel"
import UserOrganization from "../models/UserOrganizationModel"
import UserProject from "../models/UserProjectModel"
import { notifyExpiringApiKeys } from "./ApiKeyExpiryNoticeService"
import type EmailSenderService from "./EmailSenderService"

const DAY_MS = 24 * 60 * 60 * 1000
const now = new Date("2026-10-27T12:00:00Z")
const projectId = new Types.ObjectId()
const organizationId = new Types.ObjectId()
const project = { _id: projectId, name: "Demo Project", organizationId }
const owner = { _id: new Types.ObjectId(), email: "owner@example.com" }
const orgAdmin = { _id: new Types.ObjectId(), email: "admin@example.com" }

const aKey = (daysLeft: number, expiryNoticeDays?: number) => ({
    _id: new Types.ObjectId(),
    name: "CI deploy",
    projectId,
    expiresAt: new Date(now.getTime() + daysLeft * DAY_MS),
    expiryNoticeDays
})

let send: MockInstance
let emailSender: EmailSenderService
let updateOne: MockInstance
let userFind: MockInstance

beforeEach(() => {
    send = vi.fn().mockResolvedValue(undefined) as unknown as MockInstance
    emailSender = { canSendEmails: () => true, sendApiKeyExpiryEmail: send } as unknown as EmailSenderService
    updateOne = vi.spyOn(ApiKey, "updateOne").mockResolvedValue({ modifiedCount: 1 } as never)
    vi.spyOn(Project, "findById").mockResolvedValue(project as never)
    vi.spyOn(UserProject, "find").mockResolvedValue([{ userId: owner._id }] as never)
    vi.spyOn(UserOrganization, "find").mockResolvedValue([{ userId: orgAdmin._id }] as never)
    userFind = vi.spyOn(User, "find").mockResolvedValue([owner, orgAdmin] as never)
})

afterEach(() => {
    vi.restoreAllMocks()
})

const withKeys = (...keys: ReturnType<typeof aKey>[]) => vi.spyOn(ApiKey, "find").mockResolvedValue(keys as never)

describe("notifyExpiringApiKeys", () => {
    it("given a key 20 days from expiry never warned, when the tick runs, then the project owners and organization admins get the 30 days notice", async () => {
        withKeys(aKey(20))
        await notifyExpiringApiKeys(emailSender, now)

        expect(updateOne).toHaveBeenCalledWith(expect.objectContaining({ expiryNoticeDays: null }), { $set: { expiryNoticeDays: 30 } })
        expect(userFind.mock.calls[0][0]).toEqual({ _id: { $in: [owner._id, orgAdmin._id] }, status: "ACTIVE" })
        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenCalledWith(owner, project, expect.objectContaining({ name: "CI deploy" }), 20)
    })

    it("given a key warned at 30 days now 5 days from expiry, when the tick runs, then the 7 days notice goes out", async () => {
        withKeys(aKey(5, 30))
        await notifyExpiringApiKeys(emailSender, now)

        expect(updateOne).toHaveBeenCalledWith(expect.objectContaining({ expiryNoticeDays: 30 }), { $set: { expiryNoticeDays: 7 } })
        expect(send).toHaveBeenCalledTimes(2)
    })

    it("given a key already warned for its window, when the tick runs, then nothing is sent again", async () => {
        withKeys(aKey(20, 30), aKey(3, 7))
        await notifyExpiringApiKeys(emailSender, now)

        expect(updateOne).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it("given another replica claimed the notice first, when the tick runs, then this one does not send it", async () => {
        withKeys(aKey(20))
        updateOne.mockResolvedValue({ modifiedCount: 0 } as never)
        await notifyExpiringApiKeys(emailSender, now)

        expect(send).not.toHaveBeenCalled()
    })

    it("given no administrator received the notice, when the tick runs, then the claim is given back for the next tick", async () => {
        const key = aKey(20)
        withKeys(key)
        send.mockRejectedValue(new Error("SMTP down"))
        await notifyExpiringApiKeys(emailSender, now)

        expect(updateOne).toHaveBeenLastCalledWith({ _id: key._id, expiryNoticeDays: 30 }, { $unset: { expiryNoticeDays: 1 } })
    })

    it("given email is not configured, when the tick runs, then no key is even looked at", async () => {
        const find = withKeys(aKey(20))
        await notifyExpiringApiKeys({ canSendEmails: () => false } as unknown as EmailSenderService, now)

        expect(find).not.toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })
})
