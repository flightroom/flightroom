import AdmZip from "adm-zip"
import axios from "axios"
import fs from "fs-extra"
import { tmpdir } from "os"
import path, { join } from "path"
import { fastify } from "../.."

/** Whether `target` really is inside `root`, symlinks followed; false when it does not exist */
export const isInside = async (root: string, target: string): Promise<boolean> => {
    try {
        const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(target)])
        return real === realRoot || real.startsWith(realRoot + path.sep)
    } catch {
        return false
    }
}

/** Whether `dir` holds at least one regular file, at any depth; symlinks do not count */
export const hasRegularFile = async (dir: string): Promise<boolean> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
        if (entry.isFile() || (entry.isDirectory() && (await hasRegularFile(join(dir, entry.name))))) return true
    }
    return false
}

/**
 * Deletes every symlink under `dir`. isomorphic-git checks them out as real links, and a pipeline templates
 * repository could commit one to any file of the server, which the copy would then push to the new repository.
 */
export const removeSymlinks = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isSymbolicLink()) await fs.unlink(full)
        else if (entry.isDirectory() && entry.name !== ".git") await removeSymlinks(full)
    }
}

/** Downloads the zip at `url` and extracts it into a new temporary folder named after `prefix`, which it returns */
export const downloadAndExtractZip = async (prefix: string, url: string): Promise<string> => {
    const responseDownload = await axios.get(url, {
        responseType: "arraybuffer"
    })
    if (responseDownload.status !== 200) throw new Error(`Failed to download pipelines: ${responseDownload.statusText}`)

    // On Node axios already hands a Buffer back: wrapped again it would be copied, the whole archive held twice
    const zip = new AdmZip(Buffer.isBuffer(responseDownload.data) ? responseDownload.data : Buffer.from(responseDownload.data))
    // Its own folder: two scaffolds at once never share one, nor delete each other's
    const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), `${prefix}-`))
    // Keep the permissions: an executable such as mvnw must stay executable in the commit
    zip.extractAllTo(temporaryDirectory, true, true)

    return temporaryDirectory
}

/** A provider zip holds a single top-level folder (`<repo>-main/`): its content moves up to the root */
export const flattenTemplate = async (tempDir: string): Promise<void> => {
    let files = await fs.readdir(tempDir)
    files = files.filter(f => !f.startsWith(".")) // Ignore hidden files

    if (files.length === 1) {
        const top = join(tempDir, files[0])
        const stat = await fs.lstat(top)
        if (stat.isDirectory()) {
            const items = await fs.readdir(top)
            for (const item of items) {
                try {
                    await fs.move(join(top, item), join(tempDir, item), {
                        overwrite: true
                    })
                } catch (err) {
                    console.error(`Error moving ${item}:`, err)
                }
            }
            try {
                await fs.remove(top)
            } catch (err) {
                console.error(`Error removing top-level folder:`, err)
            }
        }
    }
}

/**
 * Ends the line of a template's bundler config that holds the module federation name, e.g.
 * `name: 'exampleremote', // mfe-orchestrator:federation-name`. The template keeps a valid name of
 * its own, so it builds as it is, and the scaffolder swaps that string for the frontend's.
 */
const FEDERATION_NAME_MARKER = "mfe-orchestrator:federation-name"

/** The bundler configs that carry the marker: webpack names its container with it, Vite does not need one */
const FEDERATION_NAME_FILES = ["webpack.config.ts", "webpack.config.js", "webpack.config.mjs", "webpack.config.cjs"]

/**
 * Replaces the first string literal of every line carrying {@link FEDERATION_NAME_MARKER} with
 * `name`, keeping its quotes. A host the console configured loads the remote by that name, so it
 * has to be the same `federationName` the console derives from the slug.
 */
export const replaceFederationName = (content: string, name: string): string =>
    content
        .split("\n")
        .map(line => (line.includes(FEDERATION_NAME_MARKER) ? line.replace(/(['"`])[^'"`]*\1/, (_, quote) => `${quote}${name}${quote}`) : line))
        .join("\n")

/** Writes `name` on the marked federation name line of each webpack config at the root of the template */
export const replaceFederationNameInConfigs = async (directory: string, name: string): Promise<void> => {
    for (const file of FEDERATION_NAME_FILES) {
        const filePath = join(directory, file)
        if (!(await fs.pathExists(filePath))) continue

        const content = await fs.readFile(filePath, "utf8")
        const updatedContent = replaceFederationName(content, name)
        if (content !== updatedContent) {
            await fs.writeFile(filePath, updatedContent, "utf8")
            fastify.log.info(`✅ Federation name set to ${name} in ${file}`)
        }
    }
}

/** Replaces each placeholder with its value in `filePath`, unless it is binary (any NUL byte) */
export const replacePlaceholdersInFile = async (filePath: string, placeholders: Record<string, string>): Promise<void> => {
    try {
        const buffer = await fs.readFile(filePath)
        if (buffer.includes(0)) return

        const content = buffer.toString("utf8")
        let updatedContent = content
        for (const [placeholder, value] of Object.entries(placeholders)) {
            updatedContent = updatedContent.split(placeholder).join(value)
        }

        if (content !== updatedContent) {
            await fs.writeFile(filePath, updatedContent, "utf8")
            fastify.log.info(`✅ Replaced placeholders in ${filePath}`)
        }
    } catch (error) {
        // Skip files that can't be read
        fastify.log.debug(`Skipping file ${filePath}: ${error}`)
    }
}

/**
 * Replaces each placeholder with its value in every text file under `directory`. The `.git`
 * folder is never entered, and binary files (any NUL byte) are left alone.
 */
export const replacePlaceholdersInDirectory = async (directory: string, placeholders: Record<string, string>): Promise<void> => {
    for (const item of await fs.readdir(directory)) {
        const fullPath = path.join(directory, item)
        const stats = await fs.lstat(fullPath)

        if (stats.isDirectory()) {
            if (item !== ".git") {
                await replacePlaceholdersInDirectory(fullPath, placeholders)
            }
        } else if (stats.isFile()) {
            await replacePlaceholdersInFile(fullPath, placeholders)
        }
    }
}
