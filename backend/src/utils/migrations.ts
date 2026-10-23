import { FastifyBaseLogger } from "fastify"
import { Model, mongo, ObjectId, QueryFilter } from "mongoose"
import AiChangeJob from "../models/AiChangeJobModel"
import AiChangeRequest from "../models/AiChangeRequestModel"
import AiMission from "../models/AiMissionModel"
import AiUsage from "../models/AiUsageModel"
import AssistantConversation from "../models/AssistantConversationModel"
import BackendDeployment from "../models/BackendDeploymentModel"
import Backend from "../models/BackendModel"
import BuiltBackend from "../models/BuiltBackendModel"
import BuiltFrontend from "../models/BuiltFrontendModel"
import CodeRepository, { CODE_REPOSITORY_SECRET_PATHS } from "../models/CodeRepositoryModel"
import Database, { DATABASE_SECRET_PATHS } from "../models/DatabaseModel"
import Deployment, { IDeployment } from "../models/DeploymentModel"
import DeploymentToCanaryUsers from "../models/DeploymentsToCanaryUsersModel"
import DomainRelease from "../models/DomainReleaseModel"
import FrontendDeployment from "../models/FrontendDeploymentModel"
import Frontend, { CanaryType, FrontendKind, IFrontend } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project, { PROJECT_SECRET_PATHS } from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import Storage, { STORAGE_SECRET_PATHS } from "../models/StorageModel"
import { IVariableMapEntry, Secret, variableMapModels } from "../models/VariableMapModel"
import { VariableMapKind } from "../types/VariableMapDTO"
import { migrateProjectsToOrganizations } from "./organizationMigration"
import { decryptSecret, isSecretEncryptionEnabled } from "./secretCrypto"

/**
 * Values the canary type could hold before the three current strategies replaced them. Both were the
 * same sticky percentage split and differed only in whether the identity was dropped when the browser
 * closed — ON_SESSIONS kept it in sessionStorage, COOKIE_BASED in localStorage — so both become
 * ON_SESSION, the persistent one.
 */
const LEGACY_CANARY_TYPES = ["ON_SESSIONS", "COOKIE_BASED"]

/**
 * Rewrites the canary types written by the previous model.
 *
 * It has to touch deployments as well as frontends: a deployment stores a snapshot of the
 * frontends it shipped, and that snapshot is what the serve API reads, so leaving it alone would
 * turn the canary of every already deployed environment off until the next deploy.
 *
 * Idempotent by construction — the filter only matches documents still holding a legacy value — so it
 * is safe to run on every boot, and cheap once there is nothing left to convert.
 */
export const migrateLegacyCanaryTypes = async (logger: FastifyBaseLogger): Promise<void> => {
    // Cast on the filters only: a dotted path into a subdocument is not expressible in the typed
    // QueryFilter, and spelling it out is what keeps this a single update per collection.
    const frontends = await Frontend.updateMany({ "canary.type": { $in: LEGACY_CANARY_TYPES } } as QueryFilter<IFrontend>, {
        $set: { "canary.type": CanaryType.ON_SESSION }
    })

    const deployments = await Deployment.updateMany(
        { "frontends.canary.type": { $in: LEGACY_CANARY_TYPES } } as QueryFilter<IDeployment>,
        { $set: { "frontends.$[frontend].canary.type": CanaryType.ON_SESSION } },
        { arrayFilters: [{ "frontend.canary.type": { $in: LEGACY_CANARY_TYPES } }] }
    )

    if (frontends.modifiedCount > 0 || deployments.modifiedCount > 0) {
        logger.info(`Migrated legacy canary types on ${frontends.modifiedCount} frontend(s) and ${deployments.modifiedCount} deployment(s)`)
    }
}

/** MongoDB's codes for a collection, or an index, that does not exist. */
const NAMESPACE_NOT_FOUND = 26
const INDEX_NOT_FOUND = 27

const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: number })?.code === 11000

/** The collection the frontends were stored in while the model was called Microfrontend */
const LEGACY_FRONTEND_COLLECTION = "microfrontends"

/** The kinds as they were stored before BUNDLE and DOCKER, with what each one became */
const LEGACY_FRONTEND_KINDS: Array<[string, FrontendKind]> = [
    ["MICROFRONTEND", FrontendKind.BUNDLE],
    ["FRONTEND", FrontendKind.DOCKER]
]

