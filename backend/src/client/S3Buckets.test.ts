import { Readable } from "stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => {
    /** Every command keeps the input it was built with, which is what S3 would receive */
    class FakeCommand<Input> {
        constructor(readonly input: Input) {}
    }
    return {
        send: vi.fn(),
        getSignedUrl: vi.fn(),
        PutObjectCommand: class PutObjectCommand extends FakeCommand<Record<string, unknown>> {},
        GetObjectCommand: class GetObjectCommand extends FakeCommand<Record<string, unknown>> {},
        DeleteObjectCommand: class DeleteObjectCommand extends FakeCommand<Record<string, unknown>> {}
    }
})

vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: vi.fn(function () {
        return { send: sdk.send }
    }),
    PutObjectCommand: sdk.PutObjectCommand,
    GetObjectCommand: sdk.GetObjectCommand,
    DeleteObjectCommand: sdk.DeleteObjectCommand
}))

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: sdk.getSignedUrl }))

import { S3Client } from "@aws-sdk/client-s3"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import S3BucketClient, { S3ClientConfig } from "./S3Buckets"

const CONFIG: S3ClientConfig = { region: "eu-south-1", accessKeyId: "AKIA-EXAMPLE", secretAccessKey: "not-a-real-secret", bucketName: "assets-bucket" }

/** The single command the client sent to S3 */
const sentCommand = () => {
    expect(sdk.send).toHaveBeenCalledTimes(1)
    return sdk.send.mock.calls[0][0] as { input: Record<string, unknown> }
}

const textOf = async (stream: Readable): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString("utf8")
}

/** What S3 rejects with: the SDK error name and message, plus the HTTP status in $metadata */
const s3Error = (name: string, message: string, httpStatusCode: number) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode } })

