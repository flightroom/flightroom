import { FastifyBaseLogger } from "fastify"
import mongoose, { Model, QueryFilter, Schema } from "mongoose"
import AiModel, { AI_MODEL_SECRET_PATHS } from "../models/AiModelModel"
import Backend from "../models/BackendModel"
import CodeRepository, { CODE_REPOSITORY_SECRET_PATHS } from "../models/CodeRepositoryModel"
import Configuration from "../models/ConfigurationModel"
import Database, { DATABASE_SECRET_PATHS, DatabaseType } from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project, { PROJECT_SECRET_PATHS } from "../models/ProjectModel"
import ProvisionedDatabase from "../models/ProvisionedDatabaseModel"
import Resource from "../models/ResourceModel"
import Storage, { STORAGE_SECRET_PATHS } from "../models/StorageModel"
import { Secret } from "../models/VariableMapModel"
import { WEEKDAYS } from "../types/KubeGreen"
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

/** Written once the BUNDLE frontends got the version each environment serves: they are not seeded again */
export const BUNDLE_VERSIONS_SEEDED = "migration.bundle-environment-versions"

/**
 * Gives the backends, the DOCKER frontends and the maintenance agents made before a version was set per environment the
 * one each environment runs: what its current deployment recorded, else the version of the application, which every
 * deploy wrote before. Without it, an environment would no longer get them. A document is seeded once: those made since
 * hold the field, empty or not.
 *
 * The BUNDLE frontends got theirs later, when they already held an empty list: those with none are seeded the same way,
 * once for the whole installation, as the configuration BUNDLE_VERSIONS_SEEDED records. A marker rather than the empty
 * list, which a BUNDLE created since, or taken out of every environment, holds on purpose. Written last, so that a run cut
 * short is taken again: each document is written only while its list is still empty, so a second run changes nothing.
 */
export const seedEnvironmentVersions = async (logger: FastifyBaseLogger): Promise<void> => {
    const unseeded = { environmentVersions: { $exists: false } }
    // No kind: a BUNDLE stored before the kind existed
    const unseededBundles = { kind: { $ne: FrontendKind.DOCKER }, $or: [unseeded, { environmentVersions: { $size: 0 } }] }
    const bundlesSeeded = Boolean(await Configuration.exists({ name: BUNDLE_VERSIONS_SEEDED }))
    const fields = { projectId: 1, version: 1 }
    type Unseeded = { _id: unknown; projectId: unknown; version?: string }
    const kinds = [
        { label: "backend", model: Backend, snapshot: "backends" as const, filter: unseeded, documents: await Backend.find(unseeded, fields).lean<Unseeded[]>() },
        {
            label: "frontend",
            model: Frontend,
            snapshot: "frontends" as const,
            filter: { ...unseeded, kind: FrontendKind.DOCKER },
            documents: await Frontend.find({ ...unseeded, kind: FrontendKind.DOCKER }, fields).lean<Unseeded[]>()
        },
        {
            label: "BUNDLE frontend",
            model: Frontend,
            snapshot: "frontends" as const,
            filter: unseededBundles,
            documents: bundlesSeeded ? [] : await Frontend.find(unseededBundles, fields).lean<Unseeded[]>()
        },
        // Not recorded by a deployment: every deploy wrote its version
        { label: "maintenance agent", model: MaintenanceAgent, snapshot: undefined, filter: unseeded, documents: await MaintenanceAgent.find(unseeded, fields).lean<Unseeded[]>() }
    ]
    const markBundlesSeeded = async () => {
        if (!bundlesSeeded) await Configuration.updateOne({ name: BUNDLE_VERSIONS_SEEDED }, { $setOnInsert: { value: new Date().toISOString() } }, { upsert: true })
    }
    if (kinds.every(kind => kind.documents.length === 0)) return markBundlesSeeded()

    // The current deployment of each environment of a project, read once per project
    type Recorded = { _id: unknown; version?: string }
    type Current = { _id: unknown; backends: Recorded[]; frontends: Recorded[] }
    const currentByProject = new Map<string, Current[]>()
    const currentOf = async (projectId: unknown): Promise<Current[]> => {
        const known = currentByProject.get(String(projectId))
        if (known) return known
        const current: Current[] = []
        for (const environment of await Environment.find({ projectId: projectId as never }, { _id: 1 })) {
            const deployment = await Deployment.findOne({ environmentId: environment._id }, { "backends._id": 1, "backends.version": 1, "frontends._id": 1, "frontends.version": 1 })
                .sort({ active: -1, deployedAt: -1 })
                .lean<{ backends?: Recorded[]; frontends?: Recorded[] }>()
            current.push({ _id: environment._id, backends: deployment?.backends ?? [], frontends: deployment?.frontends ?? [] })
        }
        currentByProject.set(String(projectId), current)
        return current
    }

    for (const { label, model, snapshot, filter, documents } of kinds) {
        for (const document of documents) {
            const environmentVersions = (await currentOf(document.projectId)).flatMap(environment => {
                const recorded = snapshot ? environment[snapshot].find(application => String(application._id) === String(document._id))?.version : undefined
                const version = recorded?.trim() || document.version?.trim()
                return version ? [{ environmentId: environment._id, version }] : []
            })
            await (model as unknown as Model<Record<string, unknown>>).updateOne({ _id: document._id, ...filter }, { $set: { environmentVersions } })
        }
        if (documents.length > 0) logger.info(`Set the version each environment runs on ${documents.length} ${label}(s)`)
    }
    await markBundlesSeeded()
}

