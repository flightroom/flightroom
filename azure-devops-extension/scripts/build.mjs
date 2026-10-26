import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const tasks = [
    { name: "upload-microfrontend", entry: "src/uploadMicrofrontend.ts" },
    { name: "register-docker-image", entry: "src/registerDockerImage.ts" }
]

await rm(dist, { recursive: true, force: true })

for (const task of tasks) {
    const output = path.join(dist, "tasks", task.name)
    await mkdir(output, { recursive: true })
    await cp(path.join(root, "tasks", task.name, "task.json"), path.join(output, "task.json"))
    await build({
        entryPoints: [path.join(root, task.entry)],
        bundle: true,
        platform: "node",
        target: "node20",
        format: "cjs",
        outfile: path.join(output, "index.js")
    })
}

await cp(path.join(root, "overview.md"), path.join(dist, "overview.md"))
