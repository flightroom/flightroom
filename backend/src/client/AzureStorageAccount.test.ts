import { Readable } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type FakeBlob = { url: string; upload: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> }

const sdk = vi.hoisted(() => {
    const blob = { url: "", upload: vi.fn(), delete: vi.fn(), download: vi.fn() }
    const container = { getBlockBlobClient: vi.fn() }
    /** A BlobServiceClient answering at `url`, whose blobs are all the one fake blob above */
    const serviceAt = (url: string) => ({ url, getContainerClient: vi.fn(() => container) })
    return { blob, container, serviceAt }
})

vi.mock("@azure/storage-blob", () => ({
    BlobServiceClient: Object.assign(
        vi.fn(function (url: string) {
            return sdk.serviceAt(url)
        }),
        { fromConnectionString: vi.fn(() => sdk.serviceAt("https://fromconnection.blob.core.windows.net/")) }
    ),
    StorageSharedKeyCredential: vi.fn(function (this: Record<string, string>, accountName: string, accountKey: string) {
        this.kind = "sharedKey"
        this.accountName = accountName
        this.accountKey = accountKey
    })
}))

vi.mock("@azure/identity", () => ({
    ClientSecretCredential: vi.fn(function (this: Record<string, string>, tenantId: string, clientId: string) {
        this.kind = "clientSecret"
        this.tenantId = tenantId
        this.clientId = clientId
    })
}))

import { ClientSecretCredential } from "@azure/identity"
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import AzureStorageClient, { AzureStorageConfig } from "./AzureStorageAccount"

const RAW_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=fromconnection;AccountKey=bm90LWEtcmVhbC1rZXk=;EndpointSuffix=core.windows.net"
const CONNECTION_STRING: AzureStorageConfig = { authType: "connectionString", connectionString: RAW_CONNECTION_STRING, containerName: "bundles" }
const SHARED_KEY: AzureStorageConfig = { authType: "sharedKey", accountName: "flightroomassets", accountKey: "bm90LWEtcmVhbC1rZXk=", containerName: "bundles" }
const AAD: AzureStorageConfig = { authType: "aad", accountName: "flightroomassets", tenantId: "tenant-1", clientId: "client-1", clientSecret: "not-a-real-secret", containerName: "bundles" }

const blob = sdk.blob as FakeBlob

const textOf = async (stream: Readable): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString("utf8")
}

/** What the Azure SDK rejects with: a RestError carries the HTTP status and the storage error code */
const restError = (message: string, statusCode: number, code: string) => Object.assign(new Error(message), { name: "RestError", statusCode, code })

/** The service client the storage client built, whichever way it was built */
const builtService = () => {
    const viaConstructor = vi.mocked(BlobServiceClient).mock.results[0]?.value
    const viaConnectionString = vi.mocked(BlobServiceClient.fromConnectionString).mock.results[0]?.value
    return (viaConstructor ?? viaConnectionString) as ReturnType<typeof sdk.serviceAt>
}

