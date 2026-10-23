import { beforeEach, describe, expect, it, vi } from "vitest"
import { migrateServicesToBackends } from "./migrations"

/** A raw collection as the migration uses it: the index listing, the drops and the updates */
const fakeCollection = (collectionName: string) => ({
    collectionName,
    indexes: vi.fn(),
    dropIndex: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
    find: vi.fn(),
    drop: vi.fn()
})

const mocks = vi.hoisted(() => {
    const state = {
        collections: {} as Record<string, ReturnType<typeof fakeCollection>>,
        db: {} as Record<string, ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>>,
        createIndexes: {} as Record<string, ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>>
    }
    /** A model whose collection and createIndexes are the ones registered under `name` */
    const fakeModel = (name: string, extra: Record<string, unknown> = {}) => ({
        default: {
            get collection() {
                return state.collections[name]
            },
            createIndexes: (...args: unknown[]) => state.createIndexes[name](...args),
            ...extra
        }
    })
    return { ...state, fakeModel }
})

vi.mock("../models/BackendModel", async importOriginal => ({
    ...(await importOriginal<object>()),
    ...mocks.fakeModel("backends", {
        db: {
            get db() {
                return mocks.db
            }
        }
    })
}))
vi.mock("../models/BuiltBackendModel", () => mocks.fakeModel("builtbackends"))
vi.mock("../models/BackendDeploymentModel", async importOriginal => ({ ...(await importOriginal<object>()), ...mocks.fakeModel("backenddeployments") }))
vi.mock("../models/AiChangeRequestModel", () => mocks.fakeModel("aichangerequests"))
vi.mock("../models/AiChangeJobModel", () => mocks.fakeModel("aichangejobs"))
vi.mock("../models/AiUsageModel", () => mocks.fakeModel("aiusages"))
vi.mock("../models/MaintenanceAgentModel", () => mocks.fakeModel("maintenanceagents"))
vi.mock("../models/FrontendModel", async importOriginal => ({ ...(await importOriginal<object>()), ...mocks.fakeModel("frontends") }))
vi.mock("../models/DeploymentModel", () => mocks.fakeModel("deployments"))
vi.mock("../models/AiMissionModel", async importOriginal => ({ ...(await importOriginal<object>()), ...mocks.fakeModel("aimissions") }))
vi.mock("../models/DomainReleaseModel", async importOriginal => ({ ...(await importOriginal<object>()), ...mocks.fakeModel("domainreleases") }))

const logger = { info: vi.fn(), error: vi.fn() } as never

const MODELS = ["backends", "builtbackends", "backenddeployments", "aichangerequests", "aichangejobs", "aiusages", "maintenanceagents", "frontends", "deployments", "aimissions", "domainreleases"]
const LEGACY = { services: "backends", builtservices: "builtbackends", servicedeployments: "backenddeployments" } as Record<string, string>

/**
 * Applies a `$set` of the shape the migration writes to a plain document, as MongoDB does for the subset it
 * uses: `$[name]` walks the elements its array filter (equality on one path) matches, and a path through a
 * missing array is refused, as MongoDB refuses it.
 */
const applySet = (document: Record<string, unknown>, path: string, value: unknown, filters: Record<string, unknown>[]) => {
    const read = (from: unknown, dotted: string): unknown[] => {
        const [head, ...rest] = dotted.split(".")
        const next = (from as Record<string, unknown>)?.[head]
        if (rest.length === 0) return Array.isArray(next) ? next : [next]
        return Array.isArray(next) ? next.flatMap(element => read(element, rest.join("."))) : read(next, rest.join("."))
    }
    const matches = (name: string, element: unknown) =>
        filters.every(filter =>
            Object.entries(filter)
                .filter(([key]) => key.startsWith(`${name}.`))
                .every(([key, expected]) => read(element, key.slice(name.length + 1)).includes(expected))
        )
    const walk = (target: Record<string, unknown>, segments: string[]) => {
        const [head, ...rest] = segments
        if (rest.length === 0) {
            target[head] = value
            return
        }
        const marker = rest[0].match(/^\$\[(\w*)\]$/)
        if (!marker) return walk(target[head] as Record<string, unknown>, rest)
        const array = target[head]
        if (!Array.isArray(array)) throw new Error(`The path '${head}' must exist in the document in order to apply array updates.`)
        for (const element of array) {
            if (marker[1] && !matches(marker[1], element)) continue
            walk(element, rest.slice(1))
        }
    }
    walk(document, path.split("."))
    return document
}

