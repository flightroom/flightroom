import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Domain from "../models/DomainModel"
import Frontend from "../models/FrontendModel"
import FrontendDTO from "../types/FrontendDTO"
import FrontendService from "./FrontendService"

const projectId = new Types.ObjectId()
const domainId = new Types.ObjectId().toString()
const host = { type: "MFE_ORCHESTRATOR_HUB", entryPoint: "assets/remoteEntry.js" }

afterEach(() => {
    vi.restoreAllMocks()
})

describe("FrontendService.create domain", () => {
    let write: ReturnType<typeof vi.fn>

    beforeEach(() => {
        // The slug is free: checked before any repository is created
        vi.spyOn(Frontend, "exists").mockResolvedValue(null as never)
        write = vi.spyOn(Frontend, "create").mockImplementation((async (doc: unknown) => doc) as never) as unknown as ReturnType<typeof vi.fn>
    })

    const create = (domain: unknown) => {
        const service = new FrontendService()
        vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()
        return service.create({ name: "cart", slug: "cart", version: "1.0.0", host, domainId: domain } as unknown as FrontendDTO, projectId.toString())
    }

    it("given a domain of another project, when a frontend is created in it, then it is not found and nothing is written", async () => {
        const exists = vi.spyOn(Domain, "exists").mockResolvedValue(null)

        await expect(create(domainId)).rejects.toMatchObject({ code: "DOMAIN_NOT_FOUND", statusCode: 404 })
        expect(exists).toHaveBeenCalledWith({ _id: domainId, projectId: projectId.toString() })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a domain of its project, when a frontend is created in it, then it is written with the domain", async () => {
        vi.spyOn(Domain, "exists").mockResolvedValue({ _id: domainId } as never)

        await create(domainId)

        expect(write.mock.calls[0][0]).toMatchObject({ domainId })
    })

    it("given a blank domain, when a frontend is created, then it is written in no domain", async () => {
        const exists = vi.spyOn(Domain, "exists")

        await create("")

        expect(write.mock.calls[0][0]).toMatchObject({ domainId: null })
        expect(exists).not.toHaveBeenCalled()
    })
})

describe("FrontendService.update domain", () => {
    const frontendId = new Types.ObjectId()
    const frontend = { _id: frontendId, projectId, slug: "cart", name: "Cart" }
    let write: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.spyOn(FrontendService.prototype, "getById").mockResolvedValue(frontend as never)
        vi.spyOn(FrontendService.prototype as unknown as { ensureAccessToFrontend: () => Promise<void> }, "ensureAccessToFrontend").mockResolvedValue(undefined)
        write = vi.spyOn(Frontend, "findByIdAndUpdate").mockResolvedValue(frontend as never) as unknown as ReturnType<typeof vi.fn>
    })

    const update = (updates: Record<string, unknown>) => new FrontendService().update(String(frontendId), updates as unknown as FrontendDTO)

    it("given a domain of another project, when a frontend is put in it, then it is not found and nothing is written", async () => {
        const exists = vi.spyOn(Domain, "exists").mockResolvedValue(null)

        await expect(update({ name: "Cart", domainId })).rejects.toMatchObject({ code: "DOMAIN_NOT_FOUND", statusCode: 404 })
        expect(exists).toHaveBeenCalledWith({ _id: domainId, projectId })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a blank domain, when a frontend is updated, then it is taken out of its domain", async () => {
        await update({ name: "Cart", domainId: "" })

        expect(write.mock.calls[0][1]).toEqual({ name: "Cart", domainId: null })
    })

    it("given a project, a slug and an _id in the updates, when a frontend is updated, then none of them is written", async () => {
        await update({ name: "Cart", projectId: new Types.ObjectId().toString(), slug: "renamed", _id: new Types.ObjectId().toString() })

        expect(write).toHaveBeenCalledWith(frontendId, { name: "Cart" }, { new: true, runValidators: true })
    })
})
