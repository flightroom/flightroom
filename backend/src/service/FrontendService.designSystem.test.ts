import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import Frontend, { FrontendKind, HostedOn } from "../models/FrontendModel"
import FrontendDTO from "../types/FrontendDTO"
import FrontendService from "./FrontendService"

const projectId = new Types.ObjectId()

afterEach(() => {
    vi.restoreAllMocks()
})

describe("FrontendService, design system", () => {
    const existing = () => ({ _id: new Types.ObjectId(), projectId, slug: "catalog", kind: FrontendKind.BUNDLE, designSystem: { packageName: "@acme/legacy-ui" } })

    const update = async (changes: Record<string, unknown>) => {
        const frontend = existing()
        const service = new FrontendService()
        vi.spyOn(service, "getById").mockResolvedValue(frontend as never)
        vi.spyOn(service, "ensureAccessToFrontend").mockResolvedValue()
        const write = vi.spyOn(Frontend, "findByIdAndUpdate").mockImplementation((async (_id: unknown, written: unknown) => written) as never)
        await service.update(String(frontend._id), changes as unknown as FrontendDTO)
        return write.mock.calls[0]?.[1] as Record<string, unknown> | undefined
    }

    it("given its own design system, when the frontend is updated, then it is written whole and trimmed", async () => {
        const written = await update({ designSystem: { packageName: " @acme/ui ", version: " ^3.2.0 ", notes: "" } })

        expect(written).toEqual({ designSystem: { packageName: "@acme/ui", version: "^3.2.0" } })
    })

    it("given a null design system, when the frontend is updated, then its own is unset and it builds with the project's again", async () => {
        const written = await update({ designSystem: null })

        expect(written).toEqual({ $unset: { designSystem: 1 } })
    })

    it("given a design system without its package, when the frontend is updated, then it is refused before anything is written", async () => {
        await expect(update({ designSystem: { version: "1.0.0" } })).rejects.toMatchObject({ code: "DESIGN_SYSTEM_INVALID", statusCode: 400 })
    })

    it("given a null design system, when a frontend is created, then it is created without one", async () => {
        const service = new FrontendService()
        vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()
        vi.spyOn(Frontend, "exists").mockResolvedValue(null as never)
        const write = vi.spyOn(Frontend, "create").mockImplementation((async (doc: unknown) => doc) as never)

        await service.create({ name: "Catalog", slug: "catalog", version: "1.0.0", host: { type: HostedOn.MFE_ORCHESTRATOR_HUB }, designSystem: null } as unknown as FrontendDTO, String(projectId))

        expect(write.mock.calls[0][0]).not.toHaveProperty("designSystem")
    })
})
