import { EventEmitter } from "events"
import { Readable, Writable } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => {
    const file = { createWriteStream: vi.fn(), getSignedUrl: vi.fn(), delete: vi.fn(), createReadStream: vi.fn() }
    const bucket = { file: vi.fn(() => file) }
    return { file, bucket }
})

vi.mock("@google-cloud/storage", () => ({
    Storage: vi.fn(function () {
        return { bucket: vi.fn(() => sdk.bucket) }
    })
}))

import { Storage } from "@google-cloud/storage"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import GoogleStorageClient, { GoogleStorageConfig } from "./GoogleStorageAccount"

const SERVICE_ACCOUNT_KEY = {
    type: "service_account",
    project_id: "flightroom-test",
    private_key_id: "key-1",
    private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
    client_email: "uploader@flightroom-test.iam.gserviceaccount.com"
}
const CONFIG: GoogleStorageConfig = { authType: "serviceAccount", jsonKey: JSON.stringify(SERVICE_ACCOUNT_KEY), bucketName: "assets-bucket" }

/** What the GCS client rejects with: an ApiError carries the HTTP status in `code` */
const apiError = (message: string, code: number) => Object.assign(new Error(message), { name: "ApiError", code })

/** A write stream like the one GCS hands out, keeping what was written, or failing once the upload is finished */
const uploadSink = (failWith?: Error) => {
    const chunks: Buffer[] = []
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk))
            callback()
        },
        final(callback) {
            callback(failWith)
        }
    })
    return { stream, written: () => Buffer.concat(chunks).toString("utf8") }
}

/** The storage the client built */
const builtStorage = () => vi.mocked(Storage).mock.results[0].value as { bucket: ReturnType<typeof vi.fn> }

