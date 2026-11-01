import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import Backend from "../models/BackendModel"
import BuiltBackend from "../models/BuiltBackendModel"
import BuiltFrontend from "../models/BuiltFrontendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Frontend from "../models/FrontendModel"
import { BuildRunDTO, BuildStatus } from "../types/BuildStatusDTO"
import BuildStatusService from "./BuildStatusService"

const projectId = new Types.ObjectId()
const backend = { _id: new Types.ObjectId(), projectId, name: "Orders", slug: "orders", codeRepository: { enabled: true, codeRepositoryId: new Types.ObjectId() } }
const getRuns = vi.fn<() => Promise<BuildRunDTO[]>>()

afterEach(() => {
    vi.restoreAllMocks()
})

describe("BuildStatusService.buildOf", () => {
    beforeEach(() => {
        vi.spyOn(BuildStatusService.prototype as unknown as { ensureAccessToDomainMember: () => Promise<void> }, "ensureAccessToDomainMember").mockResolvedValue(undefined)
        vi.spyOn(Backend, "findById").mockResolvedValue(backend as never)
        vi.spyOn(BuiltBackend, "exists").mockResolvedValue(null as never)
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({ _id: backend.codeRepository.codeRepositoryId, provider: "GITHUB" } as never)
        getRuns.mockReset().mockResolvedValue([])
        vi.spyOn(BuildStatusService.prototype as unknown as { getRuns: typeof getRuns }, "getRuns").mockImplementation(getRuns)
    })

    const buildOf = (version = "1.2.0") => new BuildStatusService().buildOf(String(projectId), { backendId: String(backend._id) }, version)

    it("given a version its CI registered, when its build is read, then it is registered and the provider is not asked", async () => {
        vi.mocked(BuiltBackend.exists).mockResolvedValue({ _id: new Types.ObjectId() } as never)

        await expect(buildOf()).resolves.toEqual({ version: "1.2.0", state: "registered" })
        expect(BuiltBackend.exists).toHaveBeenCalledWith({ backendId: backend._id, version: "1.2.0" })
        expect(getRuns).not.toHaveBeenCalled()
    })

    it("given the run of its tag, when its build is read, then its state follows the run, a successful one still registering the version", async () => {
        const run = (status: BuildStatus) => ({ id: "41", status, ref: "1.2.0" })
        for (const [status, state] of [
            [BuildStatus.QUEUED, "queued"],
            [BuildStatus.RUNNING, "running"],
            [BuildStatus.SUCCESS, "registering"],
            [BuildStatus.FAILED, "failed"],
            [BuildStatus.CANCELED, "canceled"]
        ] as const) {
            getRuns.mockResolvedValue([{ id: "40", status: BuildStatus.SUCCESS, ref: "1.1.0" }, run(status)])
            await expect(buildOf()).resolves.toEqual({ version: "1.2.0", state, run: run(status) })
        }
    })

    it("given a tag that started several workflows, when its build is read, then a failed one tells over one that succeeded", async () => {
        getRuns.mockResolvedValue([
            { id: "42", status: BuildStatus.SUCCESS, ref: "1.2.0" },
            { id: "41", status: BuildStatus.FAILED, ref: "1.2.0" }
        ])

        await expect(buildOf()).resolves.toMatchObject({ state: "failed", run: { id: "41" } })
    })

    it("given no run of its tag yet, when its build is read, then it has not started", async () => {
        getRuns.mockResolvedValue([{ id: "40", status: BuildStatus.SUCCESS, ref: "1.1.0" }])

        await expect(buildOf()).resolves.toEqual({ version: "1.2.0", state: "not_started" })
    })

    it("given a backend of another project, when its build is read, then it is not found and nothing else is read", async () => {
        vi.mocked(Backend.findById).mockResolvedValue({ ...backend, projectId: new Types.ObjectId() } as never)

        await expect(buildOf()).rejects.toThrow("Backend not found in this project")
        expect(BuiltBackend.exists).not.toHaveBeenCalled()
    })

    it("given a frontend, when its build is read, then its own versions are searched", async () => {
        vi.spyOn(Frontend, "findById").mockResolvedValue({ ...backend, slug: "checkout" } as never)
        vi.spyOn(BuiltFrontend, "exists").mockResolvedValue({ _id: new Types.ObjectId() } as never)

        await expect(new BuildStatusService().buildOf(String(projectId), { frontendId: String(backend._id) }, "2.0.0")).resolves.toEqual({ version: "2.0.0", state: "registered" })
        expect(BuiltFrontend.exists).toHaveBeenCalledWith({ frontendId: backend._id, version: "2.0.0" })
    })
})
