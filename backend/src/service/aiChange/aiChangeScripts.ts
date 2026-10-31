import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { gunzipSync } from "node:zlib"
import { redactSecrets } from "../../utils/redactSecrets"
import { isLockfilePath, isProtectedPath, isSecretPath, resolveInsideWorkingCopy } from "../../utils/workspacePaths"
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
    uploadTimeoutSecs: 300,
    /** Bytes of a gzipped file read back in one command: in base64 it stays under the output a command returns (64 KB). */
    downloadChunkBytes: 45_000,
    /** Bytes of the files one script changed that are read back: a lockfile fits, a build that is not ignored does not. */
    maxDownloadBytes: 10 * 1024 * 1024,
    /** Files one script changed that are looked at: past them, it rewrote the repository and nothing is read back. */
    maxListedChanges: 200
}

/** The script that is no script of package.json: the dependencies, installed with the repository's package manager. */
export const INSTALL_SCRIPT = "install"

/** The script a change must have gone through before it is pushed, in every repository that has one. */
export const BUILD_SCRIPT = "build"

/** A check command, and the program the sandbox must have to run it: the default image has Node.js only. */
export interface CheckCommand {
    command: string
    requires: string
}

/**
 * The command that checks a change of a repository with no build script in package.json, read from the files at
 * its root: the build its CI most likely runs. Undefined when none is known, and then finish waits for nothing.
 * A wrapper (mvnw, gradlew) needs only Java. .NET builds what is there when it is one solution, or one project.
 */
export const checkCommandFor = (files: Iterable<string>): CheckCommand | undefined => {
    const root = [...files].filter(file => !file.includes("/"))
    const has = (file: string) => root.includes(file)
    if (has("pom.xml")) return has("mvnw") ? { command: "./mvnw -B -q verify", requires: "java" } : { command: "mvn -B -q verify", requires: "mvn" }
    if (has("gradlew") && (has("build.gradle") || has("build.gradle.kts"))) return { command: "./gradlew build --no-daemon -q", requires: "java" }
    if (has("go.mod")) return { command: "go build ./... && go vet ./...", requires: "go" }
    const solutions = root.filter(file => file.endsWith(".sln")).length
    const projects = root.filter(file => file.endsWith(".csproj")).length
    if (solutions === 1 || (solutions === 0 && projects === 1)) return { command: "dotnet build", requires: "dotnet" }
    return undefined
}

/** What a changed repository must have run before finish: its build script, or the check command of its files. */
export interface RepositoryCheck {
    tool: "run_script" | "run_command"
    /** The script, or the command exactly as run_command must be given it. */
    run: string
}

/**
 * The folder of the copy a command runs in, relative to the root of the repository, normalized; undefined for the
 * root. An absolute path or a `..` would lead out of the copy, to the other repositories or the caches.
 */
export const commandWorkdir = (requested?: string): string | undefined => {
    if (requested === undefined) return undefined
    if (/^([\\/]|[A-Za-z]:)/.test(requested)) throw new Error(`workdir "${requested}" is absolute: give a folder relative to the root of the repository`)
    const segments = requested.split(/[\\/]+/).filter(segment => segment && segment !== ".")
    if (segments.includes("..")) throw new Error(`workdir "${requested}" leads out of the repository: ".." is not allowed`)
    return segments.join("/") || undefined
}

type PackageManager = "pnpm" | "yarn" | "npm"

/** Read from the files git tracks, in this order, when package.json names no packageManager. */
const LOCKFILES: [string, PackageManager][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"]
]

const PACKAGE_MANAGERS = new Set<string>(["pnpm", "yarn", "npm"])

/**
 * Without CI (see environmentOf) pnpm will not purge a node_modules it must rebuild unless told so: there is
 * no terminal to ask in.
 */
const INSTALL_ARGS: Record<PackageManager, string[]> = { pnpm: ["install", "--config.confirmModulesPurge=false"], yarn: ["install"], npm: ["install"] }