beforeEach(() => {
    vi.mocked(BlobServiceClient).mockClear()
    vi.mocked(BlobServiceClient.fromConnectionString).mockClear()
    vi.mocked(StorageSharedKeyCredential).mockClear()
    vi.mocked(ClientSecretCredential).mockClear()
    sdk.container.getBlockBlobClient.mockReset()
    sdk.container.getBlockBlobClient.mockImplementation((blobPath: string) => {
        blob.url = `https://flightroomassets.blob.core.windows.net/bundles/${blobPath}`
        return blob
    })
    blob.upload.mockReset()
    blob.delete.mockReset()
    blob.download.mockReset()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("AzureStorageClient, construction", () => {
    it("given a connection string, when the client is built, then the SDK parses it and no credential is built", () => {
        new AzureStorageClient(CONNECTION_STRING)

        expect(BlobServiceClient.fromConnectionString).toHaveBeenCalledWith(RAW_CONNECTION_STRING)
        expect(BlobServiceClient).not.toHaveBeenCalled()
        expect(StorageSharedKeyCredential).not.toHaveBeenCalled()
        expect(ClientSecretCredential).not.toHaveBeenCalled()
    })

    it("given an account name and key, when the client is built, then a shared key credential is built from them", () => {
        new AzureStorageClient(SHARED_KEY)

        expect(StorageSharedKeyCredential).toHaveBeenCalledTimes(1)
        expect(StorageSharedKeyCredential).toHaveBeenCalledWith("flightroomassets", "bm90LWEtcmVhbC1rZXk=")
        expect(ClientSecretCredential).not.toHaveBeenCalled()
    })

    it("given an account name and key, when the client is built, then it talks to the blob endpoint of the account with that credential", () => {
        const client = new AzureStorageClient(SHARED_KEY)

        expect(BlobServiceClient).toHaveBeenCalledTimes(1)
        expect(BlobServiceClient).toHaveBeenCalledWith("https://flightroomassets.blob.core.windows.net", vi.mocked(StorageSharedKeyCredential).mock.instances[0])
        expect(client.endpoint).toBe("https://flightroomassets.blob.core.windows.net")
    })

    it("given a service principal, when the client is built, then a client secret credential is built from its tenant, client id and secret", () => {
        new AzureStorageClient(AAD)

        expect(ClientSecretCredential).toHaveBeenCalledTimes(1)
        expect(ClientSecretCredential).toHaveBeenCalledWith("tenant-1", "client-1", "not-a-real-secret")
        expect(StorageSharedKeyCredential).not.toHaveBeenCalled()
    })

    it("given a service principal, when the client is built, then it talks to the blob endpoint of the account with that credential", () => {
        const client = new AzureStorageClient(AAD)

        expect(BlobServiceClient).toHaveBeenCalledWith("https://flightroomassets.blob.core.windows.net", vi.mocked(ClientSecretCredential).mock.instances[0])
        expect(client.endpoint).toBe("https://flightroomassets.blob.core.windows.net")
    })

    it("given an unknown authentication type, when the client is built, then it is refused before any SDK client exists", () => {
        const unknown = { authType: "managedIdentity", accountName: "flightroomassets", containerName: "bundles" } as unknown as AzureStorageConfig

        expect(() => new AzureStorageClient(unknown)).toThrow("Invalid authentication configuration")
        expect(BlobServiceClient).not.toHaveBeenCalled()
        expect(BlobServiceClient.fromConnectionString).not.toHaveBeenCalled()
    })
})

describe("AzureStorageClient.uploadFile", () => {
    it("given a buffer and a content type, when a file is uploaded, then it goes to the blob of that path in the configured container", async () => {
        blob.upload.mockResolvedValue({})

        await new AzureStorageClient(SHARED_KEY).uploadFile("site/index.html", Buffer.from("<html></html>"), "text/html")

        expect(builtService().getContainerClient).toHaveBeenCalledWith("bundles")
        expect(sdk.container.getBlockBlobClient).toHaveBeenCalledWith("site/index.html")
    })

    it("given a buffer and a content type, when a file is uploaded, then the body, its byte length and the content type header are sent", async () => {
        blob.upload.mockResolvedValue({})
        const body = Buffer.from("<html></html>")

        await new AzureStorageClient(SHARED_KEY).uploadFile("site/index.html", body, "text/html")

        expect(blob.upload).toHaveBeenCalledWith(body, 13, { blobHTTPHeaders: { blobContentType: "text/html" } })
    })

    it("given a string with non-ASCII characters, when it is uploaded, then the length sent is its UTF-8 byte length", async () => {
        blob.upload.mockResolvedValue({})

        await new AzureStorageClient(SHARED_KEY).uploadFile("site/it.json", '{"ciao":"è"}', "application/json")

        expect(blob.upload.mock.calls[0][1]).toBe(13)
    })

    it("given no content type, when a file is uploaded, then it is stored as application/octet-stream", async () => {
        blob.upload.mockResolvedValue({})

        await new AzureStorageClient(SHARED_KEY).uploadFile("site/app.js", Buffer.from("x"))

        expect(blob.upload.mock.calls[0][2]).toEqual({ blobHTTPHeaders: { blobContentType: "application/octet-stream" } })
    })

    it("given the upload succeeds, when the URL is returned, then it is the URL of the blob", async () => {
        blob.upload.mockResolvedValue({})

        await expect(new AzureStorageClient(SHARED_KEY).uploadFile("site/index.html", "x")).resolves.toBe("https://flightroomassets.blob.core.windows.net/bundles/site/index.html")
    })

    it("given Azure denies the write, when a file is uploaded, then the caller gets an upload error carrying the Azure message", async () => {
        blob.upload.mockRejectedValue(restError("This request is not authorized to perform this operation using this permission.", 403, "AuthorizationPermissionMismatch"))

        await expect(new AzureStorageClient(AAD).uploadFile("site/index.html", "x")).rejects.toThrow(
            "Failed to upload file to Azure: This request is not authorized to perform this operation using this permission."
        )
    })

    it("given the SDK rejects with something that is not an Error, when a file is uploaded, then its string form is in the message", async () => {
        blob.upload.mockRejectedValue("socket hang up")

        await expect(new AzureStorageClient(SHARED_KEY).uploadFile("site/index.html", "x")).rejects.toThrow("Failed to upload file to Azure: socket hang up")
    })

    it("given Azure rejects, when a file is uploaded, then the Azure error is kept as the cause, with its status and code", async () => {
        const denied = restError("This request is not authorized to perform this operation using this permission.", 403, "AuthorizationPermissionMismatch")
        blob.upload.mockRejectedValue(denied)

        await expect(new AzureStorageClient(AAD).uploadFile("site/index.html", "x")).rejects.toHaveProperty("cause", denied)
    })
})

describe("AzureStorageClient.deleteFile", () => {
    it("given a path, when the file is deleted, then the blob of that path in the configured container is deleted", async () => {
        blob.delete.mockResolvedValue({})

        await expect(new AzureStorageClient(SHARED_KEY).deleteFile("site/.flightroom-connection-test")).resolves.toBeUndefined()

        expect(builtService().getContainerClient).toHaveBeenCalledWith("bundles")
        expect(sdk.container.getBlockBlobClient).toHaveBeenCalledWith("site/.flightroom-connection-test")
        expect(blob.delete).toHaveBeenCalledTimes(1)
    })

    it("given the blob does not exist, when the file is deleted, then the caller gets a delete error carrying the Azure message", async () => {
        blob.delete.mockRejectedValue(restError("The specified blob does not exist.", 404, "BlobNotFound"))

        await expect(new AzureStorageClient(SHARED_KEY).deleteFile("site/missing.html")).rejects.toThrow("Failed to delete file from Azure: The specified blob does not exist.")
    })

    it("given the SDK rejects with something that is not an Error, when the file is deleted, then its string form is in the message", async () => {
        blob.delete.mockRejectedValue("timeout")

        await expect(new AzureStorageClient(SHARED_KEY).deleteFile("site/index.html")).rejects.toThrow("Failed to delete file from Azure: timeout")
    })

    it("given Azure rejects, when the file is deleted, then the Azure error is kept as the cause", async () => {
        const missing = restError("The specified blob does not exist.", 404, "BlobNotFound")
        blob.delete.mockRejectedValue(missing)

        await expect(new AzureStorageClient(SHARED_KEY).deleteFile("site/missing.html")).rejects.toHaveProperty("cause", missing)
    })
})

describe("AzureStorageClient.downloadFileStream", () => {
    it("given a path, when the file is downloaded, then the blob of that path in the configured container is downloaded", async () => {
        blob.download.mockResolvedValue({ readableStreamBody: Readable.from([]) })

        await new AzureStorageClient(CONNECTION_STRING).downloadFileStream("site/index.html")

        expect(builtService().getContainerClient).toHaveBeenCalledWith("bundles")
        expect(sdk.container.getBlockBlobClient).toHaveBeenCalledWith("site/index.html")
        expect(blob.download).toHaveBeenCalledTimes(1)
    })

    it("given Azure returns a body, when the file is downloaded, then the caller reads the blob content from the returned stream", async () => {
        const body = Readable.from([Buffer.from("<html>"), Buffer.from("</html>")])
        blob.download.mockResolvedValue({ readableStreamBody: body })

        const stream = await new AzureStorageClient(SHARED_KEY).downloadFileStream("site/index.html")

        expect(stream).toBe(body)
        expect(await textOf(stream)).toBe("<html></html>")
    })

    it("given Azure answers without a stream body, when the file is downloaded, then the caller gets a download error saying so", async () => {
        blob.download.mockResolvedValue({})

        await expect(new AzureStorageClient(SHARED_KEY).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from Azure: No readable stream in download response")
    })

    it("given the blob does not exist, when the file is downloaded, then the caller gets a download error carrying the Azure message", async () => {
        blob.download.mockRejectedValue(restError("The specified blob does not exist.", 404, "BlobNotFound"))

        await expect(new AzureStorageClient(SHARED_KEY).downloadFileStream("site/missing.html")).rejects.toThrow("Failed to download file from Azure: The specified blob does not exist.")
    })

    it("given Azure denies the read, when the file is downloaded, then the caller gets a download error carrying the Azure message", async () => {
        blob.download.mockRejectedValue(restError("This request is not authorized to perform this operation.", 403, "AuthorizationFailure"))

        await expect(new AzureStorageClient(AAD).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from Azure: This request is not authorized to perform this operation.")
    })

    it("given the SDK rejects with something that is not an Error, when the file is downloaded, then its string form is in the message", async () => {
        blob.download.mockRejectedValue("ECONNRESET")

        await expect(new AzureStorageClient(SHARED_KEY).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from Azure: ECONNRESET")
    })

    it("given the blob does not exist, when the file is downloaded, then the error is a not-found one answering 404, with the Azure error as its cause", async () => {
        const missing = restError("The specified blob does not exist.", 404, "BlobNotFound")
        blob.download.mockRejectedValue(missing)

        const error = await new AzureStorageClient(SHARED_KEY).downloadFileStream("site/missing.html").catch((thrown: unknown) => thrown)

        expect(error).toBeInstanceOf(EntityNotFoundError)
        expect(error).toMatchObject({ statusCode: 404, message: "Failed to download file from Azure: The specified blob does not exist.", cause: missing })
    })

    it("given Azure names the missing blob without a status, when the file is downloaded, then the error is still a not-found one", async () => {
        blob.download.mockRejectedValue(Object.assign(new Error("The specified blob does not exist."), { name: "RestError", code: "BlobNotFound" }))

        await expect(new AzureStorageClient(SHARED_KEY).downloadFileStream("site/missing.html")).rejects.toBeInstanceOf(EntityNotFoundError)
    })

    it("given the SDK rejects with nothing, when the file is downloaded, then the caller still gets a download error", async () => {
        blob.download.mockRejectedValue(undefined)

        await expect(new AzureStorageClient(SHARED_KEY).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from Azure: undefined")
    })

    it("given Azure denies the read, when the file is downloaded, then the error is not a not-found one and the Azure error is its cause", async () => {
        const denied = restError("This request is not authorized to perform this operation.", 403, "AuthorizationFailure")
        blob.download.mockRejectedValue(denied)

        const error = await new AzureStorageClient(AAD).downloadFileStream("site/index.html").catch((thrown: unknown) => thrown)

        expect(error).not.toBeInstanceOf(EntityNotFoundError)
        expect(error).toHaveProperty("cause", denied)
    })
})