/** Runs a drop or a rename that a second replica, migrating at the same time, may have already done */
const unlessAlreadyGone = async (operation: Promise<unknown>): Promise<void> => {
    try {
        await operation
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (code !== NAMESPACE_NOT_FOUND && code !== INDEX_NOT_FOUND) throw error
    }
}

/** Any model whose collection a migration renames or rewrites: they have nothing else in common */
type AnyModel = Model<Record<string, unknown>>

/**
 * Moves the documents of the legacy collection that the one of `model` does not hold yet, then drops the
 * legacy one. It is what a rolling update leaves behind: the pod still on the previous version keeps writing
 * to the old collection after the new one renamed it. A document whose slug was taken again in the meantime
 * cannot be moved: the legacy collection is then kept and the conflict logged. With a `naturalKey`, a
 * document the new collection already holds under another _id (the same version of a backend registered
 * again by its CI) is already there: it is skipped, not counted as a conflict.
 */
const mergeLegacyCollection = async (logger: FastifyBaseLogger, legacy: mongo.Collection, model: AnyModel, naturalKey?: string[]): Promise<void> => {
    let moved = 0
    let conflicts = 0
    for await (const { _id, ...fields } of legacy.find()) {
        try {
            moved += (await model.collection.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true })).upsertedCount
        } catch (error) {
            if (naturalKey && isDuplicateKeyError(error)) {
                const key = Object.fromEntries(naturalKey.map(name => [name, fields[name]]))
                if (await model.collection.findOne(key, { projection: { _id: 1 } })) continue
            }
            conflicts++
            logger.error({ error }, `Document ${_id} of ${legacy.collectionName} could not be moved`)
        }
    }

    if (conflicts > 0) {
        logger.error(`${conflicts} document(s) of ${legacy.collectionName} could not be moved: the collection is kept, merge them by hand`)
    } else {
        await unlessAlreadyGone(legacy.drop())
        logger.info(`Moved ${moved} document(s) from ${legacy.collectionName} and dropped it`)
    }
}

/**
 * Gives the collection of `model` the documents of the legacy one, when it still exists. Mongoose may have
 * created the new collection empty, with its indexes, before this runs, so the legacy one replaces it; one
 * already holding documents gets the legacy ones merged into it.
 */
const moveLegacyCollection = async (logger: FastifyBaseLogger, db: mongo.Db, legacyName: string, model: AnyModel, naturalKey?: string[]): Promise<void> => {
    const [legacy] = await db.listCollections({ name: legacyName }, { nameOnly: true }).toArray()
    if (!legacy) return

    const target = model.collection.collectionName
    if ((await db.collection(target).countDocuments({}, { limit: 1 })) > 0) {
        await mergeLegacyCollection(logger, db.collection(legacyName), model, naturalKey)
    } else {
        await unlessAlreadyGone(db.renameCollection(legacyName, target, { dropTarget: true }))
        await model.createIndexes()
        logger.info(`Renamed the collection ${legacyName} to ${target}`)
    }
}

/**
 * Renames `from` to `to` on every document of `collection` that has it, after dropping the indexes on it:
 * Mongoose builds them on empty collections too, and a unique one left on a field no document has any more
 * would refuse the second document holding the same value in the fields it shares with it. They go before
 * the rename, which that index would otherwise refuse as well. Building the new ones is left to the caller.
 */
const renameField = async (collection: mongo.Collection, from: string, to: string): Promise<{ dropped: number; renamed: number }> => {
    const indexes = await collection.indexes().catch(error => {
        if ((error as { code?: unknown } | null)?.code === NAMESPACE_NOT_FOUND) return []
        throw error
    })
    const stale = indexes.filter(index => index.name && Object.keys(index.key).some(key => key === from || key.startsWith(`${from}.`)))
    for (const index of stale) {
        await unlessAlreadyGone(collection.dropIndex(index.name as string))
    }

    const { modifiedCount } = await collection.updateMany({ [from]: { $exists: true } }, { $rename: { [from]: to } })
    return { dropped: stale.length, renamed: modifiedCount }
}

