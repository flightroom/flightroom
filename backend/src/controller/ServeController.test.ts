import Fastify, { FastifyInstance } from "fastify"
import { Types } from "mongoose"
import { Readable } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ s3Send: vi.fn(), azureDownload: vi.fn(), gcsCreateReadStream: vi.fn() }))

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: vi.fn(function () {
        return { send: sdk.s3Send }
    }),
    GetObjectCommand: class {
        constructor(readonly input: unknown) {}
    },
    PutObjectCommand: class {},
    DeleteObjectCommand: class {}
}))

vi.mock("@azure/storage-blob", () => ({
    BlobServiceClient: {
        fromConnectionString: vi.fn(() => ({
            url: "https://flightroomassets.blob.core.windows.net/",
            getContainerClient: () => ({ getBlockBlobClient: () => ({ download: sdk.azureDownload }) })
        }))
    },
    StorageSharedKeyCredential: vi.fn()
}))

vi.mock("@google-cloud/storage", () => ({
    Storage: vi.fn(function () {
        return { bucket: () => ({ file: () => ({ createReadStream: sdk.gcsCreateReadStream }) }) }
    })
}))

import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import { HostedOn } from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import { StorageType } from "../models/StorageModel"
import errorHandler from "../plugins/errorHandler"
import serveController from "./ServeController"

const projectId = new Types.ObjectId()
const storageId = new Types.ObjectId()
const environment = { _id: new Types.ObjectId(), projectId, slug: "DEV" }
const project = { _id: projectId, slug: "acme" }

const STORAGES = {
    [StorageType.AWS]: { region: "eu-south-1", accessKeyId: "AKIA-EXAMPLE", secretAccessKey: "not-a-real-secret", bucketName: "assets-bucket" },
    [StorageType.AZURE]: { authType: "connectionString", connectionString: "UseDevelopmentStorage=true", containerName: "bundles" },
    [StorageType.GOOGLE]: { authType: "serviceAccount", jsonKey: JSON.stringify({ client_email: "uploader@acme.iam.gserviceaccount.com", private_key: "not-a-real-key" }), bucketName: "assets-bucket" }
}

/** The last deployment of the environment, whose only frontend is uploaded to a storage of the given type */
const deploymentOn = (type: StorageType) => ({
    _id: new Types.ObjectId(),
    environmentId: environment._id,
    frontends: [{ _id: new Types.ObjectId(), slug: "cart", version: "1.0.0", host: { type: HostedOn.CUSTOM_SOURCE, storageId, entryPoint: "remoteEntry.js" } }],
    storages: [{ _id: storageId, type, authConfig: STORAGES[type] }]
})

/** What each SDK answers when the object is not in the storage */
const objectMissingFrom = (type: StorageType) => {
    switch (type) {
        case StorageType.AWS:
            sdk.s3Send.mockRejectedValue(Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }))
            break
        case StorageType.AZURE:
            sdk.azureDownload.mockRejectedValue(Object.assign(new Error("The specified blob does not exist."), { name: "RestError", statusCode: 404, code: "BlobNotFound" }))
            break
        case StorageType.GOOGLE:
            // GCS fails the read stream, once the response comes back, rather than the call
            sdk.gcsCreateReadStream.mockReturnValue(
                new Readable({
                    read() {
                        this.destroy(Object.assign(new Error("No such object: assets-bucket/acme/cart/1.0.0/missing.js"), { name: "ApiError", code: 404 }))
                    }
                })
            )
            break
    }
}

describe("ServeController, files of a frontend uploaded to a storage", () => {
    let app: FastifyInstance

    beforeEach(async () => {
        sdk.s3Send.mockReset()
        sdk.azureDownload.mockReset()
        sdk.gcsCreateReadStream.mockReset()
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        vi.spyOn(Environment, "findOne").mockReturnValue({ collation: () => Promise.resolve(environment) } as never)
        vi.spyOn(Project, "findOne").mockResolvedValue(project as never)
        app = Fastify()
        await app.register(errorHandler)
        await app.register(serveController)
        await app.ready()
    })

    afterEach(async () => {
        await app.close()
        vi.restoreAllMocks()
    })

    it.each([StorageType.AWS, StorageType.AZURE, StorageType.GOOGLE])("given a file missing from the %s storage, when it is asked for, then the answer is a 404", async type => {
        vi.spyOn(Deployment, "findOne").mockReturnValue({ sort: () => Promise.resolve(deploymentOn(type)) } as never)
        objectMissingFrom(type)

        const response = await app.inject({ method: "GET", url: `/serve/mfe/files/${projectId}/DEV/cart/missing.js` })

        expect(response.statusCode).toBe(404)
        expect(response.json().code).toBe("ENTITY_NOT_FOUND")
    })

    it("given the storage denies the read, when a file is asked for, then the answer is not a 404", async () => {
        vi.spyOn(Deployment, "findOne").mockReturnValue({ sort: () => Promise.resolve(deploymentOn(StorageType.AWS)) } as never)
        sdk.s3Send.mockRejectedValue(Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }))

        const response = await app.inject({ method: "GET", url: `/serve/mfe/files/${projectId}/DEV/cart/app.js` })

        expect(response.statusCode).toBe(500)
    })

    it("given the file is in the storage, when it is asked for, then its content is served", async () => {
        vi.spyOn(Deployment, "findOne").mockReturnValue({ sort: () => Promise.resolve(deploymentOn(StorageType.GOOGLE)) } as never)
        sdk.gcsCreateReadStream.mockReturnValue(Readable.from([Buffer.from("export default 1")]))

        const response = await app.inject({ method: "GET", url: `/serve/mfe/files/${projectId}/DEV/cart/app.js` })

        expect(response.statusCode).toBe(200)
        expect(response.body).toBe("export default 1")
    })
})
