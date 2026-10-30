import fs from "node:fs/promises"
import path from "node:path"
import { isLockfilePath, isProtectedPath, isSecretPath, resolveInsideWorkingCopy, WorkspacePathError } from "../../utils/workspacePaths"
import { LlmTool } from "../llm"
import { CommandSandbox } from "../sandbox/commandSandbox"
import { GitWorkingCopy } from "../workspace/GitWorkingCopy"
import { AiChangeRepositoryMap, AiChangeToolboxChange } from "./aiChangeAgentTypes"
import { decodeStart, describeLayout, linesHolding, linesOf, looksBinary, matchingLines, normalizeFolder, underPrefix, withoutLeadingSlash } from "./aiChangeFiles"
import { AI_CHANGE_LIMITS, agentLimitsFor, REPOSITORY_MAP_PATH } from "./aiChangeLimits"
import { AiChangeScriptRunner, BUILD_SCRIPT, runScriptTool, ScriptRun } from "./aiChangeScripts"
import { readCount, readString, toolsFor } from "./aiChangeTools"

/** Instructions a team writes for coding agents, the first one found shown in the repository map. */
const AGENT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"]

/** Files search reads ahead of the one it looks into: the disk works while the earlier ones are searched. */
const SEARCH_READ_AHEAD = 16

/** A working copy of the toolbox, under the slug its paths start with when the job has more than one. */
export interface AiChangeToolboxRepository {
    slug: string
    kind?: "frontend" | "backend"
    framework?: string
    runtime?: string
    port?: number
    workingCopy: GitWorkingCopy
    previousChanges?: AiChangeToolboxChange[]
    /** The .npmrc its install runs with in the sandbox, credentials included: never written into the working copy. */
    npmrc?: string
}

/**
 * The tools of one run, bound to the working copies of its repositories. Every path goes through
 * {@link resolveInsideWorkingCopy}: no `..`, no absolute path, no `.git`, no symlink out.
 *
 * With one repository paths are relative to its root. With more, a path starts with the slug of
 * its repository, which is stripped before anything touches the disk.
 */
export class AiChangeToolbox {
    /** Paths written or deleted, per repository. */
    private readonly changed = new Map<AiChangeToolboxRepository, Set<string>>()
    private writtenBytes = 0
    private readonly maxWrittenBytes: number
    /** Only with a sandbox: run_script is not offered otherwise. */
    private readonly scripts?: AiChangeScriptRunner
    /** Repositories the agent changed since their last build: finish waits for one. */
    private readonly unbuilt = new Set<AiChangeToolboxRepository>()
    summary?: string

    constructor(
        private readonly repositories: AiChangeToolboxRepository[],
        sandbox?: () => Promise<CommandSandbox>,
        signal?: AbortSignal,
        previewsEnabled = false,
        onPreview?: (kind: "info", message: string) => Promise<void> | void
    ) {
        if (repositories.length === 0) throw new Error("A toolbox needs at least one repository")
        this.maxWrittenBytes = agentLimitsFor(repositories.length).maxWrittenBytes
        this.scripts = sandbox ? new AiChangeScriptRunner(repositories, sandbox, signal, previewsEnabled, onPreview) : undefined
        // A follow-up refines what its parent wrote: the limits hold for the whole proposal, not for each step.
        for (const repository of repositories) {
            // A lockfile comes from the install, not from the agent: alone it may weigh more than the agent may write.
            for (const change of repository.previousChanges ?? []) this.markChanged(repository, change.path, isLockfilePath(change.path) ? 0 : change.bytes)
        }
        // What the previous message proposed was checked then: only what this run writes waits for a build.
        this.unbuilt.clear()
    }

    private get multipleRepositories() {
        return this.repositories.length > 1
    }

    /** The tools of a run on these repositories: run_script among them only with a sandbox. */
    tools(apiResources: string[] = []): LlmTool[] {
        const runScript = this.scripts ? [runScriptTool(this.multipleRepositories ? this.repositories.map(repository => repository.slug) : undefined)] : []
        return [...toolsFor(this.multipleRepositories, apiResources), ...runScript]
    }

