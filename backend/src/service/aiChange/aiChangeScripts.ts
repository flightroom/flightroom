import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { isSecretPath, resolveInsideWorkingCopy } from "../../utils/workspacePaths"
import { LlmTool } from "../llm"
import { CommandSandbox, SandboxCommandResult } from "../sandbox/commandSandbox"
import { TarEntry, tarGz } from "../sandbox/tarArchive"
import { GitWorkingCopy } from "../workspace/GitWorkingCopy"

export const AI_SCRIPT_LIMITS = {
    /** A test suite takes minutes; a dev server or a watcher never ends, and is stopped here. */
    timeoutSecs: 600,
    /** Characters of the output the agent reads: the end, where errors are printed. */
    maxOutputChars: 6_000,
    /** Bytes of an archive carried on the stdin of one command: a bigger one is sent in pieces. */
    uploadChunkBytes: 2 * 1024 * 1024,
    /** Bytes of the files of one repository copied into the sandbox. */
    maxUploadBytes: 300 * 1024 * 1024,
    uploadTimeoutSecs: 300
}

/** The script that is no script of package.json: the dependencies, installed with the repository's package manager. */
export const INSTALL_SCRIPT = "install"

type PackageManager = "pnpm" | "yarn" | "npm"

/** Read from the files git tracks, in this order, when package.json names no packageManager. */
const LOCKFILES: [string, PackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"]
]

const PACKAGE_MANAGERS = new Set<string>(["pnpm", "yarn", "npm"])

/** pnpm and yarn through corepack: the version package.json pins is the one that runs, none has to be in the image. */
export const commandFor = (manager: PackageManager, script: string): string[] => {
    const args = script === INSTALL_SCRIPT ? ["install"] : ["run", script]
    return manager === "npm" ? ["npm", ...args] : ["corepack", manager, ...args]
}

/** Every file but the dependencies: what a copy of the repository is replaced with keeps node_modules, so a reinstall is quick. */
const CLEAR_EXCEPT_DEPENDENCIES = "find . -mindepth 1 -name node_modules -prune -o ! -type d -print0 | xargs -0 rm -f"

/** Removes the copies of repositories this run does not work on, and makes the folder of each one it does. */
const PREPARE_REPOSITORIES = [
    'mkdir -p "$0" && cd "$0" || exit 1',
    'for entry in * .[!.]*; do [ -e "$entry" ] || continue; case " $* " in *" $entry "*) ;; *) rm -rf -- "$entry" ;; esac; done',
    'for slug in "$@"; do mkdir -p "$slug"; done'
].join("\n")

const SLUG = /^[a-z0-9][a-z0-9-]*$/

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences of terminal colours are what is removed
const TERMINAL_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g

const describeResult = (command: string[], result: SandboxCommandResult) => {
    const output = result.output.replace(TERMINAL_ESCAPES, "").trimEnd()
    const shown = output.length > AI_SCRIPT_LIMITS.maxOutputChars ? output.slice(-AI_SCRIPT_LIMITS.maxOutputChars) : output
    const cut = result.cutBytes > 0 || shown.length < output.length
    return [
        `$ ${command.join(" ")}`,
        `exit code ${result.exitCode}${result.exitCode === 0 ? " (success)" : ""}`,
        cut ? "… the start of the output is cut, this is its end:" : undefined,
        shown || "(no output)"
    ]
        .filter(Boolean)
        .join("\n")
}

/** A command that prepares the sandbox, which must work: its failure is no result for the agent, but an error. */
const ensureSucceeded = (what: string, result: SandboxCommandResult) => {
    if (result.exitCode !== 0) throw new Error(`${what} failed with exit code ${result.exitCode}: ${result.output.slice(-1_000)}`)
}

export interface ScriptRepository {
    slug: string
    workingCopy: GitWorkingCopy
}

interface PackageManifest {
    packageManager?: unknown
    scripts?: Record<string, unknown>
}

