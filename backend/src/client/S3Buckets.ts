import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, PutObjectCommandInput, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Readable } from "stream"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"

export interface S3ClientConfig {
    region: string
    accessKeyId: string
    secretAccessKey: string
    bucketName: string
}

export class S3BucketClient {
    private readonly s3Client: S3Client
    private readonly bucketName: string

    constructor(config: S3ClientConfig) {
        this.bucketName = config.bucketName

        this.s3Client = new S3Client({
            region: config.region,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            }
        })
    }

    /**
     * Uploads a file to the specified S3 path
     * @param filePath The path (including filename) where the file should be stored in the bucket
     * @param fileContent The file content as a Buffer, string, or Readable stream
     * @param contentType The MIME type of the file (optional)
     * @returns The URL of the uploaded file
     */
    public async uploadFile(filePath: string, fileContent: Buffer | string | Readable, contentType?: string): Promise<string> {
        const params: PutObjectCommandInput = {
            Bucket: this.bucketName,
            Key: filePath,
            Body: fileContent
        }

        if (contentType) {
            params.ContentType = contentType
        }

        const command = new PutObjectCommand(params)

        try {
            await this.s3Client.send(command)
            return `https://${this.bucketName}.s3.amazonaws.com/${encodeURIComponent(filePath)}`
        } catch (error: unknown) {
            console.error("Error uploading file to S3:", error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to upload file to S3: ${errorMessage}`, { cause: error })
        }
    }

    /**
     * Generates a pre-signed URL for direct uploads from the client
     * @param filePath The path (including filename) where the file will be stored
     * @param expiresIn URL expiration time in seconds (default: 3600 - 1 hour)
     * @returns A pre-signed URL for direct uploads
     */
    public async getPresignedUploadUrl(filePath: string, expiresIn = 3600): Promise<string> {
        const command = new PutObjectCommand({
            Bucket: this.bucketName,
            Key: filePath
        })

        try {
            return await getSignedUrl(this.s3Client, command, { expiresIn })
        } catch (error: unknown) {
            console.error("Error generating pre-signed URL:", error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to generate pre-signed URL: ${errorMessage}`, { cause: error })
        }
    }

    /**
     * Deletes a file from the bucket
     * @param filePath The path to the file to delete
     */
    public async deleteFile(filePath: string): Promise<void> {
        try {
            await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: filePath }))
        } catch (error: unknown) {
            console.error("Error deleting file from S3:", error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to delete file from S3: ${errorMessage}`, { cause: error })
        }
    }

    /**
     * Downloads a file as a readable stream
     * @param filePath The path to the file to download
     * @returns A readable stream of the file content
     */
    public async downloadFileStream(filePath: string): Promise<Readable> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: filePath
        })

        try {
            const response = await this.s3Client.send(command)
            if (!response.Body) {
                throw new Error("No body in S3 response")
            }
            return response.Body as Readable
        } catch (error: unknown) {
            console.error("Error downloading file from S3:", error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            const message = `Failed to download file from S3: ${errorMessage}`
            // A missing key is a 404 to whoever asked for the file. A missing bucket, NoSuchBucket, is a 404 from
            // S3 too but a broken storage, which fails every file: it stays a server error
            const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } }
            if (name === "NoSuchKey" || (name === "NotFound" && $metadata?.httpStatusCode === 404)) {
                // Its message reaches anonymous callers of the serve URLs: the S3 one stays in the cause and the log
                throw new EntityNotFoundError(filePath, "File not found", { cause: error })
            }
            throw new Error(message, { cause: error })
        }
    }
}

export default S3BucketClient
