import { ObjectId, Types } from "mongoose"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import EnvironmentPromotionService, { promotes, promotionRows } from "./EnvironmentPromotionService"

const newId = () => new Types.ObjectId() as unknown as ObjectId

describe("promotionRows", () => {
    const dev = newId()
    const uat = newId()

    it("reads the version of each application in the two environments", () => {
        const rows = promotionRows("backend", [{ _id: "b1", name: "Orders", slug: "orders-be", environmentVersions: [{ environmentId: dev, version: "1.2.0" }] }], dev, uat)
        expect(rows).toEqual([{ kind: "backend", _id: "b1", name: "Orders", slug: "orders-be", from: "1.2.0", to: undefined }])
    })

    it("changes only an application that runs in the source a version the target does not", () => {
        expect(promotes({ kind: "backend", _id: "1", name: "a", slug: "a", from: "1.2.0", to: "1.1.0" })).toBe(true)
        expect(promotes({ kind: "backend", _id: "1", name: "a", slug: "a", from: "1.2.0", to: "1.2.0" })).toBe(false)
        // Not running in the source: the target keeps what it runs, it is not taken out of it
        expect(promotes({ kind: "backend", _id: "1", name: "a", slug: "a", to: "1.1.0" })).toBe(false)
    })
})

describe("EnvironmentPromotionService.promote", () => {
    const projectId = newId()
    const dev = { _id: newId(), projectId }
    const uat = { _id: newId(), projectId }
    const orders = {
        _id: newId(),
        name: "Orders",
        slug: "orders-be",
        environmentVersions: [
            { environmentId: dev._id, version: "1.2.0" },
            { environmentId: uat._id, version: "1.1.0" }
        ]
    }
    const billing = { _id: newId(), name: "Billing", slug: "billing-be", environmentVersions: [{ environmentId: dev._id, version: "2.0.0" }] }
    const legacy = { _id: newId(), name: "Legacy", slug: "legacy-be", environmentVersions: [{ environmentId: uat._id, version: "0.9.0" }] }
    const shell = { _id: newId(), name: "Shell", slug: "shell-fe", environmentVersions: [{ environmentId: dev._id, version: "3.1.0" }] }

    let updates: { model: string; filter: Record<string, unknown>; update: unknown }[]

    const service = () => {
        const instance = new EnvironmentPromotionService({ _id: newId() } as never)
        // Authorization has its own tests: here it would only stand between the test and the promotion
        const gate = instance as unknown as { ensureAccessToEnvironment: () => Promise<void>; ensureNotViewer: () => Promise<void>; domainScopeFilter: () => Promise<Record<string, unknown>> }
        vi.spyOn(gate, "ensureAccessToEnvironment").mockResolvedValue()
        vi.spyOn(gate, "ensureNotViewer").mockResolvedValue()
        vi.spyOn(gate, "domainScopeFilter").mockResolvedValue({})
        return instance
    }

    const found = (documents: unknown[]) => ({ sort: () => ({ lean: () => Promise.resolve(documents) }) }) as never

    beforeEach(() => {
        vi.restoreAllMocks()
        updates = []
        vi.spyOn(Environment, "findById").mockImplementation(((id: unknown) => Promise.resolve([dev, uat].find(environment => String(environment._id) === String(id)))) as never)
        vi.spyOn(Backend, "find").mockReturnValue(found([orders, billing, legacy]))
        vi.spyOn(Frontend, "find").mockReturnValue(found([shell]))
        vi.spyOn(MaintenanceAgent, "find").mockReturnValue(found([]))
        for (const [model, name] of [
            [Backend, "backend"],
            [Frontend, "frontend"],
            [MaintenanceAgent, "maintenanceAgent"]
        ] as const) {
            vi.spyOn(model, "updateOne").mockImplementation(((filter: Record<string, unknown>, update: unknown) => {
                updates.push({ model: name, filter, update })
                return Promise.resolve({})
            }) as never)
        }
    })

    it("writes in the target the version of the source, for every application it changes", async () => {
        await service().promote(String(uat._id), { from: String(dev._id) })

        expect(updates.map(update => [update.model, String(update.filter._id)])).toEqual([
            ["backend", String(orders._id)],
            ["backend", String(billing._id)],
            ["frontend", String(shell._id)]
        ])
        // The entry of the target is replaced, those of the other environments kept
        const [pipeline] = updates[0].update as { $set: { environmentVersions: { $concatArrays: unknown[] } } }[]
        expect(pipeline.$set.environmentVersions.$concatArrays[1]).toEqual([{ environmentId: new Types.ObjectId(String(uat._id)), version: "1.2.0" }])
    })

    it("changes only the applications picked", async () => {
        await service().promote(String(uat._id), { from: String(dev._id), applications: [{ kind: "frontend", _id: String(shell._id) }] })

        expect(updates.map(update => update.model)).toEqual(["frontend"])
    })

    it("refuses a promotion to the environment it comes from", async () => {
        await expect(service().promote(String(uat._id), { from: String(uat._id) })).rejects.toMatchObject({ code: "ENVIRONMENT_PROMOTION_INVALID" })
        expect(updates).toEqual([])
    })

    it("refuses two environments of different projects", async () => {
        const other = { _id: newId(), projectId: newId() }
        vi.spyOn(Environment, "findById").mockImplementation(((id: unknown) => Promise.resolve([other, uat].find(environment => String(environment._id) === String(id)))) as never)

        await expect(service().promote(String(uat._id), { from: String(other._id) })).rejects.toMatchObject({ code: "ENVIRONMENT_PROMOTION_INVALID" })
        expect(updates).toEqual([])
    })
})
