import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

vi.mock("./MarketService", () => ({ default: class {} }))

vi.mock("./TemplateScaffoldService", () => ({
    default: class {}
}))

const createJobFromCronJob = vi.fn()
vi.mock("./ArgoCdService", () => ({
    default: class {
        createJobFromCronJob = createJobFromCronJob
    }
}))

import { BusinessException, createBusinessException } from "../errors/BusinessException"
import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import MaintenanceRun, { MaintenanceRunStatus } from "../models/MaintenanceRunModel"
import Project from "../models/ProjectModel"
import { MaintenanceAgentDTO, MaintenanceAgentKind } from "../types/MaintenanceAgent"
import MaintenanceAgentService from "./MaintenanceAgentService"

const projectId = new Types.ObjectId()

type Internals = {
    ensureAccessToProject: () => Promise<void>
    ensureAccessToDomainMember: () => Promise<void>
    ensureInDomainScope: () => Promise<void>
    getDomainScope: () => Promise<undefined>
    ensureNotViewer: () => Promise<void>
}

const serviceAs = (principal?: object) => {
    const service = new MaintenanceAgentService(principal as never)
    const internals = service as unknown as Internals
    vi.spyOn(internals, "ensureAccessToProject").mockResolvedValue()
    vi.spyOn(internals, "ensureAccessToDomainMember").mockResolvedValue()
    vi.spyOn(internals, "ensureInDomainScope").mockResolvedValue()
    vi.spyOn(internals, "getDomainScope").mockResolvedValue(undefined)
    vi.spyOn(internals, "ensureNotViewer").mockResolvedValue()
    return service
}

const codeOf = async (promise: Promise<unknown>) => {
    const error = await promise.catch(failure => failure)
    expect(error).toBeInstanceOf(BusinessException)
    return (error as BusinessException).code
}

afterEach(() => {
    vi.restoreAllMocks()
    createJobFromCronJob.mockReset()
})

describe("MaintenanceAgentService.create", () => {
    let write: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.spyOn(MaintenanceAgent, "exists").mockResolvedValue(null)
        vi.spyOn(Backend, "exists").mockResolvedValue(null)
        vi.spyOn(Frontend, "exists").mockResolvedValue(null)
        write = vi.spyOn(MaintenanceAgent, "create").mockImplementation((async (doc: unknown) => doc) as never) as unknown as ReturnType<typeof vi.fn>
    })

    const create = (overrides: Partial<MaintenanceAgentDTO> = {}) => serviceAs().create({ name: "Cleaner", slug: " Cleaner ", ...overrides } as MaintenanceAgentDTO, String(projectId))

    it("given a blank schedule and time zone, when it is created, then it runs on Play only, with the slug normalised", async () => {
        await create({ schedule: "  ", timeZone: "", kind: MaintenanceAgentKind.CONTAINER })

        expect(write.mock.calls[0][0]).toMatchObject({ slug: "cleaner", schedule: null, timeZone: null, kind: MaintenanceAgentKind.CONTAINER })
    })

    it("given a schedule the cluster would refuse, when it is created, then it is refused and nothing is written", async () => {
        expect(await codeOf(create({ schedule: "every day" }))).toBe("MAINTENANCE_AGENT_SCHEDULE_INVALID")
        expect(write).not.toHaveBeenCalled()
    })

    it("given an unknown time zone, when it is created, then it is refused", async () => {
        expect(await codeOf(create({ schedule: "0 3 * * *", timeZone: "Mars/Olympus" }))).toBe("MAINTENANCE_AGENT_TIMEZONE_INVALID")
    })

    it("given the slug of a backend, when it is created, then it is refused: their values files would be the same", async () => {
        vi.spyOn(Backend, "exists").mockResolvedValue({ _id: new Types.ObjectId() } as never)

        expect(await codeOf(create())).toBe("MAINTENANCE_AGENT_SLUG_TAKEN")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a backend of another project among its targets, when it is created, then it is refused", async () => {
        vi.spyOn(Backend, "find").mockResolvedValue([] as never)

        expect(await codeOf(create({ backendIds: [String(new Types.ObjectId())] }))).toBe("MAINTENANCE_AGENT_TARGET_INVALID")
    })

    it("given the same frontend twice, when it is created, then it is maintained once", async () => {
        const frontendId = String(new Types.ObjectId())
        vi.spyOn(Frontend, "find").mockResolvedValue([{ _id: frontendId, domainId: null }] as never)

        await create({ frontendIds: [frontendId, frontendId] })

        expect(write.mock.calls[0][0].frontendIds).toEqual([frontendId])
    })
})

