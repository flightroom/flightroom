import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AiModel from "../models/AiModelModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Database from "../models/DatabaseModel"
import Deployment from "../models/DeploymentModel"
import Project from "../models/ProjectModel"
import Resource from "../models/ResourceModel"
import Storage from "../models/StorageModel"
import { Secret } from "../models/VariableMapModel"
import { encryptStoredSecrets, runMigrations } from "./migrations"
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

describe("runMigrations", () => {
    it("Given the encryption fails, when the migrations run, then the failure is logged and the boot goes on", async () => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"))
        resetSecretEncryptionKeyCache()
        holding(Storage, [{ save: vi.fn().mockRejectedValue(new Error("write refused")) }])
        const error = vi.fn()

        await expect(runMigrations({ info: vi.fn(), error } as never)).resolves.toBeUndefined()
        expect(error).toHaveBeenCalledWith({ error: expect.any(Error) }, "Error while running data migrations")
    })
})
