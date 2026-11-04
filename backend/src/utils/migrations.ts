import { FastifyBaseLogger } from "fastify"
import mongoose, { Model, QueryFilter, Schema } from "mongoose"
import AiModel, { AI_MODEL_SECRET_PATHS } from "../models/AiModelModel"
import CodeRepository, { CODE_REPOSITORY_SECRET_PATHS } from "../models/CodeRepositoryModel"
import Database, { DATABASE_SECRET_PATHS, DatabaseType } from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import Project, { PROJECT_SECRET_PATHS } from "../models/ProjectModel"
import ProvisionedDatabase from "../models/ProvisionedDatabaseModel"
import Resource from "../models/ResourceModel"
import Storage, { STORAGE_SECRET_PATHS } from "../models/StorageModel"
import { Secret } from "../models/VariableMapModel"
import { encryptedFields } from "./encryptedFieldsPlugin"
import { isSecretEncryptionEnabled } from "./secretCrypto"

/** Anything not carrying the marker written by secretCrypto is still a credential in the clear. */
const NOT_ENCRYPTED = { $exists: true, $not: /^enc:v1:/ }

/**
 * Rewrites, encrypted, the credentials written before a key was configured.
 *
 * Still here because it runs whenever SECRETS_ENCRYPTION_KEY is turned on: encryption is opt-in, and
 * this is what turning it on later relies on. Its AI model part is also unreleased as of 10.1.0.
 *
 * Reading them back needs no migration — a value with no marker is handed over untouched — so this is
 * only about what a dump of the database shows. It is a re-save per document and nothing else: the
 * save hook is what encrypts, and it skips whatever is already encrypted, which is what makes a second
 * run cost one empty query per collection.
 *
 * Deployments are in here because a deployment freezes a copy of the storages of its project, and the
 * serve API reads the bucket keys from that copy.
 */
export const encryptStoredSecrets = async (logger: FastifyBaseLogger): Promise<void> => {
    if (!isSecretEncryptionEnabled()) return

    // The models have nothing in common but the re-save, so they are walked through the loosest
    // shape that still gives back documents to save.
    type SecretHolder = Model<Record<string, unknown>>
    type SecretFilter = QueryFilter<Record<string, unknown>>

    const anyPlaintextIn = (paths: string[]) => ({ $or: paths.map(path => ({ [path]: NOT_ENCRYPTED })) })

    const collections: Array<[string, SecretHolder, SecretFilter]> = [
        ["storage", Storage as unknown as SecretHolder, anyPlaintextIn(STORAGE_SECRET_PATHS) as SecretFilter],
        ["code repository", CodeRepository as unknown as SecretHolder, anyPlaintextIn(CODE_REPOSITORY_SECRET_PATHS) as SecretFilter],
        ["database", Database as unknown as SecretHolder, anyPlaintextIn(DATABASE_SECRET_PATHS) as SecretFilter],
        ["provisioned database", ProvisionedDatabase as unknown as SecretHolder, anyPlaintextIn(["password"]) as SecretFilter],
        ["project", Project as unknown as SecretHolder, anyPlaintextIn(PROJECT_SECRET_PATHS) as SecretFilter],
        // `config` is Mixed and a provider without a secret access key has no such field: $exists in NOT_ENCRYPTED skips it
        ["AI model", AiModel as unknown as SecretHolder, anyPlaintextIn(AI_MODEL_SECRET_PATHS) as SecretFilter],
        // $elemMatch so both halves of the criterion have to be met by the same storage of the
        // snapshot: spelled out as a dotted path, a snapshot holding one already encrypted credential
        // beside a plaintext one would satisfy neither half on the element that still needs rewriting.
        ["deployment", Deployment as unknown as SecretHolder, { storages: { $elemMatch: anyPlaintextIn(STORAGE_SECRET_PATHS) } } as SecretFilter],
        // Nested $elemMatch for the same reason, one level deeper: a key of a secret holds a value per environment, beside the one of all.
        [
            "secret",
            Secret as unknown as SecretHolder,
            { $or: [{ entries: { $elemMatch: { value: NOT_ENCRYPTED } } }, { entries: { $elemMatch: { values: { $elemMatch: { value: NOT_ENCRYPTED } } } } }] } as SecretFilter
        ],
        // $elemMatch again, at both levels a credential of a resource lives: its value and its overrides
        [
            "resource",
            Resource as unknown as SecretHolder,
            { $or: [{ secrets: { $elemMatch: { value: NOT_ENCRYPTED } } }, { secrets: { $elemMatch: { overrides: { $elemMatch: { value: NOT_ENCRYPTED } } } } }] } as SecretFilter
        ]
    ]

    for (const [label, model, filter] of collections) {
        let encrypted = 0
        for await (const document of model.find(filter).cursor()) {
            await document.save()
            encrypted++
        }

        if (encrypted > 0) {
            logger.info(`Encrypted the credentials of ${encrypted} ${label} document(s) at rest`)
        }
    }
}