describe("MaintenanceAgentService resources", () => {
    beforeEach(() => {
        vi.spyOn(MaintenanceAgent, "exists").mockResolvedValue(null)
        vi.spyOn(Backend, "exists").mockResolvedValue(null)
        vi.spyOn(Frontend, "exists").mockResolvedValue(null)
    })

    it.each([
        ["a CPU request above its limit", { cpuRequest: "1", cpuLimit: "500m" }],
        ["a memory request above the default limit of the chart", { memoryRequest: "1Gi" }],
        ["a CPU limit below the default request of the chart", { cpuLimit: "10m" }]
    ])("given %s, when it is created, then it is refused and nothing is written", async (_case, resources) => {
        const write = vi.spyOn(MaintenanceAgent, "create")

        expect(await codeOf(serviceAs().create({ name: "Cleaner", slug: "cleaner", ...resources } as MaintenanceAgentDTO, String(projectId)))).toBe("MAINTENANCE_AGENT_INVALID")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a request within its limit, when it is created, then it is kept", async () => {
        vi.spyOn(MaintenanceAgent, "create").mockImplementation((async (doc: unknown) => doc) as never)

        const agent = await serviceAs().create({ name: "Cleaner", slug: "cleaner", cpuRequest: "1", cpuLimit: "2", memoryRequest: "1Gi", memoryLimit: "1Gi" } as MaintenanceAgentDTO, String(projectId))

        expect(agent).toMatchObject({ cpuRequest: "1", cpuLimit: "2", memoryRequest: "1Gi", memoryLimit: "1Gi" })
    })

    it("given a stored limit, when a request above it is saved, then it is refused; cleared with it, it is saved", async () => {
        const agent = { _id: new Types.ObjectId(), projectId, name: "Cleaner", cpuLimit: "2", backendIds: [], frontendIds: [], configMapIds: [], secretIds: [], resourceIds: [] }
        vi.spyOn(MaintenanceAgent, "findById").mockResolvedValue(agent as never)
        const write = vi.spyOn(MaintenanceAgent, "findByIdAndUpdate").mockResolvedValue(agent as never)

        expect(await codeOf(serviceAs().update(String(agent._id), { cpuRequest: "3" } as MaintenanceAgentDTO))).toBe("MAINTENANCE_AGENT_INVALID")
        expect(write).not.toHaveBeenCalled()

        await serviceAs().update(String(agent._id), { cpuRequest: "400m", cpuLimit: null } as MaintenanceAgentDTO)
        expect(write).toHaveBeenCalledOnce()
    })
})

describe("MaintenanceAgentService.update", () => {
    it("given a domain-scoped member, when they save the targets they see, then those of other domains stay", async () => {
        const mine = String(new Types.ObjectId())
        const hidden = new Types.ObjectId()
        const agent = { _id: new Types.ObjectId(), projectId, name: "Cleaner", backendIds: [new Types.ObjectId(mine), hidden], frontendIds: [], configMapIds: [], secretIds: [], resourceIds: [] }
        const service = serviceAs()
        vi.spyOn(service as unknown as Internals, "getDomainScope").mockResolvedValue([String(new Types.ObjectId())] as never)
        vi.spyOn(MaintenanceAgent, "findById").mockResolvedValue(agent as never)
        vi.spyOn(Backend, "find").mockResolvedValue([{ _id: hidden }] as never)
        const write = vi.spyOn(MaintenanceAgent, "findByIdAndUpdate").mockResolvedValue(agent as never)

        await service.update(String(agent._id), { backendIds: [mine] } as MaintenanceAgentDTO)

        expect((write.mock.calls[0][1] as MaintenanceAgentDTO).backendIds).toEqual([mine, String(hidden)])
    })
})

