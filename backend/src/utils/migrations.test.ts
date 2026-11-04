import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AiModel from "../models/AiModelModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Database, { DATABASE_SECRET_PATHS } from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import Project from "../models/ProjectModel"
import ProvisionedDatabase from "../models/ProvisionedDatabaseModel"
import Resource from "../models/ResourceModel"
import Storage from "../models/StorageModel"
import { Secret } from "../models/VariableMapModel"
import { transformDocument } from "./encryptedFieldsPlugin"
import { encryptStoredSecrets, LegacyMongoServer, moveMongoServersToDatabases, runMigrations } from "./migrations"
import { decryptSecret, encryptSecret, isEncryptedSecret, resetSecretEncryptionKeyCache } from "./secretCrypto"

const logger = { info: vi.fn(), error: vi.fn() } as never

const MODELS = [Storage, CodeRepository, Database, ProvisionedDatabase, Project, AiModel, Deployment, Secret, Resource]

/** Every model answering no document, but `model`, answering `documents` */
const holding = (model: unknown, documents: object[]) => {
    for (const each of MODELS) {
        vi.spyOn(each, "find").mockReturnValue({ cursor: () => (each === model ? documents : [])[Symbol.iterator]() } as never)
    }
}

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    resetSecretEncryptionKeyCache()
})

describe("encryptStoredSecrets", () => {
    beforeEach(() => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"))
        resetSecretEncryptionKeyCache()
    })

    it("Given a key and a storage with a credential in the clear, when it runs, then that storage is saved again and the save hook encrypts it", async () => {
        const save = vi.fn()
        holding(Storage, [{ save }])

        await encryptStoredSecrets(logger)

        expect(save).toHaveBeenCalledTimes(1)
        for (const model of MODELS) expect(model.find).toHaveBeenCalledTimes(1)
    })

    it("Given a key and an AI model with its key in the clear, when it runs, then it is looked for by its secret paths and saved again", async () => {
        const save = vi.fn()
        holding(AiModel, [{ save }])

        await encryptStoredSecrets(logger)

        expect(save).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(vi.mocked(AiModel.find).mock.calls[0][0])).toContain("config.apiKey")
    })

    it("Given no key configured, when it runs, then nothing is read", async () => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", "")
        resetSecretEncryptionKeyCache()
        holding(Storage, [])

        await encryptStoredSecrets(logger)

        expect(Storage.find).not.toHaveBeenCalled()
    })
})

describe("runMigrations", () => {
    it("Given the encryption fails, when the migrations run, then the failure is logged and the boot goes on", async () => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"))
        resetSecretEncryptionKeyCache()
        // No MongoDB server left to move
        vi.spyOn(ProvisionedDatabase.collection, "dropIndex").mockResolvedValue({} as never)
        vi.spyOn(LegacyMongoServer, "find").mockReturnValue({ cursor: () => [][Symbol.iterator]() } as never)
        vi.spyOn(ProvisionedDatabase, "createIndexes").mockResolvedValue(undefined as never)
        vi.spyOn(ProvisionedDatabase.collection, "updateMany").mockResolvedValue({ modifiedCount: 0 } as never)
        holding(Storage, [{ save: vi.fn().mockRejectedValue(new Error("write refused")) }])
        const error = vi.fn()

        await expect(runMigrations({ info: vi.fn(), error } as never)).resolves.toBeUndefined()
        expect(error).toHaveBeenCalledWith({ error: expect.any(Error) }, "Error while running data migrations")
    })
})

/**
 * The MongoDB servers of 15.1.0 become databases of type MONGODB. Their credentials were encrypted under the model
 * MongoServer, a context a Database cannot decrypt: they are read in the clear through the old model and written
 * again as a Database's, never copied as ciphertext.
 */