beforeEach(() => {
    sdk.send.mockReset()
    sdk.getSignedUrl.mockReset()
    vi.mocked(S3Client).mockClear()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("S3BucketClient, construction", () => {
    it("given a stored configuration, when the client is built, then the SDK client gets its region and static credentials", () => {
        new S3BucketClient(CONFIG)

        expect(S3Client).toHaveBeenCalledTimes(1)
        expect(S3Client).toHaveBeenCalledWith({ region: "eu-south-1", credentials: { accessKeyId: "AKIA-EXAMPLE", secretAccessKey: "not-a-real-secret" } })
    })

    it("given a stored configuration, when the client is built, then the bucket name is not handed to the SDK client", () => {
        new S3BucketClient(CONFIG)

        expect(vi.mocked(S3Client).mock.calls[0][0]).not.toHaveProperty("bucketName")
    })
})

describe("S3BucketClient.uploadFile", () => {
    it("given a content type, when a file is uploaded, then a PutObject goes to the bucket with the key, the body and the content type", async () => {
        sdk.send.mockResolvedValue({})

        await new S3BucketClient(CONFIG).uploadFile("site/index.html", "<html></html>", "text/html")

        const command = sentCommand()
        expect(command).toBeInstanceOf(sdk.PutObjectCommand)
        expect(command.input).toEqual({ Bucket: "assets-bucket", Key: "site/index.html", Body: "<html></html>", ContentType: "text/html" })
    })

    it("given no content type, when a file is uploaded, then the PutObject leaves ContentType out for S3 to default", async () => {
        sdk.send.mockResolvedValue({})

        await new S3BucketClient(CONFIG).uploadFile("site/app.js", Buffer.from("x"))

        expect(sentCommand().input).not.toHaveProperty("ContentType")
    })

    it("given a stream, when a file is uploaded, then the stream itself is the body of the PutObject", async () => {
        sdk.send.mockResolvedValue({})
        const body = Readable.from(["chunk"])

        await new S3BucketClient(CONFIG).uploadFile("site/app.js", body, "text/javascript")

        expect(sentCommand().input.Body).toBe(body)
    })

    it("given the upload succeeds, when the URL is returned, then it names the bucket and the file", async () => {
        sdk.send.mockResolvedValue({})

        const url = await new S3BucketClient(CONFIG).uploadFile("site/index.html", "x", "text/html")

        expect(url).toContain("assets-bucket")
        expect(url).toContain("index.html")
    })

    it("given S3 denies the write, when a file is uploaded, then the caller gets an upload error carrying the S3 message", async () => {
        sdk.send.mockRejectedValue(s3Error("AccessDenied", "Access Denied", 403))

        await expect(new S3BucketClient(CONFIG).uploadFile("site/index.html", "x")).rejects.toThrow("Failed to upload file to S3: Access Denied")
    })

    it("given the SDK rejects with something that is not an Error, when a file is uploaded, then its string form is in the message", async () => {
        sdk.send.mockRejectedValue("socket hang up")

        await expect(new S3BucketClient(CONFIG).uploadFile("site/index.html", "x")).rejects.toThrow("Failed to upload file to S3: socket hang up")
    })

    it("given S3 rejects, when a file is uploaded, then the S3 error is kept as the cause, with its name and HTTP status", async () => {
        const denied = s3Error("AccessDenied", "Access Denied", 403)
        sdk.send.mockRejectedValue(denied)

        await expect(new S3BucketClient(CONFIG).uploadFile("site/index.html", "x")).rejects.toHaveProperty("cause", denied)
    })
})

describe("S3BucketClient.getPresignedUploadUrl", () => {
    it("given no expiry, when an upload URL is presigned, then it signs a PutObject on the bucket and key for 3600 seconds", async () => {
        sdk.getSignedUrl.mockResolvedValue("https://signed.example/put")

        const url = await new S3BucketClient(CONFIG).getPresignedUploadUrl("site/index.html")

        expect(url).toBe("https://signed.example/put")
        expect(sdk.getSignedUrl).toHaveBeenCalledTimes(1)
        const [client, command, options] = sdk.getSignedUrl.mock.calls[0]
        expect(client).toBe(vi.mocked(S3Client).mock.results[0].value)
        expect(command).toBeInstanceOf(sdk.PutObjectCommand)
        expect(command.input).toEqual({ Bucket: "assets-bucket", Key: "site/index.html" })
        expect(options).toEqual({ expiresIn: 3600 })
    })

    it("given an expiry in seconds, when an upload URL is presigned, then the presigner gets the same number of seconds", async () => {
        sdk.getSignedUrl.mockResolvedValue("https://signed.example/put")

        await new S3BucketClient(CONFIG).getPresignedUploadUrl("site/index.html", 600)

        expect(sdk.getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 600 })
    })

    it("given an upload URL is presigned, when it is built, then nothing is sent to S3", async () => {
        sdk.getSignedUrl.mockResolvedValue("https://signed.example/put")

        await new S3BucketClient(CONFIG).getPresignedUploadUrl("site/index.html")

        expect(sdk.send).not.toHaveBeenCalled()
    })

    it("given the presigner fails, when an upload URL is presigned, then the caller gets a presign error carrying its message", async () => {
        sdk.getSignedUrl.mockRejectedValue(new Error("expiresIn must be at most 604800"))

        await expect(new S3BucketClient(CONFIG).getPresignedUploadUrl("site/index.html", 700000)).rejects.toThrow("Failed to generate pre-signed URL: expiresIn must be at most 604800")
    })

    it("given the presigner rejects with something that is not an Error, when an upload URL is presigned, then its string form is in the message", async () => {
        sdk.getSignedUrl.mockRejectedValue(42)

        await expect(new S3BucketClient(CONFIG).getPresignedUploadUrl("site/index.html")).rejects.toThrow("Failed to generate pre-signed URL: 42")
    })

    it("given the presigner fails, when an upload URL is presigned, then its error is kept as the cause", async () => {
        const failure = new Error("Credential is missing")
        sdk.getSignedUrl.mockRejectedValue(failure)

        await expect(new S3BucketClient(CONFIG).getPresignedUploadUrl("site/index.html")).rejects.toHaveProperty("cause", failure)
    })
})

describe("S3BucketClient.deleteFile", () => {
    it("given a key, when the file is deleted, then a DeleteObject goes to the bucket with that key", async () => {
        sdk.send.mockResolvedValue({})

        await expect(new S3BucketClient(CONFIG).deleteFile("site/.flightroom-connection-test")).resolves.toBeUndefined()

        const command = sentCommand()
        expect(command).toBeInstanceOf(sdk.DeleteObjectCommand)
        expect(command.input).toEqual({ Bucket: "assets-bucket", Key: "site/.flightroom-connection-test" })
    })

    it("given S3 denies the delete, when the file is deleted, then the caller gets a delete error carrying the S3 message", async () => {
        sdk.send.mockRejectedValue(s3Error("AccessDenied", "Access Denied", 403))

        await expect(new S3BucketClient(CONFIG).deleteFile("site/index.html")).rejects.toThrow("Failed to delete file from S3: Access Denied")
    })

    it("given the SDK rejects with something that is not an Error, when the file is deleted, then its string form is in the message", async () => {
        sdk.send.mockRejectedValue("timeout")

        await expect(new S3BucketClient(CONFIG).deleteFile("site/index.html")).rejects.toThrow("Failed to delete file from S3: timeout")
    })

    it("given S3 rejects, when the file is deleted, then the S3 error is kept as the cause", async () => {
        const denied = s3Error("AccessDenied", "Access Denied", 403)
        sdk.send.mockRejectedValue(denied)

        await expect(new S3BucketClient(CONFIG).deleteFile("site/index.html")).rejects.toHaveProperty("cause", denied)
    })
})

describe("S3BucketClient.downloadFileStream", () => {
    it("given a key, when the file is downloaded, then a GetObject goes to the bucket with that key", async () => {
        sdk.send.mockResolvedValue({ Body: Readable.from([]) })

        await new S3BucketClient(CONFIG).downloadFileStream("site/index.html")

        const command = sentCommand()
        expect(command).toBeInstanceOf(sdk.GetObjectCommand)
        expect(command.input).toEqual({ Bucket: "assets-bucket", Key: "site/index.html" })
    })

    it("given S3 returns a body, when the file is downloaded, then the caller reads the object content from the returned stream", async () => {
        const body = Readable.from([Buffer.from("<html>"), Buffer.from("</html>")])
        sdk.send.mockResolvedValue({ Body: body })

        const stream = await new S3BucketClient(CONFIG).downloadFileStream("site/index.html")

        expect(stream).toBe(body)
        expect(await textOf(stream)).toBe("<html></html>")
    })

    it("given S3 answers without a body, when the file is downloaded, then the caller gets a download error saying so", async () => {
        sdk.send.mockResolvedValue({})

        await expect(new S3BucketClient(CONFIG).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from S3: No body in S3 response")
    })

    it("given the key does not exist, when the file is downloaded, then the caller gets a download error carrying the S3 message", async () => {
        sdk.send.mockRejectedValue(s3Error("NoSuchKey", "The specified key does not exist.", 404))

        await expect(new S3BucketClient(CONFIG).downloadFileStream("site/missing.html")).rejects.toThrow("Failed to download file from S3: The specified key does not exist.")
    })

    it("given S3 denies the read, when the file is downloaded, then the caller gets a download error carrying the S3 message", async () => {
        sdk.send.mockRejectedValue(s3Error("AccessDenied", "Access Denied", 403))

        await expect(new S3BucketClient(CONFIG).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from S3: Access Denied")
    })

    it("given the SDK rejects with something that is not an Error, when the file is downloaded, then its string form is in the message", async () => {
        sdk.send.mockRejectedValue("ECONNRESET")

        await expect(new S3BucketClient(CONFIG).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from S3: ECONNRESET")
    })

    it("given the key does not exist, when the file is downloaded, then the error is a not-found one answering 404, with the S3 error as its cause", async () => {
        const missing = s3Error("NoSuchKey", "The specified key does not exist.", 404)
        sdk.send.mockRejectedValue(missing)

        const error = await new S3BucketClient(CONFIG).downloadFileStream("site/missing.html").catch((thrown: unknown) => thrown)

        expect(error).toBeInstanceOf(EntityNotFoundError)
        expect(error).toMatchObject({ statusCode: 404, message: "Failed to download file from S3: The specified key does not exist.", cause: missing })
        // Set the way new Error(message, { cause }) sets it: kept, but not an own enumerable key logged or serialized with the error
        expect(Object.getOwnPropertyDescriptor(error, "cause")).toMatchObject({ enumerable: false })
    })

    it("given S3 answers 404 under another name, when the file is downloaded, then the error is still a not-found one", async () => {
        // A GetObject on a missing key can come back as a bare NotFound when the response has no XML body
        sdk.send.mockRejectedValue(s3Error("NotFound", "UnknownError", 404))

        await expect(new S3BucketClient(CONFIG).downloadFileStream("site/missing.html")).rejects.toBeInstanceOf(EntityNotFoundError)
    })

    it("given the SDK rejects with nothing, when the file is downloaded, then the caller still gets a download error", async () => {
        sdk.send.mockRejectedValue(undefined)

        await expect(new S3BucketClient(CONFIG).downloadFileStream("site/index.html")).rejects.toThrow("Failed to download file from S3: undefined")
    })

    it("given S3 denies the read, when the file is downloaded, then the error is not a not-found one and the S3 error is its cause", async () => {
        const denied = s3Error("AccessDenied", "Access Denied", 403)
        sdk.send.mockRejectedValue(denied)

        const error = await new S3BucketClient(CONFIG).downloadFileStream("site/index.html").catch((thrown: unknown) => thrown)

        expect(error).not.toBeInstanceOf(EntityNotFoundError)
        expect(error).toHaveProperty("cause", denied)
    })
})