describe("MaintenanceAgentService.run", () => {
    const agentId = new Types.ObjectId()
    const environment = { _id: new Types.ObjectId(), slug: "dev", projectId }
    const agent = { _id: agentId, projectId, slug: "cleaner", name: "Cleaner", version: "1.0.0", image: { repository: "ghcr.io/acme/cleaner" } }

    let stored: ReturnType<typeof vi.fn>
    let lastRun: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.spyOn(MaintenanceAgent, "findById").mockResolvedValue(agent as never)
        vi.spyOn(Environment, "findOne").mockResolvedValue(environment as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId } as never)
        stored = vi.spyOn(MaintenanceRun, "create").mockImplementation((async (doc: unknown) => doc) as never) as unknown as ReturnType<typeof vi.fn>
        lastRun = vi.spyOn(MaintenanceAgent, "updateOne").mockResolvedValue({} as never) as unknown as ReturnType<typeof vi.fn>
    })

    it("given an agent deployed through Argo CD, when it is run, then a Job is created from its CronJob and the run is started", async () => {
        const run = await serviceAs().run(String(agentId), String(environment._id))

        expect(createJobFromCronJob).toHaveBeenCalledWith(projectId, "cleaner", environment)
        expect(run).toMatchObject({ status: MaintenanceRunStatus.STARTED, environmentId: environment._id })
        expect(lastRun.mock.calls[0][1].$set.lastRun).toMatchObject({ ok: true, environmentId: environment._id })
    })

    it("given Argo CD refusing, when it is run, then the run is kept as failed with the reason", async () => {
        createJobFromCronJob.mockRejectedValue(createBusinessException({ code: "ARGOCD_REQUEST_FAILED", message: "Argo CD did not start a run (404 application not found)", statusCode: 502 }))

        const run = await serviceAs().run(String(agentId), String(environment._id))

        expect(run).toMatchObject({ status: MaintenanceRunStatus.FAILED, error: "Argo CD did not start a run (404 application not found)" })
        expect(lastRun.mock.calls[0][1].$set.lastRun).toMatchObject({ ok: false })
    })

    it("given a project with no Argo CD, when it is run, then it is refused and no run is kept", async () => {
        createJobFromCronJob.mockRejectedValue(createBusinessException({ code: "ARGOCD_NOT_CONFIGURED", message: "no Argo CD", statusCode: 422 }))

        expect(await codeOf(serviceAs().run(String(agentId), String(environment._id)))).toBe("ARGOCD_NOT_CONFIGURED")
        expect(stored).not.toHaveBeenCalled()
    })

    it("given an agent with no version yet, when it is run, then it is refused before Argo CD is asked", async () => {
        vi.spyOn(MaintenanceAgent, "findById").mockResolvedValue({ ...agent, version: undefined } as never)

        expect(await codeOf(serviceAs().run(String(agentId), String(environment._id)))).toBe("MAINTENANCE_AGENT_NOT_DEPLOYED")
        expect(createJobFromCronJob).not.toHaveBeenCalled()
    })

    it("given no environment, when it is run, then it is refused", async () => {
        expect(await codeOf(serviceAs().run(String(agentId), undefined as unknown as string))).toBe("MAINTENANCE_AGENT_INVALID")
    })

    it("given a user, when it is run, then the run says who started it; an API key is nobody", async () => {
        const userId = new Types.ObjectId()
        await serviceAs({ _id: userId }).run(String(agentId), String(environment._id))
        await serviceAs({ _id: new Types.ObjectId(), apiKeyId: "key" }).run(String(agentId), String(environment._id))

        expect(stored.mock.calls[0][0].userId).toBe(userId)
        expect(stored.mock.calls[1][0].userId).toBeUndefined()
    })
})

describe("MaintenanceAgentService.revokeRuntimeTokens", () => {
    const agentId = new Types.ObjectId()
    const production = new Types.ObjectId()
    const development = new Types.ObjectId()
    const agent = { _id: agentId, projectId, slug: "cleaner", name: "Cleaner" }
    const runtimeTokens = [
        { environmentId: production, token: "fra_production" },
        { environmentId: development, token: "fra_development" }
    ]

    let revoke: ReturnType<typeof vi.fn>

    beforeEach(() => {
        // Read once as the console reads it, once with the tokens it never answers with
        vi.spyOn(MaintenanceAgent, "findById").mockImplementation((() => Object.assign(Promise.resolve(agent), { select: () => Promise.resolve({ ...agent, runtimeTokens }) })) as never)
        revoke = vi.spyOn(MaintenanceAgent, "updateOne").mockResolvedValue({} as never) as unknown as ReturnType<typeof vi.fn>
    })

    it("given an environment, when its token is revoked, then only that one goes", async () => {
        expect(await serviceAs().revokeRuntimeTokens(String(agentId), String(production))).toEqual({ revoked: 1 })

        expect(revoke).toHaveBeenCalledWith({ _id: agentId }, { $pull: { runtimeTokens: { environmentId: String(production) } } })
    })

    it("given no environment, when the tokens are revoked, then those of every environment go", async () => {
        expect(await serviceAs().revokeRuntimeTokens(String(agentId))).toEqual({ revoked: 2 })

        expect(revoke).toHaveBeenCalledWith({ _id: agentId }, { $unset: { runtimeTokens: 1 } })
    })

    it("given an environment the agent holds no token for, when it is revoked, then nothing is written", async () => {
        expect(await serviceAs().revokeRuntimeTokens(String(agentId), String(new Types.ObjectId()))).toEqual({ revoked: 0 })

        expect(revoke).not.toHaveBeenCalled()
    })

    it("given a viewer, when the tokens are revoked, then it is refused and nothing is written", async () => {
        const service = serviceAs()
        vi.mocked((service as unknown as Internals).ensureNotViewer).mockRejectedValue(createBusinessException({ code: "MAINTENANCE_AGENT_TOKEN_FORBIDDEN", message: "viewer" }))

        expect(await codeOf(service.revokeRuntimeTokens(String(agentId)))).toBe("MAINTENANCE_AGENT_TOKEN_FORBIDDEN")
        expect(revoke).not.toHaveBeenCalled()
    })
})