    async run(name: string, input: unknown): Promise<string> {
        switch (name) {
            case "list_files":
                return this.listFiles(readString(input, "prefix", false))
            case "read_file":
                return this.readFile(readString(input, "path")!, readCount(input, "offset", 1), readCount(input, "limit", 1))
            case "search":
                return this.search(readString(input, "text")!, readString(input, "prefix", false), readCount(input, "context", 0, AI_CHANGE_LIMITS.maxSearchContextLines))
            case "edit_file":
                return this.editFile(readString(input, "path")!, readString(input, "old_text")!, readString(input, "new_text")!)
            case "write_file":
                return this.writeFile(readString(input, "path")!, readString(input, "content")!)
            case "delete_file":
                return this.deleteFile(readString(input, "path")!)
            case "finish": {
                const unbuilt = await this.unbuiltRepositories()
                if (unbuilt.length) throw new Error(buildFirst(unbuilt, this.multipleRepositories))
                const scripts = this.scripts
                if (scripts) {
                    for (const repository of this.repositories) {
                        if (repository.kind === "backend") await scripts.startPreview(repository)
                    }
                }
                this.summary = readString(input, "summary")
                return "Done."
            }
            case "run_script":
                if (!this.scripts) throw new Error(`Unknown tool "${name}"`)
                return this.runScript(this.scripts, this.repositoryNamed(readString(input, "repository", this.multipleRepositories)), readString(input, "script")!)
            default:
                throw new Error(`Unknown tool "${name}"`)
        }
    }

    /** The slugs of the repositories changed since their last build that have a build script: none without a sandbox. */
    async unbuiltRepositories(): Promise<string[]> {
        const scripts = this.scripts
        if (!scripts) return []
        const unbuilt = await Promise.all([...this.unbuilt].map(async repository => ((await scripts.hasScript(repository, BUILD_SCRIPT)) ? repository.slug : undefined)))
        return unbuilt.filter(slug => slug !== undefined)
    }

    /** The repository a path of the agent points into, and the path inside it. */
    private locate(requested: string): { repository: AiChangeToolboxRepository; inside: string } {
        if (!this.multipleRepositories) return { repository: this.repositories[0], inside: requested }
        const [slug, ...rest] = withoutLeadingSlash(requested).split("/")
        const repository = this.repositories.find(candidate => candidate.slug === slug)
        if (!repository) {
            throw new WorkspacePathError(`"${requested}" does not start with the slug of a repository: ${this.repositories.map(candidate => candidate.slug).join(", ")}`)
        }
        return { repository, inside: rest.join("/") }
    }

    /** The repository of a slug, the only one when the job has one. */
    private repositoryNamed(slug?: string): AiChangeToolboxRepository {
        if (!this.multipleRepositories) return this.repositories[0]
        const repository = this.repositories.find(candidate => candidate.slug === slug)
        if (!repository) throw new Error(`"${slug}" is not a repository of this job: ${this.repositories.map(candidate => candidate.slug).join(", ")}`)
        return repository
    }

    /** The path as the agent knows it: prefixed with the slug when there is more than one repository. */
    private shown(repository: AiChangeToolboxRepository, relative: string) {
        return this.multipleRepositories ? `${repository.slug}/${relative}` : relative
    }

    /** The repositories a prefix covers, with the folder inside each: all of them when there is no prefix. */
    private scope(prefix?: string): { repository: AiChangeToolboxRepository; folder?: string }[] {
        if (!this.multipleRepositories) return [{ repository: this.repositories[0], folder: prefix }]
        const folder = normalizeFolder(prefix)
        if (!folder) return this.repositories.map(repository => ({ repository }))
        const { repository, inside } = this.locate(folder)
        return [{ repository, folder: inside }]
    }

    private async listFiles(prefix?: string): Promise<string> {
        if (this.multipleRepositories && !withoutLeadingSlash(prefix ?? "")) {
            const roots = await Promise.all(this.repositories.map(async repository => `${repository.slug}/ (${(await repository.workingCopy.listFiles()).length} files)`))
            return `${roots.join("\n")}\nList one with prefix, e.g. "${this.repositories[0].slug}/src".`
        }
        const files: string[] = []
        for (const { repository, folder } of this.scope(prefix)) {
            for (const file of await repository.workingCopy.listFiles()) {
                if (underPrefix(file, folder)) files.push(this.shown(repository, file))
            }
        }
        const shown = files.slice(0, AI_CHANGE_LIMITS.maxListedFiles)
        const note = files.length > shown.length ? `\n… ${files.length - shown.length} more: list a folder with prefix.` : ""
        return shown.length ? shown.join("\n") + note : "No files."
    }

