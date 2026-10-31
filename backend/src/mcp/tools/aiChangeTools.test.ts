import { beforeEach, describe, expect, it, vi } from "vitest"
import UserCannotAccessThisProjectError from "../../errors/UserCannotAccessThisProjectError"
import { McpSession, McpToolContext } from "../toolDefinition"
import { aiChangeTools } from "./aiChangeTools"

const listChanges = vi.fn()
const getChange = vi.fn()
const getJob = vi.fn()
const availableForProject = vi.fn()
const listJobs = vi.fn()
const planDomain = vi.fn()

const { constructed } = vi.hoisted(() => ({ constructed: [] as unknown[][] }))

vi.mock("../..", () => ({ fastify: { config: { AI_PROVIDER: "anthropic" } } }))
vi.mock("../../service/aiChange/AiChangeService", () => ({
    default: class {
        constructor(...args: unknown[]) {
            constructed.push(args)
        }
        list = (...args: unknown[]) => listChanges(...args)
        get = (...args: unknown[]) => getChange(...args)
    }
}))

vi.mock("../../service/AiModelService", () => ({
    default: class {
        availableForProject = (...args: unknown[]) => availableForProject(...args)
    }
}))

vi.mock("../../service/aiChange/DomainPlanService", () => ({
    default: class {
        plan = (...args: unknown[]) => planDomain(...args)
    }
}))

vi.mock("../../service/aiChange/AiChangeJobService", () => ({
    default: class {
        get = (...args: unknown[]) => getJob(...args)
        list = (...args: unknown[]) => listJobs(...args)
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const FRONTEND = "bbbbbbbbbbbbbbbbbbbbbbbb"
const BACKEND = "eeeeeeeeeeeeeeeeeeeeeeee"
const CHANGE = "cccccccccccccccccccccccc"
const JOB = "dddddddddddddddddddddddd"

const tool = (name: string) => aiChangeTools.find(candidate => candidate.name === name)!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "MEMBER" }],
        scopes: ["mfe:read", "mfe:write"],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

const run = (name: string, args: Record<string, unknown>) => tool(name).run(args as never, context())

const changeDocument = (status: string) => ({
    _id: { toString: () => CHANGE },
    jobId: JOB,
    frontendId: FRONTEND,
    status,
    prompt: "Add a footer",
    baseBranch: "main",
    summary: "Adds a footer",
    files: [{ path: "src/Footer.tsx", action: "create", proposedContent: "export const Footer = () => null", originalContent: "old" }],
    events: Array.from({ length: 15 }, (_, index) => ({ at: new Date(0), kind: "tool", message: `step ${index}` })),
    usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 300 },
    createdAt: new Date(0),
    updatedAt: new Date(0)
})

const jobView = (status: string) => ({
    _id: JOB,
    projectId: PROJECT,
    userId: "user-1",
    rootJobId: JOB,
    prompt: "Rename the price API",
    scope: "global",
    status,
    events: Array.from({ length: 15 }, (_, index) => ({ at: new Date(0), kind: "tool", message: `step ${index}` })),
    usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 300 },
    repositories: [
        {
            requestId: CHANGE,
            kind: "frontend",
            frontendId: FRONTEND,
            frontendName: "Cart",
            frontendSlug: "cart",
            status: "PROPOSED",
            files: [{ path: "src/Price.ts", action: "update" }]
        }
    ],
    createdAt: new Date(0),
    updatedAt: new Date(0)
})