/**
 * The MongoDB servers of 15.1.0, a model of their own until they became databases: read from their old collection
 * through the encryption plugin under their old model name, the context their credentials were encrypted with, so
 * that they come back in the clear and are encrypted again as a Database's when saved. A ciphertext cannot be moved
 * as it is: it is bound to its model and its path.
 */
const legacyMongoServerSchema = new Schema(
    { projectId: Schema.Types.ObjectId, name: String, provider: String, connection: Schema.Types.Mixed },
    { timestamps: true, collection: "mongoservers", autoCreate: false, autoIndex: false }
)
legacyMongoServerSchema.plugin(encryptedFields, { model: "MongoServer", paths: ["connection.connectionString", "connection.clientSecret"] })
export const LegacyMongoServer = mongoose.models.LegacyMongoServer ?? mongoose.model("LegacyMongoServer", legacyMongoServerSchema)

/** How each provider of a server is reached as a database */
const AUTH_TYPE_OF_PROVIDER: Record<string, string> = { MONGODB: "connectionString", ATLAS: "atlasServiceAccount", COSMOS_MONGO_RU: "azureServicePrincipal" }

/**
 * Turns the MongoDB servers into databases of type MONGODB, with the same _id, and the serverId of the databases
 * created on them into databaseId. Each server is moved, its records renamed, then the server removed from the old
 * collection, one at a time: a run that stops half way leaves a server either still there (moved again, its
 * Database kept if it was already written) or gone with its records renamed. A second run finds nothing to do.
 * The unique index on the server and the name goes first: once the records lose serverId it would see them all
 * under the same null server, and refuse the rename of two databases of the same name on two servers.
 */
export const moveMongoServersToDatabases = async (logger: FastifyBaseLogger): Promise<void> => {
    await ProvisionedDatabase.collection.dropIndex("serverId_1_databaseName_1").catch(() => undefined)
    let moved = 0
    // The servers left in the old collection by this run, whose records keep their serverId until they move
    const waiting: unknown[] = []
    try {
        for await (const server of LegacyMongoServer.find().cursor()) {
            // One server that cannot be moved (a credential that does not decrypt, another replica moving it) does not hold back the others
            try {
                const authType = AUTH_TYPE_OF_PROVIDER[server.provider as string]
                if (!authType) {
                    logger.error({ serverId: String(server._id), provider: server.provider }, "A MongoDB server of an unknown provider was left where it is")
                    waiting.push(server._id)
                    continue
                }
                if (!(await Database.exists({ _id: server._id }))) {
                    const connection = { authType, ...(server.connection as Record<string, unknown>) }
                    const { createdAt, updatedAt } = server as unknown as { createdAt?: Date; updatedAt?: Date }
                    // Saved with its own dates: it is the same server, not one created by the migration
                    await new Database({ _id: server._id, projectId: server.projectId, name: server.name, type: DatabaseType.MONGODB, connection, createdAt, updatedAt }).save({
                        timestamps: false
                    })
                }
                await ProvisionedDatabase.collection.updateMany({ serverId: server._id }, { $rename: { serverId: "databaseId" } })
                await LegacyMongoServer.deleteOne({ _id: server._id })
                moved++
            } catch (error) {
                waiting.push(server._id)
                logger.error({ error, serverId: String(server._id) }, "A MongoDB server could not be moved to the databases: it is tried again at the next start")
            }
        }
        // The records of a server moved by a run that stopped before renaming them; never those of a server still waiting to be moved
        const { modifiedCount } = await ProvisionedDatabase.collection.updateMany({ serverId: { $exists: true, $nin: waiting } }, { $rename: { serverId: "databaseId" } })
        if (moved > 0 || modifiedCount > 0) logger.info(`Moved ${moved} MongoDB server(s) to the databases of their project`)
    } finally {
        // On every run: the boot may have tried to build the index on the database and the name before the rename, and failed
        await ProvisionedDatabase.createIndexes().catch(error => logger.error({ error }, "The index of the provisioned databases could not be built"))
    }
}

/**
 * Every data migration the application still needs, run once the database connection is up.
 *
 * A failure is logged and swallowed: none of these is required for the process to serve traffic, and
 * refusing to boot over one would take the whole console down for a data fix.
 */
export const runMigrations = async (logger: FastifyBaseLogger): Promise<void> => {
    try {
        await moveMongoServersToDatabases(logger)
    } catch (error) {
        logger.error({ error }, "Error while moving the MongoDB servers to the databases")
    }
    try {
        await encryptStoredSecrets(logger)
    } catch (error) {
        logger.error({ error }, "Error while running data migrations")
    }
}