/** The tool, offered only when the installation has sandboxes. */
export const runScriptTool = (slugs?: string[]): LlmTool => ({
    name: "run_script",
    description:
        "Runs, in an isolated sandbox holding a copy of the repository as it is now (your edits included), the install of its dependencies or one script of its package.json, with the package manager of the repository, and returns the exit code and the end of the output. " +
        `Run "${INSTALL_SCRIPT}" first, and again after changing package.json. Then run the scripts that check your change: lint, typecheck, test, build, whichever the repository has. ` +
        `Never a script that starts a server or watches files (dev, start, serve, watch): it is stopped after ${AI_SCRIPT_LIMITS.timeoutSecs / 60} minutes. Each call takes time: run what the change needs.`,
    inputSchema: {
        type: "object",
        properties: {
            ...(slugs ? { repository: { type: "string", enum: slugs, description: "Slug of the repository to run it in." } } : {}),
            script: { type: "string", description: `"${INSTALL_SCRIPT}", or the name of a script of package.json, e.g. "test" or "lint".` }
        },
        required: slugs ? ["repository", "script"] : ["script"],
        additionalProperties: false
    }
})

/**
 * Runs the scripts of the repositories of one run in a sandbox. The sandbox is asked for at the first
 * script: a run that only reads and edits never creates one. Each repository is copied into it whole
 * at its first script of the run, and from then on only what the agent wrote or deleted is sent.
 *
 * Nothing comes back from the sandbox but the output: the working copies stay the only truth, and
 * what a script changes there (a lockfile the install rewrote, a build) is never proposed.
 */
export class AiChangeScriptRunner {
    private sandbox?: Promise<CommandSandbox>
    private prepared = false
    private readonly copied = new Set<ScriptRepository>()
    /** What the agent wrote or deleted since the repository was last sent. */
    private readonly unsent = new Map<ScriptRepository, Set<string>>()

    constructor(
        private readonly repositories: ScriptRepository[],
        private readonly open: () => Promise<CommandSandbox>,
        private readonly signal?: AbortSignal
    ) {
        for (const repository of repositories) {
            if (!SLUG.test(repository.slug)) throw new Error(`"${repository.slug}" cannot name a folder of the sandbox`)
        }
    }

    /** A path the agent wrote or deleted: it reaches the sandbox before the next script. */
    touch(repository: ScriptRepository, relative: string) {
        const paths = this.unsent.get(repository) ?? new Set<string>()
        paths.add(relative)
        this.unsent.set(repository, paths)
    }

    async run(repository: ScriptRepository, script: string): Promise<string> {
        const manifest = await this.manifestOf(repository)
        if (script !== INSTALL_SCRIPT && typeof manifest.scripts?.[script] !== "string") {
            const scripts = Object.keys(manifest.scripts ?? {})
            throw new Error(`package.json has no script "${script}"${scripts.length ? `: it has ${scripts.join(", ")}` : ""}`)
        }
        const command = commandFor(await this.managerOf(repository, manifest), script)
        try {
            const sandbox = await this.sandboxForRun()
            await this.send(sandbox, repository)
            const result = await sandbox.exec(command, {
                workdir: this.folderOf(sandbox, repository),
                environment: this.environmentOf(sandbox),
                timeoutSecs: AI_SCRIPT_LIMITS.timeoutSecs,
                signal: this.signal
            })
            return describeResult(command, result)
        } catch (error) {
            // The sandbox may be gone, deleted as idle or its node lost: the next script starts again from a new one.
            this.sandbox = undefined
            this.prepared = false
            this.copied.clear()
            throw error
        }
    }

    private sandboxForRun(): Promise<CommandSandbox> {
        this.sandbox ??= this.open()
        return this.sandbox
    }

    private folderOf(sandbox: CommandSandbox, repository: ScriptRepository) {
        return `${sandbox.root}/repositories/${repository.slug}`
    }