    /** At most `maxBytes` from the start of a file: a 2 GB file must not be read to show 100 KB of it. */
    private async readStart(absolute: string, size: number, maxBytes: number): Promise<Buffer> {
        const handle = await fs.open(absolute, "r")
        try {
            const buffer = Buffer.alloc(Math.min(size, maxBytes))
            await handle.read(buffer, 0, buffer.length, 0)
            return buffer
        } finally {
            await handle.close()
        }
    }

    private async readFile(requested: string, offset?: number, limit?: number): Promise<string> {
        const { repository, inside } = this.locate(requested)
        const { absolute, relative } = await resolveInsideWorkingCopy(repository.workingCopy.dir, inside)
        const shown = this.shown(repository, relative)
        if (isSecretPath(relative)) {
            throw new WorkspacePathError(`"${shown}" may hold credentials and cannot be read`)
        }
        const stat = await fs.stat(absolute).catch(() => undefined)
        if (!stat?.isFile()) {
            throw new Error(`"${shown}" does not exist`)
        }
        if (offset !== undefined || limit !== undefined) return this.readLines(absolute, stat.size, shown, offset ?? 1, limit)
        const buffer = await this.readStart(absolute, stat.size, AI_CHANGE_LIMITS.maxReadBytes)
        if (looksBinary(buffer)) {
            throw new Error(`"${shown}" is a binary file`)
        }
        if (stat.size > AI_CHANGE_LIMITS.maxReadBytes) {
            const rest = stat.size <= AI_CHANGE_LIMITS.maxReadByLinesBytes ? " Read the rest with offset and limit." : ""
            return `${decodeStart(buffer)}\n… truncated: the file is ${stat.size} bytes.${rest}`
        }
        return buffer.toString("utf8")
    }

    /** Lines of a file, under a header saying which: the agent asks for the part around what search found. */
    private async readLines(absolute: string, size: number, shown: string, offset: number, limit?: number): Promise<string> {
        // Loaded whole to count its lines: past this size, only its start can be read.
        if (size > AI_CHANGE_LIMITS.maxReadByLinesBytes) {
            throw new Error(`"${shown}" is ${size} bytes, too big to read by lines: read it without offset and limit for its start`)
        }
        const buffer = await fs.readFile(absolute)
        if (looksBinary(buffer)) {
            throw new Error(`"${shown}" is a binary file`)
        }
        const lines = linesOf(buffer.toString("utf8"))
        if (lines.length === 0) return "[the file is empty]"
        if (offset > lines.length) {
            throw new Error(`"${shown}" has ${lines.length} lines: offset must be at most ${lines.length}`)
        }
        const end = Math.min(lines.length, limit === undefined ? lines.length : offset + limit - 1)
        // Whole lines only, as many as fit: the header must name exactly the lines returned.
        let last = offset - 1
        let bytes = 0
        while (last < end && bytes + Buffer.byteLength(lines[last], "utf8") + 1 <= AI_CHANGE_LIMITS.maxReadBytes) {
            bytes += Buffer.byteLength(lines[last], "utf8") + 1
            last++
        }
        if (last < offset) {
            // One line longer than everything a read returns, as in minified code: its start is all there is.
            const start = decodeStart(Buffer.from(lines[offset - 1], "utf8").subarray(0, AI_CHANGE_LIMITS.maxReadBytes))
            return `[line ${offset} of ${lines.length}, cut at ${AI_CHANGE_LIMITS.maxReadBytes} bytes]\n${start}`
        }
        const content = `[lines ${offset}-${last} of ${lines.length}]\n${lines.slice(offset - 1, last).join("\n")}`
        return last < end ? `${content}\n… truncated at ${AI_CHANGE_LIMITS.maxReadBytes} bytes: continue with offset ${last + 1}.` : content
    }

