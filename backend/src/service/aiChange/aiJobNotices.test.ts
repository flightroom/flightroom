import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"

const { log } = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("../..", () => ({ fastify: { log, config: {} } }))

import AiChangeJob, { AiJobStatus } from "../../models/AiChangeJobModel"
import Backend from "../../models/BackendModel"
import Domain from "../../models/DomainModel"
import Frontend from "../../models/FrontendModel"
import Project from "../../models/ProjectModel"
import User from "../../models/UserModel"
import type EmailSenderService from "../EmailSenderService"
import { notifyAiJobEnded } from "./aiJobNotices"

const MINUTE_MS = 60 * 1000
const now = new Date("2026-10-27T12:00:00Z")
const jobId = new Types.ObjectId()
const projectId = new Types.ObjectId()
const domainId = new Types.ObjectId()
const frontendId = new Types.ObjectId()
const backendId = new Types.ObjectId()
const project = { _id: projectId, name: "Shop" }

const aJob = (overrides: Record<string, unknown> = {}) => ({
    _id: jobId,
    rootJobId: jobId,
    projectId,
    userId: new Types.ObjectId(),
    prompt: "Add a  checkout\npage",
    title: "Checkout page",
    scope: "selection",
    frontendIds: [frontendId],
    backendIds: [],
    status: AiJobStatus.DONE,
    ...overrides
})

const aUser = (minutesAgo?: number) => ({
    email: "dev@example.com",
    name: "Dev",
    status: "ACTIVE",
    lastSeenAt: minutesAgo === undefined ? undefined : new Date(now.getTime() - minutesAgo * MINUTE_MS)
})

let send: MockInstance
let emailSender: EmailSenderService

const withJob = (job: ReturnType<typeof aJob> | null) => vi.spyOn(AiChangeJob, "findById").mockResolvedValue(job as never)
const withUser = (user: ReturnType<typeof aUser>) => vi.spyOn(User, "findById").mockResolvedValue(user as never)

beforeEach(() => {
    send = vi.fn().mockResolvedValue(undefined) as unknown as MockInstance
    emailSender = { canSendEmails: () => true, sendAiJobEndedEmail: send } as unknown as EmailSenderService
    vi.spyOn(Project, "findById").mockResolvedValue(project as never)
    vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, name: "Storefront" } as never)
    vi.spyOn(Backend, "findOne").mockResolvedValue({ _id: backendId, name: "Orders" } as never)
    vi.spyOn(Domain, "findOne").mockResolvedValue({ _id: domainId, name: "Payments" } as never)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("notifyAiJobEnded", () => {
    it("given a job on one frontend done while its user was away, when it ends, then they get an email pointing at the frontend", async () => {
        withJob(aJob())
        const user = aUser(10)
        withUser(user)

        expect(await notifyAiJobEnded(jobId as never, emailSender, now)).toBe(true)
        expect(send).toHaveBeenCalledWith(user, project, { label: "Checkout page", failed: false, target: { kind: "frontend", name: "Storefront" }, path: `/frontend/${frontendId}` })
    })

    it("given a domain job that failed while its user never opened the console, when it ends, then the email points at the domain", async () => {
        withJob(aJob({ scope: "domain", domainId, backendIds: [backendId], status: AiJobStatus.FAILED }))
        withUser(aUser())

        await notifyAiJobEnded(jobId as never, emailSender, now)
        expect(send).toHaveBeenCalledWith(expect.anything(), project, expect.objectContaining({ failed: true, target: { kind: "domain", name: "Payments" }, path: `/domain/${domainId}` }))
    })

    it("given a job on a single backend, when it ends, then the email points at the backend", async () => {
        withJob(aJob({ frontendIds: [], backendIds: [backendId] }))
        withUser(aUser(10))

        await notifyAiJobEnded(jobId as never, emailSender, now)
        expect(send).toHaveBeenCalledWith(expect.anything(), project, expect.objectContaining({ target: { kind: "backend", name: "Orders" }, path: `/backend/${backendId}` }))
    })

    it("given an untitled job on several repositories, when it ends, then the email names it by its prompt and points at the assistant", async () => {
        withJob(aJob({ title: undefined, backendIds: [backendId] }))
        withUser(aUser(10))

        await notifyAiJobEnded(jobId as never, emailSender, now)
        expect(send).toHaveBeenCalledWith(expect.anything(), project, { label: "Add a checkout page", failed: false, target: { kind: "repositories", count: 2 }, path: "/assistant" })
    })

    it("given a follow-up without a title, when it ends, then the email names it by the title of its chain", async () => {
        const rootJobId = new Types.ObjectId()
        vi.spyOn(AiChangeJob, "findById")
            .mockResolvedValueOnce(aJob({ title: undefined, rootJobId }) as never)
            .mockResolvedValueOnce({ title: "Checkout page" } as never)
        withUser(aUser(10))

        await notifyAiJobEnded(jobId as never, emailSender, now)
        expect(send).toHaveBeenCalledWith(expect.anything(), project, expect.objectContaining({ label: "Checkout page" }))
    })

    it("given the user was at the console a minute ago, when the job ends, then no email is sent", async () => {
        withJob(aJob())
        withUser(aUser(1))

        expect(await notifyAiJobEnded(jobId as never, emailSender, now)).toBe(false)
        expect(send).not.toHaveBeenCalled()
    })

    it.each([
        ["stopped by the user", { status: AiJobStatus.FAILED, stoppedAt: now }],
        ["part of a mission", { missionId: new Types.ObjectId() }],
        ["still running", { status: AiJobStatus.RUNNING }]
    ])("given a job %s, when it is reported as ended, then no email is sent", async (_, overrides) => {
        withJob(aJob(overrides))
        withUser(aUser(10))

        expect(await notifyAiJobEnded(jobId as never, emailSender, now)).toBe(false)
        expect(send).not.toHaveBeenCalled()
    })

    it("given no SMTP is configured, when a job ends, then nothing is read nor sent", async () => {
        const findById = withJob(aJob())

        expect(await notifyAiJobEnded(jobId as never, { canSendEmails: () => false } as unknown as EmailSenderService, now)).toBe(false)
        expect(findById).not.toHaveBeenCalled()
    })
})
