import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { log } = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("../..", () => ({ fastify: { log, config: { REPOSITORIES_FOLDER: "/tmp/repos", REPOSITORIES_MAX_SIZE_MB: 500 } } }))

const workspaces = new Map<string, { target: unknown; workingCopy: Record<string, unknown>; defaultBranch: string }>()
const workspaceService = {
    open: vi.fn(async (component: { _id: unknown }) => workspaces.get(String(component._id))!),
    prepare: vi.fn(async () => "base-commit")
}
vi.mock("../workspace/RepositoryWorkspaceService", () => ({
    // A function, not an arrow: the service calls it with `new`.
    default: vi.fn(function RepositoryWorkspaceService() {
        return workspaceService
    })
}))

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }))
vi.mock("./aiChangeAgent", async importOriginal => ({ ...(await importOriginal<typeof import("./aiChangeAgent")>()), runAiChangeAgent: runAgent }))

import AiChangeJob, { AiJobStatus } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AiChangeStatus } from "../../models/AiChangeRequestModel"
import AiMission from "../../models/AiMissionModel"
import AiModel from "../../models/AiModelModel"
import AiUsage from "../../models/AiUsageModel"
import Backend from "../../models/BackendModel"
import CodeRepository, { CodeRepositoryProvider } from "../../models/CodeRepositoryModel"
import Domain from "../../models/DomainModel"
import Environment from "../../models/EnvironmentModel"
import Frontend from "../../models/FrontendModel"
import Organization from "../../models/OrganizationModel"
import Project from "../../models/ProjectModel"
import Resource from "../../models/ResourceModel"
import User, { IUser } from "../../models/UserModel"
import UserProject, { RoleInProject } from "../../models/UserProjectModel"
import { ConfigMap, Secret } from "../../models/VariableMapModel"
import { withNoMaintenanceAgents } from "../../testing/noMaintenanceAgents"
import BaseAuthorizedService from "../BaseAuthorizedService"
import { LlmClient } from "../llm"
import { AnthropicLlmClient } from "../llm/anthropicProvider"
import { RepositoryFileService } from "../RepositoryFileService"
import AiChangeJobService from "./AiChangeJobService"
import AiMissionService from "./AiMissionService"

withNoMaintenanceAgents()

type WithGates = { ensureAccessToProject: () => Promise<void>; isOrganizationAdmin: () => Promise<boolean> }
type WithProcess = { process: (jobId: string, client: LlmClient) => Promise<void> }
type WithApplyClaimed = { applyClaimed: (request: unknown, files: unknown) => Promise<unknown> }

const user = { _id: new Types.ObjectId(), email: "ada@example.com", name: "Ada" } as unknown as IUser
const projectId = new Types.ObjectId().toString()

const frontend = (slug: string, name: string) => ({ _id: new Types.ObjectId(), projectId, slug, name, stack: { framework: "REACT" }, context: `${name} context` })
const catalog = frontend("catalog", "Catalog")
const cart = frontend("cart", "Cart")
const connectionId = new Types.ObjectId()
// Shares its slug with the catalog frontend: a backend and a frontend may.
const catalogApi = {
    _id: new Types.ObjectId(),
    projectId,
    slug: "catalog",
    name: "Catalog API",
    stack: { runtime: "NODE", framework: "Express" },
    port: 3000,
    livenessPath: "/healthz/live",
    readinessPath: "/healthz/ready",
    docsPath: "/docs",
    env: [{ name: "DATABASE_URL", required: true, secret: true, description: "Postgres connection string" }],
    codeRepository: { enabled: true, codeRepositoryId: connectionId, name: "catalog-api" }
}

interface Update {
    model: string
    filter: Record<string, unknown>
    update: Record<string, unknown>
}

/** The progress lines pushed by the recorded updates, in order. */
/** The filter and projection of the first call of a find, its ids as text: they reach Mongo cast by toObjectId */
const firstQuery = (find: unknown) => {
    const [filter, projection] = vi.mocked(find as (...args: unknown[]) => unknown).mock.calls[0] as [{ _id?: { $in: unknown[] } } & Record<string, unknown>, unknown]
    return [{ ...filter, ...(filter._id && { _id: { $in: filter._id.$in.map(String) } }) }, projection]
}

const pushed = (updates: Update[]) => updates.flatMap(({ update }) => ((update.$push as { events?: { $each: { message: string }[] } } | undefined)?.events?.$each ?? []).map(entry => entry.message))