    /**
     * Matching lines as `path:line: text`. With `context`, the lines around each one follow as
     * `path-line- text`, a line shown once however many matches it is near, and `--` between groups.
     */
    private async search(text: string, prefix?: string, context = 0): Promise<string> {
        const needle = text.toLowerCase()
        if (!needle.trim()) throw new Error("Empty search text")
        const output: string[] = []
        let matches = 0
        for (const { repository, folder } of this.scope(prefix)) {
            const files = (await repository.workingCopy.listFiles()).filter(file => underPrefix(file, folder))
            // Started a few files ahead, looked into in order: a read that fails throws only once the search reaches its file.
            const reads: Promise<Buffer | undefined>[] = []
            for (let index = 0; index < files.length; index++) {
                if (matches >= AI_CHANGE_LIMITS.maxSearchMatches) break
                for (let next = reads.length; next < Math.min(index + SEARCH_READ_AHEAD, files.length); next++) {
                    const read = this.searchable(repository, files[next])
                    // Handled here too: a read past the file the search stops at must not be an unhandled rejection.
                    read.catch(() => undefined)
                    reads.push(read)
                }
                const buffer = await reads[index]
                if (!buffer) continue
                const found = matchingLines(this.shown(repository, files[index]), linesOf(buffer.toString("utf8")), needle, context, AI_CHANGE_LIMITS.maxSearchMatches - matches)
                if (context > 0 && output.length && found.output.length) output.push("--")
                output.push(...found.output)
                matches += found.matches
                if (output.length >= AI_CHANGE_LIMITS.maxSearchLines) break
            }
        }
        if (!output.length) return "No matches."
        // Said, not left to guess: a search that stopped early does not show every match.
        const stopped = output.length >= AI_CHANGE_LIMITS.maxSearchLines || matches >= AI_CHANGE_LIMITS.maxSearchMatches
        const shown = output.slice(0, AI_CHANGE_LIMITS.maxSearchLines).join("\n")
        return stopped ? `${shown}\n… stopped before the end: narrow the search with prefix or a longer text.` : shown
    }

    /** The content of a file search looks into: none when it leads out of the repository, is a secret, too big or binary. */
    private async searchable(repository: AiChangeToolboxRepository, file: string): Promise<Buffer | undefined> {
        // Resolved like a read: a tracked file under a symlinked folder must not lead out, or to a secret.
        const resolved = await resolveInsideWorkingCopy(repository.workingCopy.dir, file).catch(() => undefined)
        if (!resolved || isSecretPath(resolved.relative)) return undefined
        const stat = await fs.lstat(resolved.absolute).catch(() => undefined)
        if (!stat?.isFile() || stat.size > AI_CHANGE_LIMITS.maxSearchedFileBytes) return undefined
        const buffer = await fs.readFile(resolved.absolute)
        return looksBinary(buffer) ? undefined : buffer
    }

    /** A small text file of a repository, or undefined when it is missing, a secret, binary or out of it. */
    private async readSmallText(repository: AiChangeToolboxRepository, relative: string): Promise<string | undefined> {
        const resolved = await resolveInsideWorkingCopy(repository.workingCopy.dir, relative).catch(() => undefined)
        if (!resolved || isSecretPath(resolved.relative)) return undefined
        const stat = await fs.stat(resolved.absolute).catch(() => undefined)
        if (!stat?.isFile()) return undefined
        const buffer = await this.readStart(resolved.absolute, stat.size, AI_CHANGE_LIMITS.maxMapBytes)
        if (looksBinary(buffer)) return undefined
        if (stat.size <= AI_CHANGE_LIMITS.maxMapBytes) return buffer.toString("utf8").trim() || undefined
        // Cut at a line: the agent copies lines of the notes into edit_file, a half line would not be found.
        const start = decodeStart(buffer)
        const lastLine = start.lastIndexOf("\n")
        return `${(lastLine > 0 ? start.slice(0, lastLine) : start).trim()}\n… cut: read_file has the rest.`
    }

    /**
     * What each repository holds, before the agent starts: its layout and what agents and the team
     * wrote about it. A repository that cannot be mapped has none: the agent explores it with its tools.
     */
    async repositoryMaps(): Promise<(AiChangeRepositoryMap | undefined)[]> {
        return Promise.all(this.repositories.map(repository => this.repositoryMap(repository).catch(() => undefined)))
    }

    private async repositoryMap(repository: AiChangeToolboxRepository): Promise<AiChangeRepositoryMap> {
        // Independent of each other: listed and read at once.
        const [files, notes, instructions] = await Promise.all([repository.workingCopy.listFiles(), this.readSmallText(repository, REPOSITORY_MAP_PATH), this.agentInstructions(repository)])
        return { layout: describeLayout(files), files: files.length, notesPath: this.shown(repository, REPOSITORY_MAP_PATH), notes, instructions }
    }