/** Renames each field on the collection of its model, then builds the indexes of the model again when anything changed */
const renameFields = async (logger: FastifyBaseLogger, fields: Array<[AnyModel, string, string]>): Promise<void> => {
    for (const [model, from, to] of fields) {
        const { dropped, renamed } = await renameField(model.collection as unknown as mongo.Collection, from, to)
        if (dropped > 0 || renamed > 0) {
            await model.createIndexes()
            logger.info(`Renamed ${from} to ${to} on ${renamed} document(s) of ${model.collection.collectionName}, dropping ${dropped} index(es) on it`)
        }
    }
}

/**
 * Moves what was stored under the Microfrontend name to the Frontend one: the collection, the fields
 * of the other collections pointing at a frontend, the deployment snapshots and the kinds.
 *
 * Before the other migrations touching a frontend: they read them through the new names. Mongoose may
 * have created an empty `frontends` collection with its indexes before this runs, so the legacy one
 * replaces it; one already holding documents gets the legacy frontends merged into it.
 *
 * The indexes on a renamed field are dropped whether documents still carry it or not: Mongoose builds
 * them on empty collections too, and the unique one of the built frontends, left on a field no document
 * has any more, would refuse the second image registered with a version already used by another frontend.
 * They are dropped before the rename, which that index would otherwise refuse as well, and built again after.
 *
 * Idempotent, and safe with a second replica migrating at the same time: once nothing carries a legacy
 * name or kind, it costs one listing, a few index listings and a few empty updates.
 */
export const migrateMicrofrontendsToFrontends = async (logger: FastifyBaseLogger): Promise<void> => {
    const db = Frontend.db.db
    if (!db) return

    await moveLegacyCollection(logger, db, LEGACY_FRONTEND_COLLECTION, Frontend as unknown as AnyModel)

    // The models have nothing in common but these fields, so they are walked through the loosest shape
    await renameFields(logger, [
        [BuiltFrontend as unknown as AnyModel, "microfrontendId", "frontendId"],
        [FrontendDeployment as unknown as AnyModel, "microfrontendId", "frontendId"],
        [DeploymentToCanaryUsers as unknown as AnyModel, "microfrontendId", "frontendId"],
        [AiChangeRequest as unknown as AnyModel, "microfrontendId", "frontendId"],
        [AiChangeJob as unknown as AnyModel, "microfrontendIds", "frontendIds"],
        [Deployment as unknown as AnyModel, "microfrontends", "frontends"]
    ])

    for (const [from, to] of LEGACY_FRONTEND_KINDS) {
        const frontends = await Frontend.collection.updateMany({ kind: from }, { $set: { kind: to } })
        const deployments = await Deployment.collection.updateMany({ "frontends.kind": from }, { $set: { "frontends.$[legacy].kind": to } }, { arrayFilters: [{ "legacy.kind": from }] })
        if (frontends.modifiedCount > 0 || deployments.modifiedCount > 0) {
            logger.info(`Migrated the kind ${from} to ${to} on ${frontends.modifiedCount} frontend(s) and ${deployments.modifiedCount} deployment(s)`)
        }
    }
}

/**
 * The collections the backends, their versions and their deploys were stored in while the model was called
 * Service, with the field naming the backend in each and the unique key a version is known by
 */
const LEGACY_BACKEND_COLLECTIONS: Array<[string, AnyModel, string | undefined, string[] | undefined]> = [
    ["services", Backend as unknown as AnyModel, undefined, undefined],
    ["builtservices", BuiltBackend as unknown as AnyModel, "serviceId", ["backendId", "version"]],
    ["servicedeployments", BackendDeployment as unknown as AnyModel, "serviceId", undefined]
]

/** The kind a frontend or a backend was told apart by, as it was stored before */
const LEGACY_BACKEND_KIND = "service"

/**
 * Moves what was stored under the Service name to the Backend one: the collections of the backends, of
 * their versions and of their deploys, the fields of the other collections pointing at a backend (with
 * their indexes), the deployment snapshots and the kind of the components of the AI missions and of the
 * domain releases.
 *
 * Right after the frontends, before the other migrations touching a backend: they read them through the
 * new names. The field naming the backend in the versions and in the deploys is renamed in the legacy
 * collection first, so a merge into a new collection is not refused by its unique index.
 *
 * Idempotent, and safe with a second replica migrating at the same time: once nothing carries a legacy
 * name or kind, it costs a few listings, a few index listings and a few empty updates.
 */
