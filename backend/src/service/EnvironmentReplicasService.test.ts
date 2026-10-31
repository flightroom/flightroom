import { ObjectId, Types } from "mongoose"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import EnvironmentReplicasService, { replicasRows, replicasUpdate } from "./EnvironmentReplicasService"

const newId = () => new Types.ObjectId() as unknown as ObjectId

describe("replicasRows", () => {
    const dev = newId()
    const uat = newId()

    it("lists the containers that run in the environment, with the pods they run there", () => {
        const rows = replicasRows(
            "backend",
            [
                { _id: "b1", name: "Orders", slug: "orders-be", replicas: 2, environmentVersions: [{ environmentId: uat, version: "1.0.0" }] },
                {
                    _id: "b2",
                    name: "Billing",
                    slug: "billing-be",
                    replicas: 2,
                    environmentResources: [{ environmentId: uat, replicas: 0 }],
                    environmentVersions: [{ environmentId: uat, version: "1.0.0" }]
                },
                { _id: "b3", name: "Draft", slug: "draft-be", environmentVersions: [{ environmentId: uat, version: "1.0.0" }] },
                { _id: "b4", name: "Elsewhere", slug: "elsewhere-be", environmentVersions: [{ environmentId: dev, version: "1.0.0" }] }
            ],
            uat
        )

        // The environment's own 0 wins, one that sets none runs the chart's one, one not deployed there is left out
        expect(rows.map(row => [row.slug, row.replicas])).toEqual([
            ["orders-be", 2],
            ["billing-be", 0],
            ["draft-be", 1]
        ])
    })
})

describe("replicasUpdate", () => {
    it("sets the replicas in the entry of the environment, its CPU and memory kept, or adds an entry with the replicas only", () => {
        const environmentId = new Types.ObjectId()
        const [{ $set }] = replicasUpdate(environmentId, 0)
        const [hasEntry, merged, appended] = $set.environmentResources.$cond as unknown as [unknown, { $map: { in: { $cond: unknown[] } } }, { $concatArrays: unknown[] }]

        expect(hasEntry).toEqual({ $in: [environmentId, { $ifNull: ["$environmentResources.environmentId", []] }] })
        expect(merged.$map.in.$cond[1]).toEqual({ $mergeObjects: ["$$this", { replicas: 0 }] })
        expect(appended.$concatArrays[1]).toEqual([{ environmentId, replicas: 0 }])
    })
})

describe("EnvironmentReplicasService.scale", () => {
    const projectId = newId()
    const uat = { _id: newId(), projectId }
    const orders = { _id: newId(), name: "Orders", slug: "orders-be", environmentVersions: [{ environmentId: uat._id, version: "1.0.0" }] }
    const legacy = { _id: newId(), name: "Legacy", slug: "legacy-be", environmentVersions: [] }
    const shell = { _id: newId(), name: "Shell", slug: "shell-fe", environmentVersions: [{ environmentId: uat._id, version: "3.1.0" }] }
    const watcher = { _id: newId(), name: "Watcher", slug: "watcher", environmentVersions: [{ environmentId: uat._id, version: "0.2.0" }] }

    let updates: { model: string; filter: Record<string, unknown>; update: unknown; options: unknown }[]
    let notViewer: ReturnType<typeof vi.fn>

    const service = () => {
        const instance = new EnvironmentReplicasService({ _id: newId() } as never)
        // Authorization has its own tests: here it would only stand between the test and the change
        const gate = instance as unknown as { ensureAccessToEnvironment: () => Promise<void>; ensureNotViewer: () => Promise<void>; domainScopeFilter: () => Promise<Record<string, unknown>> }
        vi.spyOn(gate, "ensureAccessToEnvironment").mockResolvedValue()
        notViewer = vi.spyOn(gate, "ensureNotViewer").mockResolvedValue() as never
        vi.spyOn(gate, "domainScopeFilter").mockResolvedValue({})
        return instance
    }

    const found = (documents: unknown[]) => ({ sort: () => ({ lean: () => Promise.resolve(documents) }) }) as never

    beforeEach(() => {
        vi.restoreAllMocks()
        updates = []
        vi.spyOn(Environment, "findById").mockResolvedValue(uat as never)
        vi.spyOn(Backend, "find").mockReturnValue(found([orders, legacy]))
        vi.spyOn(Frontend, "find").mockReturnValue(found([shell]))
        vi.spyOn(MaintenanceAgent, "find").mockReturnValue(found([watcher]))
        for (const [model, name] of [
            [Backend, "backend"],
            [Frontend, "frontend"],
            [MaintenanceAgent, "maintenanceAgent"]
        ] as const) {
            vi.spyOn(model, "updateOne").mockImplementation(((filter: Record<string, unknown>, update: unknown, options: unknown) => {
                updates.push({ model: name, filter, update, options })
                return Promise.resolve({})
            }) as never)
        }
    })

    it("sets the replicas of every container the environment runs, a JOB agent and one not deployed there left out", async () => {
        await service().scale(String(uat._id), { replicas: 0 })

        expect(updates.map(update => [update.model, String(update.filter._id)])).toEqual([
            ["backend", String(orders._id)],
            ["frontend", String(shell._id)],
            ["maintenanceAgent", String(watcher._id)]
        ])
        expect(updates[0].update).toEqual(replicasUpdate(new Types.ObjectId(String(uat._id)), 0))
        // Mongoose 9 refuses an aggregation pipeline as an update without it
        expect(updates.every(update => (update.options as { updatePipeline?: boolean })?.updatePipeline)).toBe(true)
        expect(vi.mocked(MaintenanceAgent.find).mock.calls[0][0]).toMatchObject({ kind: "container" })
        expect(notViewer).toHaveBeenCalled()
    })

    it.each([[-1], [21], [1.5], ["3"], [undefined]])("refuses replicas %s before anything is written", async replicas => {
        await expect(service().scale(String(uat._id), { replicas })).rejects.toMatchObject({ code: "ENVIRONMENT_REPLICAS_INVALID" })
        expect(updates).toEqual([])
    })
})