describe("AiChangeJobService", () => {
    let role: RoleInProject
    let frontends: ReturnType<typeof frontend>[]
    let withRepository: ReturnType<typeof frontend>[]
    let backends: (typeof catalogApi)[]
    let activeJobs: number
    let updates: Update[]

    beforeEach(() => {
        role = RoleInProject.MEMBER
        frontends = [catalog, cart]
        withRepository = [catalog, cart]
        backends = []
        activeJobs = 0
        updates = []
        const gates = BaseAuthorizedService.prototype as unknown as WithGates
        vi.spyOn(gates, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(gates, "isOrganizationAdmin").mockResolvedValue(false)
        vi.spyOn(UserProject, "findOne").mockImplementation((() => Promise.resolve({ role })) as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId(), name: "Shop", context: "Shop context" } as never)
        // The organization defines no AI: the system one, from the configuration the service is given, answers
        vi.spyOn(AiModel, "find").mockResolvedValue([] as never)
        vi.spyOn(AiUsage, "create").mockResolvedValue({} as never)
        vi.spyOn(RepositoryFileService.prototype, "resolveTargets").mockImplementation(async () =>
            withRepository.map(candidate => ({ frontend: candidate, codeRepository: { projectId }, repositoryName: candidate.slug }) as never)
        )
        vi.spyOn(Frontend, "find").mockImplementation(((filter: { _id: { $in: unknown[] } }) =>
            Promise.resolve(frontends.filter(candidate => filter._id.$in.map(String).includes(String(candidate._id))))) as never)
        // By id for the components of a job, by project for the backends a global job covers.
        vi.spyOn(Backend, "find").mockImplementation(((filter: { _id?: { $in: unknown[] } }) =>
            Promise.resolve(filter._id ? backends.filter(candidate => filter._id!.$in.map(String).includes(String(candidate._id))) : backends)) as never)
        vi.spyOn(CodeRepository, "find").mockResolvedValue([{ _id: connectionId, projectId, provider: CodeRepositoryProvider.GITHUB }] as never)
        vi.spyOn(AiChangeJob, "exists").mockResolvedValue(null as never)
        vi.spyOn(AiChangeRequest, "exists").mockResolvedValue(null as never)
        vi.spyOn(AiChangeJob, "countDocuments").mockImplementation((() => Promise.resolve(activeJobs)) as never)
        vi.spyOn(AiMission, "countDocuments").mockResolvedValue(0 as never)
        // No mission running: what the cap moves on before refusing.
        vi.spyOn(AiMission, "find").mockResolvedValue([] as never)
        vi.spyOn(AiChangeJob, "create").mockImplementation(((document: Record<string, unknown>) => Promise.resolve({ ...document, createdAt: new Date(), updatedAt: new Date() })) as never)
        vi.spyOn(AiChangeRequest, "create").mockImplementation(((document: Record<string, unknown>) => Promise.resolve({ _id: new Types.ObjectId(), files: [], ...document })) as never)
        for (const [model, target] of [
            ["job", AiChangeJob],
            ["request", AiChangeRequest]
        ] as const) {
            const record = (filter: Record<string, unknown>, update: Record<string, unknown>) => {
                updates.push({ model, filter, update })
                return Promise.resolve({ ...filter, ...update })
            }
            vi.spyOn(target as typeof AiChangeRequest, "updateOne").mockImplementation(record as never)
            vi.spyOn(target as typeof AiChangeRequest, "updateMany").mockImplementation(record as never)
            vi.spyOn(target as typeof AiChangeRequest, "findOneAndUpdate").mockImplementation(record as never)
        }
        for (const candidate of frontends) {
            workspaces.set(String(candidate._id), { target: {}, workingCopy: { dir: `/tmp/repos/${candidate.slug}` }, defaultBranch: "main" })
        }
        workspaces.set(String(catalogApi._id), { target: {}, workingCopy: { dir: "/tmp/repos/catalog.service" }, defaultBranch: "main" })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
        workspaces.clear()
    })

    const service = () => new AiChangeJobService(user, { ANTHROPIC_API_KEY: "sk-test" })

    /** Two AIs of the organization, the second marked as its default. */
    const orgModels = () => {
        const model = (name: string, isDefault: boolean) => ({ _id: new Types.ObjectId(), name, provider: "anthropic", config: { apiKey: "sk-org" }, isDefault, updatedAt: new Date(0) })
        const models = [model("Claude Sonnet", false), model("Claude Opus", true)]
        vi.spyOn(AiModel, "find").mockResolvedValue(models as never)
        return { sonnet: String(models[0]._id), opus: String(models[1]._id) }
    }

    describe("create", () => {
        beforeEach(() => {
            // The agent itself is covered below: here only what create decides.
            vi.spyOn(AiChangeJobService.prototype as unknown as WithProcess, "process").mockResolvedValue(undefined)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([] as never)
            vi.spyOn(AnthropicLlmClient.prototype, "json").mockResolvedValue({ name: "Price API rename" })
        })

        it("Given a viewer, when a job is started, then it is refused before anything is created", async () => {
            role = RoleInProject.VIEWER

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "global" })).rejects.toMatchObject({ code: "AI_CHANGE_FORBIDDEN", statusCode: 403 })
            expect(AiChangeJob.create).not.toHaveBeenCalled()
        })

        it("Given more than 10 frontends with a repository, when a global job is started, then it asks to select them", async () => {
            withRepository = Array.from({ length: 11 }, (_, index) => frontend(`mfe-${index}`, `Mfe ${index}`))

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "global" })).rejects.toMatchObject({ code: "AI_JOB_TOO_MANY_REPOSITORIES", statusCode: 422 })
            expect(AiChangeJob.create).not.toHaveBeenCalled()
        })

        it("Given 11 selected frontends, when the job is started, then it is refused", async () => {
            const ids = Array.from({ length: 11 }, () => new Types.ObjectId().toString())

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "selection", frontendIds: ids })).rejects.toMatchObject({ code: "AI_JOB_TOO_MANY_REPOSITORIES" })
        })

        it("Given no frontend with a repository, when a global job is started, then it is refused", async () => {
            withRepository = []

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "global" })).rejects.toMatchObject({ code: "AI_JOB_NO_REPOSITORIES", statusCode: 422 })
        })

        it("Given a selected frontend without a repository, when the job is started, then it is refused naming it", async () => {
            withRepository = [catalog]

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "selection", frontendIds: [String(catalog._id), String(cart._id)] })).rejects.toMatchObject({
                code: "AI_JOB_NO_REPOSITORIES",
                message: expect.stringContaining("Cart")
            })
        })

        it("Given 3 jobs already running in the project, when another is started, then it is refused", async () => {
            activeJobs = 3

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "global" })).rejects.toMatchObject({ code: "AI_CHANGE_TOO_MANY", statusCode: 429 })
        })

        it("Given 2 jobs and a mission running in the project, when another job is started, then the mission counts as one and the mission's jobs do not count", async () => {
            activeJobs = 2
            vi.spyOn(AiMission, "countDocuments").mockResolvedValue(1 as never)

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "global" })).rejects.toMatchObject({ code: "AI_CHANGE_TOO_MANY", statusCode: 429 })
            const [jobFilter] = (AiChangeJob.countDocuments as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
            expect(jobFilter).toMatchObject({ missionId: { $exists: false } })
        })

        it("Given the cap reached by a mission whose last job died unnoticed, when a job is started, then the mission is moved on first and the job starts once it ended", async () => {
            activeJobs = 2
            let missionRunning = true
            vi.spyOn(AiMission, "countDocuments").mockImplementation((() => Promise.resolve(missionRunning ? 1 : 0)) as never)
            const missionId = new Types.ObjectId()
            vi.spyOn(AiMission, "find").mockResolvedValue([{ _id: missionId }] as never)
            const advance = vi.spyOn(AiMissionService.prototype, "advance").mockImplementation(async () => {
                missionRunning = false
            })
            vi.spyOn(AiChangeJobService.prototype as unknown as WithProcess, "process").mockResolvedValue(undefined)

            await service().create(projectId, { prompt: "Rename the price API", scope: "global" })

            expect(advance).toHaveBeenCalledWith(String(missionId))
            expect(AiChangeJob.create).toHaveBeenCalled()
        })

        it("Given two selected frontends, when the job is started, then it is its own root and each repository gets a pending request on its default branch", async () => {
            const job = await service().create(projectId, { prompt: "Rename the price API", scope: "selection", frontendIds: [String(cart._id), String(catalog._id)] })

            expect(job).toMatchObject({ status: AiJobStatus.PENDING, scope: "selection", rootJobId: job._id, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } })
            const requests = (AiChangeRequest.create as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([document]) => document as Record<string, unknown>)
            expect(requests).toEqual([
                expect.objectContaining({ frontendId: cart._id, jobId: expect.anything(), jobRepositoryCount: 2, baseBranch: "main", status: AiChangeStatus.PENDING }),
                expect.objectContaining({ frontendId: catalog._id, jobRepositoryCount: 2 })
            ])
            // Each repository gets the feature branch of the conversation, named after the model's summary of the request.
            expect(requests.map(request => request.branch)).toEqual([
                expect.stringMatching(/^ai-feature\/price-api-rename-\d{8}-\d{6}$/),
                expect.stringMatching(/^ai-feature\/price-api-rename-\d{8}-\d{6}$/)
            ])
            expect(AnthropicLlmClient.prototype.json).toHaveBeenCalledTimes(1)
            expect(String(requests[0].jobId)).toBe(job._id)
        })

        it("Given a model that cannot name the branch, when the job is started, then the branch is named after the words of the request", async () => {
            vi.mocked(AnthropicLlmClient.prototype.json).mockRejectedValue(new Error("overloaded"))

            await service().create(projectId, { prompt: "Please rename the price API", scope: "selection", frontendIds: [String(cart._id)] })

            const [[request]] = (AiChangeRequest.create as unknown as ReturnType<typeof vi.fn>).mock.calls as [Record<string, unknown>][]
            expect(request.branch).toMatch(/^ai-feature\/rename-price-api-\d{8}-\d{6}$/)
        })

        it("Given a chosen effort, when the job is started, then the job and each of its requests keep it", async () => {
            const job = await service().create(projectId, { prompt: "Rename the price API", scope: "selection", frontendIds: [String(cart._id), String(catalog._id)], effort: "max" })

            expect(job.effort).toBe("max")
            expect(AiChangeJob.create).toHaveBeenCalledWith(expect.objectContaining({ effort: "max" }))
            const requests = (AiChangeRequest.create as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([document]) => document as Record<string, unknown>)
            expect(requests.map(request => request.effort)).toEqual(["max", "max"])
        })

        it("Given no effort chosen, when a job is started, then it reasons at high", async () => {
            const job = await service().create(projectId, { prompt: "Rename the price API", scope: "global" })

            expect(job.effort).toBe("high")
            expect(AiChangeRequest.create).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }))
        })

        it("Given an installation capped at high, when a job is started at max, then the job and its requests keep high, the effort it runs at", async () => {
            const capped = new AiChangeJobService(user, { ANTHROPIC_API_KEY: "sk-test", AI_MAX_EFFORT: "high" })

            const job = await capped.create(projectId, { prompt: "Rename the price API", scope: "global", effort: "max" })

            expect(job.effort).toBe("high")
            expect(AiChangeRequest.create).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }))
        })

        it("Given no AI chosen, when a job is started, then it runs on the organization's default and the job and each request record it", async () => {
            const { opus } = orgModels()

            const job = await service().create(projectId, { prompt: "Rename the price API", scope: "global" })

            expect(job.aiModelId).toBe(opus)
            expect(AiChangeJob.create).toHaveBeenCalledWith(expect.objectContaining({ aiModelId: opus }))
            const requests = (AiChangeRequest.create as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([document]) => document as Record<string, unknown>)
            expect(requests.map(request => request.aiModelId)).toEqual([opus, opus])
        })

        it("Given the system AI and nothing defined by the organization, when a job is started, then it records the system AI", async () => {
            const job = await service().create(projectId, { prompt: "Rename the price API", scope: "global" })

            expect(job.aiModelId).toBe("system")
        })

        it("Given a project restricted to the system AI, when a job asks for an AI of the organization, then it is refused before anything is created", async () => {
            const { sonnet } = orgModels()
            vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId(), name: "Shop", aiModelIds: ["system"] } as never)

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "global", aiModelId: sonnet })).rejects.toMatchObject({ code: "AI_MODEL_NOT_AVAILABLE", statusCode: 422 })
            expect(AiChangeJob.create).not.toHaveBeenCalled()
        })

        it("Given a project with AI turned off, when a job is started, then it answers as AI off", async () => {
            vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId(), name: "Shop", aiModelIds: [] } as never)

            await expect(service().create(projectId, { prompt: "Rename the price API", scope: "global" })).rejects.toMatchObject({ code: "ASSISTANT_DISABLED" })
        })

        it("Given a job and a request stored before the effort could be chosen, when they are read, then they read as high", () => {
            expect(AiChangeJob.hydrate({ _id: new Types.ObjectId(), prompt: "Rename the price API" }).effort).toBe("high")
            expect(AiChangeRequest.hydrate({ _id: new Types.ObjectId(), prompt: "Rename the price API" }).effort).toBe("high")
        })

        it("Given a frontend and a backend selected, when the job is started, then the job lists each under its kind and each gets its request", async () => {
            backends = [catalogApi]

            await service().create(projectId, { prompt: "Expose the price", scope: "selection", frontendIds: [String(cart._id)], backendIds: [String(catalogApi._id)] })

            expect(AiChangeJob.create).toHaveBeenCalledWith(expect.objectContaining({ frontendIds: [cart._id], backendIds: [catalogApi._id] }))
            const requests = (AiChangeRequest.create as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([document]) => document as Record<string, unknown>)
            expect(requests).toEqual([
                expect.objectContaining({ frontendId: cart._id, jobRepositoryCount: 2 }),
                expect.objectContaining({ backendId: catalogApi._id, jobRepositoryCount: 2, baseBranch: "main" })
            ])
            expect(requests[1].frontendId).toBeUndefined()
        })

        it("Given a backend with a repository, when a global job is started, then it works on the backend too", async () => {
            backends = [catalogApi]

            await service().create(projectId, { prompt: "Expose the price", scope: "global" })

            expect(AiChangeJob.create).toHaveBeenCalledWith(expect.objectContaining({ scope: "global", frontendIds: [catalog._id, cart._id], backendIds: [catalogApi._id] }))
        })

        describe("on a domain", () => {
            const checkoutId = new Types.ObjectId()
            const checkout = { _id: checkoutId, projectId, slug: "checkout", name: "Checkout", description: "From the cart to the payment" }

            beforeEach(() => {
                vi.spyOn(Domain, "findOne").mockImplementation(((filter: { _id: unknown; projectId: unknown }) =>
                    Promise.resolve(String(filter._id) === String(checkoutId) && String(filter.projectId) === projectId ? checkout : null)) as never)
            })

            it("Given a domain with a frontend and a backend, when its job is started, then it works on its members only and remembers the domain", async () => {
                withRepository = [{ ...cart, domainId: checkoutId } as never, catalog]
                backends = [{ ...catalogApi, domainId: checkoutId } as never]

                const job = await service().create(projectId, { prompt: "Show the shipping cost", scope: "domain", domainId: String(checkoutId) })

                expect(AiChangeJob.create).toHaveBeenCalledWith(expect.objectContaining({ scope: "domain", domainId: checkoutId, frontendIds: [cart._id], backendIds: [catalogApi._id] }))
                expect(job).toMatchObject({ scope: "domain", domainId: String(checkoutId) })
            })

            it("Given a base branch picked for one member, when its job is started, then that repository starts from it and the others from their default", async () => {
                withRepository = [{ ...cart, domainId: checkoutId } as never]
                backends = [{ ...catalogApi, domainId: checkoutId } as never]

                await service().create(projectId, { prompt: "Show the shipping cost", scope: "domain", domainId: String(checkoutId), baseBranches: { [String(catalogApi._id)]: " develop " } })

                const requests = (AiChangeRequest.create as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([document]) => document as Record<string, unknown>)
                expect(requests).toEqual([expect.objectContaining({ frontendId: cart._id, baseBranch: "main" }), expect.objectContaining({ backendId: catalogApi._id, baseBranch: "develop" })])
            })

            describe("by a member assigned to it", () => {
                let backendsOutside: ReturnType<typeof vi.spyOn>

                beforeEach(() => {
                    vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(checkoutId)])
                    withRepository = [{ ...cart, domainId: checkoutId } as never]
                    backends = [{ ...catalogApi, domainId: checkoutId } as never]
                    vi.spyOn(CodeRepository, "findById").mockResolvedValue({ provider: CodeRepositoryProvider.GITHUB } as never)
                    vi.spyOn(Frontend, "exists").mockResolvedValue(null as never)
                    backendsOutside = vi.spyOn(Backend, "exists").mockResolvedValue(null as never)
                })

                it("Given a member's repository shared with a backend of another domain, when its job is started, then it is refused before anything is created", async () => {
                    backendsOutside.mockResolvedValue({ _id: new Types.ObjectId() } as never)

                    await expect(service().create(projectId, { prompt: "Show the shipping cost", scope: "domain", domainId: String(checkoutId) })).rejects.toMatchObject({
                        code: "DOMAIN_SCOPE_FORBIDDEN",
                        statusCode: 403
                    })
                    expect(AiChangeJob.create).not.toHaveBeenCalled()
                })

                it("Given repositories used by the domain's members only, when its job is started, then it runs", async () => {
                    await service().create(projectId, { prompt: "Show the shipping cost", scope: "domain", domainId: String(checkoutId) })

                    expect(AiChangeJob.create).toHaveBeenCalledTimes(1)
                })
            })

            it("Given a domain whose members have no repository, when its job is started, then it is refused naming the domain", async () => {
                withRepository = [catalog]

                await expect(service().create(projectId, { prompt: "Show the shipping cost", scope: "domain", domainId: String(checkoutId) })).rejects.toMatchObject({
                    code: "AI_JOB_NO_REPOSITORIES",
                    message: expect.stringContaining("Checkout")
                })
                expect(AiChangeJob.create).not.toHaveBeenCalled()
            })

            it("Given a domain of another project, when its job is started, then it is not found", async () => {
                const elsewhere = new Types.ObjectId().toString()

                await expect(service().create(projectId, { prompt: "Show the shipping cost", scope: "domain", domainId: elsewhere })).rejects.toMatchObject({
                    message: expect.stringContaining(elsewhere)
                })
                expect(AiChangeJob.create).not.toHaveBeenCalled()
            })

            it("Given a domain with more than 10 members with a repository, when its job is started, then it is refused", async () => {
                withRepository = Array.from({ length: 11 }, (_, index) => ({ ...frontend(`mfe-${index}`, `Mfe ${index}`), domainId: checkoutId }) as never)

                await expect(service().create(projectId, { prompt: "Show the shipping cost", scope: "domain", domainId: String(checkoutId) })).rejects.toMatchObject({
                    code: "AI_JOB_TOO_MANY_REPOSITORIES"
                })
            })
        })

        it("Given a selected backend of another project, when the job is started, then it is not found", async () => {
            backends = [{ ...catalogApi, projectId: new Types.ObjectId().toString() }]

            await expect(service().create(projectId, { prompt: "Expose the price", scope: "selection", backendIds: [String(catalogApi._id)] })).rejects.toMatchObject({
                message: expect.stringContaining(String(catalogApi._id))
            })
            expect(AiChangeJob.create).not.toHaveBeenCalled()
        })
    })

    describe("followUp", () => {
        const parentJobId = new Types.ObjectId()
        const rootJobId = new Types.ObjectId()
        const parentRequest = (status: AiChangeStatus) => ({
            _id: new Types.ObjectId(),
            jobId: parentJobId,
            frontendId: catalog._id,
            baseBranch: "develop",
            branch: "ai/catalog-20261020-090000",
            pullRequestUrl: "https://github.com/acme/catalog/pull/4",
            status,
            files: []
        })
        let parentStatus: AiJobStatus
        let requests: ReturnType<typeof parentRequest>[]

        beforeEach(() => {
            parentStatus = AiJobStatus.DONE
            requests = [parentRequest(AiChangeStatus.PROPOSED)]
            vi.spyOn(AiChangeJobService.prototype as unknown as WithProcess, "process").mockResolvedValue(undefined)
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({
                    _id: parentJobId,
                    rootJobId,
                    projectId,
                    userId: user._id,
                    prompt: "Rename the price API",
                    scope: "global",
                    frontendIds: [catalog._id],
                    status: parentStatus,
                    usage: {},
                    updatedAt: new Date()
                })) as never)
            vi.spyOn(AiChangeRequest, "find").mockImplementation(((filter: { jobId: unknown }) => Promise.resolve(filter.jobId === parentJobId ? requests : [])) as never)
        })

        it("Given a finished job, when it is followed up, then the child joins its chain and each request refines the parent's one on the same branch", async () => {
            const child = await service().followUp(String(parentJobId), { prompt: "Also rename the tests" })

            expect(child).toMatchObject({ parentJobId: String(parentJobId), rootJobId: String(rootJobId), scope: "global" })
            expect(AiChangeRequest.create).toHaveBeenCalledWith(expect.objectContaining({ frontendId: catalog._id, parentId: requests[0]._id, baseBranch: "develop" }))
            // The follow-up goes on on the parent's branch: its pull request follows it.
            expect(AiChangeRequest.create).toHaveBeenCalledWith(expect.objectContaining({ branch: "ai/catalog-20261020-090000", pullRequestUrl: "https://github.com/acme/catalog/pull/4" }))
        })

        it("Given a job of a mission, when it is followed up, then the follow-up is the mission's too and takes no place among the active jobs", async () => {
            const missionId = new Types.ObjectId()
            activeJobs = 3
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({
                    _id: parentJobId,
                    rootJobId,
                    missionId,
                    projectId,
                    userId: user._id,
                    prompt: "Upgrade React",
                    scope: "selection",
                    frontendIds: [catalog._id],
                    status: parentStatus,
                    usage: {},
                    updatedAt: new Date()
                })) as never)

            await service().followUp(String(parentJobId), { prompt: "Also the tests" })

            expect(AiChangeJob.create).toHaveBeenCalledWith(expect.objectContaining({ missionId, parentJobId, rootJobId }))
            expect(AiChangeJob.countDocuments).not.toHaveBeenCalled()
        })

        it("Given a job someone else started, when a member follows it up, then it is refused, and an organization administrator may", async () => {
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({
                    _id: parentJobId,
                    rootJobId,
                    projectId,
                    userId: new Types.ObjectId(),
                    prompt: "Rename the price API",
                    scope: "global",
                    frontendIds: [catalog._id],
                    status: parentStatus,
                    usage: {},
                    updatedAt: new Date()
                })) as never)

            await expect(service().followUp(String(parentJobId), { prompt: "Also rename the tests" })).rejects.toMatchObject({ code: "AI_JOB_NOT_OWNER", statusCode: 403 })
            expect(AiChangeJob.create).not.toHaveBeenCalled()

            vi.spyOn(BaseAuthorizedService.prototype as unknown as WithGates, "isOrganizationAdmin").mockResolvedValue(true)
            const child = await service().followUp(String(parentJobId), { prompt: "Also rename the tests" })
            expect(child.canAct).toBe(true)
        })

        it("Given a parent that reasoned at low, when it is followed up, then the child reasons at low too unless another effort is chosen", async () => {
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({
                    _id: parentJobId,
                    rootJobId,
                    projectId,
                    userId: user._id,
                    prompt: "Rename the price API",
                    scope: "global",
                    frontendIds: [catalog._id],
                    status: parentStatus,
                    effort: "low",
                    usage: {},
                    updatedAt: new Date()
                })) as never)

            const inherited = await service().followUp(String(parentJobId), { prompt: "Also rename the tests" })
            const chosen = await service().followUp(String(parentJobId), { prompt: "Also rename the mocks", effort: "xhigh" })

            expect(inherited.effort).toBe("low")
            expect(chosen.effort).toBe("xhigh")
            expect(AiChangeRequest.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ prompt: "Also rename the tests", effort: "low" }))
            expect(AiChangeRequest.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompt: "Also rename the mocks", effort: "xhigh" }))
        })

        it("Given a parent at max and an installation capped since at medium, when it is followed up, then the child reasons at medium", async () => {
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({
                    _id: parentJobId,
                    rootJobId,
                    projectId,
                    userId: user._id,
                    prompt: "Rename the price API",
                    scope: "global",
                    frontendIds: [catalog._id],
                    status: parentStatus,
                    effort: "max",
                    usage: {},
                    updatedAt: new Date()
                })) as never)

            const child = await new AiChangeJobService(user, { ANTHROPIC_API_KEY: "sk-test", AI_MAX_EFFORT: "medium" }).followUp(String(parentJobId), { prompt: "Also rename the tests" })

            expect(child.effort).toBe("medium")
        })

        /** The parent's job as stored, run on the given AI. */
        const parentOn = (aiModelId: string) =>
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({
                    _id: parentJobId,
                    rootJobId,
                    projectId,
                    userId: user._id,
                    prompt: "Rename the price API",
                    scope: "global",
                    frontendIds: [catalog._id],
                    status: parentStatus,
                    aiModelId,
                    usage: {},
                    updatedAt: new Date()
                })) as never)

        it("Given a parent run on an AI that is not the default, when it is followed up without choosing, then the child keeps the parent's AI", async () => {
            const { sonnet, opus } = orgModels()
            parentOn(sonnet)

            const inherited = await service().followUp(String(parentJobId), { prompt: "Also rename the tests" })
            const chosen = await service().followUp(String(parentJobId), { prompt: "Also rename the mocks", aiModelId: opus })

            expect(inherited.aiModelId).toBe(sonnet)
            expect(chosen.aiModelId).toBe(opus)
        })

        it("Given a parent run on an AI deleted since, when it is followed up, then the child runs on the default", async () => {
            const { opus } = orgModels()
            parentOn(new Types.ObjectId().toString())

            const child = await service().followUp(String(parentJobId), { prompt: "Also rename the tests" })

            expect(child.aiModelId).toBe(opus)
        })

        it("Given a parent stored before the effort could be chosen, when it is followed up, then the child reasons at high", async () => {
            const child = await service().followUp(String(parentJobId), { prompt: "Also rename the tests" })

            expect(child.effort).toBe("high")
        })

        it("Given a job of a domain, when it is followed up, then the child stays in the domain", async () => {
            const domainId = new Types.ObjectId()
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({
                    _id: parentJobId,
                    rootJobId,
                    projectId,
                    userId: user._id,
                    prompt: "Show the shipping cost",
                    scope: "domain",
                    domainId,
                    frontendIds: [catalog._id],
                    status: parentStatus,
                    usage: {},
                    updatedAt: new Date()
                })) as never)

            await service().followUp(String(parentJobId), { prompt: "Also in the summary" })

            expect(AiChangeJob.create).toHaveBeenCalledWith(expect.objectContaining({ scope: "domain", domainId, parentJobId }))
        })

        it("Given a job still running, when it is followed up, then it is refused", async () => {
            parentStatus = AiJobStatus.RUNNING

            await expect(service().followUp(String(parentJobId), { prompt: "Also rename the tests" })).rejects.toMatchObject({ code: "AI_JOB_NOT_DONE", statusCode: 409 })
        })

        it("Given a follow-up of the job still running, when another one is asked, then it is refused", async () => {
            vi.spyOn(AiChangeJob, "exists").mockResolvedValue({ _id: new Types.ObjectId() } as never)

            await expect(service().followUp(String(parentJobId), { prompt: "Also rename the tests" })).rejects.toMatchObject({ code: "AI_JOB_FOLLOW_UP_RUNNING", statusCode: 409 })
            expect(AiChangeJob.create).not.toHaveBeenCalled()
        })

        it("Given a proposal already applied, when it is followed up, then there is nothing left to refine", async () => {
            requests = [parentRequest(AiChangeStatus.APPLIED)]

            await expect(service().followUp(String(parentJobId), { prompt: "Also rename the tests" })).rejects.toMatchObject({ code: "AI_CHANGE_NOT_PROPOSED" })
            expect(AiChangeJob.create).not.toHaveBeenCalled()
        })
    })

    describe("process", () => {
        let dir: string
        let jobId: Types.ObjectId
        let parentJobId: Types.ObjectId
        let parent: { _id: Types.ObjectId; prompt: string; files: Record<string, unknown>[]; commit?: string; baseCommit?: string }
        let request: Record<string, unknown>
        let workingCopy: Record<string, ReturnType<typeof vi.fn> | string>
        let frontendIds: Types.ObjectId[]

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-job-"))
            fs.mkdirSync(path.join(dir, "src"))
            fs.writeFileSync(path.join(dir, "src/App.tsx"), "base\n")
            jobId = new Types.ObjectId()
            parentJobId = new Types.ObjectId()
            parent = {
                _id: new Types.ObjectId(),
                prompt: "Show the price",
                files: [
                    { path: "src/App.tsx", action: "update", baseBlobOid: "app-blob", proposedContent: "first proposal\n" },
                    { path: "src/Price.tsx", action: "create", proposedContent: "export const Price = () => null\n" }
                ]
            }
            request = {
                _id: new Types.ObjectId(),
                jobId,
                frontendId: catalog._id,
                prompt: "Also show the currency",
                baseBranch: "main",
                branch: "ai/catalog-20261020-090000",
                parentId: parent._id
            }
            workingCopy = {
                dir,
                blobOid: vi.fn(async (_commit: string, file: string) => (file === "src/App.tsx" ? "app-blob" : undefined)),
                changes: vi.fn(async () => [{ path: "src/App.tsx", action: "update", baseBlobOid: "app-blob" }]),
                readHeadFile: vi.fn(async () => "base\n"),
                readWorkingFile: vi.fn(async (file: string) => fs.readFileSync(path.join(dir, file), "utf8")),
                discardChanges: vi.fn(async () => undefined),
                commitAndPush: vi.fn(async () => "branch-commit")
            }
            workspaces.set(String(catalog._id), { target: {}, workingCopy, defaultBranch: "main" })
            frontends = [catalog]
            frontendIds = [catalog._id]

            const jobs: Record<string, unknown> = {
                [String(jobId)]: {
                    _id: jobId,
                    parentJobId,
                    rootJobId: parentJobId,
                    projectId,
                    userId: user._id,
                    prompt: "Also show the currency",
                    frontendIds,
                    status: AiJobStatus.RUNNING
                },
                [String(parentJobId)]: { _id: parentJobId, rootJobId: parentJobId, prompt: "Show the price", summary: "Added the price" }
            }
            vi.spyOn(AiChangeJob, "findById").mockImplementation(((id: unknown) => Promise.resolve(jobs[String(id)] ?? null)) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([request] as never)
            vi.spyOn(AiChangeRequest, "findById").mockImplementation(((id: unknown) => Promise.resolve(String(id) === String(parent._id) ? parent : null)) as never)
            // Neither the project nor its organization has a design system, unless a test gives one
            vi.spyOn(Organization, "findById").mockResolvedValue(null as never)
            runAgent.mockImplementation(async (_client: unknown, _input: unknown, hooks: { onUsage: (usage: unknown) => Promise<void> }) => {
                await hooks.onUsage({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 })
                await hooks.onUsage({ inputTokens: 20, cachedInputTokens: 8, outputTokens: 7 })
                fs.writeFileSync(path.join(dir, "src/App.tsx"), "first proposal with currency\n")
                return { summary: "Shows the price with its currency", stopReason: "finished" }
            })
        })

        afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

        const run = () => (service() as unknown as WithProcess).process(String(jobId), {} as LlmClient)

        it("Given a follow-up, when it runs, then the agent starts from the parent's files, sees the chain, and its proposal supersedes the parent", async () => {
            let onDisk: Record<string, string> = {}
            runAgent.mockImplementationOnce(async (_client: unknown, input: { previousRequests: unknown; repositories: { frontend: { slug: string }; previousChanges: unknown }[] }) => {
                onDisk = { app: fs.readFileSync(path.join(dir, "src/App.tsx"), "utf8"), price: fs.readFileSync(path.join(dir, "src/Price.tsx"), "utf8") }
                expect(input.previousRequests).toEqual([{ prompt: "Show the price", summary: "Added the price" }])
                expect(input.repositories.map(repository => repository.frontend.slug)).toEqual(["catalog"])
                // The parent's files count towards the limits of the follow-up.
                expect(input.repositories[0].previousChanges).toEqual([
                    { path: "src/App.tsx", bytes: 15 },
                    { path: "src/Price.tsx", bytes: 32 }
                ])
                return { summary: "Shows the price with its currency", stopReason: "finished" }
            })

            await run()

            expect(onDisk).toEqual({ app: "first proposal\n", price: "export const Price = () => null\n" })
            expect(pushed(updates)).toEqual(expect.arrayContaining(["preparing", "applying-previous", "working", "proposed", "superseded"]))
            const proposal = updates.find(({ update }) => update.status === AiChangeStatus.PROPOSED)
            expect(proposal).toMatchObject({ filter: { _id: request._id, status: AiChangeStatus.RUNNING }, update: { summary: "Shows the price with its currency" } })
            expect(updates).toContainEqual(
                expect.objectContaining({ filter: { _id: parent._id, status: AiChangeStatus.PROPOSED }, update: expect.objectContaining({ status: AiChangeStatus.DISCARDED }) })
            )
            expect(updates).toContainEqual(
                expect.objectContaining({ model: "job", filter: { _id: jobId, status: AiJobStatus.RUNNING }, update: expect.objectContaining({ status: AiJobStatus.DONE }) })
            )
            expect(workingCopy.discardChanges).toHaveBeenCalled()
        })

        it("Given a frontend and a project without a design system, when the job runs, then the agent builds with the organization's", async () => {
            vi.spyOn(Organization, "findById").mockResolvedValue({ designSystem: { packageName: "@acme/brand" } } as never)

            await run()

            const input = runAgent.mock.calls[0][1] as { repositories: { frontend: { designSystem?: unknown } }[] }
            expect(input.repositories[0].frontend.designSystem).toEqual({ packageName: "@acme/brand" })
        })

        it("Given a user stopping the job while the agent works, when it is stopped, then the model call is aborted at once and nothing is pushed nor saved", async () => {
            const started = new Promise<void>(resolve => {
                runAgent.mockImplementationOnce(
                    (_client: unknown, _input: unknown, _hooks: unknown, signal: AbortSignal) =>
                        new Promise((_resolve, reject) => {
                            signal.addEventListener("abort", () => reject(new Error("aborted")))
                            resolve()
                        })
                )
            })
            const running = run()
            await started
            vi.spyOn(AiChangeJob, "findById").mockResolvedValue({
                _id: jobId,
                rootJobId: jobId,
                projectId,
                userId: user._id,
                frontendIds,
                status: AiJobStatus.RUNNING,
                usage: {},
                updatedAt: new Date()
            } as never)
            vi.spyOn(AiChangeJob, "findOneAndUpdate").mockResolvedValue({
                _id: jobId,
                rootJobId: jobId,
                projectId,
                userId: user._id,
                frontendIds,
                status: AiJobStatus.FAILED,
                usage: {},
                stoppedAt: new Date()
            } as never)

            await service().stop(String(jobId))
            await running

            expect(workingCopy.commitAndPush).not.toHaveBeenCalled()
            expect(updates.some(({ update }) => update.status === AiChangeStatus.PROPOSED || update.status === AiJobStatus.DONE)).toBe(false)
            expect(workingCopy.discardChanges).toHaveBeenCalled()
        })

        it("Given a proposal, when the job ends, then it is pushed on the conversation's branch, named after its first message, before it is saved", async () => {
            await run()

            expect(workingCopy.commitAndPush).toHaveBeenCalledWith({
                branch: "ai/catalog-20261020-090000",
                message: "Show the price\n\nShows the price with its currency",
                author: { name: "Ada", email: "ada@example.com" },
                files: [{ path: "src/App.tsx", action: "update", content: "first proposal with currency\n" }]
            })
            expect((workingCopy.commitAndPush as ReturnType<typeof vi.fn>).mock.calls[0][0].pushTo).toBeUndefined()
            const proposal = updates.find(({ update }) => update.status === AiChangeStatus.PROPOSED)
            expect(proposal?.update).toMatchObject({ branch: "ai/catalog-20261020-090000", commit: "branch-commit" })
            expect(pushed(updates)).toContain("pushing")
        })

        it("Given a push the remote refuses, when the job ends, then the proposal is saved anyway with the error", async () => {
            workingCopy.commitAndPush = vi.fn(async () => {
                throw new Error("403 Forbidden")
            })

            await run()

            const proposal = updates.find(({ update }) => update.status === AiChangeStatus.PROPOSED)
            expect(proposal?.update).toMatchObject({ pushError: "403 Forbidden" })
            expect(proposal?.update.commit).toBeUndefined()
        })

        it("Given a job at max effort, when it runs, then the agent reasons at max, its reasoning is logged on the job and its request, and the usage is audited with the effort", async () => {
            // The job of beforeEach, chosen at max.
            Object.assign((await AiChangeJob.findById(jobId)) as object, { effort: "max" })
            runAgent.mockImplementationOnce(async (_client: unknown, _input: unknown, hooks: { onEvent: (kind: string, message: string) => Promise<void> }) => {
                await hooks.onEvent("thinking", "The price is rendered in src/App.tsx.")
                return { summary: "Shows the price with its currency", stopReason: "finished" }
            })

            await run()

            expect(runAgent.mock.calls[0][1]).toMatchObject({ effort: "max" })
            const thinking = updates.filter(({ update }) =>
                ((update.$push as { events?: { $each: { kind: string; message: string }[] } } | undefined)?.events?.$each ?? []).some(
                    entry => entry.kind === "thinking" && entry.message === "The price is rendered in src/App.tsx."
                )
            )
            expect(thinking.map(({ model }) => model)).toEqual(["job", "request"])
            expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ audit: "ai_job_usage", effort: "max" }), "AI job usage")
        })

        it("Given what the agent says and thinks repeating a secret, when it is logged, then the secret is masked and the steps are kept as they are", async () => {
            runAgent.mockImplementationOnce(async (_client: unknown, _input: unknown, hooks: { onEvent: (kind: string, message: string) => Promise<void> }) => {
                await hooks.onEvent("thinking", "The pipeline sets NPM_TOKEN=abcdef1234567890.")
                await hooks.onEvent("text", "Set API_KEY = sk-live-123456789 in the pipeline.")
                await hooks.onEvent("tool", "read_file catalog/.npmrc")
                return { summary: "Shows the price with its currency", stopReason: "finished" }
            })

            await run()

            const logged = pushed(updates).join("\n")
            expect(logged).not.toContain("abcdef1234567890")
            expect(logged).not.toContain("sk-live-123456789")
            expect(logged).toContain("The pipeline sets NPM_TOKEN=")
            expect(pushed(updates)).toContain("read_file catalog/.npmrc")
        })

        describe("going on with the parent's conversation", () => {
            const transcript = [
                { role: "user", text: "<request>\nShow the price\n</request>" },
                { role: "assistant", text: "Added the price.", toolCalls: [] }
            ]
            const withParent = (parentJob: Record<string, unknown>) => {
                const current = { _id: jobId, parentJobId, rootJobId: parentJobId, projectId, userId: user._id, prompt: "Why src/Price.tsx?", frontendIds, status: AiJobStatus.RUNNING }
                const jobs: Record<string, unknown> = {
                    [String(jobId)]: current,
                    [String(parentJobId)]: { _id: parentJobId, rootJobId: parentJobId, prompt: "Show the price", summary: "Added the price", ...parentJob }
                }
                vi.spyOn(AiChangeJob, "findById").mockImplementation(((id: unknown) => Promise.resolve(jobs[String(id)] ?? null)) as never)
            }

            it("Given a parent on the same repositories with a conversation, when a question is answered without a change, then the agent carries on from it and the proposal keeps the parent's description", async () => {
                withParent({ frontendIds, transcript })
                ;(parent as Record<string, unknown>).summary = "Adds the price to the catalog"
                // The working copy holds the parent's files and nothing more.
                workingCopy.changes = vi.fn(async () => [
                    { path: "src/App.tsx", action: "update", baseBlobOid: "app-blob" },
                    { path: "src/Price.tsx", action: "create" }
                ])
                const answer = [...transcript, { role: "user", text: "Why src/Price.tsx?" }, { role: "assistant", text: "To keep the price apart.", toolCalls: [] }]
                runAgent.mockImplementationOnce(async (_client: unknown, input: { history?: unknown; previousRequests?: unknown }) => {
                    expect(input.history).toEqual(transcript)
                    expect(input.previousRequests).toBeUndefined()
                    return { summary: "To keep the price apart.", stopReason: "end_turn", transcript: answer }
                })

                Object.assign(parent, { commit: "parent-commit", baseCommit: "base-commit" })

                await run()

                const proposal = updates.find(({ update }) => update.status === AiChangeStatus.PROPOSED)
                expect(proposal?.update).toMatchObject({ summary: "Adds the price to the catalog" })
                // The branch already holds these very files: pushing them again would only run the CI again.
                expect(workingCopy.commitAndPush).not.toHaveBeenCalled()
                expect(proposal?.update).toMatchObject({ commit: "parent-commit" })
                expect(updates).toContainEqual(
                    expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.DONE, summary: "To keep the price apart.", transcript: answer }) })
                )
            })

            it("Given a parent on other repositories, when the follow-up runs, then the agent starts over, told only what was asked before", async () => {
                withParent({ frontendIds: [catalog._id, cart._id], transcript })
                runAgent.mockImplementationOnce(async (_client: unknown, input: { history?: unknown; previousRequests?: unknown }) => {
                    expect(input.history).toBeUndefined()
                    expect(input.previousRequests).toEqual([{ prompt: "Show the price", summary: "Added the price" }])
                    return { summary: "Shows the price with its currency", stopReason: "finished", transcript: [] }
                })

                await run()

                expect(runAgent).toHaveBeenCalledTimes(1)
                expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.DONE }) }))
            })
        })

        it("Given a job on a frontend and a backend of the same slug, when it runs, then the agent sees both under distinct slugs and the backend with its container facts", async () => {
            backends = [catalogApi]
            const backendRequest = { _id: new Types.ObjectId(), jobId, backendId: catalogApi._id, baseBranch: "main" }
            vi.spyOn(AiChangeJob, "findById").mockImplementation(((id: unknown) =>
                Promise.resolve(
                    String(id) === String(jobId)
                        ? {
                              _id: jobId,
                              rootJobId: jobId,
                              projectId,
                              userId: user._id,
                              prompt: "Expose the price",
                              frontendIds: [catalog._id],
                              backendIds: [catalogApi._id],
                              status: AiJobStatus.RUNNING
                          }
                        : null
                )) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([{ ...request, parentId: undefined }, backendRequest] as never)
            workspaces.set(String(catalogApi._id), {
                target: {},
                workingCopy: {
                    dir: `${dir}-backend`,
                    changes: vi.fn(async () => [{ path: "src/routes/price.ts", action: "create" }]),
                    readWorkingFile: vi.fn(async () => "export const price = 1\n"),
                    discardChanges: vi.fn(async () => undefined)
                },
                defaultBranch: "main"
            })
            let input: { repositories: { frontend?: { slug: string }; backend?: Record<string, unknown> }[] } | undefined
            runAgent.mockImplementationOnce(async (_client: unknown, received: typeof input) => {
                input = received
                return { summary: "Exposed the price", stopReason: "finished" }
            })

            await run()

            expect(input?.repositories.map(repository => repository.frontend?.slug ?? repository.backend?.slug)).toEqual(["catalog", "catalog-backend"])
            expect(input?.repositories[1].backend).toEqual({
                name: "Catalog API",
                slug: "catalog-backend",
                runtime: "NODE",
                framework: "Express",
                port: 3000,
                livenessPath: "/healthz/live",
                readinessPath: "/healthz/ready",
                docsPath: "/docs",
                env: [{ name: "DATABASE_URL", required: true, secret: true, description: "Postgres connection string" }],
                context: undefined,
                // Where the other workloads of the cluster reach it: the chart's Service is named after the slug
                clusterUrl: "http://catalog"
            })
            expect(updates).toContainEqual(
                expect.objectContaining({ filter: { _id: backendRequest._id, status: AiChangeStatus.RUNNING }, update: expect.objectContaining({ status: AiChangeStatus.PROPOSED }) })
            )
        })

        describe("on backends with configuration", () => {
            const configMapId = new Types.ObjectId()
            const secretId = new Types.ObjectId()
            const databaseId = new Types.ObjectId()
            const apiId = new Types.ObjectId()
            const environmentId = new Types.ObjectId()
            const orders = {
                ...catalogApi,
                _id: new Types.ObjectId(),
                slug: "orders",
                name: "Orders API",
                env: [],
                exposurePath: "/api/orders/",
                configMapIds: [configMapId],
                secretIds: [secretId],
                resourceIds: [databaseId, apiId]
            }
            // As a careless query would read them: credentials decrypted, overrides and the pasted document included
            const storedResources = [
                {
                    _id: databaseId,
                    name: "orders",
                    type: "database",
                    variant: "credentials",
                    description: "Main Postgres of orders",
                    values: [{ field: "host", value: "db.internal", overrides: [{ environmentId, value: "override-host" }] }],
                    secrets: [{ field: "password", value: "s3cr3t-password", overrides: [{ environmentId, value: "s3cr3t-override" }] }]
                },
                {
                    _id: apiId,
                    name: "payments",
                    type: "api",
                    variant: "apiKey",
                    values: [
                        { field: "baseUrl", value: "https://api.pay.example.com/v1", overrides: [{ environmentId, value: "https://override.example.com" }] },
                        { field: "specUrl", value: "https://api.pay.example.com/openapi.json", overrides: [] },
                        { field: "in", value: "header", overrides: [] },
                        { field: "name", value: "X-API-Key", overrides: [] },
                        // A credential stored in the wrong list must still never be shown
                        { field: "apiKey", value: "sk-live-misplaced", overrides: [] }
                    ],
                    secrets: [{ field: "apiKey", value: "sk-live-SECRET", overrides: [] }],
                    apiSpec: "pasted-spec-content",
                    apiSpecBytes: 19
                }
            ]

            let input: Record<string, unknown> | undefined
            const runOn = async (backend: Record<string, unknown> & { _id: Types.ObjectId }, others: Record<string, unknown>[] = []) => {
                backends = [backend, ...others] as unknown as (typeof catalogApi)[]
                const backendRequest = { _id: new Types.ObjectId(), jobId, backendId: backend._id, baseBranch: "main" }
                vi.spyOn(AiChangeJob, "findById").mockImplementation(((id: unknown) =>
                    Promise.resolve(
                        String(id) === String(jobId)
                            ? { _id: jobId, rootJobId: jobId, projectId, userId: user._id, prompt: "Charge the order", frontendIds: [], backendIds: [backend._id], status: AiJobStatus.RUNNING }
                            : null
                    )) as never)
                vi.spyOn(AiChangeRequest, "find").mockResolvedValue([backendRequest] as never)
                workspaces.set(String(backend._id), {
                    target: {},
                    workingCopy: {
                        dir: `${dir}-orders`,
                        changes: vi.fn(async () => [{ path: "src/pay.ts", action: "create" }]),
                        readWorkingFile: vi.fn(async () => "export const pay = 1\n"),
                        discardChanges: vi.fn(async () => undefined)
                    },
                    defaultBranch: "main"
                })
                runAgent.mockImplementationOnce(async (_client: unknown, received: Record<string, unknown>) => {
                    input = received
                    return { summary: "Charges the order", stopReason: "finished" }
                })
                await run()
                return input as {
                    repositories: { backend: Record<string, unknown> }[]
                    apiSpecs?: { resource: string; specUrl?: string; loadPasted?: () => Promise<string | undefined> }[]
                }
            }

            beforeEach(() => {
                input = undefined
                vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, name: "Shop", exposure: { domain: "shop.example.com", certificateIssuer: "letsencrypt" } } as never)
                vi.spyOn(ConfigMap, "find").mockResolvedValue([{ _id: configMapId, name: "orders-config", entries: [{ key: "LOG_LEVEL" }, { key: "FEATURE_FLAGS" }] }] as never)
                vi.spyOn(Secret, "find").mockResolvedValue([
                    { _id: secretId, name: "orders-keys", entries: [{ key: "STRIPE_API_KEY", values: [{ environmentId, value: "sk-stripe-SECRET" }] }] }
                ] as never)
                vi.spyOn(Resource, "find").mockResolvedValue(storedResources as never)
                vi.spyOn(Resource, "findOne").mockResolvedValue({ apiSpec: "pasted-spec-content" } as never)
                vi.spyOn(Environment, "find").mockReturnValue({
                    sort: () =>
                        Promise.resolve([
                            { slug: "DEV", isProduction: false },
                            { slug: "PROD", isProduction: true }
                        ])
                } as never)
            })

            it("Given maps, resources and an exposure, when it runs, then the agent gets their names, keys and URLs and never a value of a credential nor of an override", async () => {
                const received = await runOn(orders)

                expect(received.repositories[0].backend).toMatchObject({
                    exposurePath: "/api/orders/",
                    clusterUrl: "http://orders",
                    publicUrls: [
                        { environment: "DEV", url: "https://dev.shop.example.com/api/orders" },
                        { environment: "PROD", url: "https://shop.example.com/api/orders" }
                    ],
                    configMaps: [{ name: "orders-config", keys: ["LOG_LEVEL", "FEATURE_FLAGS"] }],
                    secrets: [{ name: "orders-keys", keys: ["STRIPE_API_KEY"] }]
                })
                const [database, api] = received.repositories[0].backend.resources as Record<string, unknown>[]
                expect(database).toEqual({
                    name: "orders",
                    type: "database",
                    variant: "credentials",
                    description: "Main Postgres of orders",
                    keys: expect.arrayContaining([{ key: "DB_ORDERS_PASSWORD", field: "password", secret: true, required: true }])
                })
                expect(api).toMatchObject({
                    name: "payments",
                    variant: "apiKey",
                    values: { baseUrl: "https://api.pay.example.com/v1", specUrl: "https://api.pay.example.com/openapi.json", in: "header", name: "X-API-Key" },
                    apiSpec: true,
                    keys: expect.arrayContaining([{ key: "API_PAYMENTS_AUTH", secret: false, required: true, value: "apiKey" }])
                })
                const serialized = JSON.stringify(received)
                for (const value of [
                    "s3cr3t-password",
                    "s3cr3t-override",
                    "sk-live-SECRET",
                    "sk-live-misplaced",
                    "sk-stripe-SECRET",
                    "override-host",
                    "override.example.com",
                    "db.internal",
                    "pasted-spec-content"
                ]) {
                    expect(serialized).not.toContain(value)
                }
                // Read with projections that leave the credentials, the overrides and the document out
                expect(firstQuery(Resource.find)).toEqual([
                    { _id: { $in: [String(databaseId), String(apiId)] }, projectId },
                    "name type variant envPrefix customFields description values.field values.value apiSpecBytes"
                ])
                expect(firstQuery(ConfigMap.find)).toEqual([{ _id: { $in: [String(configMapId)] }, projectId }, "name entries.key"])
                expect(firstQuery(Secret.find)).toEqual([{ _id: { $in: [String(secretId)] }, projectId }, "name entries.key"])
            })

            it("Given an api resource with a pasted document, when it runs, then read_api_spec gets it from the project only when the agent asks", async () => {
                const received = await runOn(orders)

                expect(received.apiSpecs).toEqual([{ resource: "payments", specUrl: "https://api.pay.example.com/openapi.json", loadPasted: expect.any(Function) }])
                expect(Resource.findOne).not.toHaveBeenCalled()
                expect(await received.apiSpecs?.[0].loadPasted?.()).toBe("pasted-spec-content")
                expect(Resource.findOne).toHaveBeenCalledWith({ _id: apiId, projectId }, { apiSpec: 1 })
            })

            it("Given an api resource with neither a spec URL nor a pasted document, when it runs, then read_api_spec is not offered for it", async () => {
                const [database, api] = storedResources
                vi.mocked(Resource.find).mockResolvedValue([database, { ...api, values: api.values?.filter(value => value.field !== "specUrl"), apiSpec: undefined, apiSpecBytes: undefined }] as never)

                const received = await runOn(orders)

                expect(received).not.toHaveProperty("apiSpecs")
                expect((received.repositories[0].backend.resources as { name: string }[]).map(resource => resource.name)).toEqual(["orders", "payments"])
            })

            it("Given a domain-scoped member whose backend shares an api with a backend of another domain, when their job runs, then the agent is told nothing of that api", async () => {
                const ownDomain = new Types.ObjectId()
                vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(ownDomain)])
                // The backend is in a domain: the job follows its context
                vi.spyOn(Domain, "find").mockReturnValue({ sort: () => Promise.resolve([]) } as never)
                vi.mocked(Resource.find).mockImplementation(((filter: { _id: { $in: unknown[] } }) =>
                    Promise.resolve(storedResources.filter(resource => filter._id.$in.map(String).includes(String(resource._id))))) as never)

                const received = await runOn({ ...orders, domainId: ownDomain }, [{ ...catalogApi, _id: new Types.ObjectId(), slug: "billing", domainId: new Types.ObjectId(), resourceIds: [apiId] }])

                expect(firstQuery(Resource.find)[0]).toEqual({ _id: { $in: [String(databaseId)] }, projectId })
                expect((received.repositories[0].backend.resources as { name: string }[]).map(resource => resource.name)).toEqual(["orders"])
                expect(received).not.toHaveProperty("apiSpecs")
                expect(JSON.stringify(received)).not.toContain("payments")
            })

            it("Given a backend attaching nothing in a project without exposure, when it runs, then nothing more is read and the agent gets only its cluster URL", async () => {
                vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, name: "Shop" } as never)

                const received = await runOn({ ...orders, exposurePath: undefined, configMapIds: [], secretIds: [], resourceIds: [] })

                for (const model of [ConfigMap, Secret, Resource, Environment]) {
                    expect(model.find).not.toHaveBeenCalled()
                }
                expect(received.repositories[0].backend).not.toHaveProperty("resources")
                expect(received.repositories[0].backend).not.toHaveProperty("publicUrls")
                expect(received.repositories[0].backend.clusterUrl).toBe("http://orders")
                expect(received).not.toHaveProperty("apiSpecs")
            })
        })

        it("Given a job of a domain whose backends attach resources, when it runs, then the domain lists each with the backends using it", async () => {
            const databaseId = new Types.ObjectId()
            const domainId = new Types.ObjectId()
            backends = [
                { ...catalogApi, slug: "payments", resourceIds: [databaseId] },
                { ...catalogApi, slug: "orders", resourceIds: [databaseId] }
            ] as never
            const job = { _id: jobId, rootJobId: jobId, projectId, userId: user._id, prompt: "Refund an order", domainId, frontendIds, status: AiJobStatus.RUNNING }
            vi.spyOn(AiChangeJob, "findById").mockImplementation(((id: unknown) => Promise.resolve(String(id) === String(jobId) ? job : null)) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([{ ...request, parentId: undefined }] as never)
            vi.spyOn(Domain, "findById").mockResolvedValue({ _id: domainId, name: "Checkout" } as never)
            vi.spyOn(Resource, "find").mockResolvedValue([{ _id: databaseId, name: "orders", type: "database", secrets: [{ field: "password", value: "s3cr3t" }] }] as never)
            let received: { domain?: unknown } | undefined
            runAgent.mockImplementationOnce(async (_client: unknown, input: typeof received) => {
                received = input
                return { summary: "Refunds", stopReason: "finished" }
            })

            await run()

            expect(Backend.find).toHaveBeenCalledWith({ projectId, domainId }, { slug: 1, resourceIds: 1 })
            expect(firstQuery(Resource.find)).toEqual([{ _id: { $in: [String(databaseId)] }, projectId }, "name type description"])
            expect(received?.domain).toEqual({ name: "Checkout", resources: [{ name: "orders", type: "database", usedBy: ["payments", "orders"] }] })
            expect(JSON.stringify(received)).not.toContain("s3cr3t")
        })

        it("Given a job of a domain started by a member scoped to it, when it runs, then a resource shared with another domain is left out of the domain", async () => {
            const databaseId = new Types.ObjectId()
            const sharedId = new Types.ObjectId()
            const domainId = new Types.ObjectId()
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(domainId)])
            backends = [
                { ...catalogApi, slug: "payments", domainId, resourceIds: [databaseId, sharedId] },
                { ...catalogApi, _id: new Types.ObjectId(), slug: "billing", domainId: new Types.ObjectId(), resourceIds: [sharedId] }
            ] as never
            const job = { _id: jobId, rootJobId: jobId, projectId, userId: user._id, prompt: "Refund an order", domainId, frontendIds, status: AiJobStatus.RUNNING }
            vi.spyOn(AiChangeJob, "findById").mockImplementation(((id: unknown) => Promise.resolve(String(id) === String(jobId) ? job : null)) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([{ ...request, parentId: undefined }] as never)
            vi.spyOn(Domain, "findById").mockResolvedValue({ _id: domainId, name: "Checkout" } as never)
            vi.spyOn(Resource, "find").mockResolvedValue([{ _id: databaseId, name: "orders", type: "database" }] as never)
            runAgent.mockImplementationOnce(async () => ({ summary: "Refunds", stopReason: "finished" }))

            await run()

            expect(firstQuery(Resource.find)).toEqual([{ _id: { $in: [String(databaseId)] }, projectId }, "name type description"])
        })

        it("Given a job of a domain, when it runs, then the agent is told what the domain is for", async () => {
            const domainId = new Types.ObjectId()
            const job = { _id: jobId, rootJobId: jobId, projectId, userId: user._id, prompt: "Show the shipping cost", domainId, frontendIds, status: AiJobStatus.RUNNING }
            vi.spyOn(AiChangeJob, "findById").mockImplementation(((id: unknown) => Promise.resolve(String(id) === String(jobId) ? job : null)) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([{ ...request, parentId: undefined }] as never)
            vi.spyOn(Domain, "findById").mockResolvedValue({ _id: domainId, name: "Checkout", description: "From the cart to the payment" } as never)
            let received: { domain?: unknown } | undefined
            runAgent.mockImplementationOnce(async (_client: unknown, input: typeof received) => {
                received = input
                return { summary: "Shows the shipping cost", stopReason: "finished" }
            })

            await run()

            expect(Domain.findById).toHaveBeenCalledWith(domainId)
            expect(received?.domain).toEqual({ name: "Checkout", description: "From the cart to the payment" })
        })

        it("Given a file of the parent changed on the base branch since, when the follow-up runs, then it fails naming the file and the parent stays applicable", async () => {
            vi.mocked(workingCopy.blobOid as ReturnType<typeof vi.fn>).mockResolvedValue("someone-else-blob")

            await run()

            expect(runAgent).not.toHaveBeenCalled()
            const failure = updates.find(({ model, update }) => model === "request" && update.status === AiChangeStatus.FAILED)
            expect(failure?.update.error).toContain("catalog/src/App.tsx")
            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.FAILED }) }))
            expect(updates.some(({ update }) => update.status === AiChangeStatus.DISCARDED)).toBe(false)
            expect(fs.readFileSync(path.join(dir, "src/App.tsx"), "utf8")).toBe("base\n")
        })

        it("Given an agent spending tokens over two rounds, when it runs, then job and requests add each round, cached tokens included, and the total is audited once", async () => {
            await run()

            const increments = updates.filter(({ update }) => update.$inc).map(({ model, update }) => ({ model, inc: update.$inc }))
            expect(increments).toEqual([
                { model: "job", inc: { "usage.inputTokens": 10, "usage.cachedInputTokens": 4, "usage.outputTokens": 5 } },
                { model: "request", inc: { "usage.inputTokens": 10, "usage.cachedInputTokens": 4, "usage.outputTokens": 5 } },
                { model: "job", inc: { "usage.inputTokens": 20, "usage.cachedInputTokens": 8, "usage.outputTokens": 7 } },
                { model: "request", inc: { "usage.inputTokens": 20, "usage.cachedInputTokens": 8, "usage.outputTokens": 7 } }
            ])
            const audits = log.info.mock.calls.filter(([entry]) => entry?.audit === "ai_job_usage")
            expect(audits).toEqual([[{ audit: "ai_job_usage", userId: String(user._id), projectId, jobId: String(jobId), inputTokens: 30, cachedInputTokens: 12, outputTokens: 12 }, "AI job usage"]])
        })

        it("Given an agent spending tokens over two rounds, when it runs, then each round is added to the ledger with the organization, the project, the job and its repositories", async () => {
            const organizationId = new Types.ObjectId()
            vi.mocked(Project.findById).mockResolvedValue({ _id: projectId, organizationId, name: "Shop", context: "Shop context" } as never)

            await run()

            const attribution = { organizationId, projectId, userId: user._id, source: "agent", jobId, frontendIds: [catalog._id] }
            expect(vi.mocked(AiUsage.create).mock.calls).toEqual([
                [expect.objectContaining({ ...attribution, inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 })],
                [expect.objectContaining({ ...attribution, inputTokens: 20, cachedInputTokens: 8, outputTokens: 7 })]
            ])
        })

        it("Given a ledger that cannot be written, when the agent spends tokens, then the job still adds them and finishes", async () => {
            vi.mocked(AiUsage.create).mockRejectedValue(new Error("mongo down"))

            await run()

            expect(updates.filter(({ update }) => update.$inc)).toHaveLength(4)
            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.DONE }) }))
            expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ aiJobId: String(jobId) }), "AI job usage not recorded")
        })

        it("Given a proposal of more files than a repository allows, when it is collected, then the job fails before any request is proposed", async () => {
            vi.mocked(workingCopy.changes as ReturnType<typeof vi.fn>).mockResolvedValue(
                Array.from({ length: 21 }, (_, index) => ({ path: `src/generated/file-${index}.ts`, action: "delete", baseBlobOid: "blob" }))
            )

            await run()

            expect(updates.some(({ update }) => update.status === AiChangeStatus.PROPOSED)).toBe(false)
            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.FAILED, error: expect.stringContaining("21 files") }) }))
        })

        it("Given a save that fails after one proposal was stored, when the job ends, then it is done with the partial failure and the rest failed", async () => {
            const cartRequest = { _id: new Types.ObjectId(), jobId, frontendId: cart._id, baseBranch: "main" }
            frontends = [catalog, cart]
            frontendIds.push(cart._id)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([request, cartRequest] as never)
            workspaces.set(String(cart._id), {
                target: {},
                workingCopy: {
                    dir: `${dir}-cart`,
                    changes: vi.fn(async () => [{ path: "src/Cart.tsx", action: "create" }]),
                    readWorkingFile: vi.fn(async () => "cart\n"),
                    discardChanges: vi.fn(async () => undefined)
                },
                defaultBranch: "main"
            })
            vi.spyOn(AiChangeRequest, "findOneAndUpdate").mockImplementation(((filter: Record<string, unknown>, update: Record<string, unknown>) => {
                if (filter._id === cartRequest._id && update.status === AiChangeStatus.PROPOSED) return Promise.reject(new Error("document too large"))
                updates.push({ model: "request", filter, update })
                return Promise.resolve({ ...filter, ...update })
            }) as never)

            await run()

            expect(updates).toContainEqual(
                expect.objectContaining({ filter: { _id: request._id, status: AiChangeStatus.RUNNING }, update: expect.objectContaining({ status: AiChangeStatus.PROPOSED }) })
            )
            expect(updates).toContainEqual(
                expect.objectContaining({
                    model: "request",
                    update: expect.objectContaining({ status: AiChangeStatus.FAILED, error: expect.stringContaining("Only 1 of 2 proposals could be saved") })
                })
            )
            const done = updates.find(({ model, update }) => model === "job" && update.status === AiJobStatus.DONE)
            expect(done?.update.error).toContain("document too large")
            expect(updates.some(({ model, update }) => model === "job" && update.status === AiJobStatus.FAILED)).toBe(false)
        })

        const rateLimit = () => new Error("Your requests to gpt-6.1-sol for gpt-6.1-sol in northcentralus have exceeded token rate limit.")
        const failed = () => updates.some(({ update }) => update.status === AiChangeStatus.FAILED || update.status === AiJobStatus.FAILED)

        it("Given an agent that stops midway after writing files, when the job ends, then what it wrote is proposed as incomplete and the job is done", async () => {
            runAgent.mockImplementationOnce(async () => {
                fs.writeFileSync(path.join(dir, "src/App.tsx"), "half done\n")
                throw rateLimit()
            })

            await run()

            const proposal = updates.find(({ model, update }) => model === "request" && update.status === AiChangeStatus.PROPOSED)
            expect(proposal?.update.files).toEqual([expect.objectContaining({ path: "src/App.tsx", proposedContent: "half done\n" })])
            expect(proposal?.update.error).toMatch(/incomplete.*rate limiting/)
            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.DONE }) }))
            expect(failed()).toBe(false)
            expect(workingCopy.discardChanges).toHaveBeenCalled()
        })

        it("Given an agent that stops before writing anything, when the job ends, then it fails with the provider's error", async () => {
            vi.mocked(workingCopy.changes as ReturnType<typeof vi.fn>).mockResolvedValue([])
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([{ ...request, parentId: undefined }] as never)
            runAgent.mockRejectedValueOnce(rateLimit())

            await run()

            expect(updates.some(({ update }) => update.status === AiChangeStatus.PROPOSED)).toBe(false)
            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.FAILED, error: expect.stringContaining("rate limit") }) }))
        })

        /** An endpoint's answer quoted in the provider's error must not reach the job: it is what an endpoint inside the network would leak. */
        it("Given a provider error quoting what the endpoint answered, when the job fails, then the job keeps a generic error, not the provider's", async () => {
            vi.mocked(workingCopy.changes as ReturnType<typeof vi.fn>).mockResolvedValue([])
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([{ ...request, parentId: undefined }] as never)
            runAgent.mockRejectedValueOnce(Object.assign(new Error("404 <html>internal admin console</html>"), { status: 404 }))

            await run()

            const failure = updates.find(({ model, update }) => model === "job" && update.status === AiJobStatus.FAILED)
            expect(failure?.update.error).toContain("The AI provider could not answer")
            expect(failure?.update.error).not.toContain("internal admin console")
        })

        it("Given a follow-up whose agent stops before changing the parent's files, when the job ends, then it fails and the parent stays applicable", async () => {
            // The working copy holds the parent's files, restored before the agent ran.
            vi.mocked(workingCopy.changes as ReturnType<typeof vi.fn>).mockResolvedValue([
                { path: "src/App.tsx", action: "update", baseBlobOid: "app-blob" },
                { path: "src/Price.tsx", action: "create" }
            ])
            runAgent.mockRejectedValueOnce(rateLimit())

            await run()

            expect(updates.some(({ update }) => update.status === AiChangeStatus.PROPOSED || update.status === AiChangeStatus.DISCARDED)).toBe(false)
            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.FAILED, error: expect.stringContaining("rate limit") }) }))
        })

        it("Given a job declared dead while its agent works, when the agent stops, then nothing it wrote is proposed", async () => {
            runAgent.mockImplementationOnce(async (_client: unknown, _input: unknown, hooks: { onUsage: (usage: unknown) => Promise<void> }, signal: AbortSignal) => {
                fs.writeFileSync(path.join(dir, "src/App.tsx"), "half done\n")
                const job = (await AiChangeJob.findById(jobId)) as unknown as { status: AiJobStatus }
                job.status = AiJobStatus.FAILED
                await hooks.onUsage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })
                signal.throwIfAborted()
                return { summary: "", stopReason: "finished" }
            })

            await run()

            expect(updates.some(({ update }) => update.status === AiChangeStatus.PROPOSED)).toBe(false)
        })
    })

    describe("apply", () => {
        const jobId = new Types.ObjectId()
        let status: AiJobStatus

        beforeEach(() => {
            status = AiJobStatus.DONE
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({ _id: jobId, rootJobId: jobId, projectId, userId: user._id, frontendIds: [catalog._id, cart._id], status, usage: {}, updatedAt: new Date() })) as never)
            const proposal = (owner: { _id: Types.ObjectId }) => ({
                _id: new Types.ObjectId(),
                jobId,
                frontendId: owner._id,
                status: AiChangeStatus.PROPOSED,
                files: [{ path: "src/a.ts", action: "update", baseBlobOid: "blob", proposedContent: "x" }]
            })
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([proposal(cart), proposal(catalog)] as never)
        })

        const claims = () => updates.filter(({ update }) => update.status === AiChangeStatus.APPLYING)

        it("Given a job someone else started, when a member applies it, then it is refused without claiming, and an organization administrator may", async () => {
            vi.spyOn(AiChangeJob, "findById").mockImplementation((() =>
                Promise.resolve({ _id: jobId, rootJobId: jobId, projectId, userId: new Types.ObjectId(), frontendIds: [catalog._id, cart._id], status, usage: {}, updatedAt: new Date() })) as never)
            vi.spyOn(AiChangeJobService.prototype as unknown as WithApplyClaimed, "applyClaimed").mockResolvedValue({})

            await expect(service().apply(String(jobId))).rejects.toMatchObject({ code: "AI_JOB_NOT_OWNER", statusCode: 403 })
            expect(claims()).toEqual([])

            vi.spyOn(BaseAuthorizedService.prototype as unknown as WithGates, "isOrganizationAdmin").mockResolvedValue(true)
            await service().apply(String(jobId))
            expect(claims()).toHaveLength(2)
        })

        it("Given a job not finished, when it is applied, then it is refused", async () => {
            status = AiJobStatus.RUNNING

            await expect(service().apply(String(jobId))).rejects.toMatchObject({ code: "AI_JOB_NOT_DONE", statusCode: 409 })
        })

        it("Given a follow-up refining one of its proposals, when the job is applied, then nothing is claimed", async () => {
            vi.spyOn(AiChangeRequest, "exists").mockResolvedValue({ _id: new Types.ObjectId() } as never)
            const applyClaimed = vi.spyOn(AiChangeJobService.prototype as unknown as WithApplyClaimed, "applyClaimed")

            await expect(service().apply(String(jobId))).rejects.toMatchObject({ code: "AI_JOB_FOLLOW_UP_RUNNING", statusCode: 409 })
            expect(claims()).toEqual([])
            expect(applyClaimed).not.toHaveBeenCalled()
        })

        it("Given a member assigned to a domain and a repository of the job shared with another domain, when the job is applied, then nothing is claimed", async () => {
            const ownDomain = new Types.ObjectId()
            const link = { enabled: true, codeRepositoryId: connectionId, name: "shop-web" }
            frontends = [catalog, cart].map(candidate => ({ ...candidate, domainId: ownDomain, codeRepository: link }))
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(ownDomain)])
            vi.spyOn(CodeRepository, "findById").mockResolvedValue({ provider: CodeRepositoryProvider.GITHUB } as never)
            vi.spyOn(Frontend, "exists").mockResolvedValue({ _id: new Types.ObjectId() } as never)
            vi.spyOn(Backend, "exists").mockResolvedValue(null as never)
            const applyClaimed = vi.spyOn(AiChangeJobService.prototype as unknown as WithApplyClaimed, "applyClaimed")

            await expect(service().apply(String(jobId))).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN", statusCode: 403 })
            expect(claims()).toEqual([])
            expect(applyClaimed).not.toHaveBeenCalled()
        })

        it("Given two proposals, when the job is applied, then it answers with both claimed and brings them onto their base afterwards, one after the other", async () => {
            let release: () => void = () => undefined
            const firstDone = new Promise<void>(resolve => {
                release = resolve
            })
            const applyClaimed = vi
                .spyOn(AiChangeJobService.prototype as unknown as WithApplyClaimed, "applyClaimed")
                .mockImplementationOnce(async () => {
                    await firstDone
                    return {}
                })
                .mockResolvedValueOnce({})

            await service().apply(String(jobId))

            expect(claims()).toHaveLength(2)
            expect(applyClaimed.mock.calls.length).toBeLessThanOrEqual(1)
            release()
            await vi.waitFor(() => expect(applyClaimed).toHaveBeenCalledTimes(2))
            expect(applyClaimed.mock.calls.map(([request]) => String((request as { frontendId: unknown }).frontendId))).toEqual([String(catalog._id), String(cart._id)])
            expect(pushed(updates)).toContain("applying")
        })

        it("Given a proposal that cannot be applied, when the job is applied, then the next one is applied anyway", async () => {
            const applyClaimed = vi
                .spyOn(AiChangeJobService.prototype as unknown as WithApplyClaimed, "applyClaimed")
                .mockRejectedValueOnce(new Error("conflict"))
                .mockResolvedValueOnce({})

            await service().apply(String(jobId))

            await vi.waitFor(() => expect(applyClaimed).toHaveBeenCalledTimes(2))
        })
    })

    describe("stop", () => {
        const jobId = new Types.ObjectId()
        const job = (status: AiJobStatus) => ({ _id: jobId, rootJobId: jobId, projectId, userId: user._id, frontendIds: [catalog._id, cart._id], status, usage: {}, updatedAt: new Date() })
        let stopped: ReturnType<typeof job> | null

        beforeEach(() => {
            vi.spyOn(AiChangeJob, "findById").mockResolvedValue(job(AiJobStatus.RUNNING) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([] as never)
            stopped = { ...job(AiJobStatus.FAILED), stoppedAt: new Date() } as ReturnType<typeof job>
            vi.spyOn(AiChangeJob, "findOneAndUpdate").mockImplementation(((filter: Record<string, unknown>, update: Record<string, unknown>) => {
                updates.push({ model: "job", filter, update })
                return Promise.resolve(stopped)
            }) as never)
        })

        it("Given a job someone else started, when a member stops it, then it is refused and it keeps running; an organization administrator may stop it", async () => {
            vi.spyOn(AiChangeJob, "findById").mockResolvedValue({ ...job(AiJobStatus.RUNNING), userId: new Types.ObjectId() } as never)

            await expect(service().stop(String(jobId))).rejects.toMatchObject({ code: "AI_JOB_NOT_OWNER", statusCode: 403 })
            expect(updates).toEqual([])

            vi.spyOn(BaseAuthorizedService.prototype as unknown as WithGates, "isOrganizationAdmin").mockResolvedValue(true)
            await service().stop(String(jobId))
            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.FAILED }) }))
        })

        it("Given a job at work, when it is stopped, then it ends as stopped and its requests at work are discarded", async () => {
            const view = await service().stop(String(jobId))

            expect(view.stoppedAt).toBeDefined()
            expect(updates).toContainEqual(
                expect.objectContaining({
                    model: "job",
                    filter: { _id: jobId, status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] }, "events.message": { $ne: "pushing" } },
                    update: expect.objectContaining({ status: AiJobStatus.FAILED, stoppedAt: expect.any(Date) })
                })
            )
            expect(updates).toContainEqual(
                expect.objectContaining({
                    model: "request",
                    filter: { jobId, status: { $in: [AiChangeStatus.PENDING, AiChangeStatus.RUNNING] } },
                    update: expect.objectContaining({ status: AiChangeStatus.DISCARDED })
                })
            )
            expect(pushed(updates)).toContain("stopped")
        })

        it("Given a job already done or pushing its proposals, when it is stopped, then it is refused and no request is touched", async () => {
            stopped = null

            await expect(service().stop(String(jobId))).rejects.toMatchObject({ code: "AI_JOB_NOT_RUNNING", statusCode: 409 })
            expect(updates.filter(({ model }) => model === "request")).toEqual([])
        })

        it("Given a viewer of the project, when they stop a job, then it is refused", async () => {
            role = RoleInProject.VIEWER

            await expect(service().stop(String(jobId))).rejects.toBeDefined()
            expect(updates).toEqual([])
        })
    })

    describe("a job someone else started", () => {
        it("Given a job of another member, when it is read, then it reads as not theirs to act on, with who started it", async () => {
            const jobId = new Types.ObjectId()
            const owner = { _id: new Types.ObjectId(), name: "Grace", surname: "Hopper", email: "grace@example.com" }
            vi.spyOn(AiChangeJob, "findById").mockResolvedValue({
                _id: jobId,
                rootJobId: jobId,
                projectId,
                userId: owner._id,
                frontendIds: [catalog._id],
                status: AiJobStatus.DONE,
                usage: {},
                updatedAt: new Date()
            } as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([] as never)
            vi.spyOn(User, "find").mockResolvedValue([owner] as never)

            expect(await service().get(String(jobId))).toMatchObject({ canAct: false, userName: "Grace Hopper" })
        })
    })

    describe("a job of a mission", () => {
        it("Given a job started by a mission, when it ends, however it ends, then the mission moves on", async () => {
            const missionId = new Types.ObjectId()
            const jobId = new Types.ObjectId()
            vi.spyOn(AiChangeJob, "findById").mockResolvedValue({ _id: jobId, projectId, userId: user._id, missionId, frontendIds: [catalog._id], status: AiJobStatus.PENDING } as never)
            vi.spyOn(Project, "findById").mockResolvedValue(null as never)
            const advance = vi.spyOn(AiMissionService.prototype, "advance").mockResolvedValue(undefined)

            await (service() as unknown as WithProcess).process(String(jobId), {} as LlmClient)

            expect(updates).toContainEqual(expect.objectContaining({ model: "job", update: expect.objectContaining({ status: AiJobStatus.FAILED }) }))
            expect(advance).toHaveBeenCalledWith(String(missionId))
        })
    })

    describe("working", () => {
        it("Given two jobs, one of a mission, and a change on the cart alone, when the project is asked, then each agent is listed with what it works on", async () => {
            const missionId = new Types.ObjectId()
            const jobs = [
                { _id: new Types.ObjectId(), frontendIds: [catalog._id, cart._id], backendIds: [catalogApi._id] },
                { _id: new Types.ObjectId(), missionId, frontendIds: [catalog._id] }
            ]
            const requestId = new Types.ObjectId()
            vi.spyOn(AiChangeJob, "find").mockResolvedValue(jobs as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([{ _id: requestId, frontendId: cart._id }] as never)

            const working = await service().working(projectId)

            expect(working).toEqual([
                { jobId: String(jobs[0]._id), kind: "job", componentIds: [String(catalog._id), String(cart._id), String(catalogApi._id)] },
                { jobId: String(jobs[1]._id), kind: "job", missionId: String(missionId), componentIds: [String(catalog._id)] },
                { jobId: String(requestId), kind: "request", componentIds: [String(cart._id)] }
            ])
            // Only what is running and still alive: a job's own requests are listed through the job.
            const [jobFilter] = (AiChangeJob.find as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
            expect(jobFilter).toMatchObject({ status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] }, updatedAt: { $gt: expect.any(Date) } })
            const [requestFilter] = (AiChangeRequest.find as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
            expect(requestFilter).toMatchObject({ jobId: { $exists: false }, status: { $in: [AiChangeStatus.PENDING, AiChangeStatus.RUNNING] } })
        })

        it("Given a domain-scoped member, when the project is asked, then only the jobs they may open are listed, whole, and the changes on what they see", async () => {
            const ownDomain = new Types.ObjectId()
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(ownDomain)])
            const jobs = [
                { _id: new Types.ObjectId(), scope: "selection", frontendIds: [catalog._id, cart._id] },
                { _id: new Types.ObjectId(), scope: "selection", frontendIds: [catalog._id] },
                { _id: new Types.ObjectId(), scope: "global", frontendIds: [catalog._id] }
            ]
            const requests = [
                { _id: new Types.ObjectId(), frontendId: catalog._id },
                { _id: new Types.ObjectId(), frontendId: cart._id }
            ]
            vi.spyOn(AiChangeJob, "find").mockResolvedValue(jobs as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue(requests as never)
            // Only the catalog is in the member's domain.
            vi.spyOn(Frontend, "find").mockResolvedValue([{ _id: catalog._id, domainId: ownDomain }] as never)
            vi.spyOn(Backend, "find").mockResolvedValue([] as never)

            expect(await service().working(projectId)).toEqual([
                { jobId: String(jobs[1]._id), kind: "job", componentIds: [String(catalog._id)] },
                { jobId: String(requests[0]._id), kind: "request", componentIds: [String(catalog._id)] }
            ])
        })

        it("Given nothing running, when the project is asked, then no agent is listed", async () => {
            vi.spyOn(AiChangeJob, "find").mockResolvedValue([] as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([] as never)

            expect(await service().working(projectId)).toEqual([])
        })
    })

    describe("domainConversations", () => {
        it("Given a chain with follow-ups and another conversation, when the domain is listed, then each conversation comes with its first and its latest job only, newest first", async () => {
            const domainId = new Types.ObjectId()
            const job = (rootJobId: Types.ObjectId | undefined, prompt: string, minutes: number) => {
                const _id = new Types.ObjectId()
                return {
                    _id,
                    rootJobId: rootJobId ?? _id,
                    projectId,
                    userId: user._id,
                    prompt,
                    scope: "domain",
                    domainId,
                    status: AiJobStatus.DONE,
                    frontendIds: [],
                    backendIds: [],
                    createdAt: new Date(Date.UTC(2026, 9, 19, 10, minutes)),
                    updatedAt: new Date()
                }
            }
            const shipping = job(undefined, "Show the shipping cost", 0)
            const middle = job(shipping._id, "Also in the summary", 10)
            const latest = job(shipping._id, "And in the email", 20)
            const coupons = job(undefined, "Accept coupons", 5)
            const chains = [shipping, middle, latest, coupons]
            const find = vi.spyOn(AiChangeJob, "find").mockImplementation((() => ({ sort: () => ({ limit: () => Promise.resolve([shipping, coupons]) }) })) as never)
            vi.spyOn(AiChangeJob, "findOne").mockImplementation(((filter: { rootJobId: unknown }) => ({
                sort: () => Promise.resolve(chains.filter(candidate => String(candidate.rootJobId) === String(filter.rootJobId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0])
            })) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([] as never)

            const conversations = await service().domainConversations(projectId, String(domainId))

            expect(find).toHaveBeenCalledWith(expect.objectContaining({ domainId: String(domainId), $expr: { $eq: ["$_id", "$rootJobId"] } }), expect.anything())
            expect(conversations.map(view => view.prompt)).toEqual(["And in the email", "Accept coupons", "Show the shipping cost"])
        })
    })

    describe("list", () => {
        it("Given a domain-scoped member whose latest jobs are all out of their scope, when the jobs are listed, then an older one of theirs still fills the list", async () => {
            const ownDomain = new Types.ObjectId()
            const otherDomain = new Types.ObjectId()
            const job = (domainId: Types.ObjectId, prompt: string, minutes: number) => ({
                _id: new Types.ObjectId(),
                projectId,
                userId: user._id,
                prompt,
                scope: "domain",
                domainId,
                status: AiJobStatus.DONE,
                frontendIds: [],
                backendIds: [],
                createdAt: new Date(Date.UTC(2026, 9, 19, 10, minutes)),
                updatedAt: new Date()
            })
            // A full page of jobs of a domain they have since lost, newer than the one of their own domain
            const jobs = [...Array.from({ length: 20 }, (_, index) => job(otherDomain, `Elsewhere ${index}`, 59 - index)), job(ownDomain, "Show the shipping cost", 0)]
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(ownDomain)])
            type Cursor = { createdAt: Date; _id: Types.ObjectId }
            /** The jobs after the cursor a page starts from, as the database would answer. */
            const after = (filter: { $and?: [unknown, { $or: [unknown, Cursor] }] }) => {
                const cursor = filter.$and?.[1].$or[1]
                return cursor
                    ? jobs.filter(candidate => candidate.createdAt < cursor.createdAt || (candidate.createdAt.getTime() === cursor.createdAt.getTime() && String(candidate._id) < String(cursor._id)))
                    : jobs
            }
            const sorts: unknown[] = []
            const find = vi.spyOn(AiChangeJob, "find").mockImplementation(((filter: Parameters<typeof after>[0]) => ({
                sort: (order: unknown) => {
                    sorts.push(order)
                    return { limit: (limit: number) => Promise.resolve(after(filter).slice(0, limit)) }
                }
            })) as never)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([] as never)

            const listed = await service().list(projectId)

            expect(listed.map(view => view.prompt)).toEqual(["Show the shipping cost"])
            // The second page starts after the last job of the first, ties of createdAt broken by the id:
            // no job read twice nor skipped, even with jobs created between the pages
            const last = jobs[19]
            expect(find.mock.calls[1][0]).toMatchObject({ $and: [{ projectId }, { $or: [{ createdAt: { $lt: last.createdAt } }, { createdAt: last.createdAt, _id: { $lt: last._id } }] }] })
            expect(sorts).toEqual([
                { createdAt: -1, _id: -1 },
                { createdAt: -1, _id: -1 }
            ])
        })

        it("Given a domain-scoped member whose whole long history is out of their scope, when the jobs are listed, then the reading stops after ten pages", async () => {
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(new Types.ObjectId())])
            const elsewhere = () => ({
                _id: new Types.ObjectId(),
                projectId,
                scope: "domain",
                domainId: new Types.ObjectId(),
                status: AiJobStatus.DONE,
                frontendIds: [],
                backendIds: [],
                createdAt: new Date(),
                updatedAt: new Date()
            })
            const find = vi.spyOn(AiChangeJob, "find").mockImplementation((() => ({
                sort: () => ({ limit: (limit: number) => Promise.resolve(Array.from({ length: limit }, elsewhere)) })
            })) as never)

            const listed = await service().list(projectId)

            expect(listed).toEqual([])
            expect(find).toHaveBeenCalledTimes(10)
        })
    })
})