export const migrateServicesToBackends = async (logger: FastifyBaseLogger): Promise<void> => {
    const db = Backend.db.db
    if (!db) return

    for (const [legacyName, model, field, naturalKey] of LEGACY_BACKEND_COLLECTIONS) {
        if (field) {
            const [legacy] = await db.listCollections({ name: legacyName }, { nameOnly: true }).toArray()
            if (legacy) await renameField(db.collection(legacyName), field, "backendId")
        }
        await moveLegacyCollection(logger, db, legacyName, model, naturalKey)
    }

    await renameFields(logger, [
        [BuiltBackend as unknown as AnyModel, "serviceId", "backendId"],
        [BackendDeployment as unknown as AnyModel, "serviceId", "backendId"],
        [AiChangeRequest as unknown as AnyModel, "serviceId", "backendId"],
        [AiChangeJob as unknown as AnyModel, "serviceIds", "backendIds"],
        [AiUsage as unknown as AnyModel, "serviceIds", "backendIds"],
        [MaintenanceAgent as unknown as AnyModel, "serviceIds", "backendIds"],
        [Frontend as unknown as AnyModel, "serviceIds", "backendIds"],
        [Deployment as unknown as AnyModel, "services", "backends"]
    ])

    // The frontends a deployment recorded carry the backends they call: an array, which $rename cannot reach into
    const snapshots = await Deployment.collection.updateMany({ "frontends.serviceIds": { $exists: true } }, [
        {
            $set: {
                frontends: {
                    $map: {
                        input: "$frontends",
                        as: "frontend",
                        in: {
                            $cond: [
                                { $eq: [{ $type: "$$frontend.serviceIds" }, "missing"] },
                                "$$frontend",
                                {
                                    $mergeObjects: [
                                        { $arrayToObject: { $filter: { input: { $objectToArray: "$$frontend" }, cond: { $ne: ["$$this.k", "serviceIds"] } } } },
                                        { backendIds: "$$frontend.serviceIds" }
                                    ]
                                }
                            ]
                        }
                    }
                }
            }
        }
    ])
    if (snapshots.modifiedCount > 0) {
        logger.info(`Renamed serviceIds to backendIds on the frontends of ${snapshots.modifiedCount} deployment(s)`)
    }

    const kind = { $set: { "repositories.$[legacy].kind": "backend" } }
    const legacyKind = { arrayFilters: [{ "legacy.kind": LEGACY_BACKEND_KIND }] }
    const missions = await AiMission.collection.updateMany({ "repositories.kind": LEGACY_BACKEND_KIND }, kind, legacyKind)
    const members = await DomainRelease.collection.updateMany({ "members.kind": LEGACY_BACKEND_KIND }, { $set: { "members.$[legacy].kind": "backend" } }, legacyKind)
    const built = await DomainRelease.collection.updateMany(
        { "repositories.members.kind": LEGACY_BACKEND_KIND },
        { $set: { "repositories.$[repository].members.$[legacy].kind": "backend" } },
        { arrayFilters: [{ "repository.members.kind": LEGACY_BACKEND_KIND }, { "legacy.kind": LEGACY_BACKEND_KIND }] }
    )
    if (missions.modifiedCount > 0 || members.modifiedCount > 0 || built.modifiedCount > 0) {
        logger.info(`Migrated the kind ${LEGACY_BACKEND_KIND} to backend on ${missions.modifiedCount} AI mission(s) and ${members.modifiedCount + built.modifiedCount} domain release update(s)`)
    }
}

/**
 * Removes the expiry the first version of the assistant history had: a TTL index on `expiresAt`,
 * which made MongoDB delete conversations 90 days after their last answer. Conversations are now only
 * ever deleted logically, so the index goes and the field with it.
 *
 * Mongoose creates the indexes a schema declares but never drops one it no longer declares, hence the
 * explicit drop. Idempotent: once both are gone, it costs one failed drop and one empty update.
 */
export const removeAssistantConversationExpiry = async (logger: FastifyBaseLogger): Promise<void> => {
    try {
        await AssistantConversation.collection.dropIndex("expiresAt_1")
        logger.info("Dropped the expiry index of the assistant conversations")
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (code !== NAMESPACE_NOT_FOUND && code !== INDEX_NOT_FOUND) throw error
    }
    const { modifiedCount } = await AssistantConversation.collection.updateMany({ expiresAt: { $exists: true } }, { $unset: { expiresAt: "" } })
    if (modifiedCount > 0) {
        logger.info(`Removed the expiry date of ${modifiedCount} assistant conversation(s)`)
    }
}