    /** Caches and the home of every tool under the root: the only folder the sandbox is sure to let them write. */
    private environmentOf(sandbox: CommandSandbox): Record<string, string> {
        return { CI: "true", HOME: `${sandbox.root}/home`, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", NO_COLOR: "1", FORCE_COLOR: "0" }
    }

    private async manifestOf(repository: ScriptRepository): Promise<PackageManifest> {
        const resolved = await resolveInsideWorkingCopy(repository.workingCopy.dir, "package.json")
        const content = await fs.readFile(resolved.absolute, "utf8").catch(() => undefined)
        if (content === undefined) throw new Error("The repository has no package.json at its root: run_script runs the scripts of Node.js projects only")
        try {
            const manifest = JSON.parse(content)
            return manifest && typeof manifest === "object" ? manifest : {}
        } catch {
            throw new Error("package.json is not valid JSON")
        }
    }

    private async managerOf(repository: ScriptRepository, manifest: PackageManifest): Promise<PackageManager> {
        const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : undefined
        if (declared && PACKAGE_MANAGERS.has(declared)) return declared as PackageManager
        const files = new Set(await repository.workingCopy.listFiles())
        return LOCKFILES.find(([lockfile]) => files.has(lockfile))?.[1] ?? "npm"
    }

    private async send(sandbox: CommandSandbox, repository: ScriptRepository) {
        if (!this.prepared) {
            const result = await sandbox.exec(["sh", "-c", PREPARE_REPOSITORIES, `${sandbox.root}/repositories`, ...this.repositories.map(({ slug }) => slug)], {
                timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs,
                signal: this.signal
            })
            ensureSucceeded("Preparing the sandbox", result)
            this.prepared = true
        }
        const unsent = this.unsent.get(repository) ?? new Set<string>()
        if (!this.copied.has(repository)) {
            // Whole: the sandbox may hold the copy of an earlier message, with files this one no longer has.
            const { entries } = await this.entriesOf(repository, [...new Set([...(await repository.workingCopy.listFiles()), ...unsent])])
            await this.extract(sandbox, repository, tarGz(entries), CLEAR_EXCEPT_DEPENDENCIES, [])
            this.copied.add(repository)
        } else if (unsent.size) {
            const { entries, removed } = await this.entriesOf(repository, [...unsent])
            await this.extract(sandbox, repository, entries.length ? tarGz(entries) : undefined, 'rm -f -- "$@"', removed)
        }
        this.unsent.delete(repository)
    }

    /** The files to copy, and the paths that no longer exist. Secrets stay out: no .env reaches the sandbox. */
    private async entriesOf(repository: ScriptRepository, paths: string[]): Promise<{ entries: TarEntry[]; removed: string[] }> {
        const entries: TarEntry[] = []
        const removed: string[] = []
        let bytes = 0
        for (const requested of paths) {
            const resolved = await resolveInsideWorkingCopy(repository.workingCopy.dir, requested).catch(() => undefined)
            if (!resolved || isSecretPath(resolved.relative)) continue
            const stat = await fs.lstat(resolved.absolute).catch(() => undefined)
            if (!stat) {
                removed.push(resolved.relative)
                continue
            }
            if (!stat.isFile()) continue
            bytes += stat.size
            if (bytes > AI_SCRIPT_LIMITS.maxUploadBytes) throw new Error(`The repository is bigger than the ${AI_SCRIPT_LIMITS.maxUploadBytes / 1024 / 1024} MB a sandbox takes`)
            entries.push({ path: resolved.relative, content: await fs.readFile(resolved.absolute), executable: (stat.mode & 0o111) !== 0 })
        }
        return { entries, removed }
    }

    /**
     * Runs `before` (a shell script given `args`) in the copy of the repository, then extracts the
     * archive there. A small archive goes on the stdin of that command; a bigger one is first written
     * to a file of the sandbox in pieces, each a command of its own.
     */
    private async extract(sandbox: CommandSandbox, repository: ScriptRepository, archive: Buffer | undefined, before: string, args: string[]) {
        const options = { workdir: this.folderOf(sandbox, repository), timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs, signal: this.signal }
        const what = `Copying ${repository.slug} into the sandbox`
        if (!archive) {
            ensureSucceeded(what, await sandbox.exec(["sh", "-c", before, "sh", ...args], options))
            return
        }
        if (archive.length <= AI_SCRIPT_LIMITS.uploadChunkBytes) {
            ensureSucceeded(what, await sandbox.exec(["sh", "-c", `set -e\n${before}\ntar -xzf -`, "sh", ...args], { ...options, stdin: archive }))
            return
        }
        const file = `${sandbox.root}/uploads/${repository.slug}-${randomUUID()}.tgz`
        for (let offset = 0; offset < archive.length; offset += AI_SCRIPT_LIMITS.uploadChunkBytes) {
            const piece = archive.subarray(offset, offset + AI_SCRIPT_LIMITS.uploadChunkBytes)
            ensureSucceeded(what, await sandbox.exec(["sh", "-c", 'mkdir -p "$(dirname "$0")" && cat >> "$0"', file], { ...options, stdin: piece }))
        }
        ensureSucceeded(
            what,
            await sandbox.exec(["sh", "-c", `${before} && tar -xzf "$ARCHIVE"; status=$?; rm -f "$ARCHIVE"; exit $status`, "sh", ...args], { ...options, environment: { ARCHIVE: file } })
        )
    }
}