beforeEach(() => {
    vi.mocked(Storage).mockClear()
    sdk.bucket.file.mockClear()
    sdk.file.createWriteStream.mockReset()
    sdk.file.getSignedUrl.mockReset()
    sdk.file.delete.mockReset()
    sdk.file.createReadStream.mockReset()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("GoogleStorageClient, construction", () => {
    it("given a service account key, when the client is built, then the SDK gets only its client email and private key as credentials", () => {
        new GoogleStorageClient(CONFIG)

        expect(Storage).toHaveBeenCalledTimes(1)
        expect(Storage).toHaveBeenCalledWith({ credentials: { client_email: SERVICE_ACCOUNT_KEY.client_email, private_key: SERVICE_ACCOUNT_KEY.private_key } })
    })

    it("given a configured bucket, when the client is built, then it works on that bucket", () => {
        new GoogleStorageClient(CONFIG)

        expect(builtStorage().bucket).toHaveBeenCalledWith("assets-bucket")
    })

    it("given a key that is not valid JSON, when the client is built, then neither the error nor its cause quotes any part of the key", () => {
        // JSON.parse quotes the text around where it stopped, and in a service account key that is the private key
        const secret = "oops-SECRET-PRIVATE-KEY-MATERIAL"
        const broken = { ...CONFIG, jsonKey: `{"type": "service_account", "private_key": ${secret}}` }

        let thrown: unknown
        try {
            new GoogleStorageClient(broken)
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toBe("The Google service account key is not valid JSON")
        const everything = `${(thrown as Error).message} ${(thrown as Error).stack} ${String((thrown as Error).cause)} ${JSON.stringify(thrown)}`
        for (const fragment of ["oops", "SECRET", "PRIVATE-KEY", "MATERIAL", "private_key"]) {
            expect(everything).not.toContain(fragment)
        }
        expect((thrown as Error).cause).toBeUndefined()
        expect(Storage).not.toHaveBeenCalled()
    })

    it("given an unknown authentication type, when the client is built, then it is refused before any SDK client exists", () => {
        const adc = { authType: "applicationDefault", bucketName: "assets-bucket" } as unknown as GoogleStorageConfig

        expect(() => new GoogleStorageClient(adc)).toThrow("Invalid authentication configuration")
        expect(Storage).not.toHaveBeenCalled()
    })
})

describe("GoogleStorageClient.uploadFile", () => {
    it("given a content type, when a file is uploaded, then a non-resumable write stream is opened on that object with the content type", async () => {
        const sink = uploadSink()
        sdk.file.createWriteStream.mockReturnValue(sink.stream)

        await new GoogleStorageClient(CONFIG).uploadFile("site/index.html", "<html></html>", "text/html")

        expect(sdk.bucket.file).toHaveBeenCalledWith("site/index.html")
        expect(sdk.file.createWriteStream).toHaveBeenCalledWith({ metadata: { contentType: "text/html" }, resumable: false })
    })

    it("given no content type, when a file is uploaded, then it is stored as application/octet-stream", async () => {
        sdk.file.createWriteStream.mockReturnValue(uploadSink().stream)

        await new GoogleStorageClient(CONFIG).uploadFile("site/app.js", Buffer.from("x"))

        expect(sdk.file.createWriteStream.mock.calls[0][0].metadata).toEqual({ contentType: "application/octet-stream" })
    })

    it("given a buffer, when a file is uploaded, then its bytes are written to the object", async () => {
        const sink = uploadSink()
        sdk.file.createWriteStream.mockReturnValue(sink.stream)

        await new GoogleStorageClient(CONFIG).uploadFile("site/app.js", Buffer.from("console.log(1)"))

        expect(sink.written()).toBe("console.log(1)")
    })

    it("given a string, when a file is uploaded, then it is written to the object", async () => {
        const sink = uploadSink()
        sdk.file.createWriteStream.mockReturnValue(sink.stream)

        await new GoogleStorageClient(CONFIG).uploadFile("site/it.json", '{"ciao":"è"}', "application/json")

        expect(sink.written()).toBe('{"ciao":"è"}')
    })

    it("given a stream, when a file is uploaded, then everything it yields is piped to the object", async () => {
        const sink = uploadSink()
        sdk.file.createWriteStream.mockReturnValue(sink.stream)

        await new GoogleStorageClient(CONFIG).uploadFile("site/app.js", Readable.from([Buffer.from("first,"), Buffer.from("second")]))

        expect(sink.written()).toBe("first,second")
    })

    it("given the upload finishes, when the URL is returned, then it names the bucket and the file", async () => {
        sdk.file.createWriteStream.mockReturnValue(uploadSink().stream)

        const url = await new GoogleStorageClient(CONFIG).uploadFile("site/index.html", "x", "text/html")

        expect(url).toContain("assets-bucket")
        expect(url).toContain("index.html")
    })

    it("given GCS denies the write, when a file is uploaded, then the caller gets an upload error carrying the GCS message", async () => {
        const denied = apiError("uploader@flightroom-test.iam.gserviceaccount.com does not have storage.objects.create access", 403)
        sdk.file.createWriteStream.mockReturnValue(uploadSink(denied).stream)

        await expect(new GoogleStorageClient(CONFIG).uploadFile("site/index.html", "x")).rejects.toThrow(
            "Failed to upload file: uploader@flightroom-test.iam.gserviceaccount.com does not have storage.objects.create access"
        )
    })

    it("given the source stream fails, when a file is uploaded, then the upload stream is destroyed and the caller gets the source error", async () => {
        const sink = uploadSink()
        sdk.file.createWriteStream.mockReturnValue(sink.stream)
        const failing = new Readable({
            read() {
                this.destroy(new Error("EIO: i/o error, read"))
            }
        })

        await expect(new GoogleStorageClient(CONFIG).uploadFile("site/app.js", failing)).rejects.toThrow("Failed to upload file: EIO: i/o error, read")
        expect(sink.stream.destroyed).toBe(true)
    })

    it("given content that is neither a buffer, a string nor a stream, when it is uploaded, then the caller gets an upload error", async () => {
        sdk.file.createWriteStream.mockReturnValue(uploadSink().stream)

        await expect(new GoogleStorageClient(CONFIG).uploadFile("site/app.js", 42 as unknown as Buffer)).rejects.toThrow("Failed to upload file: Unsupported file content type")
    })

    it("given the write stream fails with something that is not an Error, when a file is uploaded, then its string form is in the message", async () => {
        // Some transports emit plain values: a stream that fails as soon as it is ended
        const stream = Object.assign(new EventEmitter(), { end: vi.fn((): void => void stream.emit("error", "socket hang up")) })
        sdk.file.createWriteStream.mockReturnValue(stream)

        await expect(new GoogleStorageClient(CONFIG).uploadFile("site/app.js", "x")).rejects.toThrow("Failed to upload file: socket hang up")
        expect(stream.end).toHaveBeenCalledWith("x")
    })

    it("given GCS denies the write, when a file is uploaded, then the GCS error is kept as the cause, with its HTTP status", async () => {
        const denied = apiError("uploader@flightroom-test.iam.gserviceaccount.com does not have storage.objects.create access", 403)
        sdk.file.createWriteStream.mockReturnValue(uploadSink(denied).stream)

        await expect(new GoogleStorageClient(CONFIG).uploadFile("site/index.html", "x")).rejects.toHaveProperty("cause", denied)
    })
})

describe("GoogleStorageClient.getSignedUrl", () => {
    const NOW = new Date("2026-10-30T12:00:00.000Z")

    it("given no expiry, when an upload URL is signed, then it is a write URL for octet-stream content expiring in 60 minutes", async () => {
        vi.useFakeTimers({ now: NOW })
        sdk.file.getSignedUrl.mockResolvedValue(["https://signed.example/put"])

        const url = await new GoogleStorageClient(CONFIG).getSignedUrl("site/index.html")

        expect(url).toBe("https://signed.example/put")
        expect(sdk.bucket.file).toHaveBeenCalledWith("site/index.html")
        expect(sdk.file.getSignedUrl).toHaveBeenCalledWith({ action: "write", expires: NOW.getTime() + 60 * 60 * 1000, contentType: "application/octet-stream" })
    })

    it("given an expiry in minutes, when an upload URL is signed, then it expires that many minutes from now", async () => {
        vi.useFakeTimers({ now: NOW })
        sdk.file.getSignedUrl.mockResolvedValue(["https://signed.example/put"])

        await new GoogleStorageClient(CONFIG).getSignedUrl("site/index.html", 15)

        expect(new Date(sdk.file.getSignedUrl.mock.calls[0][0].expires).toISOString()).toBe("2026-10-30T12:15:00.000Z")
    })

    it("given signing fails, when an upload URL is signed, then the caller gets a signing error carrying its message", async () => {
        sdk.file.getSignedUrl.mockRejectedValue(new Error("Cannot sign data without `client_email`."))

        await expect(new GoogleStorageClient(CONFIG).getSignedUrl("site/index.html")).rejects.toThrow("Failed to generate signed URL: Cannot sign data without `client_email`.")
    })

    it("given signing rejects with something that is not an Error, when an upload URL is signed, then its string form is in the message", async () => {
        sdk.file.getSignedUrl.mockRejectedValue("offline")

        await expect(new GoogleStorageClient(CONFIG).getSignedUrl("site/index.html")).rejects.toThrow("Failed to generate signed URL: offline")
    })

    it("given signing fails, when an upload URL is signed, then its error is kept as the cause", async () => {
        const failure = new Error("Cannot sign data without `client_email`.")
        sdk.file.getSignedUrl.mockRejectedValue(failure)

        await expect(new GoogleStorageClient(CONFIG).getSignedUrl("site/index.html")).rejects.toHaveProperty("cause", failure)
    })
})

describe("GoogleStorageClient.deleteFile", () => {
    it("given a path, when the file is deleted, then that object of the bucket is deleted", async () => {
        sdk.file.delete.mockResolvedValue([{}])

        await expect(new GoogleStorageClient(CONFIG).deleteFile("site/.flightroom-connection-test")).resolves.toBeUndefined()

        expect(sdk.bucket.file).toHaveBeenCalledWith("site/.flightroom-connection-test")
        expect(sdk.file.delete).toHaveBeenCalledTimes(1)
    })

    it("given the object does not exist, when the file is deleted, then the caller gets a delete error carrying the GCS message", async () => {
        sdk.file.delete.mockRejectedValue(apiError("No such object: assets-bucket/site/missing.html", 404))

        await expect(new GoogleStorageClient(CONFIG).deleteFile("site/missing.html")).rejects.toThrow("Failed to delete file: No such object: assets-bucket/site/missing.html")
    })

    it("given the SDK rejects with something that is not an Error, when the file is deleted, then its string form is in the message", async () => {
        sdk.file.delete.mockRejectedValue("timeout")

        await expect(new GoogleStorageClient(CONFIG).deleteFile("site/index.html")).rejects.toThrow("Failed to delete file: timeout")
    })

    it("given GCS rejects, when the file is deleted, then the GCS error is kept as the cause", async () => {
        const missing = apiError("No such object: assets-bucket/site/missing.html", 404)
        sdk.file.delete.mockRejectedValue(missing)

        await expect(new GoogleStorageClient(CONFIG).deleteFile("site/missing.html")).rejects.toHaveProperty("cause", missing)
    })
})

describe("GoogleStorageClient.downloadFileStream", () => {
    /** A read stream like the one GCS hands out, failing the way it does once the response comes back */
    const failingRead = (error: Error) =>
        new Readable({
            read() {
                this.destroy(error)
            }
        })

    /** The error the returned stream fails with, once read the way the HTTP response reads it */
    const failureOf = (stream: Readable) => new Promise<unknown>(resolve => stream.on("error", resolve).resume())

    it("given a path, when the file is downloaded, then the read stream of that object is opened", () => {
        sdk.file.createReadStream.mockReturnValue(Readable.from([]))

        new GoogleStorageClient(CONFIG).downloadFileStream("site/index.html")

        expect(sdk.bucket.file).toHaveBeenCalledWith("site/index.html")
        expect(sdk.file.createReadStream).toHaveBeenCalledTimes(1)
    })

    it("given GCS returns the object, when the file is downloaded, then the caller reads its content from the returned stream", async () => {
        sdk.file.createReadStream.mockReturnValue(Readable.from([Buffer.from("<html>"), Buffer.from("</html>")]))

        const stream = new GoogleStorageClient(CONFIG).downloadFileStream("site/index.html")

        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        expect(Buffer.concat(chunks).toString("utf8")).toBe("<html></html>")
    })

    it("given the object does not exist, when the file is downloaded, then the stream fails with a not-found error answering 404, with the GCS error as its cause", async () => {
        const missing = apiError("No such object: assets-bucket/site/missing.html", 404)
        sdk.file.createReadStream.mockReturnValue(failingRead(missing))

        const error = await failureOf(new GoogleStorageClient(CONFIG).downloadFileStream("site/missing.html"))

        expect(error).toBeInstanceOf(EntityNotFoundError)
        expect(error).toMatchObject({ statusCode: 404, message: "Failed to download file: No such object: assets-bucket/site/missing.html", cause: missing })
        // Set the way new Error(message, { cause }) sets it: kept, but not an own enumerable key logged or serialized with the error
        expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({ enumerable: false })
    })

    it("given the bucket does not exist, when the file is downloaded, then the stream fails with the GCS error itself: the storage is misconfigured, the file is not missing", async () => {
        const noBucket = apiError("The specified bucket does not exist.", 404)
        sdk.file.createReadStream.mockReturnValue(failingRead(noBucket))

        await expect(failureOf(new GoogleStorageClient(CONFIG).downloadFileStream("site/index.html"))).resolves.toBe(noBucket)
    })

    it("given GCS denies the read, when the file is downloaded, then the stream fails with the GCS error itself", async () => {
        const denied = apiError("uploader@flightroom-test.iam.gserviceaccount.com does not have storage.objects.get access", 403)
        sdk.file.createReadStream.mockReturnValue(failingRead(denied))

        await expect(failureOf(new GoogleStorageClient(CONFIG).downloadFileStream("site/index.html"))).resolves.toBe(denied)
    })

    it("given the caller stops reading, when the returned stream is destroyed, then the GCS read stream is destroyed too", async () => {
        // Never yields: a download still under way
        const source = new Readable({ read: () => undefined })
        sdk.file.createReadStream.mockReturnValue(source)

        new GoogleStorageClient(CONFIG).downloadFileStream("site/index.html").destroy()

        await new Promise(resolve => source.once("close", resolve))
        expect(source.destroyed).toBe(true)
    })
})