/** The documents a cursor of a legacy collection yields */
const cursorOf = (documents: object[]) => ({
    async *[Symbol.asyncIterator]() {
        yield* documents
    }
})

describe("migrateServicesToBackends", () => {
    let legacy: Record<string, ReturnType<typeof fakeCollection>>
    let targets: Record<string, ReturnType<typeof fakeCollection>>

    /** Makes the listing find the legacy collections named, and only those */
    const legacyCollections = (...names: string[]) =>
        mocks.db.listCollections.mockImplementation((...args: unknown[]) => {
            const { name } = args[0] as { name: string }
            return { toArray: () => Promise.resolve(names.includes(name) ? [{ name }] : []) }
        })

    beforeEach(() => {
        for (const name of MODELS) {
            const collection = fakeCollection(name)
            collection.indexes.mockResolvedValue([{ name: "_id_", key: { _id: 1 } }])
            collection.updateMany.mockResolvedValue({ modifiedCount: 0 })
            mocks.collections[name] = collection
            mocks.createIndexes[name] = vi.fn().mockResolvedValue(undefined)
        }
        legacy = {}
        targets = {}
        for (const [from, to] of Object.entries(LEGACY)) {
            legacy[from] = fakeCollection(from)
            legacy[from].indexes.mockResolvedValue([{ name: "_id_", key: { _id: 1 } }])
            legacy[from].updateMany.mockResolvedValue({ modifiedCount: 0 })
            targets[to] = fakeCollection(to)
            targets[to].countDocuments.mockResolvedValue(0)
        }
        mocks.db = {
            listCollections: vi.fn(),
            renameCollection: vi.fn().mockResolvedValue(undefined),
            collection: vi.fn((...args: unknown[]) => legacy[args[0] as string] ?? targets[args[0] as string])
        }
        legacyCollections()
    })

    it("Given only the legacy collections hold backends, versions and deploys, when it runs, then they replace the empty ones Mongoose created and get their indexes", async () => {
        legacyCollections("services", "builtservices", "servicedeployments")

        await migrateServicesToBackends(logger)

        expect(mocks.db.renameCollection).toHaveBeenCalledWith("services", "backends", { dropTarget: true })
        expect(mocks.db.renameCollection).toHaveBeenCalledWith("builtservices", "builtbackends", { dropTarget: true })
        expect(mocks.db.renameCollection).toHaveBeenCalledWith("servicedeployments", "backenddeployments", { dropTarget: true })
        expect(mocks.createIndexes.backends).toHaveBeenCalled()
        expect(mocks.createIndexes.builtbackends).toHaveBeenCalled()
        expect(mocks.createIndexes.backenddeployments).toHaveBeenCalled()
    })

    it("Given legacy versions, when it runs, then the field naming the backend is renamed with its unique index before the collection moves", async () => {
        legacyCollections("builtservices")
        legacy.builtservices.indexes.mockResolvedValue([
            { name: "_id_", key: { _id: 1 } },
            { name: "serviceId_1_version_1", key: { serviceId: 1, version: 1 } }
        ])

        await migrateServicesToBackends(logger)

        expect(legacy.builtservices.dropIndex).toHaveBeenCalledWith("serviceId_1_version_1")
        expect(legacy.builtservices.updateMany).toHaveBeenCalledWith({ serviceId: { $exists: true } }, { $rename: { serviceId: "backendId" } })
        expect(legacy.builtservices.updateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.db.renameCollection.mock.invocationCallOrder[0])
    })

    it("Given both collections hold backends, when it runs, then the ones missing from the new one are moved and the legacy one is dropped", async () => {
        const moved = "6800000000000000000000b1"
        legacyCollections("services")
        targets.backends.countDocuments.mockResolvedValue(1)
        legacy.services.find.mockReturnValue(cursorOf([{ _id: moved, slug: "orders-api" }]))
        mocks.collections.backends.updateOne.mockResolvedValue({ upsertedCount: 1 })

        await migrateServicesToBackends(logger)

        expect(mocks.db.renameCollection).not.toHaveBeenCalled()
        expect(mocks.collections.backends.updateOne).toHaveBeenCalledWith({ _id: moved }, { $setOnInsert: { slug: "orders-api" } }, { upsert: true })
        expect(legacy.services.drop).toHaveBeenCalled()
    })

    it("Given a legacy version the new collection already holds under another id, when it runs, then it is skipped and the legacy collection dropped", async () => {
        legacyCollections("builtservices")
        targets.builtbackends.countDocuments.mockResolvedValue(1)
        legacy.builtservices.find.mockReturnValue(cursorOf([{ _id: "6800000000000000000000c1", backendId: "6800000000000000000000b1", version: "1.2.0" }]))
        mocks.collections.builtbackends.updateOne.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: 11000 }))
        mocks.collections.builtbackends.findOne.mockResolvedValue({ _id: "6800000000000000000000c2" })

        await migrateServicesToBackends(logger)

        expect(mocks.collections.builtbackends.findOne).toHaveBeenCalledWith({ backendId: "6800000000000000000000b1", version: "1.2.0" }, { projection: { _id: 1 } })
        expect(legacy.builtservices.drop).toHaveBeenCalled()
    })

    it("Given a legacy version refused for another reason than an existing copy, when it runs, then the legacy collection is kept", async () => {
        legacyCollections("builtservices")
        targets.builtbackends.countDocuments.mockResolvedValue(1)
        legacy.builtservices.find.mockReturnValue(cursorOf([{ _id: "6800000000000000000000c1", backendId: "6800000000000000000000b1", version: "1.2.0" }]))
        mocks.collections.builtbackends.updateOne.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: 11000 }))
        mocks.collections.builtbackends.findOne.mockResolvedValue(null)

        await migrateServicesToBackends(logger)

        expect(legacy.builtservices.drop).not.toHaveBeenCalled()
    })

    it("Given a legacy backend whose slug was taken again, when it runs, then the legacy collection is kept and the conflict logged", async () => {
        legacyCollections("services")
        targets.backends.countDocuments.mockResolvedValue(1)
        legacy.services.find.mockReturnValue(cursorOf([{ _id: "6800000000000000000000b1", slug: "orders-api" }]))
        mocks.collections.backends.updateOne.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: 11000 }))

        await migrateServicesToBackends(logger)

        expect(legacy.services.drop).not.toHaveBeenCalled()
    })

    it("Given an index on a renamed field of a collection no document carries it in, when it runs, then the index is dropped and the indexes built again", async () => {
        mocks.collections.aiusages.indexes.mockResolvedValue([
            { name: "_id_", key: { _id: 1 } },
            { name: "serviceIds_1_createdAt_-1", key: { serviceIds: 1, createdAt: -1 } }
        ])

        await migrateServicesToBackends(logger)

        expect(mocks.collections.aiusages.dropIndex).toHaveBeenCalledWith("serviceIds_1_createdAt_-1")
        expect(mocks.collections.aiusages.dropIndex).toHaveBeenCalledTimes(1)
        expect(mocks.createIndexes.aiusages).toHaveBeenCalled()
    })

    it("Given documents carrying the legacy fields, when it runs, then each field is renamed on its own collection", async () => {
        await migrateServicesToBackends(logger)

        expect(mocks.collections.aichangerequests.updateMany).toHaveBeenCalledWith({ serviceId: { $exists: true } }, { $rename: { serviceId: "backendId" } })
        expect(mocks.collections.aichangejobs.updateMany).toHaveBeenCalledWith({ serviceIds: { $exists: true } }, { $rename: { serviceIds: "backendIds" } })
        expect(mocks.collections.maintenanceagents.updateMany).toHaveBeenCalledWith({ serviceIds: { $exists: true } }, { $rename: { serviceIds: "backendIds" } })
        expect(mocks.collections.frontends.updateMany).toHaveBeenCalledWith({ serviceIds: { $exists: true } }, { $rename: { serviceIds: "backendIds" } })
        expect(mocks.collections.deployments.updateMany).toHaveBeenCalledWith({ services: { $exists: true } }, { $rename: { services: "backends" } })
    })

    it("Given the legacy kind, when it runs, then it becomes backend on the AI missions and on the members of the domain releases", async () => {
        await migrateServicesToBackends(logger)

        expect(mocks.collections.aimissions.updateMany).toHaveBeenCalledWith(
            { "repositories.kind": "service" },
            { $set: { "repositories.$[legacy].kind": "backend" } },
            { arrayFilters: [{ "legacy.kind": "service" }] }
        )
        expect(mocks.collections.domainreleases.updateMany).toHaveBeenCalledWith(
            { "members.kind": "service" },
            { $set: { "members.$[legacy].kind": "backend" } },
            { arrayFilters: [{ "legacy.kind": "service" }] }
        )
        expect(mocks.collections.domainreleases.updateMany).toHaveBeenCalledWith(
            { "repositories.members.kind": "service" },
            { $set: { "repositories.$[repository].members.$[legacy].kind": "backend" } },
            { arrayFilters: [{ "repository.members.kind": "service" }, { "legacy.kind": "service" }] }
        )
    })

    it("Given a domain release with a repository that has no members, when its kinds are migrated, then the other repositories are updated and nothing is refused", async () => {
        await migrateServicesToBackends(logger)

        const [, update, options] = mocks.collections.domainreleases.updateMany.mock.calls.find(([filter]) => "repositories.members.kind" in (filter as object)) as [
            object,
            { $set: Record<string, unknown> },
            { arrayFilters: Record<string, unknown>[] }
        ]
        const [[path, value]] = Object.entries(update.$set)
        const release = {
            repositories: [
                {
                    id: "orders",
                    members: [
                        { kind: "service", name: "Orders API" },
                        { kind: "frontend", name: "Cart" }
                    ]
                },
                { id: "untouched", status: "failed" }
            ]
        }

        expect(applySet(release, path, value, options.arrayFilters)).toEqual({
            repositories: [
                {
                    id: "orders",
                    members: [
                        { kind: "backend", name: "Orders API" },
                        { kind: "frontend", name: "Cart" }
                    ]
                },
                { id: "untouched", status: "failed" }
            ]
        })
        // What the previous, positional form did with the same document
        expect(() => applySet(structuredClone(release), "repositories.$[].members.$[legacy].kind", value, [{ "legacy.kind": "service" }])).toThrow(/must exist/)
    })

    it("Given frontends recorded in a deployment with the backends they call, when it runs, then serviceIds becomes backendIds inside the snapshot", async () => {
        await migrateServicesToBackends(logger)

        const call = mocks.collections.deployments.updateMany.mock.calls.find(([filter]) => "frontends.serviceIds" in (filter as object)) as unknown[]
        expect(call[0]).toEqual({ "frontends.serviceIds": { $exists: true } })
        const [stage] = call[1] as [{ $set: { frontends: { $map: { input: string; in: { $cond: unknown[] } } } } }]
        expect(stage.$set.frontends.$map.input).toBe("$frontends")
        expect(JSON.stringify(stage.$set.frontends.$map.in.$cond[2])).toContain('{"backendIds":"$$frontend.serviceIds"}')
    })

    it("Given everything already migrated, when it runs again, then nothing is renamed, dropped or rebuilt", async () => {
        await migrateServicesToBackends(logger)

        expect(mocks.db.renameCollection).not.toHaveBeenCalled()
        for (const name of MODELS) {
            expect(mocks.collections[name].dropIndex).not.toHaveBeenCalled()
            expect(mocks.createIndexes[name]).not.toHaveBeenCalled()
        }
    })

    it.each([
        ["an index another replica already dropped", { dropIndex: Object.assign(new Error("index not found"), { code: 27 }) }],
        ["a collection that does not exist yet", { indexes: Object.assign(new Error("ns not found"), { code: 26 }) }]
    ])("Given %s, when it runs, then it carries on", async (_, failure) => {
        const collection = mocks.collections.backenddeployments
        collection.indexes.mockResolvedValue([{ name: "serviceId_1_environmentId_1_deployedAt_-1__id_-1", key: { serviceId: 1, environmentId: 1 } }])
        if ("dropIndex" in failure) collection.dropIndex.mockRejectedValue(failure.dropIndex)
        if ("indexes" in failure) collection.indexes.mockRejectedValue(failure.indexes)

        await expect(migrateServicesToBackends(logger)).resolves.toBeUndefined()
    })
})
