import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"
import Frontend, { HostedOn } from "../models/FrontendModel"
import Storage from "../models/StorageModel"
import FrontendDTO from "../types/FrontendDTO"
import FrontendService from "./FrontendService"

const projectId = new Types.ObjectId()

/** Runs a create with the access check and the write stubbed, and returns what would be written. */
const created = async (frontend: Partial<FrontendDTO>) => {
    const service = new FrontendService()
    vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()
    // The slug is free: checked before any repository is created
    vi.spyOn(Frontend, "exists").mockResolvedValue(null as never)
    const create = vi.spyOn(Frontend, "create").mockImplementation((async (doc: unknown) => doc) as never)
    await service.create({ name: "cart", slug: "cart", version: "1.0.0", ...frontend } as FrontendDTO, projectId.toString())
    return create.mock.calls[0][0] as unknown as { host: Record<string, unknown> }
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("FrontendService.create hosting", () => {
    /** The assistant created frontends without a host, and the required field failed every save. */
    it("given no host and a default storage, when a frontend is created, then it is served from that storage", async () => {
        const storageId = new Types.ObjectId()
        vi.spyOn(Storage, "findOne").mockResolvedValue({ _id: storageId } as never)

        const { host } = await created({})

        expect(host).toEqual({ type: HostedOn.CUSTOM_SOURCE, storageId, entryPoint: "assets/remoteEntry.js" })
    })

    it("given no host and no default storage, when a frontend is created, then it is served from the Flightroom hub", async () => {
        vi.spyOn(Storage, "findOne").mockResolvedValue(null as never)

        const { host } = await created({})

        expect(host).toEqual({ type: HostedOn.MFE_ORCHESTRATOR_HUB, entryPoint: "assets/remoteEntry.js" })
    })

    it("given a host, when a frontend is created, then it is kept as given", async () => {
        const findOne = vi.spyOn(Storage, "findOne")
        const host = { type: HostedOn.CUSTOM_URL, url: "https://cdn.example.com/cart" }

        expect((await created({ host })).host).toEqual(host)
        expect(findOne).not.toHaveBeenCalled()
    })
})
