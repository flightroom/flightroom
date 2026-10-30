import { ClientSecretCredential } from "@azure/identity"
import { BlobServiceClient, BlockBlobUploadOptions, StorageSharedKeyCredential } from "@azure/storage-blob"
import { Readable } from "stream"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"

type AuthConfig =
    | {
          authType: "connectionString"
          connectionString: string
      }
    | {
          authType: "sharedKey"
          accountName: string
          accountKey: string
      }
    | {
          authType: "aad"
          accountName: string
          tenantId: string
          clientId: string
          clientSecret: string
      }

export type AzureStorageConfig = AuthConfig & {
    containerName: string
}

export class AzureStorageClient {
    private readonly blobServiceClient: BlobServiceClient
    private readonly containerName: string

    constructor(config: AzureStorageConfig) {
        this.containerName = config.containerName

        switch (config.authType) {
            case "connectionString": {
                this.blobServiceClient = BlobServiceClient.fromConnectionString(config.connectionString)
                break
            }

            case "sharedKey": {
                const sharedKeyCredential = new StorageSharedKeyCredential(config.accountName, config.accountKey)
                this.blobServiceClient = new BlobServiceClient(`https://${config.accountName}.blob.core.windows.net`, sharedKeyCredential)
                break
            }

            case "aad": {
                const credential = new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret)
                this.blobServiceClient = new BlobServiceClient(`https://${config.accountName}.blob.core.windows.net`, credential)
                break
            }

            default:
                throw new Error("Invalid authentication configuration")
        }
    }

    /** Where the requests go, as resolved from the account name or the connection string */
    public get endpoint(): string {
        return this.blobServiceClient.url
    }

    /**
     * Uploads a file to Azure Blob Storage
     * @param filePath The path (including filename) where the file should be stored in the container
     * @param fileContent The file content as a Buffer, string, or Readable stream
     * @param contentType The MIME type of the file (optional)
     * @returns The URL of the uploaded blob
     */
    public async uploadFile(filePath: string, fileContent: Buffer | string | Readable, contentType: string = "application/octet-stream"): Promise<string> {
        const containerClient = this.blobServiceClient.getContainerClient(this.containerName)
        const blockBlobClient = containerClient.getBlockBlobClient(filePath)

        const options: BlockBlobUploadOptions = {
            blobHTTPHeaders: { blobContentType: contentType }
        }

        try {
            // upload needs the length up front, which a stream does not have: it goes up in blocks instead
            if (fileContent instanceof Readable) {
                await blockBlobClient.uploadStream(fileContent, undefined, undefined, options)
            } else {
                await blockBlobClient.upload(fileContent, Buffer.byteLength(fileContent), options)
            }
            return blockBlobClient.url
        } catch (error: unknown) {
            console.error("Error uploading file to Azure Blob Storage:", error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to upload file to Azure: ${errorMessage}`, { cause: error })
        }
    }

    /**
     * Deletes a blob from the container
     * @param filePath The path to the blob to delete
     */
    public async deleteFile(filePath: string): Promise<void> {
        const containerClient = this.blobServiceClient.getContainerClient(this.containerName)
        const blockBlobClient = containerClient.getBlockBlobClient(filePath)

        try {
            await blockBlobClient.delete()
        } catch (error: unknown) {
            console.error("Error deleting file from Azure Blob Storage:", error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to delete file from Azure: ${errorMessage}`, { cause: error })
        }
    }

    /**
     * Downloads a blob as a readable stream
     * @param filePath The path to the blob to download
     * @returns A readable stream of the blob content
     */
    public async downloadFileStream(filePath: string): Promise<Readable> {
        const containerClient = this.blobServiceClient.getContainerClient(this.containerName)
        const blockBlobClient = containerClient.getBlockBlobClient(filePath)

        try {
            const downloadResponse = await blockBlobClient.download()
            if (!downloadResponse.readableStreamBody) {
                throw new Error("No readable stream in download response")
            }
            return downloadResponse.readableStreamBody as Readable
        } catch (error: unknown) {
            console.error("Error downloading file from Azure Blob Storage:", error)
            const errorMessage = error instanceof Error ? error.message : String(error)
            const message = `Failed to download file from Azure: ${errorMessage}`
            // A missing blob is a 404 to whoever asked for the file. A missing container, ContainerNotFound, is a
            // 404 from Azure too but a broken storage, which fails every file: it stays a server error
            const { code } = (error ?? {}) as { code?: string }
            if (code === "BlobNotFound") {
                // Its message reaches anonymous callers of the serve URLs: the Azure one stays in the cause and the log
                throw new EntityNotFoundError(filePath, "File not found", { cause: error })
            }
            throw new Error(message, { cause: error })
        }
    }
}

export default AzureStorageClient
