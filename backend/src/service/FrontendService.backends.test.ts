import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Backend from "../models/BackendModel"
import FrontendService from "./FrontendService"

const projectId = new Types.ObjectId()

/** A frontend whose save returns itself, so the test reads what would be written */
const frontendWith = (backendIds?: Types.ObjectId[]) => {
    const frontend = { _id: new Types.ObjectId(), projectId, backendIds, save: vi.fn() }
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

describe("FrontendService.linkBackend", () => {
    it("given a backend of the same project, when it is linked, then the frontend keeps its id", async () => {
        const backend = { _id: new Types.ObjectId(), projectId }
        vi.spyOn(Backend, "findById").mockResolvedValue(backend as never)
        const frontend = frontendWith()

        const saved = await serviceFor(frontend).linkBackend(frontend._id.toString(), backend._id.toString())

        expect(saved.backendIds?.map(String)).toEqual([backend._id.toString()])
    })

    it("given a backend already linked, when it is linked again, then it is not duplicated", async () => {
        const backend = { _id: new Types.ObjectId(), projectId }
        vi.spyOn(Backend, "findById").mockResolvedValue(backend as never)
        const frontend = frontendWith([backend._id])

        const saved = await serviceFor(frontend).linkBackend(frontend._id.toString(), backend._id.toString())

        expect(saved.backendIds).toHaveLength(1)
    })

    it("given a backend of another project, when it is linked, then it is not found", async () => {
        const backend = { _id: new Types.ObjectId(), projectId: new Types.ObjectId() }
        vi.spyOn(Backend, "findById").mockResolvedValue(backend as never)
        const frontend = frontendWith()

        await expect(serviceFor(frontend).linkBackend(frontend._id.toString(), backend._id.toString())).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(frontend.save).not.toHaveBeenCalled()
    })
})

describe("FrontendService.unlinkBackend", () => {
    it("given a linked backend, when it is unlinked, then only that link goes", async () => {
        const kept = new Types.ObjectId()
        const removed = new Types.ObjectId()
        const frontend = frontendWith([kept, removed])

        const saved = await serviceFor(frontend).unlinkBackend(frontend._id.toString(), removed.toString())

        expect(saved.backendIds?.map(String)).toEqual([kept.toString()])
    })
})
