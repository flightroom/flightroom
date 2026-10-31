import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AiModel from "../models/AiModelModel"
import Backend from "../models/BackendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Database from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import Storage from "../models/StorageModel"
import { Secret } from "../models/VariableMapModel"
import { convertKubeGreenSchedules, encryptStoredSecrets, runMigrations, seedEnvironmentVersions } from "./migrations"
import { resetSecretEncryptionKeyCache } from "./secretCrypto"

const logger = { info: vi.fn(), error: vi.fn() } as never

const MODELS = [Storage, CodeRepository, Database, Project, AiModel, Deployment, Secret, Resource]

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

/** The applications not seeded yet, as each model answers them */
const unseeded = (documents: { backends?: object[]; frontends?: object[]; agents?: object[] } = {}) => {
    vi.spyOn(Backend, "find").mockReturnValue({ lean: () => Promise.resolve(documents.backends ?? []) } as never)
    vi.spyOn(Frontend, "find").mockReturnValue({ lean: () => Promise.resolve(documents.frontends ?? []) } as never)
    vi.spyOn(MaintenanceAgent, "find").mockReturnValue({ lean: () => Promise.resolve(documents.agents ?? []) } as never)
}

describe("seedEnvironmentVersions", () => {
    const projectId = new Types.ObjectId()
    const [production, staging] = [new Types.ObjectId(), new Types.ObjectId()]
    const [backendId, frontendId, agentId] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()]

    beforeEach(() => {
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: production }, { _id: staging }] as never)
        // Production serves 1.0.0 of the backend and 2.0.0 of the frontend; staging was never deployed
        vi.spyOn(Deployment, "findOne").mockImplementation(
            (filter?: unknown) =>
                ({
                    sort: () => ({
                        lean: () =>
                            Promise.resolve(
                                (filter as { environmentId?: unknown })?.environmentId === production
                                    ? { backends: [{ _id: backendId, version: "1.0.0" }], frontends: [{ _id: frontendId, version: "2.0.0" }] }
                                    : null
                            )
                    })
                }) as never
        )
        for (const model of [Backend, Frontend, MaintenanceAgent]) vi.spyOn(model, "updateOne").mockResolvedValue({} as never)
    })

    it("Given applications made before, when it runs, then each environment gets what its deployment recorded, else the version of the application", async () => {
        unseeded({
            backends: [{ _id: backendId, projectId, version: "1.1.0" }],
            frontends: [{ _id: frontendId, projectId, version: "2.1.0" }],
            agents: [{ _id: agentId, projectId, version: "3.0.0" }]
        })

        await seedEnvironmentVersions(logger)

        const set = (model: typeof Backend | typeof Frontend | typeof MaintenanceAgent) => vi.mocked(model.updateOne).mock.calls[0]
        expect(set(Backend)).toEqual([
            { _id: backendId, environmentVersions: { $exists: false } },
            {
                $set: {
                    environmentVersions: [
                        { environmentId: production, version: "1.0.0" },
                        { environmentId: staging, version: "1.1.0" }
                    ]
                }
            }
        ])
        expect(set(Frontend)[1]).toEqual({
            $set: {
                environmentVersions: [
                    { environmentId: production, version: "2.0.0" },
                    { environmentId: staging, version: "2.1.0" }
                ]
            }
        })
        // A maintenance agent is recorded by no deployment: its version, everywhere
        expect(set(MaintenanceAgent)[1]).toEqual({
            $set: {
                environmentVersions: [
                    { environmentId: production, version: "3.0.0" },
                    { environmentId: staging, version: "3.0.0" }
                ]
            }
        })
        expect(Environment.find).toHaveBeenCalledTimes(1)
    })

    it("Given an application never deployed and with no version, when it runs, then it gets an empty list and is not looked at again", async () => {
        unseeded({ backends: [{ _id: new Types.ObjectId(), projectId }] })

        await seedEnvironmentVersions(logger)

        expect(vi.mocked(Backend.updateOne).mock.calls[0][1]).toEqual({ $set: { environmentVersions: [] } })
    })

    it("Given every application seeded already, when it runs, then no environment nor deployment is read", async () => {
        unseeded()

        await seedEnvironmentVersions(logger)

        expect(Environment.find).not.toHaveBeenCalled()
        expect(Deployment.findOne).not.toHaveBeenCalled()
    })
})

describe("convertKubeGreenSchedules", () => {
    const holdingSchedules = (documents: object[]) => {
        const updateOne = vi.fn().mockResolvedValue({})
        vi.spyOn(Environment, "collection", "get").mockReturnValue({ find: () => ({ toArray: async () => documents }), updateOne } as never)
        return updateOne
    }

    it("Given a schedule saved as one rule, when it runs, then its days are awake between the two times and the others asleep, and the rule is unset", async () => {
        const _id = new Types.ObjectId()
        const updateOne = holdingSchedules([{ _id, kubeGreen: { weekdays: "1-5", sleepAt: "20:00", wakeUpAt: "08:00" } }])

        await convertKubeGreenSchedules(logger)

        const [filter, update] = updateOne.mock.calls[0]
        expect(filter).toEqual({ _id })
        expect(update.$set["kubeGreen.days"]).toEqual([
            { weekday: 0, awake: false, wakeUpAt: "", sleepAt: "" },
            ...[1, 2, 3, 4, 5].map(weekday => ({ weekday, awake: true, wakeUpAt: "08:00", sleepAt: "20:00" })),
            { weekday: 6, awake: false, wakeUpAt: "", sleepAt: "" }
        ])
        expect(update.$unset).toEqual({ "kubeGreen.weekdays": "", "kubeGreen.sleepAt": "", "kubeGreen.wakeUpAt": "" })
    })

    it("Given a rule with no wake up, when it runs, then its days are awake from midnight", async () => {
        const updateOne = holdingSchedules([{ _id: new Types.ObjectId(), kubeGreen: { weekdays: "*", sleepAt: "22:00", wakeUpAt: "" } }])

        await convertKubeGreenSchedules(logger)

        expect(updateOne.mock.calls[0][1].$set["kubeGreen.days"]).toEqual([0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, awake: true, wakeUpAt: "", sleepAt: "22:00" })))
    })
})

describe("runMigrations", () => {
    it("Given the encryption fails, when the migrations run, then the failure is logged and the boot goes on", async () => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"))
        resetSecretEncryptionKeyCache()
        unseeded()
        holding(Storage, [{ save: vi.fn().mockRejectedValue(new Error("write refused")) }])
        const error = vi.fn()

        await expect(runMigrations({ info: vi.fn(), error } as never)).resolves.toBeUndefined()
        expect(error).toHaveBeenCalledWith({ error: expect.any(Error) }, "Error while running data migrations")
    })
})
