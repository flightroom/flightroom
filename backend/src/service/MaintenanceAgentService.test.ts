import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

vi.mock("./MarketService", () => ({ default: class {} }))

vi.mock("./TemplateScaffoldService", () => ({
    placeholderDomain: () => "https://console.example.com",
    default: class {}
}))

const createJobFromCronJob = vi.fn()
vi.mock("./ArgoCdService", () => ({
    default: class {
        createJobFromCronJob = createJobFromCronJob
    }
}))

import { BusinessException, createBusinessException } from "../errors/BusinessException"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import MaintenanceRun, { MaintenanceRunStatus } from "../models/MaintenanceRunModel"
import Project from "../models/ProjectModel"
import Service from "../models/ServiceModel"
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
        vi.spyOn(Service, "exists").mockResolvedValue(null)
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

    it("given the slug of a service, when it is created, then it is refused: their values files would be the same", async () => {
        vi.spyOn(Service, "exists").mockResolvedValue({ _id: new Types.ObjectId() } as never)

        expect(await codeOf(create())).toBe("MAINTENANCE_AGENT_SLUG_TAKEN")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a service of another project among its targets, when it is created, then it is refused", async () => {
        vi.spyOn(Service, "find").mockResolvedValue([] as never)

        expect(await codeOf(create({ serviceIds: [String(new Types.ObjectId())] }))).toBe("MAINTENANCE_AGENT_TARGET_INVALID")
    })

    it("given the same frontend twice, when it is created, then it is maintained once", async () => {
        const frontendId = String(new Types.ObjectId())
        vi.spyOn(Frontend, "find").mockResolvedValue([{ _id: frontendId, domainId: null }] as never)

        await create({ frontendIds: [frontendId, frontendId] })

        expect(write.mock.calls[0][0].frontendIds).toEqual([frontendId])
    })
})

describe("MaintenanceAgentService.update", () => {
    it("given a domain-scoped member, when they save the targets they see, then those of other domains stay", async () => {
        const mine = String(new Types.ObjectId())
        const hidden = new Types.ObjectId()
        const agent = { _id: new Types.ObjectId(), projectId, name: "Cleaner", serviceIds: [new Types.ObjectId(mine), hidden], frontendIds: [], configMapIds: [], secretIds: [], resourceIds: [] }
        const service = serviceAs()
        vi.spyOn(service as unknown as Internals, "getDomainScope").mockResolvedValue([String(new Types.ObjectId())] as never)
        vi.spyOn(MaintenanceAgent, "findById").mockResolvedValue(agent as never)
        vi.spyOn(Service, "find").mockResolvedValue([{ _id: hidden }] as never)
        const write = vi.spyOn(MaintenanceAgent, "findByIdAndUpdate").mockResolvedValue(agent as never)

        await service.update(String(agent._id), { serviceIds: [mine] } as MaintenanceAgentDTO)

        expect((write.mock.calls[0][1] as MaintenanceAgentDTO).serviceIds).toEqual([mine, String(hidden)])
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