describe("moveMongoServersToDatabases", () => {
    const projectId = new Types.ObjectId()
    const serverId = new Types.ObjectId()
    let saved: Array<Record<string, unknown>>
    let renames: ReturnType<typeof vi.fn>
    let removed: ReturnType<typeof vi.fn>

    /** A server as the old collection holds it, its secret encrypted under its old model, read back through the old model */
    const legacy = (provider: string, connection: Record<string, unknown>, _id = serverId, dates: Record<string, Date> = {}) => {
        const encrypted = { ...connection }
        for (const key of ["connectionString", "clientSecret"]) {
            if (typeof encrypted[key] === "string") encrypted[key] = encryptSecret(encrypted[key], `MongoServer:connection.${key}`)
        }
        return LegacyMongoServer.hydrate({ _id, projectId, name: "Shared cluster", provider, connection: encrypted, ...dates })
    }

    const holdingServers = (servers: unknown[]) => vi.spyOn(LegacyMongoServer, "find").mockReturnValue({ cursor: () => servers[Symbol.iterator]() } as never)

    beforeEach(() => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"))
        resetSecretEncryptionKeyCache()
        saved = []
        vi.spyOn(Database, "exists").mockResolvedValue(null as never)
        vi.spyOn(Database.prototype, "save").mockImplementation(async function (this: { toObject: () => Record<string, unknown> }) {
            saved.push(this.toObject())
            return this
        } as never)
        vi.spyOn(ProvisionedDatabase.collection, "dropIndex").mockResolvedValue({} as never)
        renames = vi.spyOn(ProvisionedDatabase.collection, "updateMany").mockResolvedValue({ modifiedCount: 0 } as never) as unknown as ReturnType<typeof vi.fn>
        vi.spyOn(ProvisionedDatabase, "createIndexes").mockResolvedValue(undefined as never)
        removed = vi.spyOn(LegacyMongoServer, "deleteOne").mockResolvedValue({} as never) as unknown as ReturnType<typeof vi.fn>
    })

    it.each([
        ["MONGODB", { connectionString: "mongodb://root:root-pw@db.internal/admin" }, "connectionString"],
        ["ATLAS", { clientId: "mdb_sa_id", clientSecret: "sa-secret", groupId: "5f1a2b3c4d5e6f7a8b9c0d1e", clusterName: "Cluster0" }, "atlasServiceAccount"],
        ["COSMOS_MONGO_RU", { tenantId: "t", clientId: "c", clientSecret: "sp-secret", subscriptionId: "s", resourceGroup: "rg", accountName: "acc" }, "azureServicePrincipal"]
    ])("given a %s server, when it is moved, then it is a MONGODB database with the same id, its connection of the matching kind in the clear", async (provider, connection, authType) => {
        holdingServers([legacy(provider, connection)])

        await moveMongoServersToDatabases(logger)

        expect(saved).toHaveLength(1)
        expect(saved[0]).toMatchObject({ _id: serverId, projectId, name: "Shared cluster", type: "MONGODB", connection: { authType, ...connection } })
        expect(removed).toHaveBeenCalledWith({ _id: serverId })
    })

    /** The ciphertext of the old model would not decrypt as a Database's: the secret is encrypted again under the new one */
    it("given a server with an encrypted secret, when it is moved, then what is saved encrypts and decrypts as a Database's", async () => {
        holdingServers([legacy("MONGODB", { connectionString: "mongodb://root:root-pw@db.internal/admin" })])

        await moveMongoServersToDatabases(logger)

        const document = { connection: { ...(saved[0].connection as Record<string, unknown>) } }
        transformDocument(document, { model: "Database", paths: DATABASE_SECRET_PATHS }, encryptSecret)
        expect(isEncryptedSecret(document.connection.connectionString)).toBe(true)
        expect(decryptSecret(document.connection.connectionString, "Database:connection.connectionString")).toBe("mongodb://root:root-pw@db.internal/admin")
    })

    it("given a server, when it is moved, then the databases created on it are renamed to databaseId, after the old unique index went", async () => {
        holdingServers([legacy("MONGODB", { connectionString: "mongodb://root:pw@db/admin" })])

        await moveMongoServersToDatabases(logger)

        expect(ProvisionedDatabase.collection.dropIndex).toHaveBeenCalledWith("serverId_1_databaseName_1")
        expect(renames).toHaveBeenCalledWith({ serverId: serverId }, { $rename: { serverId: "databaseId" } })
        expect(vi.mocked(ProvisionedDatabase.collection.dropIndex).mock.invocationCallOrder[0]).toBeLessThan(renames.mock.invocationCallOrder[0])
        expect(ProvisionedDatabase.createIndexes).toHaveBeenCalled()
    })

    /** A run that stopped after writing the Database: the second one does not write it twice, and still finishes */
    it("given a server whose Database was already written, when it is moved again, then it is not written twice and the server still goes", async () => {
        holdingServers([legacy("MONGODB", { connectionString: "mongodb://root:pw@db/admin" })])
        vi.mocked(Database.exists).mockResolvedValue({ _id: serverId } as never)

        await moveMongoServersToDatabases(logger)

        expect(saved).toEqual([])
        expect(renames).toHaveBeenCalledWith({ serverId: serverId }, expect.anything())
        expect(removed).toHaveBeenCalled()
    })

    /** The boot may have tried to build the index before the rename and failed: it is built on every run, idempotent */
    it("given nothing left to move, when it runs again, then nothing is written and the index is built anyway", async () => {
        holdingServers([])

        await moveMongoServersToDatabases(logger)

        expect(saved).toEqual([])
        expect(renames).toHaveBeenCalledWith({ serverId: { $exists: true, $nin: [] } }, { $rename: { serverId: "databaseId" } })
        expect(ProvisionedDatabase.createIndexes).toHaveBeenCalled()
    })

    it("given a server that cannot be moved, when the migration runs, then it is logged, the next one is moved and its records keep serverId", async () => {
        const otherId = new Types.ObjectId()
        holdingServers([legacy("MONGODB", { connectionString: "mongodb://root:pw@db/admin" }), legacy("MONGODB", { connectionString: "mongodb://root:pw@other/admin" }, otherId)])
        vi.mocked(Database.prototype.save).mockRejectedValueOnce(new Error("E11000 duplicate key"))
        const error = vi.fn()

        await moveMongoServersToDatabases({ info: vi.fn(), error } as never)

        expect(error).toHaveBeenCalledWith(expect.objectContaining({ serverId: String(serverId) }), expect.stringContaining("could not be moved"))
        expect(removed).toHaveBeenCalledTimes(1)
        expect(removed).toHaveBeenCalledWith({ _id: otherId })
        expect(renames).toHaveBeenCalledWith({ serverId: { $exists: true, $nin: [serverId] } }, { $rename: { serverId: "databaseId" } })
        expect(ProvisionedDatabase.createIndexes).toHaveBeenCalled()
    })

    it("given a server, when it is moved, then the database keeps the dates of the server", async () => {
        const createdAt = new Date("2026-11-04T10:00:00Z")
        const updatedAt = new Date("2026-11-04T11:00:00Z")
        holdingServers([legacy("MONGODB", { connectionString: "mongodb://root:pw@db/admin" }, serverId, { createdAt, updatedAt })])

        await moveMongoServersToDatabases(logger)

        expect(saved[0]).toMatchObject({ createdAt, updatedAt })
        expect(Database.prototype.save).toHaveBeenCalledWith({ timestamps: false })
    })

    it("given the index cannot be built, when the migration runs, then it is logged and nothing is thrown", async () => {
        holdingServers([])
        vi.mocked(ProvisionedDatabase.createIndexes).mockRejectedValue(new Error("duplicate key"))
        const error = vi.fn()

        await expect(moveMongoServersToDatabases({ info: vi.fn(), error } as never)).resolves.toBeUndefined()
        expect(error).toHaveBeenCalledWith({ error: expect.any(Error) }, "The index of the provisioned databases could not be built")
    })

    it("given a server of a provider nobody knows, when it is moved, then it is left where it is", async () => {
        holdingServers([legacy("REDIS", { connectionString: "redis://x" })])

        await moveMongoServersToDatabases(logger)

        expect(saved).toEqual([])
        expect(removed).not.toHaveBeenCalled()
        expect(renames).toHaveBeenCalledWith({ serverId: { $exists: true, $nin: [serverId] } }, { $rename: { serverId: "databaseId" } })
    })
})