    /** The first of {@link AGENT_INSTRUCTION_FILES} the repository holds. */
    private async agentInstructions(repository: AiChangeToolboxRepository): Promise<AiChangeRepositoryMap["instructions"]> {
        for (const file of AGENT_INSTRUCTION_FILES) {
            const content = await this.readSmallText(repository, file)
            if (content) return { path: this.shown(repository, file), content }
        }
        return undefined
    }

    private async ensureCanChange(repository: AiChangeToolboxRepository, relative: string, bytes: number) {
        const shown = this.shown(repository, relative)
        if (isProtectedPath(relative)) {
            throw new WorkspacePathError(`"${shown}" is CI configuration, a lockfile or registry configuration and cannot be changed`)
        }
        // A file .gitignore excludes would never reach the proposal and would stay on disk for the next run.
        if (await repository.workingCopy.isIgnored(relative)) {
            throw new WorkspacePathError(`"${shown}" is ignored by .gitignore`)
        }
        const changed = this.changed.get(repository) ?? new Set<string>()
        if (!changed.has(relative) && changed.size >= AI_CHANGE_LIMITS.maxChangedFiles) {
            throw new Error(`At most ${AI_CHANGE_LIMITS.maxChangedFiles} files can be changed in one repository`)
        }
        if (this.writtenBytes + bytes > this.maxWrittenBytes) {
            throw new Error(`At most ${this.maxWrittenBytes} bytes can be written in one request`)
        }
    }

    private markChanged(repository: AiChangeToolboxRepository, relative: string, bytes: number) {
        const changed = this.changed.get(repository) ?? new Set<string>()
        changed.add(relative)
        this.changed.set(repository, changed)
        this.writtenBytes += bytes
        this.scripts?.touch(repository, relative)
        this.unbuilt.add(repository)
    }

    /** Runs a script and takes into the working copy what it changed in the sandbox: see {@link takeScriptChanges}. */
    private async runScript(scripts: AiChangeScriptRunner, repository: AiChangeToolboxRepository, script: string): Promise<string> {
        // Tried is enough: a build broken before the change, or a sandbox that fails, must not hold finish forever.
        if (script === BUILD_SCRIPT) this.unbuilt.delete(repository)
        const run = await scripts.run(repository, script, paths => this.tooManyFiles(repository, paths))
        const changes = await this.takeScriptChanges(repository, run)
        return [run.output, changes].filter(Boolean).join("\n\n")
    }

    /** Why these paths cannot all join the change of a repository, if they cannot. */
    private tooManyFiles(repository: AiChangeToolboxRepository, paths: string[]): string | undefined {
        const changed = this.changed.get(repository) ?? new Set<string>()
        const count = new Set([...changed, ...paths]).size
        return count > AI_CHANGE_LIMITS.maxChangedFiles ? `your change would hold ${count} files, more than the ${AI_CHANGE_LIMITS.maxChangedFiles} of one repository: not part of it` : undefined
    }

    /**
     * What a script changed becomes part of the change as if the agent had written it, in the limit of
     * files, its bytes not counted: a lockfile alone may weigh more than the agent may write. The runner
     * already left out what may not be proposed; the sandbox holds these files already, nothing is sent back.
     */
    private async takeScriptChanges(repository: AiChangeToolboxRepository, run: ScriptRun): Promise<string | undefined> {
        const notes: string[] = []
        if (run.files.length) {
            const changed = this.changed.get(repository) ?? new Set<string>()
            for (const file of run.files) {
                const { absolute, relative } = await resolveInsideWorkingCopy(repository.workingCopy.dir, file.path)
                await fs.mkdir(path.dirname(absolute), { recursive: true })
                await fs.writeFile(absolute, file.content)
                changed.add(relative)
            }
            this.changed.set(repository, changed)
            notes.push(`Files the script changed, now part of your change: ${run.files.map(file => this.shown(repository, file.path)).join(", ")}`)
        }
        if (run.left.length) notes.push(`Left out of your change:\n${run.left.map(line => `- ${line}`).join("\n")}`)
        return notes.join("\n") || undefined
    }