/** pnpm and yarn through corepack: the version package.json pins is the one that runs, none has to be in the image. */
export const commandFor = (manager: PackageManager, script: string): string[] => {
    const args = script === INSTALL_SCRIPT ? INSTALL_ARGS[manager] : ["run", script]
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

/** The files of the copy written since the marker, with their hash: node_modules is the install's, not the repository's. */
const LIST_CHANGES = 'find . -name node_modules -prune -o -type f -newer "$0" -exec sha256sum {} +'

/** A line of sha256sum. A name holding a newline or a backslash is printed escaped, starting with one: it does not match, and is skipped. */
const CHANGE_LINE = /^([0-9a-f]{64}) [ *]\.\/(.+)$/

const SLUG = /^[a-z0-9][a-z0-9-]*$/

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences of terminal colours are what is removed
const TERMINAL_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g

const looksBinary = (content: Buffer) => content.subarray(0, 8_000).includes(0)

/**
 * What the agent reads of a run: a credential the command printed is masked before it reaches the model. Masked
 * whole, then cut: a private key or a token across the cut would be masked by neither of its halves. The line the
 * cut falls in is left out, as it may be the end of a secret whose start is gone.
 */
const describeResult = (shown: string, result: SandboxCommandResult) => {
    const output = redactSecrets(result.output.replace(TERMINAL_ESCAPES, "")).trimEnd()
    let tail = output.length > AI_SCRIPT_LIMITS.maxOutputChars ? output.slice(-AI_SCRIPT_LIMITS.maxOutputChars) : output
    const cut = result.cutBytes > 0 || tail.length < output.length
    const firstLineEnd = tail.indexOf("\n")
    if (cut && firstLineEnd !== -1) tail = tail.slice(firstLineEnd + 1)
    return [
        `$ ${redactSecrets(shown)}`,
        `exit code ${result.exitCode}${result.exitCode === 0 ? " (success)" : ""}`,
        cut ? "… the start of the output is cut, this is its end:" : undefined,
        tail || "(no output)"
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
    kind?: "frontend" | "backend"
    framework?: string
    runtime?: string
    port?: number
    /** The user configuration of its package manager in the sandbox (a private registry and its token): never part of the copy. */
    npmrc?: string
}

interface PreviewPlan {
    command: string[]
    port: number
    environment?: Record<string, string>
    install?: string[]
}

const previewPortOf = (repository: ScriptRepository) => {
    if (repository.kind === "frontend") return 5173
    const port = repository.port
    return Number.isInteger(port) && port !== undefined && port > 0 && port <= 65_535 ? port : 3000
}

const packagePreview = (repository: ScriptRepository, manifest: PackageManifest, manager: PackageManager): PreviewPlan | undefined => {
    const scripts = manifest.scripts ?? {}
    const script = ["dev", "start", "serve"].find(name => typeof scripts[name] === "string")
    if (!script) return undefined
    const port = previewPortOf(repository)
    const command = commandFor(manager, script)
    if (repository.kind === "frontend") command.push("--", "--host", "0.0.0.0", "--port", String(port))
    return { command, port, ...(repository.kind === "backend" ? { environment: { HOST: "0.0.0.0", PORT: String(port), HTTP_PORT: String(port) } } : {}) }
}

/** Builds a preview command from the registered runtime and files at the repository root. */
export const previewPlanFor = (repository: ScriptRepository, files: Set<string>, manifest: PackageManifest | undefined, manager?: PackageManager): PreviewPlan | undefined => {
    if (!repository.kind) return undefined
    const port = previewPortOf(repository)
    if (repository.kind === "frontend" || !repository.runtime || repository.runtime === "NODE") {
        return manifest && manager ? packagePreview(repository, manifest, manager) : undefined
    }

    const environment = { HOST: "0.0.0.0", PORT: String(port), HTTP_PORT: String(port) }
    switch (repository.runtime) {
        case "PYTHON": {
            const install = files.has("requirements.txt")
                ? ["python3", "-m", "pip", "install", "-r", "requirements.txt"]
                : files.has("pyproject.toml")
                  ? ["python3", "-m", "pip", "install", "-e", "."]
                  : undefined
            if (files.has("manage.py")) {
                return { command: ["python3", "manage.py", "runserver", `0.0.0.0:${port}`], port, ...(install ? { install } : {}) }
            }
            const framework = repository.framework?.toLowerCase() ?? ""
            if (framework.includes("flask")) {
                const app = files.has("app.py") ? "app" : files.has("app/main.py") ? "app.main" : "main"
                return {
                    command: ["python3", "-m", "flask", "--app", app, "run", "--host", "0.0.0.0", "--port", String(port)],
                    port,
                    ...(install ? { install } : {})
                }
            }
            if (framework.includes("fastapi")) {
                const module = files.has("app/main.py") ? "app.main" : files.has("src/main.py") ? "main" : files.has("app.py") ? "app" : "main"
                const pythonPath = files.has("src/main.py") ? "src" : undefined
                return {
                    command: ["python3", "-m", "uvicorn", `${module}:app`, "--host", "0.0.0.0", "--port", String(port), "--reload"],
                    port,
                    environment: { ...environment, ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) },
                    ...(install ? { install } : {})
                }
            }
            return undefined
        }
        case "JAVA": {
            const framework = repository.framework?.toLowerCase() ?? ""
            const wrapper = files.has("mvnw") ? ["sh", "./mvnw"] : files.has("gradlew") ? ["sh", "./gradlew"] : undefined
            if (files.has("pom.xml")) {
                const goal = framework.includes("quarkus") ? "quarkus:dev" : framework.includes("micronaut") ? "mn:run" : framework.includes("spring") ? "spring-boot:run" : undefined
                if (!goal) return undefined
                return {
                    command: [...(wrapper ?? ["mvn"]), goal],
                    port,
                    environment: {
                        ...environment,
                        ...(framework.includes("quarkus")
                            ? { QUARKUS_HTTP_HOST: "0.0.0.0", QUARKUS_HTTP_PORT: String(port) }
                            : framework.includes("micronaut")
                              ? { MICRONAUT_SERVER_HOST: "0.0.0.0", MICRONAUT_SERVER_PORT: String(port) }
                              : { SERVER_ADDRESS: "0.0.0.0", SERVER_PORT: String(port) })
                    }
                }
            }
            if (files.has("build.gradle") || files.has("build.gradle.kts")) {
                const goal = framework.includes("quarkus") ? "quarkusDev" : framework.includes("micronaut") ? "run" : framework.includes("spring") ? "bootRun" : undefined
                if (!goal) return undefined
                return {
                    command: [...(wrapper ?? ["gradle"]), goal],
                    port,
                    environment: { ...environment, SERVER_ADDRESS: "0.0.0.0", SERVER_PORT: String(port) }
                }
            }
            return undefined
        }
        case "GO":
            return files.has("go.mod") ? { command: ["go", "run", "."], port, environment } : undefined
        case "DOTNET": {
            const project = [...files].find(file => file.endsWith(".csproj"))
            return project ? { command: ["dotnet", "run", "--project", `./${project}`, "--", "--urls", `http://0.0.0.0:${port}`], port, environment } : undefined
        }
        default:
            return undefined
    }
}

/** A file a script changed in the copy of the repository, read back from the sandbox. */
export interface ScriptChangedFile {
    path: string
    content: Buffer
}

/** What one script or command took in the sandbox, failed or not, told to whoever counts what the sandbox costs. */
export interface SandboxExec {
    seconds: number
}

/** One run in the copy of a repository: a script of package.json or a command of the agent. */
interface SandboxRun {
    /** Run at the root of the copy. */
    command: string[]
    /** The command as the agent reads it back. */
    shown: string
    /** The install runs without CI: see environmentOf. */
    install: boolean
    /** The registry configuration of the repository, credentials included: for its package manager only. */
    npmrc: boolean
    timeoutSecs: number
    /** Whether a run that succeeds starts the preview of the repository: a script may have installed what it needs. */
    preview: boolean
}

export interface ScriptRun {
    /** What the agent reads: the command, its exit code and the end of its output. */
    output: string
    /** The files the script created or changed that may be proposed, with their new content. */
    files: ScriptChangedFile[]
    /** What the script changed that does not come back, said to the agent. */
    left: string[]
}

const sha256 = (content: Buffer) => createHash("sha256").update(content).digest("hex")

interface PackageManifest {
    packageManager?: unknown
    scripts?: Record<string, unknown>
}

/** The tool, offered only when the installation has sandboxes. */
export const runScriptTool = (slugs?: string[]): LlmTool => ({
    name: "run_script",
    description:
        "Runs, in an isolated sandbox holding a copy of the repository as it is now (your edits included), the install of its dependencies or one script of its package.json, with the package manager of the repository, and returns the exit code and the end of the output. " +
        `Run "${INSTALL_SCRIPT}" first, and again after changing package.json: the lockfile it updates becomes part of your change. Then run the scripts that check your change: lint, typecheck, test, build, whichever the repository has. ` +
        "Every file a script creates or changes in the repository (a lockfile, lint --fix, a formatter, generated code) becomes part of your change, as if you had written it; what .gitignore excludes (node_modules, builds) stays in the sandbox. Run a script that rewrites files only when the request needs it. " +
        `Never a script that starts a server or watches files (dev, start, serve, watch): it is stopped after ${AI_SCRIPT_LIMITS.timeoutSecs / 60} minutes. Each call takes time: run what the change needs. ` +
        "Anything that is not the install or a script of package.json (a repository without one, a single test file, a tool of its own) runs with run_command.",
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

/** The tool that runs any command, offered with run_script, only when the installation has sandboxes. */
export const runCommandTool = (slugs?: string[]): LlmTool => ({
    name: "run_command",
    description:
        "Runs a shell command (sh -c) in the isolated sandbox of run_script, in a copy of the repository as it is now (your edits included), and returns the exit code and the end of the output: " +
        "the build and tests of a repository without package.json (mvn, ./gradlew, go, dotnet, python), one test file, a tool the scripts do not run. " +
        "Every file the command creates or changes in the repository becomes part of your change, as for run_script; what .gitignore excludes stays in the sandbox. " +
        "The network reaches the public package registries only: no database, no Docker, no internal service, nothing the deployed application talks to. " +
        `Dependencies of package.json are installed with run_script "${INSTALL_SCRIPT}", which updates the lockfile and is the only one given the repository's private registry, never with npm, pnpm or yarn here. ` +
        `Never a command that starts a server or watches files: it is stopped after timeout_seconds, ${AI_SCRIPT_LIMITS.timeoutSecs / 60} minutes at most. Each call takes time: run what the change needs.`,
    inputSchema: {
        type: "object",
        properties: {
            ...(slugs ? { repository: { type: "string", enum: slugs, description: "Slug of the repository to run it in." } } : {}),
            command: { type: "string", description: 'The command, run by sh -c, e.g. "mvn -B -q verify" or "go test ./internal/orders/...".' },
            workdir: { type: "string", description: 'Folder to run it in, relative to the root of the repository, e.g. "services/api". Leave out for the root.' },
            timeout_seconds: {
                type: "integer",
                minimum: 1,
                maximum: AI_SCRIPT_LIMITS.timeoutSecs,
                description: `Seconds before it is stopped, ${AI_SCRIPT_LIMITS.timeoutSecs} when left out.`
            }
        },
        required: slugs ? ["repository", "command"] : ["command"],
        additionalProperties: false
    }
})

/** The gateway no longer has the sandbox: deleted under the run, or its node lost. */
const isGone = (error: unknown) => (error as { code?: unknown } | null)?.code === "not_found"

/**
 * Runs the scripts of the repositories of one run, and the commands of the agent, in a sandbox. The sandbox
 * is asked for at the first script: a run that only reads and edits never creates one. Each repository is copied into it whole
 * at its first script of the run, and from then on only what the agent wrote or deleted is sent.
 *
 * What a script changes in the copy comes back with its output (a lockfile the install rewrote, the
 * files lint --fix corrected), for the toolbox to write into the working copy, which stays the only
 * truth: what .gitignore excludes, credentials, CI configuration and binaries never come back. Deleted
 * files are not seen: a script that removes a file of the repository leaves it in the proposal.
 */
export class AiChangeScriptRunner {
    private sandbox?: Promise<CommandSandbox>
    private prepared = false
    private readonly copied = new Set<ScriptRepository>()
    private readonly previewStarted = new Set<ScriptRepository>()
    /** What the agent wrote or deleted since the repository was last sent. */
    private readonly unsent = new Map<ScriptRepository, Set<string>>()
    /** Whether the image of the sandbox has a program, asked once per run. */
    private readonly programs = new Map<string, Promise<boolean>>()

    constructor(
        private readonly repositories: ScriptRepository[],
        private readonly open: () => Promise<CommandSandbox>,
        private readonly signal?: AbortSignal,
        private readonly previewsEnabled = false,
        private readonly onPreview?: (kind: "info", message: string) => Promise<void> | void,
        /** Told after each script and command, even one that throws: its time is what the sandbox costs. It must not throw. */
        private readonly onExec?: (exec: SandboxExec) => Promise<void> | void
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

    /** Whether package.json has this script: false without one, or with one that is not JSON. */
    async hasScript(repository: ScriptRepository, script: string): Promise<boolean> {
        const manifest = await this.manifestOf(repository).catch(() => undefined)
        return typeof manifest?.scripts?.[script] === "string"
    }

    /**
     * What finish waits for once the repository changed: its build script, else the check command of its files when
     * the sandbox has the program it needs, else nothing.
     */
    async checkOf(repository: ScriptRepository): Promise<RepositoryCheck | undefined> {
        if (await this.hasScript(repository, BUILD_SCRIPT)) return { tool: "run_script", run: BUILD_SCRIPT }
        const check = checkCommandFor(await repository.workingCopy.listFiles())
        return check && (await this.hasProgram(check.requires)) ? { tool: "run_command", run: check.command } : undefined
    }

    /**
     * Whether the image of the sandbox has this program: a check it cannot run would cost the agent a round for
     * nothing. Asked once per run, all repositories sharing the sandbox. One that cannot be asked has none, and is
     * asked again, in the sandbox that replaces it, next time.
     */
    private hasProgram(program: string): Promise<boolean> {
        let found = this.programs.get(program)
        if (!found) {
            found = this.sandboxForRun()
                .then(sandbox => sandbox.exec(["sh", "-c", 'command -v "$0" >/dev/null', program], { timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs, signal: this.signal }))
                .then(result => result.exitCode === 0)
                .catch(() => {
                    this.programs.delete(program)
                    this.forgetSandbox()
                    return false
                })
            this.programs.set(program, found)
        }
        return found
    }

    /**
     * `refusal` says why the paths a script changed cannot join the change, if they cannot: then none comes back.
     * A sandbox the gateway no longer has, deleted under the script, is replaced once before the agent hears of it.
     */
    async run(repository: ScriptRepository, script: string, refusal: (paths: string[]) => string | undefined = () => undefined): Promise<ScriptRun> {
        const manifest = await this.manifestOf(repository)
        if (script !== INSTALL_SCRIPT && typeof manifest.scripts?.[script] !== "string") {
            const scripts = Object.keys(manifest.scripts ?? {})
            throw new Error(`package.json has no script "${script}"${scripts.length ? `: it has ${scripts.join(", ")}` : ""}`)
        }
        const command = commandFor(await this.managerOf(repository, manifest), script)
        return this.runRetried(repository, { command, shown: command.join(" "), install: script === INSTALL_SCRIPT, npmrc: true, timeoutSecs: AI_SCRIPT_LIMITS.timeoutSecs, preview: true }, refusal)
    }

    /**
     * Runs a command of the agent with sh, in the copy of the repository or a folder of it, as a script but for the
     * preview, which it never starts: what it changes comes back the same way, see {@link run}.
     */
    async runCommand(
        repository: ScriptRepository,
        command: string,
        options: { workdir?: string; timeoutSecs?: number } = {},
        refusal: (paths: string[]) => string | undefined = () => undefined
    ): Promise<ScriptRun> {
        if (!command.trim()) throw new Error("The command is empty")
        const workdir = commandWorkdir(options.workdir)
        const run = {
            // A folder that does not exist is an exit code the agent reads, not a failure of the sandbox.
            command: workdir ? ["sh", "-c", 'cd -- "$1" || exit 1; exec sh -c "$0"', command, workdir] : ["sh", "-c", command],
            shown: workdir ? `cd ${workdir} && ${command}` : command,
            install: false,
            npmrc: false,
            timeoutSecs: options.timeoutSecs ?? AI_SCRIPT_LIMITS.timeoutSecs,
            preview: false
        }
        return this.runRetried(repository, run, refusal)
    }

    /** A sandbox the gateway no longer has, deleted under the run, is replaced once before the agent hears of it. */
    private runRetried(repository: ScriptRepository, run: SandboxRun, refusal: (paths: string[]) => string | undefined): Promise<ScriptRun> {
        return this.runInSandbox(repository, run, refusal).catch(error => {
            if (this.signal?.aborted || !isGone(error)) throw error
            return this.runInSandbox(repository, run, refusal)
        })
    }

    private async runInSandbox(repository: ScriptRepository, run: SandboxRun, refusal: (paths: string[]) => string | undefined): Promise<ScriptRun> {
        try {
            const sandbox = await this.sandboxForRun()
            await this.send(sandbox, repository)
            const marker = `${sandbox.root}/markers/${repository.slug}`
            const marked = await sandbox.exec(["sh", "-c", 'mkdir -p "$(dirname "$0")" && touch "$0"', marker], { timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs, signal: this.signal })
            ensureSucceeded("Marking the start of the script", marked)
            const startedAt = Date.now()
            let result: SandboxCommandResult
            try {
                result = await sandbox.exec(run.command, {
                    workdir: this.folderOf(sandbox, repository),
                    environment: this.environmentOf(sandbox, repository, run.install, run.npmrc),
                    timeoutSecs: run.timeoutSecs,
                    signal: this.signal
                })
            } finally {
                // Stopped at its timeout or aborted, it took the sandbox's time all the same.
                await this.onExec?.({ seconds: (Date.now() - startedAt) / 1000 })
            }
            // Read back whatever the exit code: lint --fix fails on what it could not fix, and still fixed the rest.
            const changes = await this.changesOf(sandbox, repository, marker, refusal)
            if (result.exitCode === 0 && run.preview) await this.startPreview(repository)
            return { output: describeResult(run.shown, result), ...changes }
        } catch (error) {
            this.forgetSandbox()
            throw error
        }
    }

    /** The sandbox may be gone, deleted as idle or its node lost: the next script starts again from a new one, its preview too. */
    private forgetSandbox() {
        this.sandbox = undefined
        this.prepared = false
        this.copied.clear()
        this.previewStarted.clear()
    }

    private sandboxForRun(): Promise<CommandSandbox> {
        this.sandbox ??= this.open()
        return this.sandbox
    }

    /** Keep a running preview's files in step with edits without restarting its dev server. */
    async sync(repository: ScriptRepository) {
        if (!this.previewsEnabled || !this.sandbox || !this.copied.has(repository)) return
        try {
            await this.send(await this.sandbox, repository)
        } catch (error) {
            // A sandbox the gateway no longer has fails no edit: the next script copies the repository into a new one.
            if (!isGone(error)) throw error
            this.forgetSandbox()
        }
    }

    /** Start and expose this repository's development server after its dependencies are installed. */
    async startPreview(repository: ScriptRepository, throwOnFailure = false): Promise<string | undefined> {
        if (!this.previewsEnabled || !repository.kind || this.previewStarted.has(repository)) return undefined
        this.previewStarted.add(repository)

        let url: string
        try {
            const sandbox = await this.sandboxForRun()
            await this.send(sandbox, repository)
            const files = new Set(await repository.workingCopy.listFiles())
            for (const change of await repository.workingCopy.changes()) {
                if (change.action === "delete") files.delete(change.path)
                else files.add(change.path)
            }
            const manifest = files.has("package.json") ? await this.manifestOf(repository) : undefined
            const manager = manifest ? await this.managerOf(repository, manifest) : undefined
            const plan = previewPlanFor(repository, files, manifest, manager)
            if (!plan) throw new Error(`No development server is configured for ${repository.runtime ?? repository.kind}`)
            if (plan.install) {
                const installed = await sandbox.exec(plan.install, {
                    workdir: this.folderOf(sandbox, repository),
                    environment: this.environmentOf(sandbox, repository, true),
                    timeoutSecs: AI_SCRIPT_LIMITS.timeoutSecs,
                    signal: this.signal
                })
                ensureSucceeded("Installing preview dependencies", installed)
            }

            const log = `${sandbox.root}/logs/${repository.slug}-preview.log`
            const started = await sandbox.exec(["sh", "-c", 'set -e; mkdir -p "$(dirname "$0")"; nohup "$@" </dev/null >"$0" 2>&1 & echo $!', log, ...plan.command], {
                workdir: this.folderOf(sandbox, repository),
                environment: {
                    ...this.environmentOf(sandbox, repository, true),
                    ...plan.environment
                },
                timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs,
                signal: this.signal
            })
            if (started.exitCode !== 0) throw new Error("The development server could not start")

            const ready = await sandbox.exec(
                [
                    "node",
                    "-e",
                    "const port=Number(process.argv[1]);const until=Date.now()+30000;const check=()=>fetch(`http://127.0.0.1:${port}`).then(()=>process.exit(0),()=>Date.now()<until?setTimeout(check,250):process.exit(1));check()",
                    String(plan.port)
                ],
                { workdir: this.folderOf(sandbox, repository), timeoutSecs: 35, signal: this.signal }
            )
            if (ready.exitCode !== 0) throw new Error("The development server did not become ready")
            if (!sandbox.exposeService) throw new Error("The sandbox does not support exposed services")

            const kind = repository.kind
            const name = `preview-${kind === "frontend" ? "fe" : "be"}-${createHash("sha256").update(repository.slug).digest("hex").slice(0, 8)}`
            url = await sandbox.exposeService(plan.port, name)
        } catch (error) {
            if (this.signal?.aborted) throw error
            await this.onPreview?.("info", `preview-failed|${repository.kind}`)
            if (throwOnFailure) throw error
            return undefined
        }
        await this.onPreview?.("info", `preview-ready|${repository.kind}|${repository.slug}|${encodeURIComponent(url)}`)
        return url
    }

    private folderOf(sandbox: CommandSandbox, repository: ScriptRepository) {
        return `${sandbox.root}/repositories/${repository.slug}`
    }

    /** Out of the copy: no script lists it as a change, and two repositories may install from different registries. */
    private npmrcOf(sandbox: CommandSandbox, repository: ScriptRepository) {
        return `${sandbox.root}/npmrc/${repository.slug}`
    }

    /**
     * Caches and the home of every tool under the root: the only folder the sandbox is sure to let them write.
     * CI keeps test runners out of watch mode, but not for the install: under CI pnpm and yarn freeze the
     * lockfile, and an install after the agent changed a dependency would fail. The npmrc of the repository is the
     * user configuration npm, pnpm and yarn 1 read: given to the package manager only, not to a command of the agent.
     */
    private environmentOf(sandbox: CommandSandbox, repository: ScriptRepository, install: boolean, npmrc = true): Record<string, string> {
        return {
            ...(install ? {} : { CI: "true" }),
            ...(npmrc && repository.npmrc ? { npm_config_userconfig: this.npmrcOf(sandbox, repository) } : {}),
            HOME: `${sandbox.root}/home`,
            COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
            NO_COLOR: "1",
            FORCE_COLOR: "0"
        }
    }

    /**
     * The files the script wrote whose content differs from the working copy, read back. A file that may not
     * be proposed is sent again before the next script, so the copy goes back to what the working copy holds.
     */
    private async changesOf(sandbox: CommandSandbox, repository: ScriptRepository, marker: string, refusal: (paths: string[]) => string | undefined): Promise<Omit<ScriptRun, "output">> {
        const options = { workdir: this.folderOf(sandbox, repository), timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs, signal: this.signal }
        const listing = await sandbox.exec(["sh", "-c", LIST_CHANGES, marker], options)
        ensureSucceeded("Listing what the script changed", listing)
        const lines = listing.output.split("\n").filter(Boolean)
        if (listing.cutBytes > 0 || lines.length > AI_SCRIPT_LIMITS.maxListedChanges) {
            return { files: [], left: [`the script changed more than ${AI_SCRIPT_LIMITS.maxListedChanges} files: none is part of your change`] }
        }
        const changed: { path: string; hash: string }[] = []
        const refused: string[] = []
        for (const line of lines) {
            const match = CHANGE_LINE.exec(line)
            if (!match) continue
            const [, hash, requested] = match
            const resolved = await resolveInsideWorkingCopy(repository.workingCopy.dir, requested).catch(() => undefined)
            if (!resolved || isSecretPath(resolved.relative) || (await repository.workingCopy.isIgnored(resolved.relative))) continue
            const local = await fs.lstat(resolved.absolute).catch(() => undefined)
            if (local?.isFile() && sha256(await fs.readFile(resolved.absolute)) === hash) continue
            if (local && !local.isFile()) refused.push(resolved.relative)
            else if (isProtectedPath(resolved.relative) && !isLockfilePath(resolved.relative)) refused.push(resolved.relative)
            else changed.push({ path: resolved.relative, hash })
        }
        // The listing comes in the order of the sandbox's filesystem: by path, the same change reads the same every time
        refused.sort()
        changed.sort((a, b) => a.path.localeCompare(b.path))
        const left = refused.length ? [`${refused.join(", ")}: CI configuration, registry configuration or not a regular file, not part of your change`] : []
        const paths = changed.map(file => file.path)
        const tooMany = paths.length ? refusal(paths) : undefined
        if (tooMany) return this.leave(repository, [...refused, ...paths], [...left, `${paths.join(", ")}: ${tooMany}`])

        const files: ScriptChangedFile[] = []
        let bytes = 0
        for (const { path } of changed) {
            const content = await this.download(sandbox, repository, path, AI_SCRIPT_LIMITS.maxDownloadBytes - bytes)
            if (content === undefined) {
                return this.leave(
                    repository,
                    [...refused, ...paths],
                    [...left, `${paths.join(", ")}: more than the ${AI_SCRIPT_LIMITS.maxDownloadBytes / 1024 / 1024} MB read back from one script, not part of your change`]
                )
            }
            if (looksBinary(content)) {
                refused.push(path)
                left.push(`${path}: a binary file, not part of your change`)
                continue
            }
            bytes += content.length
            files.push({ path, content })
        }
        for (const path of refused) this.touch(repository, path)
        return { files, left }
    }

    private leave(repository: ScriptRepository, paths: string[], left: string[]): Omit<ScriptRun, "output"> {
        for (const path of paths) this.touch(repository, path)
        return { files: [], left }
    }

    /**
     * One file of the copy, gzipped in the sandbox and read in pieces: what a command returns is cut past
     * 64 KB, and a lockfile is bigger. Undefined when it holds more than `maxBytes`.
     */
    private async download(sandbox: CommandSandbox, repository: ScriptRepository, relative: string, maxBytes: number): Promise<Buffer | undefined> {
        const options = { workdir: this.folderOf(sandbox, repository), timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs, signal: this.signal }
        const archive = `${sandbox.root}/downloads/${repository.slug}-${randomUUID()}.gz`
        const what = `Reading ${relative} back from the sandbox`
        try {
            const packed = await sandbox.exec(["sh", "-c", 'mkdir -p "$(dirname "$1")" && gzip -c < "$0" > "$1" && wc -c < "$1"', relative, archive], options)
            ensureSucceeded(what, packed)
            const size = Number(packed.output.trim())
            if (!Number.isInteger(size)) throw new Error(`${what} failed: no size in ${packed.output.slice(-200)}`)
            const pieces: Buffer[] = []
            for (let offset = 0; offset < size; offset += AI_SCRIPT_LIMITS.downloadChunkBytes) {
                const piece = await sandbox.exec(["sh", "-c", 'tail -c +"$1" "$0" | head -c "$2" | base64', archive, String(offset + 1), String(AI_SCRIPT_LIMITS.downloadChunkBytes)], options)
                ensureSucceeded(what, piece)
                if (piece.cutBytes > 0) throw new Error(`${what} failed: a piece came back cut`)
                pieces.push(Buffer.from(piece.output, "base64"))
            }
            try {
                return gunzipSync(Buffer.concat(pieces), { maxOutputLength: Math.max(1, maxBytes) })
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") return undefined
                throw error
            }
        } finally {
            await sandbox.exec(["rm", "-f", archive], options).catch(() => undefined)
        }
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
            if (repository.npmrc) await this.writeNpmrc(sandbox, repository, repository.npmrc)
            this.copied.add(repository)
        } else if (unsent.size) {
            const { entries, removed } = await this.entriesOf(repository, [...unsent])
            await this.extract(sandbox, repository, entries.length ? tarGz(entries) : undefined, 'rm -f -- "$@"', removed)
        }
        this.unsent.delete(repository)
    }

    /** On stdin, never in the command line a gateway may log; readable by the sandbox user only. */
    private async writeNpmrc(sandbox: CommandSandbox, repository: ScriptRepository, npmrc: string) {
        const written = await sandbox.exec(["sh", "-c", 'mkdir -p "$(dirname "$0")" && umask 077 && cat > "$0"', this.npmrcOf(sandbox, repository)], {
            stdin: Buffer.from(`${npmrc.trimEnd()}\n`, "utf8"),
            timeoutSecs: AI_SCRIPT_LIMITS.uploadTimeoutSecs,
            signal: this.signal
        })
        ensureSucceeded(`Writing the .npmrc of ${repository.slug} into the sandbox`, written)
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
            ensureSucceeded(what, await sandbox.exec(["sh", "-c", `set -e\n${before}\ntar -xzmf -`, "sh", ...args], { ...options, stdin: archive }))
            return
        }
        const file = `${sandbox.root}/uploads/${repository.slug}-${randomUUID()}.tgz`
        for (let offset = 0; offset < archive.length; offset += AI_SCRIPT_LIMITS.uploadChunkBytes) {
            const piece = archive.subarray(offset, offset + AI_SCRIPT_LIMITS.uploadChunkBytes)
            ensureSucceeded(what, await sandbox.exec(["sh", "-c", 'mkdir -p "$(dirname "$0")" && cat >> "$0"', file], { ...options, stdin: piece }))
        }
        ensureSucceeded(
            what,
            await sandbox.exec(["sh", "-c", `${before} && tar -xzmf "$ARCHIVE"; status=$?; rm -f "$ARCHIVE"; exit $status`, "sh", ...args], { ...options, environment: { ARCHIVE: file } })
        )
    }
}
