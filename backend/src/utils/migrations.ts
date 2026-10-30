import { FastifyBaseLogger } from "fastify"
import { Model, QueryFilter } from "mongoose"
import AiModel, { AI_MODEL_SECRET_PATHS } from "../models/AiModelModel"
import CodeRepository, { CODE_REPOSITORY_SECRET_PATHS } from "../models/CodeRepositoryModel"
import Database, { DATABASE_SECRET_PATHS } from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import Project, { PROJECT_SECRET_PATHS } from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import Storage, { STORAGE_SECRET_PATHS } from "../models/StorageModel"
import { Secret } from "../models/VariableMapModel"
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
        ["project", Project as unknown as SecretHolder, anyPlaintextIn(PROJECT_SECRET_PATHS) as SecretFilter],
        // `config` is Mixed and a provider without a secret access key has no such field: $exists in NOT_ENCRYPTED skips it
        ["AI model", AiModel as unknown as SecretHolder, anyPlaintextIn(AI_MODEL_SECRET_PATHS) as SecretFilter],
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

/**
 * Every data migration the application still needs, run once the database connection is up.
 *
 * A failure is logged and swallowed: none of these is required for the process to serve traffic, and
 * refusing to boot over one would take the whole console down for a data fix.
 */
export const runMigrations = async (logger: FastifyBaseLogger): Promise<void> => {
    try {
        await encryptStoredSecrets(logger)
    } catch (error) {
        logger.error({ error }, "Error while running data migrations")
    }
}
