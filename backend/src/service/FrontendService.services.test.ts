import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Service from "../models/ServiceModel"
import FrontendService from "./FrontendService"

const projectId = new Types.ObjectId()

/** A frontend whose save returns itself, so the test reads what would be written */
const frontendWith = (serviceIds?: Types.ObjectId[]) => {
    const frontend = { _id: new Types.ObjectId(), projectId, serviceIds, save: vi.fn() }
    frontend.save.mockImplementation(async () => frontend)
    return frontend
}

const serviceFor = (frontend: ReturnType<typeof frontendWith>) => {
    const service = new FrontendService()
    vi.spyOn(service, "getById").mockResolvedValue(frontend as never)
    return service
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("FrontendService.linkService", () => {
    it("given a service of the same project, when it is linked, then the frontend keeps its id", async () => {
        const backend = { _id: new Types.ObjectId(), projectId }
        vi.spyOn(Service, "findById").mockResolvedValue(backend as never)
        const frontend = frontendWith()

        const saved = await serviceFor(frontend).linkService(frontend._id.toString(), backend._id.toString())

        expect(saved.serviceIds?.map(String)).toEqual([backend._id.toString()])
    })

    it("given a service already linked, when it is linked again, then it is not duplicated", async () => {
        const backend = { _id: new Types.ObjectId(), projectId }
        vi.spyOn(Service, "findById").mockResolvedValue(backend as never)
        const frontend = frontendWith([backend._id])

        const saved = await serviceFor(frontend).linkService(frontend._id.toString(), backend._id.toString())

        expect(saved.serviceIds).toHaveLength(1)
    })

    it("given a service of another project, when it is linked, then it is not found", async () => {
        const backend = { _id: new Types.ObjectId(), projectId: new Types.ObjectId() }
        vi.spyOn(Service, "findById").mockResolvedValue(backend as never)
        const frontend = frontendWith()

        await expect(serviceFor(frontend).linkService(frontend._id.toString(), backend._id.toString())).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(frontend.save).not.toHaveBeenCalled()
    })
})

describe("FrontendService.unlinkService", () => {
    it("given a linked service, when it is unlinked, then only that link goes", async () => {
        const kept = new Types.ObjectId()
        const removed = new Types.ObjectId()
        const frontend = frontendWith([kept, removed])

        const saved = await serviceFor(frontend).unlinkService(frontend._id.toString(), removed.toString())

        expect(saved.serviceIds?.map(String)).toEqual([kept.toString()])
    })
})