describe("AI change tools", () => {
    beforeEach(() => {
        for (const mock of [listChanges, getChange, getJob, availableForProject, listJobs, planDomain]) {
            mock.mockReset()
        }
        constructed.length = 0
    })

    it("given their definitions, when read, then every one is console-only and none starts, applies or discards: the assistant does that with its agent runs", () => {
        for (const definition of aiChangeTools) {
            expect(definition.consoleOnly, definition.name).toBe(true)
            expect(definition.annotations.destructiveHint, definition.name).toBeFalsy()
        }
        expect(aiChangeTools.map(definition => definition.name)).toEqual(["ai_models_list", "ai_changes_list", "ai_change_get", "ai_domain_plan", "ai_jobs_list", "ai_job_get"])
    })

    /** A global job takes the backends too: their id must not read as a frontend's */
    it("given a job on a backend, when it is viewed, then the repository is named a backend with its backendId", async () => {
        const view = jobView("DONE")
        getJob.mockResolvedValue({ ...view, repositories: [{ ...view.repositories[0], kind: "backend", frontendName: "Orders API", frontendSlug: "orders-api" }] })

        const result = (await run("ai_job_get", { jobId: JOB })) as { repositories: Record<string, unknown>[] }

        expect(result.repositories[0]).toMatchObject({ kind: "backend", backendId: FRONTEND, backend: "Orders API" })
        expect(result.repositories[0]).not.toHaveProperty("frontendId")
        expect(result.repositories[0]).not.toHaveProperty("frontend")
    })

    describe("ai_changes_list", () => {
        it("given a frontend, when listed, then each change is a view", async () => {
            listChanges.mockResolvedValue([changeDocument("PROPOSED")])

            expect(await run("ai_changes_list", { frontendId: FRONTEND })).toEqual([expect.objectContaining({ id: CHANGE, status: "PROPOSED" })])
            expect(listChanges).toHaveBeenCalledWith({ kind: "frontend", id: FRONTEND })
        })

        it("given a backend, when listed, then the changes of the backend are", async () => {
            listChanges.mockResolvedValue([])

            await run("ai_changes_list", { backendId: BACKEND })

            expect(listChanges).toHaveBeenCalledWith({ kind: "backend", id: BACKEND })
            expect(tool("ai_changes_list").inputSchema.safeParse({}).success).toBe(false)
        })

        it("given changes read without their progress, when listed, then the view has no progress rather than an empty one", async () => {
            const { events: _events, ...withoutEvents } = changeDocument("PROPOSED")
            listChanges.mockResolvedValue([withoutEvents])

            const [change] = (await run("ai_changes_list", { frontendId: FRONTEND })) as Record<string, unknown>[]

            expect(change).not.toHaveProperty("recentEvents")
        })

        it("given a frontend of another project, when listed, then the refusal surfaces", async () => {
            listChanges.mockRejectedValue(new UserCannotAccessThisProjectError())

            await expect(run("ai_changes_list", { frontendId: FRONTEND })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
        })
    })

    describe("ai_change_get", () => {
        it("given a change, when read, then its status and files are returned", async () => {
            getChange.mockResolvedValue(changeDocument("PROPOSED"))

            expect(await run("ai_change_get", { changeId: CHANGE })).toMatchObject({ id: CHANGE, status: "PROPOSED", summary: "Adds a footer" })
            expect(getChange).toHaveBeenCalledWith(CHANGE)
        })

        it("given a change of another project, when read, then the refusal surfaces", async () => {
            getChange.mockRejectedValue(new UserCannotAccessThisProjectError())

            await expect(run("ai_change_get", { changeId: CHANGE })).rejects.toBeInstanceOf(UserCannotAccessThisProjectError)
        })
    })

    describe("AI models", () => {
        it("given the tool's project, when its AIs are listed, then they come with the default", async () => {
            const available = { models: [{ id: "system", name: "System", provider: "anthropic", model: "claude-opus-5-5", system: true, isDefault: false, efforts: ["low"] }], defaultId: "system" }
            availableForProject.mockResolvedValue(available)

            expect(await run("ai_models_list", {})).toEqual(available)
            expect(availableForProject).toHaveBeenCalledWith(PROJECT)
            expect(tool("ai_models_list").annotations).toMatchObject({ readOnlyHint: true })
        })
    })

    describe("progress", () => {
        it("given progress with the agent's reasoning, when viewed, then the reasoning is left out and the latest steps fill the view", async () => {
            const events = Array.from({ length: 12 }, (_, index) => [
                { at: new Date(0), kind: "tool", message: `step ${index}` },
                { at: new Date(0), kind: "thinking", message: "x".repeat(1_000) }
            ]).flat()
            getChange.mockResolvedValue({ ...changeDocument("RUNNING"), events })
            getJob.mockResolvedValue({ ...jobView("RUNNING"), events })

            const change = (await run("ai_change_get", { changeId: CHANGE })) as { recentEvents: { kind: string; message: string }[] }
            const job = (await run("ai_job_get", { jobId: JOB })) as { recentEvents: { kind: string; message: string }[] }

            for (const view of [change, job]) {
                expect(view.recentEvents.map(entry => entry.message)).toEqual(Array.from({ length: 10 }, (_, index) => `step ${index + 2}`))
            }
        })
    })

    describe("ai_job_get", () => {
        it("given a job, when read, then its status and usage are returned", async () => {
            getJob.mockResolvedValue(jobView("DONE"))

            expect(await run("ai_job_get", { jobId: JOB })).toMatchObject({ jobId: JOB, status: "DONE", usage: { outputTokens: 300 } })
            expect(getJob).toHaveBeenCalledWith(JOB)
        })
    })

    describe("ai_jobs_list", () => {
        it("given active, when listed, then the caller's active jobs of the project come back without progress", async () => {
            const { events: _events, ...withoutEvents } = jobView("RUNNING")
            listJobs.mockResolvedValue([withoutEvents])

            const [job] = (await run("ai_jobs_list", { active: true })) as Record<string, unknown>[]

            expect(listJobs).toHaveBeenCalledWith(PROJECT, true)
            expect(job).toMatchObject({ jobId: JOB, status: "RUNNING" })
            expect(job).not.toHaveProperty("recentEvents")
        })
    })

    describe("ai_domain_plan", () => {
        it("given a domain and a request, when planned, then the plan comes back and nothing is written", async () => {
            const plan = { frontends: [{ name: "Orders", slug: "orders", template: "vite-react", repositoryName: "orders-fe" }], backends: [] }
            planDomain.mockResolvedValue(plan)

            expect(await run("ai_domain_plan", { domainId: FRONTEND, prompt: "Track orders" })).toEqual(plan)
            expect(planDomain).toHaveBeenCalledWith(PROJECT, { domainId: FRONTEND, prompt: "Track orders" })
            expect(tool("ai_domain_plan").annotations).toMatchObject({ destructiveHint: false })
        })
    })
})