    private async writeFile(requested: string, content: string): Promise<string> {
        const { repository, inside } = this.locate(requested)
        const { absolute, relative } = await resolveInsideWorkingCopy(repository.workingCopy.dir, inside)
        const bytes = Buffer.byteLength(content, "utf8")
        await this.ensureCanChange(repository, relative, bytes)
        const existing = await fs.lstat(absolute).catch(() => undefined)
        if (existing && !existing.isFile()) {
            throw new Error(`"${this.shown(repository, relative)}" is not a regular file`)
        }
        await fs.mkdir(path.dirname(absolute), { recursive: true })
        await fs.writeFile(absolute, content, "utf8")
        this.markChanged(repository, relative, bytes)
        await this.scripts?.sync(repository)
        return `${existing ? "Updated" : "Created"} ${this.shown(repository, relative)}.`
    }

    /**
     * Only `new_text` counts towards the written bytes: the rest of the file was already there.
     * A secret is refused even though nothing is read back: "found twice" would tell what it holds.
     */
    private async editFile(requested: string, oldText: string, newText: string): Promise<string> {
        const { repository, inside } = this.locate(requested)
        const { absolute, relative } = await resolveInsideWorkingCopy(repository.workingCopy.dir, inside)
        const shown = this.shown(repository, relative)
        if (isSecretPath(relative)) {
            throw new WorkspacePathError(`"${shown}" may hold credentials and cannot be edited`)
        }
        if (!oldText) throw new Error("old_text is empty: use write_file to create a file")
        const bytes = Buffer.byteLength(newText, "utf8")
        await this.ensureCanChange(repository, relative, bytes)
        const existing = await fs.lstat(absolute).catch(() => undefined)
        if (!existing?.isFile()) {
            throw new Error(`"${shown}" does not exist: use write_file to create it`)
        }
        if (existing.size > AI_CHANGE_LIMITS.maxSearchedFileBytes) {
            throw new Error(`"${shown}" is ${existing.size} bytes, too big to edit`)
        }
        const buffer = await fs.readFile(absolute)
        if (looksBinary(buffer)) {
            throw new Error(`"${shown}" is a binary file`)
        }
        const content = buffer.toString("utf8")
        const at = content.indexOf(oldText)
        if (at === -1) {
            // Where to look again, so a long file is not read again whole for one snippet copied wrong.
            const near = linesHolding(content, oldText)
            const where = near.length > 0 && near.length <= 5 ? `, but its first line is at line ${near.join(", ")}` : ""
            const how = where ? "read the lines from there" : "find it with search, read the lines around it"
            throw new Error(`old_text was not found in "${shown}"${where}: ${how} with read_file offset and limit, and copy them exactly`)
        }
        if (content.indexOf(oldText, at + oldText.length) !== -1) {
            throw new Error(`old_text appears more than once in "${shown}": include more surrounding lines to make it unique`)
        }
        await fs.writeFile(absolute, content.slice(0, at) + newText + content.slice(at + oldText.length), "utf8")
        this.markChanged(repository, relative, bytes)
        await this.scripts?.sync(repository)
        // The line tells the agent where to read again, should it need to, without the whole file.
        return `Edited ${shown} at line ${content.slice(0, at).split("\n").length}.`
    }

    private async deleteFile(requested: string): Promise<string> {
        const { repository, inside } = this.locate(requested)
        const { absolute, relative } = await resolveInsideWorkingCopy(repository.workingCopy.dir, inside)
        await this.ensureCanChange(repository, relative, 0)
        const existing = await fs.lstat(absolute).catch(() => undefined)
        if (!existing?.isFile()) {
            throw new Error(`"${this.shown(repository, relative)}" does not exist`)
        }
        await fs.rm(absolute)
        this.markChanged(repository, relative, 0)
        await this.scripts?.sync(repository)
        return `Deleted ${this.shown(repository, relative)}.`
    }
}

/** Why the work is not over yet: the change of these repositories was never built. */
export const buildFirst = (slugs: string[], multipleRepositories: boolean) =>
    `Not finished: you changed files since the last build${multipleRepositories ? ` of ${slugs.join(", ")}` : ""}, and your change is pushed once you are done. ` +
    `Run run_script "${BUILD_SCRIPT}"${multipleRepositories ? " in each" : ""}, fix what your change broke, then finish.`