/** The days of a cron `weekdays`, e.g. `1-5`, `1,3,5` or `*`; a range backwards goes round the week, as it did in the editor */
const cronDays = (weekdays: string): number[] => {
    if (weekdays.trim() === "*") return [...WEEKDAYS]
    return weekdays
        .replace(/\s+/g, "")
        .split(",")
        .flatMap(part => {
            const [from, to = from] = part.split("-").map(Number)
            if (!Number.isInteger(from) || !Number.isInteger(to)) return []
            return Array.from({ length: ((to - from + 7) % 7) + 1 }, (_, offset) => (from + offset) % 7)
        })
}

/**
 * Turns the kube-green schedules saved as one rule, its days going to sleep at `sleepAt` and waking up at `wakeUpAt`,
 * into a day each: those days awake between the two times, the others asleep, as the rule had them from Friday night to
 * Monday morning. A rule with no wake up, or waking up after it goes to sleep, keeps those days awake from midnight. Once
 * per environment: the rule is unset as it is turned.
 */
export const convertKubeGreenSchedules = async (logger: FastifyBaseLogger): Promise<void> => {
    type Legacy = { _id: unknown; kubeGreen: { weekdays?: string; sleepAt?: string; wakeUpAt?: string } }
    const legacy = await Environment.collection.find<Legacy>({ "kubeGreen.weekdays": { $exists: true } }, { projection: { kubeGreen: 1 } }).toArray()
    for (const { _id, kubeGreen } of legacy) {
        const awake = new Set(cronDays(kubeGreen.weekdays ?? ""))
        const sleepAt = kubeGreen.sleepAt ?? ""
        const wakeUpAt = kubeGreen.wakeUpAt && kubeGreen.wakeUpAt < sleepAt ? kubeGreen.wakeUpAt : ""
        const days = WEEKDAYS.map(weekday => (awake.has(weekday) ? { weekday, awake: true, wakeUpAt, sleepAt } : { weekday, awake: false, wakeUpAt: "", sleepAt: "" }))
        await Environment.collection.updateOne({ _id: _id as never }, { $set: { "kubeGreen.days": days }, $unset: { "kubeGreen.weekdays": "", "kubeGreen.sleepAt": "", "kubeGreen.wakeUpAt": "" } })
    }
    if (legacy.length > 0) logger.info(`Turned the kube-green schedule of ${legacy.length} environment(s) into a day each`)
}

/**
 * Drops from the backends the variables saved as a declaration, before a backend's variables carried the value the deploy
 * hands the container: one with no value, missing, null or empty (an empty value is never encrypted, so it is stored as
 * ""), has nothing left to say now that every variable of a backend has one. Then unsets `required` from those that stay,
 * a flag a backend's variables no longer have. Raw updates on the collection: the values stay as they are stored, encrypted
 * or not, and each one matches only what is still to be done, so a second run changes nothing.
 */
export const pruneBackendEnvDeclarations = async (logger: FastifyBaseLogger): Promise<void> => {
    const noValue = { value: { $in: [null, ""] } }
    const pruned = await Backend.collection.updateMany({ env: { $elemMatch: noValue } }, { $pull: { env: noValue } } as never)
    // Apart: a $pull and an $unset of the same array conflict in one update
    const unset = await Backend.collection.updateMany({ "env.required": { $exists: true } }, { $unset: { "env.$[].required": "" } })
    if (pruned.modifiedCount > 0) logger.info(`Removed the variables with no value of ${pruned.modifiedCount} backend(s)`)
    if (unset.modifiedCount > 0) logger.info(`Unset required on the variables of ${unset.modifiedCount} backend(s)`)
}

/**
 * Unsets the design system a frontend had of its own, before only the organization and the project could set one: no
 * screen nor tool reads it any longer, and its npmrc may hold the credentials of a registry. A raw update matching only
 * the frontends that still have one, so a second run changes nothing.
 */
export const unsetFrontendDesignSystems = async (logger: FastifyBaseLogger): Promise<void> => {
    const { modifiedCount } = await Frontend.collection.updateMany({ designSystem: { $exists: true } }, { $unset: { designSystem: "" } })
    if (modifiedCount > 0) logger.info(`Removed the design system of their own from ${modifiedCount} frontend(s)`)
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
    // Apart: the deploys of the applications made before depend on it, whatever happens to the credentials
    try {
        await seedEnvironmentVersions(logger)
    } catch (error) {
        logger.error({ error }, "Error while setting the version each environment runs")
    }
    try {
        await convertKubeGreenSchedules(logger)
    } catch (error) {
        logger.error({ error }, "Error while turning the kube-green schedules into a day each")
    }
    try {
        await pruneBackendEnvDeclarations(logger)
    } catch (error) {
        logger.error({ error }, "Error while removing the variables of the backends with no value")
    }
    try {
        await unsetFrontendDesignSystems(logger)
    } catch (error) {
        logger.error({ error }, "Error while removing the design systems of the frontends")
    }
}
