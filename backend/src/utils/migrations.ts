import { FastifyBaseLogger } from "fastify"
import { Model, QueryFilter } from "mongoose"
import AiModel, { AI_MODEL_SECRET_PATHS } from "../models/AiModelModel"
import Backend from "../models/BackendModel"
import CodeRepository, { CODE_REPOSITORY_SECRET_PATHS } from "../models/CodeRepositoryModel"
import Database, { DATABASE_SECRET_PATHS } from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project, { PROJECT_SECRET_PATHS } from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import Storage, { STORAGE_SECRET_PATHS } from "../models/StorageModel"
import { Secret } from "../models/VariableMapModel"
import { WEEKDAYS } from "../types/KubeGreen"
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
 * Gives the backends, the DOCKER frontends and the maintenance agents made before a version was set per environment the
 * one each environment runs: what its current deployment recorded, else the version of the application, which every
 * deploy wrote before. Without it, an environment would no longer get them. A document is seeded once: those made since
 * hold the field, empty or not.
 */
export const seedEnvironmentVersions = async (logger: FastifyBaseLogger): Promise<void> => {
    const unseeded = { environmentVersions: { $exists: false } }
    const fields = { projectId: 1, version: 1 }
    type Unseeded = { _id: unknown; projectId: unknown; version?: string }
    const kinds = [
        { label: "backend", model: Backend, snapshot: "backends" as const, documents: await Backend.find(unseeded, fields).lean<Unseeded[]>() },
        { label: "frontend", model: Frontend, snapshot: "frontends" as const, documents: await Frontend.find({ ...unseeded, kind: FrontendKind.DOCKER }, fields).lean<Unseeded[]>() },
        // Not recorded by a deployment: every deploy wrote its version
        { label: "maintenance agent", model: MaintenanceAgent, snapshot: undefined, documents: await MaintenanceAgent.find(unseeded, fields).lean<Unseeded[]>() }
    ]
    if (kinds.every(kind => kind.documents.length === 0)) return

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

    for (const { label, model, snapshot, documents } of kinds) {
        for (const document of documents) {
            const environmentVersions = (await currentOf(document.projectId)).flatMap(environment => {
                const recorded = snapshot ? environment[snapshot].find(application => String(application._id) === String(document._id))?.version : undefined
                const version = recorded?.trim() || document.version?.trim()
                return version ? [{ environmentId: environment._id, version }] : []
            })
            await (model as unknown as Model<Record<string, unknown>>).updateOne({ _id: document._id, ...unseeded }, { $set: { environmentVersions } })
        }
        if (documents.length > 0) logger.info(`Set the version each environment runs on ${documents.length} ${label}(s)`)
    }
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
}
