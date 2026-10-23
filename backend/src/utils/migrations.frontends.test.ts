import { beforeEach, describe, expect, it, vi } from "vitest"
import { migrateMicrofrontendsToFrontends } from "./migrations"

/** A raw collection as the migration uses it: the index listing, the drops and the updates */
const fakeCollection = (collectionName: string) => ({
    collectionName,
    indexes: vi.fn(),
    dropIndex: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
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

vi.mock("../models/FrontendModel", async importOriginal => ({
    ...(await importOriginal<object>()),
    ...mocks.fakeModel("frontends", {
        db: {
            get db() {
                return mocks.db
            }
        }
    })
}))
vi.mock("../models/BuiltFrontendModel", () => mocks.fakeModel("builtfrontends"))
vi.mock("../models/FrontendDeploymentModel", () => mocks.fakeModel("frontenddeployments"))
vi.mock("../models/DeploymentsToCanaryUsersModel", () => mocks.fakeModel("deploymenttocanaryusers"))
vi.mock("../models/AiChangeRequestModel", () => mocks.fakeModel("aichangerequests"))
vi.mock("../models/AiChangeJobModel", () => mocks.fakeModel("aichangejobs"))
vi.mock("../models/DeploymentModel", () => mocks.fakeModel("deployments"))

const logger = { info: vi.fn(), error: vi.fn() } as never

const REFERENCES = ["builtfrontends", "frontenddeployments", "deploymenttocanaryusers", "aichangerequests", "aichangejobs", "deployments"]

/** The documents a cursor of the legacy collection yields */
const cursorOf = (documents: object[]) => ({
    async *[Symbol.asyncIterator]() {
        yield* documents
    }
})

describe("migrateMicrofrontendsToFrontends", () => {
    let legacy: ReturnType<typeof fakeCollection>
    let target: ReturnType<typeof fakeCollection>

    beforeEach(() => {
        for (const name of ["frontends", ...REFERENCES]) {
            const collection = fakeCollection(name)
            collection.indexes.mockResolvedValue([{ name: "_id_", key: { _id: 1 } }])
            collection.updateMany.mockResolvedValue({ modifiedCount: 0 })
            mocks.collections[name] = collection
            mocks.createIndexes[name] = vi.fn().mockResolvedValue(undefined)
        }
        legacy = fakeCollection("microfrontends")
        target = fakeCollection("frontends")
        target.countDocuments.mockResolvedValue(0)
        mocks.db = {
            listCollections: vi.fn().mockReturnValue({ toArray: () => Promise.resolve([{ name: "microfrontends" }]) }),
            renameCollection: vi.fn().mockResolvedValue(undefined),
            collection: vi.fn((...args: unknown[]) => (args[0] === "microfrontends" ? legacy : target))
        }
    })

    it("Given only the legacy collection holds frontends, when it runs, then it replaces the empty one Mongoose created and gets its indexes", async () => {
        await migrateMicrofrontendsToFrontends(logger)

        expect(mocks.db.renameCollection).toHaveBeenCalledWith("microfrontends", "frontends", { dropTarget: true })
        expect(mocks.createIndexes.frontends).toHaveBeenCalled()
    })

    it("Given both collections hold frontends, when it runs, then the ones missing from the new one are moved and the legacy one is dropped", async () => {
        const moved = "6800000000000000000000a1"
        target.countDocuments.mockResolvedValue(1)
        legacy.find.mockReturnValue(cursorOf([{ _id: moved, slug: "cart", kind: "MICROFRONTEND" }]))
        mocks.collections.frontends.updateOne.mockResolvedValue({ upsertedCount: 1 })

        await migrateMicrofrontendsToFrontends(logger)

        expect(mocks.db.renameCollection).not.toHaveBeenCalled()
        expect(mocks.collections.frontends.updateOne).toHaveBeenCalledWith({ _id: moved }, { $setOnInsert: { slug: "cart", kind: "MICROFRONTEND" } }, { upsert: true })
        expect(legacy.drop).toHaveBeenCalled()
    })

    it("Given a legacy frontend whose slug was taken again, when it runs, then the legacy collection is kept and the conflict logged", async () => {
        target.countDocuments.mockResolvedValue(1)
        legacy.find.mockReturnValue(cursorOf([{ _id: "6800000000000000000000a1", slug: "cart" }]))
        mocks.collections.frontends.updateOne.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: 11000 }))

        await migrateMicrofrontendsToFrontends(logger)

        expect(legacy.drop).not.toHaveBeenCalled()
    })

    it("Given an index on a renamed field of a collection no document carries it in, when it runs, then the index is dropped and the indexes built again", async () => {
        mocks.db.listCollections.mockReturnValue({ toArray: () => Promise.resolve([]) })
        mocks.collections.builtfrontends.indexes.mockResolvedValue([
            { name: "_id_", key: { _id: 1 } },
            { name: "microfrontendId_1_version_1_image", key: { microfrontendId: 1, version: 1 } }
        ])

        await migrateMicrofrontendsToFrontends(logger)

        expect(mocks.collections.builtfrontends.dropIndex).toHaveBeenCalledWith("microfrontendId_1_version_1_image")
        expect(mocks.collections.builtfrontends.dropIndex).toHaveBeenCalledTimes(1)
        expect(mocks.createIndexes.builtfrontends).toHaveBeenCalled()
    })

    it("Given documents carrying the legacy fields, when it runs, then each field is renamed on its own collection", async () => {
        await migrateMicrofrontendsToFrontends(logger)

        expect(mocks.collections.builtfrontends.updateMany).toHaveBeenCalledWith({ microfrontendId: { $exists: true } }, { $rename: { microfrontendId: "frontendId" } })
        expect(mocks.collections.aichangejobs.updateMany).toHaveBeenCalledWith({ microfrontendIds: { $exists: true } }, { $rename: { microfrontendIds: "frontendIds" } })
        expect(mocks.collections.deployments.updateMany).toHaveBeenCalledWith({ microfrontends: { $exists: true } }, { $rename: { microfrontends: "frontends" } })
    })

    it("Given the legacy kinds, when it runs, then they become BUNDLE and DOCKER on the frontends and in the deployment snapshots", async () => {
        await migrateMicrofrontendsToFrontends(logger)

        expect(mocks.collections.frontends.updateMany).toHaveBeenCalledWith({ kind: "MICROFRONTEND" }, { $set: { kind: "BUNDLE" } })
        expect(mocks.collections.frontends.updateMany).toHaveBeenCalledWith({ kind: "FRONTEND" }, { $set: { kind: "DOCKER" } })
        expect(mocks.collections.deployments.updateMany).toHaveBeenCalledWith(
            { "frontends.kind": "FRONTEND" },
            { $set: { "frontends.$[legacy].kind": "DOCKER" } },
            { arrayFilters: [{ "legacy.kind": "FRONTEND" }] }
        )
    })

    it("Given everything already migrated, when it runs again, then nothing is renamed, dropped or rebuilt", async () => {
        mocks.db.listCollections.mockReturnValue({ toArray: () => Promise.resolve([]) })

        await migrateMicrofrontendsToFrontends(logger)

        expect(mocks.db.renameCollection).not.toHaveBeenCalled()
        for (const name of ["frontends", ...REFERENCES]) {
            expect(mocks.collections[name].dropIndex).not.toHaveBeenCalled()
            expect(mocks.createIndexes[name]).not.toHaveBeenCalled()
        }
    })

    it.each([
        ["an index another replica already dropped", { dropIndex: Object.assign(new Error("index not found"), { code: 27 }) }],
        ["a collection that does not exist yet", { indexes: Object.assign(new Error("ns not found"), { code: 26 }) }]
    ])("Given %s, when it runs, then it carries on", async (_, failure) => {
        mocks.db.listCollections.mockReturnValue({ toArray: () => Promise.resolve([]) })
        const collection = mocks.collections.frontenddeployments
        collection.indexes.mockResolvedValue([{ name: "microfrontendId_1_environmentId_1_deployedAt_-1__id_-1", key: { microfrontendId: 1, environmentId: 1 } }])
        if ("dropIndex" in failure) collection.dropIndex.mockRejectedValue(failure.dropIndex)
        if ("indexes" in failure) collection.indexes.mockRejectedValue(failure.indexes)

        await expect(migrateMicrofrontendsToFrontends(logger)).resolves.toBeUndefined()
    })
})
