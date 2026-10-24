import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ZipArchive } from "archiver"
import * as tl from "azure-pipelines-task-lib/task"
import FormData from "form-data"
import fetch from "node-fetch"
import { flightroomApiUrl } from "./flightroomApi.js"

const createZip = async (sourcePath: string, zipPath: string): Promise<void> => {
    const sourceStats = await stat(sourcePath)

    await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(zipPath)
        const archive = new ZipArchive({ zlib: { level: 9 } })
        output.once("close", resolve)
        output.once("error", reject)
        archive.once("error", reject)
        archive.pipe(output)

        if (sourceStats.isDirectory()) {
            archive.directory(sourcePath, false)
        } else {
            archive.file(sourcePath, { name: path.basename(sourcePath) })
        }

        void archive.finalize().catch(reject)
    })
}

export async function run(): Promise<void> {
    try {
        const apiKey = tl.getInput("apiKey", true)!
        const microfrontendSlug = tl.getInput("microfrontendSlug", true)!
        const domain = tl.getInput("domain", true)!
        const filePath = tl.getPathInput("filePath", true)!
        const version = tl.getInput("version", true)!

        if (!existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`)
        }

        const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "flightroom-upload-"))
        const zipPath = path.join(tempDirectory, "bundle.zip")
        try {
            await createZip(filePath, zipPath)

            const form = new FormData()
            form.append("file", createReadStream(zipPath))
            const endpoint = `frontends/by-slug/${encodeURIComponent(microfrontendSlug)}/upload/${encodeURIComponent(version)}`
            const response = await fetch(flightroomApiUrl(domain, endpoint), {
                method: "POST",
                headers: { ...form.getHeaders(), "api-key": apiKey, Accept: "application/json" },
                body: form
            })

            if (!response.ok) {
                const details = await response.text()
                throw new Error(`Upload failed: ${response.status} ${response.statusText}${details ? ` - ${details}` : ""}`)
            }
        } finally {
            await rm(tempDirectory, { recursive: true, force: true })
        }

        tl.setResult(tl.TaskResult.Succeeded, "Frontend bundle uploaded successfully")
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, error instanceof Error ? error.message : String(error))
    }
}

void run()
