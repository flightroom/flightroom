import axios from "axios"
import fs from "fs"
import path from "path"
import Stream from "stream"
import { fastify } from "../.."
import AzureStorageClient from "../../client/AzureStorageAccount"
import GoogleStorageClient from "../../client/GoogleStorageAccount"
import S3BucketClient from "../../client/S3Buckets"
import { IProject } from "../../models/ProjectModel"
import { IStorage, StorageType } from "../../models/StorageModel"

/** A file of a frontend hosted by the orchestrator, read from the folder its version was deployed to */
export const getFrontendStreamLocal = (project: IProject, frontendSlug: string, version: string, filePath: string): Stream => {
    const basePath = path.join(fastify.config.MICROFRONTEND_HOST_FOLDER, project.slug + "-" + project._id.toString(), frontendSlug, version)
    if (!fs.existsSync(basePath)) {
        throw new Error("Frontend file not found in path " + basePath)
    }

    // Confine the requested file to basePath: `filePath` is the attacker-controlled `*` route param,
    // which the router delivers percent-decoded (so `..%2f` arrives as `../`). Without this check a
    // traversal would read any file the process can, the pod service-account token included.
    const root = path.resolve(basePath)
    const finalPath = path.resolve(root, filePath)
    if (finalPath !== root && !finalPath.startsWith(root + path.sep)) {
        throw new Error("File not found for path: " + filePath)
    }

    if (!fs.existsSync(finalPath)) {
        throw new Error("File not found for path: " + finalPath)
    }

    return fs.createReadStream(finalPath)
}

/** A file of a frontend hosted at a custom url, whose placeholders take the version, the frontend and the project */
export const getFrontendStreamCustomUrl = async (project: IProject, frontendSlug: string, version: string, filePath: string, baseUrl: string): Promise<Stream> => {
    let finalPath = path.join(baseUrl, filePath)

    finalPath = finalPath.replace("$version", version)
    finalPath = finalPath.replace("$microfrontendSlug", frontendSlug)
    finalPath = finalPath.replace("$projectId", project._id.toString())
    finalPath = finalPath.replace("$projectSlug", project.slug)

    const response = await axios.get(finalPath, { responseType: "stream" })
    return response.data
}

/** A file of a frontend uploaded to a storage of the project, under the folder of the project, the frontend and the version */
export const getFrontendStreamStorage = async (project: IProject, frontendSlug: string, version: string, filePath: string, storage: IStorage): Promise<Stream> => {
    const storagePath = storage.path || ""
    const basePathInStorage = path.join(storagePath, `${project.slug}-${project._id.toString()}`, frontendSlug, version)
    // Confine to the frontend's own prefix: `filePath` is attacker-controlled and `path.join`
    // collapses `..`, which could otherwise reach another project's objects in a shared bucket.
    let finalPath = path.join(basePathInStorage, filePath)
    if (finalPath !== basePathInStorage && !finalPath.startsWith(basePathInStorage + path.sep)) {
        throw new Error("File not found for path: " + filePath)
    }
    if (finalPath.startsWith("/")) {
        finalPath = finalPath.substring(1)
    }

    switch (storage.type) {
        case StorageType.AZURE: {
            const client = new AzureStorageClient(storage.authConfig)
            return (await client.downloadFileStream(finalPath)) as unknown as Stream
        }
        case StorageType.AWS: {
            const client = new S3BucketClient(storage.authConfig)
            return (await client.downloadFileStream(finalPath)) as unknown as Stream
        }
        case StorageType.GOOGLE: {
            const client = new GoogleStorageClient(storage.authConfig)
            return client.downloadFileStream(finalPath) as unknown as Stream
        }
    }
}