/** Anything not carrying the marker written by secretCrypto is still a credential in the clear. */
const NOT_ENCRYPTED = { $exists: true, $not: /^enc:v1:/ }

/**
 * Rewrites, encrypted, the credentials written before a key was configured.
 *
 * Reading them back needs no migration — a value with no marker is handed over untouched — so this is
 * only about what a dump of the database shows. It is a re-save per document and nothing else: the
 * save hook is what encrypts, and it skips whatever is already encrypted, which is what makes a second
 * run cost one empty query per collection.
 *
 * Deployments are in here because a deployment freezes a copy of the storages of its project, and the
 * serve API reads the bucket keys from that copy.
 */
const encryptStoredSecrets = async (logger: FastifyBaseLogger): Promise<void> => {
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
        ["project", Project as unknown as SecretHolder, anyPlaintextIn(PROJECT_SECRET_PATHS) as SecretFilter],
        // $elemMatch so both halves of the criterion have to be met by the same storage of the
        // snapshot: spelled out as a dotted path, a snapshot holding one already encrypted credential
        // beside a plaintext one would satisfy neither half on the element that still needs rewriting.
        ["deployment", Deployment as unknown as SecretHolder, { storages: { $elemMatch: anyPlaintextIn(STORAGE_SECRET_PATHS) } } as SecretFilter],
        // Nested $elemMatch for the same reason, one level deeper: a key of a secret holds a value per environment.
        ["secret", Secret as unknown as SecretHolder, { entries: { $elemMatch: { values: { $elemMatch: { value: NOT_ENCRYPTED } } } } } as SecretFilter],
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

/** A backend as it was stored while it held its config map and secrets itself */
interface BackendWithInlineVariables {
    _id: ObjectId
    projectId: ObjectId
    slug: string
    configMap?: IVariableMapEntry[] | null
    secrets?: IVariableMapEntry[] | null
}

/** What the secrets were bound to while they were encrypted inside the backend: they have to be read with it, so it keeps the model name they were written under */
const INLINE_SECRETS_CONTEXT = "Service:secrets.values.value"

/** The map the migration made out of one list of one backend: found again by this, never by its name, which another map may hold. Stored, so it keeps the old wording */
const migratedFrom = (backend: BackendWithInlineVariables) => `Moved from the service ${backend.slug} (${backend._id})`

const extractInlineVariables = async (backend: BackendWithInlineVariables, kind: VariableMapKind, entries: IVariableMapEntry[] | null = []): Promise<ObjectId[]> => {
    if (!entries?.length) return []
    const model = variableMapModels[kind]
    const description = migratedFrom(backend)
    // Left by a run that crashed before updating the backend, or by another replica booting at the same time
    const findMine = () => model.findOne({ projectId: backend.projectId, description }, { _id: 1 })

    const existing = await findMine()
    if (existing) return [existing._id]

    const readable =
        kind === "secret" ? entries.map(entry => ({ ...entry, values: entry.values.map(value => ({ ...value, value: decryptSecret(value.value, INLINE_SECRETS_CONTEXT) as string })) })) : entries
    // A slug may end with a dash, a Kubernetes name may not; `orders` and `orders-` would then share one
    const name = backend.slug.replace(/-+$/, "")
    for (const candidate of [name, `${name}-${String(backend._id).slice(-6)}`]) {
        try {
            const map = await model.create({ projectId: backend.projectId, name: candidate, description, entries: readable })
            return [map._id]
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error
            const created = await findMine()
            if (created) return [created._id]
        }
    }
    throw new Error(`No free name for the ${kind} of the backend ${backend.slug}`)
}

/**
 * Moves the config map and the secrets a backend used to hold into maps of its project, named after the
 * backend and attached to it, so nothing it received is lost now that maps live on their own.
 *
 * Read and written on the raw collection: the backend schema no longer knows those fields. The secrets
 * are decrypted with the context they were written under and encrypted again by the save of the new map,
 * under its own. A backend that fails (a secret the key cannot read) is logged and left as it is, inline
 * values included, for the next boot: the others, and the migrations after this one, still run.
 */
export const moveBackendVariablesToMaps = async (logger: FastifyBaseLogger): Promise<void> => {
    let moved = 0
    for await (const backend of Backend.collection.find<BackendWithInlineVariables>({ $or: [{ configMap: { $exists: true } }, { secrets: { $exists: true } }] })) {
        try {
            const configMapIds = await extractInlineVariables(backend, "configMap", backend.configMap)
            const secretIds = await extractInlineVariables(backend, "secret", backend.secrets)
            await Backend.collection.updateOne({ _id: backend._id }, { $addToSet: { configMapIds: { $each: configMapIds }, secretIds: { $each: secretIds } }, $unset: { configMap: "", secrets: "" } })
            moved++
        } catch (error) {
            logger.error({ error, backendId: String(backend._id) }, `Could not move the config map and secrets of the backend ${backend.slug} into maps`)
        }
    }

    if (moved > 0) {
        logger.info(`Moved the config map and secrets of ${moved} backend(s) into maps of their project`)
    }
}

/** An AI change request as it was stored before it carried its conversation. */
interface AiChangeRequestLinks {
    _id: ObjectId
    jobId?: ObjectId
    parentId?: ObjectId
    conversationId?: ObjectId
}

/** How far back a request's parents are followed: as far as a job looks for the requests before it. */
const MAX_CONVERSATION_LENGTH = 50

/**
 * The conversation of a request written before requests carried one: the first job of its chain of follow-ups.
 * Once its job is gone (expired with its proposals), the oldest request still reachable through `parentId`
 * names it: a request without a parent was made by the first job of its chain. A request without a job comes
 * from before jobs and is a conversation of its own.
 */
const conversationOf = async (request: AiChangeRequestLinks): Promise<ObjectId> => {
    if (!request.jobId) return request._id
    const job = await AiChangeJob.collection.findOne<{ rootJobId: ObjectId }>({ _id: request.jobId }, { projection: { rootJobId: 1 } })
    if (job) return job.rootJobId
    let oldest = request
    for (let depth = 0; oldest.parentId && depth < MAX_CONVERSATION_LENGTH; depth++) {
        const parent = await AiChangeRequest.collection.findOne<AiChangeRequestLinks>({ _id: oldest.parentId }, { projection: { jobId: 1, parentId: 1, conversationId: 1 } })
        if (!parent) break
        if (parent.conversationId) return parent.conversationId
        oldest = parent
    }
    return oldest.jobId ?? oldest._id
}

/**
 * Gives every AI change request written before requests carried their conversation the one it belongs to:
 * the console groups the requests of a frontend by it. Idempotent: only the requests still without
 * one are read, so once they are all done it costs one empty query.
 */
export const backfillAiChangeConversations = async (logger: FastifyBaseLogger): Promise<void> => {
    let filled = 0
    for await (const request of AiChangeRequest.collection.find<AiChangeRequestLinks>({ conversationId: { $exists: false } }, { projection: { jobId: 1, parentId: 1 } })) {
        await AiChangeRequest.collection.updateOne({ _id: request._id }, { $set: { conversationId: await conversationOf(request) } })
        filled++
    }

    if (filled > 0) {
        logger.info(`Linked ${filled} AI change request(s) to their conversation`)
    }
}

/**
 * Every data migration the application needs, run once the database connection is up.
 *
 * A failure is logged and swallowed: none of these is required for the process to serve traffic, and
 * refusing to boot over one would take the whole console down for a data fix. Except the moves of the
 * frontends and of the backends to their new names, which run first and are let through: without them the
 * console would boot showing no frontend and no backend and every deployment would serve nothing, so a
 * failed boot, retried, is better.
 */
export const runMigrations = async (logger: FastifyBaseLogger): Promise<void> => {
    await migrateMicrofrontendsToFrontends(logger)
    await migrateServicesToBackends(logger)
    try {
        // First: everything else in the application reads a project through its organization, so a
        // project still missing one would be invisible to whoever owns it.
        await migrateProjectsToOrganizations(logger)
        await migrateLegacyCanaryTypes(logger)
        // Before the encryption: whatever it moves is then covered by it
        await moveBackendVariablesToMaps(logger)
        await encryptStoredSecrets(logger)
        await removeAssistantConversationExpiry(logger)
        await backfillAiChangeConversations(logger)
    } catch (error) {
        logger.error({ error }, "Error while running data migrations")
    }
}
