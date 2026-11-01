import { execFileSync, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandSandbox, SandboxExecOptions } from "../sandbox/commandSandbox"
import { GitWorkingCopy } from "../workspace/GitWorkingCopy"
import {
    AI_SCRIPT_LIMITS,
    AiChangeScriptRunner,
    checkCommandFor,
    commandFor,
    commandWorkdir,
    conversationPortOf,
    PREVIEW_FILE,
    PREVIEW_GATEWAY,
    parsePreviewOverride,
    previewPlanFor,
    ScriptRepository
} from "./aiChangeScripts"
import { AiChangeToolbox } from "./aiChangeToolbox"

const hasTools = ["git", "tar", "npm"].every(tool => spawnSync(tool, ["--version"]).status === 0)

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }

/** A committed repository on disk: the runner copies what HEAD tracks plus what the agent wrote. */
const makeRepository = (files: Record<string, string | Buffer>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-scripts-"))
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        fs.writeFileSync(path.join(dir, file), content)
    }
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, env: gitEnv })
    execFileSync("git", ["add", "."], { cwd: dir, env: gitEnv })
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, env: gitEnv })
    return dir
}

const workingCopyOf = (dir: string) => new GitWorkingCopy(dir, "http://unused", { username: "", password: "" })

const manifest = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "shop", version: "1.0.0", scripts, ...extra })

/** Runs every command on this machine under a folder standing for the sandbox: the shell scripts the runner sends really run. */
class LocalSandbox implements CommandSandbox {
    readonly commands: string[][] = []

    constructor(readonly root: string) {}

    async exec(command: string[], options: SandboxExecOptions = {}) {
        this.commands.push(command)
        const result = spawnSync(command[0], command.slice(1), { cwd: options.workdir ?? this.root, input: options.stdin, env: { ...process.env, ...options.environment } })
        return { exitCode: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, cutBytes: 0 }
    }
}

describe.skipIf(!hasTools)("AiChangeScriptRunner", () => {
    let dir: string
    let root: string
    let sandbox: LocalSandbox
    let repository: ScriptRepository

    beforeEach(() => {
        dir = makeRepository({
            "package.json": manifest({ show: "node -e \"process.stdout.write(require('fs').readFileSync('src/a.txt','utf8'))\"", fail: "node -e \"console.error('boom'); process.exit(3)\"" }),
            "src/a.txt": "from the repository",
            "src/old.txt": "to delete",
            ".env": "API_TOKEN=do-not-copy"
        })
        root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-sandbox-"))
        sandbox = new LocalSandbox(root)
        repository = { slug: "shop", workingCopy: workingCopyOf(dir) }
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.rmSync(root, { recursive: true, force: true })
    })

    const copy = (relative: string) => path.join(root, "repositories", "shop", relative)

    it("Given a repository, when a script runs, then it runs on a copy of it with npm and its output comes back", async () => {
        const { output, files } = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "show")
        expect(output).toContain("$ npm run show")
        expect(output).toContain("exit code 0 (success)")
        expect(output).toContain("from the repository")
        expect(fs.readFileSync(copy("src/a.txt"), "utf8")).toBe("from the repository")
        // The copy itself is no change of the script.
        expect(files).toEqual([])
    })

    it("Given a .env in the repository, when it is copied, then the secret stays out of the sandbox", async () => {
        await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "show")
        expect(fs.existsSync(copy(".env"))).toBe(false)
    })

    it("Given a failing script, then its exit code and the end of its output come back as a result, not an error", async () => {
        const { output } = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "fail")
        expect(output).toContain("exit code 3")
        expect(output).not.toContain("success")
        expect(output).toContain("boom")
    })

    it("Given a script package.json does not have, then it is refused naming the ones it has, and no sandbox is asked for", async () => {
        const open = vi.fn(async () => sandbox)
        await expect(new AiChangeScriptRunner([repository], open).run(repository, "deploy")).rejects.toThrow('package.json has no script "deploy": it has show, fail')
        expect(open).not.toHaveBeenCalled()
    })

    it("Given edits after the first script, when the next one runs, then only they are sent and a deleted file goes", async () => {
        const runner = new AiChangeScriptRunner([repository], async () => sandbox)
        await runner.run(repository, "show")
        fs.writeFileSync(path.join(dir, "src/a.txt"), "edited by the agent")
        fs.rmSync(path.join(dir, "src/old.txt"))
        runner.touch(repository, "src/a.txt")
        runner.touch(repository, "src/old.txt")
        sandbox.commands.length = 0

        expect((await runner.run(repository, "show")).output).toContain("edited by the agent")
        expect(fs.existsSync(copy("src/old.txt"))).toBe(false)
        // Neither the folders prepared again nor the copy replaced: one command sends the change, then the script runs between its marker and the listing of what it changed.
        expect(sandbox.commands).toHaveLength(4)
        expect(sandbox.commands[0].join(" ")).toContain('rm -f -- "$@"')
    })

    it("Given the copy of an earlier message, when a new run copies the repository, then stale files and other repositories go while node_modules stays", async () => {
        fs.mkdirSync(copy("node_modules/dep"), { recursive: true })
        fs.writeFileSync(copy("node_modules/dep/index.js"), "installed")
        fs.writeFileSync(copy("stale.txt"), "from an earlier message")
        fs.mkdirSync(path.join(root, "repositories", "other-repository"), { recursive: true })

        await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "show")

        expect(fs.readFileSync(copy("node_modules/dep/index.js"), "utf8")).toBe("installed")
        expect(fs.existsSync(copy("stale.txt"))).toBe(false)
        expect(fs.existsSync(path.join(root, "repositories", "other-repository"))).toBe(false)
    })

    it("Given an archive bigger than one piece, when it is copied, then it is sent in pieces and comes back identical", async () => {
        // Random: gzip cannot shrink it below the size of a piece.
        const noise = randomBytes(20_000)
        fs.writeFileSync(path.join(dir, "assets.bin"), noise)
        repository.workingCopy = workingCopyOf(dir)
        const runner = new AiChangeScriptRunner([repository], async () => sandbox)
        runner.touch(repository, "assets.bin")
        const chunk = AI_SCRIPT_LIMITS.uploadChunkBytes
        AI_SCRIPT_LIMITS.uploadChunkBytes = 4_096
        try {
            await runner.run(repository, "show")
        } finally {
            AI_SCRIPT_LIMITS.uploadChunkBytes = chunk
        }
        expect(fs.readFileSync(copy("assets.bin")).equals(noise)).toBe(true)
        expect(sandbox.commands.filter(command => command.join(" ").includes("cat >>")).length).toBeGreaterThan(1)
        expect(fs.readdirSync(path.join(root, "uploads"))).toEqual([])
    })

    it("Given a sandbox that fails, when the next script runs, then a new sandbox is asked for and the repository copied again", async () => {
        const broken: CommandSandbox = { root, exec: vi.fn().mockRejectedValue(new Error("sandbox not found")) }
        const open = vi.fn<() => Promise<CommandSandbox>>().mockResolvedValueOnce(broken).mockResolvedValueOnce(sandbox)
        const runner = new AiChangeScriptRunner([repository], open)

        await expect(runner.run(repository, "show")).rejects.toThrow("sandbox not found")
        expect((await runner.run(repository, "show")).output).toContain("from the repository")
        expect(open).toHaveBeenCalledTimes(2)
    })

    it("Given a sandbox the gateway no longer has, when a script runs, then it runs again once in a new sandbox and the agent sees its result", async () => {
        const deleted: CommandSandbox = { root, exec: vi.fn().mockRejectedValue(Object.assign(new Error("[not_found] sandbox not found"), { code: "not_found" })) }
        const open = vi.fn<() => Promise<CommandSandbox>>().mockResolvedValueOnce(deleted).mockResolvedValueOnce(sandbox)

        expect((await new AiChangeScriptRunner([repository], open).run(repository, "show")).output).toContain("from the repository")
        expect(open).toHaveBeenCalledTimes(2)
    })

    it("Given a sandbox the gateway loses twice in a row, when a script runs, then the agent hears of it", async () => {
        const deleted: CommandSandbox = { root, exec: vi.fn().mockRejectedValue(Object.assign(new Error("[not_found] sandbox not found"), { code: "not_found" })) }
        const open = vi.fn(async () => deleted)

        await expect(new AiChangeScriptRunner([repository], open).run(repository, "show")).rejects.toThrow("sandbox not found")
        expect(open).toHaveBeenCalledTimes(2)
    })

    it("Given a token or a private key across the cut of a long output, then neither half reaches the agent", async () => {
        const token = `ghp_${"t".repeat(36)}`
        const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtopsecretkeymaterial\n-----END RSA PRIVATE KEY-----"
        const filler = `${"y".repeat(100)}\n`.repeat(Math.ceil(AI_SCRIPT_LIMITS.maxOutputChars / 101))
        for (const [secret, leak] of [
            [token, "tttttttttt"],
            [key, "topsecretkeymaterial"]
        ]) {
            // The secret ends right where the end the agent reads starts, before masking.
            const output = `${"x\n".repeat(5_000)}${secret}${filler.slice(-(AI_SCRIPT_LIMITS.maxOutputChars - 25))}`
            const long: CommandSandbox = { root, exec: vi.fn(async () => ({ exitCode: 0, output, cutBytes: 0 })) }
            const run = await new AiChangeScriptRunner([repository], async () => long).run(repository, "show")
            expect(run.output).not.toContain(leak)
            expect(run.output).toContain("the start of the output is cut")
        }
    })

    it("Given an output longer than the agent reads, then only its end comes back, said to be cut", async () => {
        const long: CommandSandbox = { root, exec: vi.fn(async () => ({ exitCode: 0, output: `${"x".repeat(AI_SCRIPT_LIMITS.maxOutputChars)}THE END`, cutBytes: 0 })) }
        const { output } = await new AiChangeScriptRunner([repository], async () => long).run(repository, "show")
        expect(output).toContain("the start of the output is cut")
        expect(output.endsWith("THE END")).toBe(true)
    })
})

/** A script of package.json writing files in its copy, as lint --fix, a formatter or an install do. */
const writes = (files: Record<string, string>) =>
    `node -e "const fs=require('fs'),path=require('path');for(const [f,c] of Object.entries(${JSON.stringify(files).replace(/"/g, '\\"')})){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,c)}"`

describe.skipIf(!hasTools)("AiChangeScriptRunner changes of a script", () => {
    let dir: string
    let root: string
    let sandbox: LocalSandbox
    let repository: ScriptRepository

    const setUp = (scripts: Record<string, string>, files: Record<string, string> = {}) => {
        dir = makeRepository({ "package.json": manifest(scripts), ".gitignore": "dist/\n", "src/a.js": "const a = 1", "src/b.js": "const b = 2", ...files })
        repository = { slug: "shop", workingCopy: workingCopyOf(dir) }
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-sandbox-"))
        sandbox = new LocalSandbox(root)
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.rmSync(root, { recursive: true, force: true })
    })

    it("Given a script that fixes a file and creates one, then both come back with their content, and a file it rewrote unchanged does not", async () => {
        setUp({ fix: writes({ "src/a.js": "const a = 1;\n", "src/b.js": "const b = 2", "src/generated.js": "export {}" }) })
        const run = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "fix")
        expect(Object.fromEntries(run.files.map(file => [file.path, file.content.toString("utf8")]))).toEqual({ "src/a.js": "const a = 1;\n", "src/generated.js": "export {}" })
        expect(run.left).toEqual([])
    })

    it("Given an install that rewrites the lockfile, then the lockfile comes back", async () => {
        setUp({ relock: writes({ "package-lock.json": '{"lockfileVersion":3,"packages":{}}' }) }, { "package-lock.json": '{"lockfileVersion":3}' })
        const run = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "relock")
        expect(run.files.map(file => file.path)).toEqual(["package-lock.json"])
    })

    it("Given a script that writes ignored files, secrets and CI configuration, then none comes back and the CI file is sent again", async () => {
        setUp({ build: writes({ "dist/main.js": "built", ".env": "TOKEN=x", ".github/workflows/ci.yml": "on: push" }), noop: "node -e 0" })
        const runner = new AiChangeScriptRunner([repository], async () => sandbox)
        const run = await runner.run(repository, "build")
        expect(run.files).toEqual([])
        expect(run.left.join("\n")).toContain(".github/workflows/ci.yml")
        // Sent again before the next script: the working copy has none, so it goes from the copy.
        await runner.run(repository, "noop")
        expect(fs.existsSync(path.join(root, "repositories/shop/.github/workflows/ci.yml"))).toBe(false)
        expect(fs.existsSync(path.join(root, "repositories/shop/dist/main.js"))).toBe(true)
    })

    it("Given a file bigger than a piece, then it is read back in pieces and comes back identical", async () => {
        const big = randomBytes(30_000).toString("hex")
        setUp({ big: writes({ "src/big.txt": big }) })
        const chunk = AI_SCRIPT_LIMITS.downloadChunkBytes
        AI_SCRIPT_LIMITS.downloadChunkBytes = 4_096
        try {
            const run = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "big")
            expect(run.files[0].content.toString("utf8")).toBe(big)
        } finally {
            AI_SCRIPT_LIMITS.downloadChunkBytes = chunk
        }
        expect(sandbox.commands.filter(command => command.join(" ").includes("head -c")).length).toBeGreaterThan(1)
        expect(fs.readdirSync(path.join(root, "downloads"))).toEqual([])
    })

    it("Given changes the toolbox refuses, then none comes back, the reason is told and nothing is read", async () => {
        setUp({ fix: writes({ "src/a.js": "fixed", "src/b.js": "fixed" }) })
        const run = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "fix", paths => `${paths.length} files are too many`)
        expect(run.files).toEqual([])
        expect(run.left).toEqual(["src/a.js, src/b.js: 2 files are too many"])
        expect(sandbox.commands.some(command => command.join(" ").includes("gzip"))).toBe(false)
    })

    it("Given a command in a folder of the repository, then it runs there with sh and what it writes comes back as a change", async () => {
        setUp({})
        const run = await new AiChangeScriptRunner([repository], async () => sandbox).runCommand(repository, "pwd && printf generated > out.txt", { workdir: "./src/" })

        expect(run.output).toContain("$ cd src && pwd && printf generated > out.txt")
        expect(run.output).toContain("exit code 0 (success)")
        expect(run.output).toContain(path.join(root, "repositories/shop/src"))
        expect(run.files.map(file => [file.path, file.content.toString("utf8")])).toEqual([["src/out.txt", "generated"]])
        expect(sandbox.commands).toContainEqual(["sh", "-c", 'cd -- "$1" || exit 1; exec sh -c "$0"', "pwd && printf generated > out.txt", "src"])
    })

    it("Given a folder that does not exist, then the command fails with an exit code the agent reads and the sandbox is kept", async () => {
        setUp({})
        const open = vi.fn(async () => sandbox)
        const runner = new AiChangeScriptRunner([repository], open)

        expect((await runner.runCommand(repository, "ls", { workdir: "missing" })).output).toMatch(/exit code [1-9]/)
        expect((await runner.runCommand(repository, "ls")).output).toContain("exit code 0")
        expect(open).toHaveBeenCalledTimes(1)
    })

    it("Given a command printing credentials, then the agent reads them masked", async () => {
        setUp({})
        const { output } = await new AiChangeScriptRunner([repository], async () => sandbox).runCommand(repository, "echo NPM_TOKEN=abc123def456 && echo https://ci:s3cr3tpass@example.com/repo.git")

        expect(output).toContain("NPM_TOKEN=[REDACTED]")
        expect(output).not.toContain("abc123def456")
        expect(output).not.toContain("s3cr3tpass")
    })

    it("Given a workdir that is absolute or leads out, then the command is refused before any sandbox is asked for", async () => {
        setUp({})
        const open = vi.fn(async () => sandbox)
        const runner = new AiChangeScriptRunner([repository], open)

        await expect(runner.runCommand(repository, "ls", { workdir: "/etc" })).rejects.toThrow("is absolute")
        await expect(runner.runCommand(repository, "ls", { workdir: "src/../../other" })).rejects.toThrow('".." is not allowed')
        await expect(runner.runCommand(repository, "  ")).rejects.toThrow("The command is empty")
        expect(open).not.toHaveBeenCalled()
    })

    it("Given a hook, when a script and a command run, then it is told how long each took", async () => {
        setUp({ build: "node -e 0" })
        const onExec = vi.fn()
        const runner = new AiChangeScriptRunner([repository], async () => sandbox, { onExec })

        await runner.runCommand(repository, "true", { timeoutSecs: 30 })
        await runner.run(repository, "build")

        expect(onExec).toHaveBeenCalledTimes(2)
        expect(onExec).toHaveBeenCalledWith({ seconds: expect.any(Number) })
    })

    it("Given a command that throws in the sandbox, a timeout or an abort, then its time is counted all the same", async () => {
        setUp({})
        const onExec = vi.fn()
        const failing: CommandSandbox = {
            root,
            exec: vi.fn(async (command: string[], options?: SandboxExecOptions) => {
                if (command[2] === "sleep 600") throw new Error("deadline exceeded")
                return sandbox.exec(command, options)
            })
        }

        await expect(new AiChangeScriptRunner([repository], async () => failing, { onExec }).runCommand(repository, "sleep 600")).rejects.toThrow("deadline exceeded")
        expect(onExec).toHaveBeenCalledWith({ seconds: expect.any(Number) })
    })

    it("Given the dev server an earlier run of the conversation left and its port taken by another, when the preview starts again, then the earlier one is stopped and a free port is used", async () => {
        const taken = net.createServer()
        await new Promise<void>(resolve => taken.listen(0, "0.0.0.0", resolve))
        const port = (taken.address() as net.AddressInfo).port
        // Started by a shell that exits at once, as the dev server is: init reaps it once stopped, so it does not linger as a zombie.
        const leftover = Number(execFileSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim())
        const alive = () => {
            try {
                process.kill(leftover, 0)
                return true
            } catch {
                return false
            }
        }
        fs.mkdirSync(path.join(root, "previews"))
        fs.writeFileSync(path.join(root, "previews", "orders.pid"), String(leftover))
        const exposed = vi.fn(async (_port: number, _name: string) => "https://preview.example.test")
        // Only the stop and the search for a port really run: no dev server is started here.
        const probing: CommandSandbox = {
            root,
            exec: async (command, options) => (command[2]?.includes("exec node") ? sandbox.exec(command, options) : { exitCode: 0, output: "", cutBytes: 0 }),
            exposeService: exposed
        }
        const backend = makeRepository({ "package.json": manifest({ dev: "node server.js" }) })
        const orders: ScriptRepository = { slug: "orders", kind: "backend", runtime: "NODE", port, workingCopy: workingCopyOf(backend) }

        try {
            await new AiChangeScriptRunner([orders], async () => probing, { previewsEnabled: true }).startPreview(orders, true)

            // The stop waits for it to be gone before looking for a port.
            expect(alive()).toBe(false)
            expect(fs.existsSync(path.join(root, "previews", "orders.pid"))).toBe(false)
            expect(exposed).toHaveBeenCalledWith(expect.any(Number), expect.any(String))
            expect(exposed.mock.calls[0][0]).not.toBe(port)
        } finally {
            if (alive()) process.kill(leftover)
            taken.close()
            fs.rmSync(backend, { recursive: true, force: true })
        }
    })
})

describe("checkCommandFor", () => {
    it("Given the files at the root of a Maven, Gradle, Go or .NET repository, then the command its CI most likely builds it with comes back", () => {
        expect(checkCommandFor(["pom.xml", "src/main/java/App.java"])).toEqual({ command: "mvn -B -q verify", requires: "mvn" })
        expect(checkCommandFor(["pom.xml", "mvnw"])).toEqual({ command: "./mvnw -B -q verify", requires: "java" })
        expect(checkCommandFor(["gradlew", "build.gradle.kts"])).toEqual({ command: "./gradlew build --no-daemon -q", requires: "java" })
        expect(checkCommandFor(["gradlew", "build.gradle"])).toEqual({ command: "./gradlew build --no-daemon -q", requires: "java" })
        expect(checkCommandFor(["build.gradle.kts", "settings.gradle.kts"])).toEqual({ command: "gradle build --no-daemon -q", requires: "gradle" })
        expect(checkCommandFor(["go.mod", "main.go"])).toEqual({ command: "go build ./... && go vet ./...", requires: "go" })
        expect(checkCommandFor(["Accounts.sln", "Accounts.csproj", "Tests.csproj"])).toEqual({ command: "dotnet build", requires: "dotnet" })
        expect(checkCommandFor(["Accounts.csproj", "Program.cs"])).toEqual({ command: "dotnet build", requires: "dotnet" })
    })

    it("Given no known build file at the root, or build files in a folder only, then there is no check", () => {
        expect(checkCommandFor(["requirements.txt", "app/main.py"])).toBeUndefined()
        expect(checkCommandFor(["services/orders/pom.xml", "src/Api/Api.csproj"])).toBeUndefined()
        // dotnet build would not know which to build.
        expect(checkCommandFor(["Accounts.sln", "Billing.sln"])).toBeUndefined()
        expect(checkCommandFor(["Accounts.csproj", "Tests.csproj"])).toBeUndefined()
        expect(checkCommandFor([])).toBeUndefined()
    })
})

describe("commandWorkdir", () => {
    it("Given a folder of the repository, then it comes back normalized, and the root as none", () => {
        expect(commandWorkdir("services/api/")).toBe("services/api")
        expect(commandWorkdir("./services//api")).toBe("services/api")
        expect(commandWorkdir(".")).toBeUndefined()
        expect(commandWorkdir("")).toBeUndefined()
        expect(commandWorkdir(undefined)).toBeUndefined()
    })

    it("Given an absolute path or a way out, then it is refused", () => {
        for (const workdir of ["/sandbox", "\\server\\share", "C:/repo", "..", "src/../..", "a\\..\\b"]) expect(() => commandWorkdir(workdir)).toThrow()
    })
})

describe("commandFor", () => {
    it("Given each package manager, then npm runs as itself and pnpm and yarn through corepack", () => {
        expect(commandFor("npm", "install")).toEqual(["npm", "install"])
        expect(commandFor("npm", "test")).toEqual(["npm", "run", "test"])
        expect(commandFor("pnpm", "install")).toEqual(["corepack", "pnpm", "install", "--config.confirmModulesPurge=false"])
        expect(commandFor("yarn", "lint")).toEqual(["corepack", "yarn", "run", "lint"])
    })
})

describe.skipIf(!hasTools)("AiChangeScriptRunner package manager", () => {
    const recording = () => ({
        root: "/sandbox",
        exec: vi.fn(async (_command: string[], _options?: SandboxExecOptions) => ({ exitCode: 0, output: "", cutBytes: 0 })),
        exposeService: vi.fn(async (_port: number, _name: string) => "https://preview.example.test")
    })

    /** The call that ran the script: the others are shell scripts preparing the copy or reading it. */
    const scriptCall = (sandbox: ReturnType<typeof recording>) => sandbox.exec.mock.calls.find(([command]) => command[0] !== "sh")
    const lastCommand = (sandbox: ReturnType<typeof recording>) => scriptCall(sandbox)?.[0]

    it("Given a pnpm lockfile, when a script runs, then pnpm runs it in the folder of the repository", async () => {
        const dir = makeRepository({ "package.json": manifest({ test: "vitest" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })
        const sandbox = recording()
        const repository = { slug: "shop", workingCopy: workingCopyOf(dir) }
        await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "test")
        expect(lastCommand(sandbox)).toEqual(["corepack", "pnpm", "run", "test"])
        expect(scriptCall(sandbox)?.[1]).toMatchObject({
            workdir: "/sandbox/repositories/shop",
            timeoutSecs: AI_SCRIPT_LIMITS.timeoutSecs,
            environment: { CI: "true", HOME: "/sandbox/home" }
        })
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given a packageManager in package.json, then it wins over the lockfile", async () => {
        const dir = makeRepository({ "package.json": manifest({}, { packageManager: "yarn@4.5.0" }), "package-lock.json": "{}" })
        const sandbox = recording()
        const repository = { slug: "shop", workingCopy: workingCopyOf(dir) }
        await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "install")
        expect(lastCommand(sandbox)).toEqual(["corepack", "yarn", "install"])
        // Under CI pnpm and yarn freeze the lockfile: the install would fail once the agent changes a dependency.
        expect(scriptCall(sandbox)?.[1]?.environment).not.toHaveProperty("CI")
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given an enabled frontend preview, when started, then its dev server is started and exposed", async () => {
        const dir = makeRepository({ "package.json": manifest({ dev: "vite" }) })
        const sandbox = recording()
        const repository = { slug: "shop", kind: "frontend" as const, workingCopy: workingCopyOf(dir) }
        const onPreview = vi.fn()
        const runner = new AiChangeScriptRunner([repository], async () => sandbox, { previewsEnabled: true, onPreview })

        await expect(runner.startPreview(repository)).resolves.toBe("https://preview.example.test")

        expect(sandbox.exec.mock.calls.find(([command]) => command[2]?.includes("nohup"))).toEqual([
            [
                "sh",
                "-c",
                expect.any(String),
                "/sandbox/logs/shop-preview.log",
                "/sandbox/previews/shop.pid",
                "npm",
                "run",
                "dev",
                "--",
                "--host",
                "0.0.0.0",
                "--port",
                String(conversationPortOf("/sandbox/shop")),
                "--strictPort"
            ],
            expect.objectContaining({ workdir: "/sandbox/repositories/shop" })
        ])
        expect(sandbox.exposeService).toHaveBeenCalledWith(conversationPortOf("/sandbox/shop"), expect.stringMatching(/^preview-fe-/))
        expect(onPreview).toHaveBeenCalledWith("info", "preview-ready|frontend|shop|https%3A%2F%2Fpreview.example.test")
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given a live preview opened from the console, when it starts, then the dependencies are installed first unless the copy already has them", async () => {
        const dir = makeRepository({ "package.json": manifest({ dev: "vite" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })
        const sandbox = recording()
        const repository = { slug: "shop", kind: "frontend" as const, workingCopy: workingCopyOf(dir) }

        await new AiChangeScriptRunner([repository], async () => sandbox, { previewsEnabled: true }).startPreview(repository, true)

        const commands = sandbox.exec.mock.calls.map(([command]) => command)
        const install = commands.findIndex(command => command[2]?.includes("node_modules ] ||"))
        expect(commands[install]?.slice(3)).toEqual(["sh", "corepack", "pnpm", "install", "--config.confirmModulesPurge=false"])
        expect(sandbox.exec.mock.calls[install]?.[1]?.environment).not.toHaveProperty("CI")
        expect(install).toBeLessThan(commands.findIndex(command => command[2]?.includes("nohup")))
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given another conversation of the sandbox holding the port of the preview, when it starts, then it listens and is exposed on the free port the sandbox found", async () => {
        const dir = makeRepository({ "package.json": manifest({ dev: "vite" }) })
        const sandbox = recording()
        sandbox.exec.mockImplementation(async (command: string[]) => ({ exitCode: 0, output: command[2]?.includes("exec node") ? "41234\n" : "", cutBytes: 0 }))
        const repository = { slug: "shop", kind: "frontend" as const, workingCopy: workingCopyOf(dir) }

        await new AiChangeScriptRunner([repository], async () => sandbox, { previewsEnabled: true }).startPreview(repository)

        expect(sandbox.exec.mock.calls.find(([command]) => command[2]?.includes("exec node"))?.[0].slice(3, 5)).toEqual(["/sandbox/previews/shop.pid", String(conversationPortOf("/sandbox/shop"))])
        expect(sandbox.exec.mock.calls.find(([command]) => command[2]?.includes("nohup"))?.[0].slice(-3)).toEqual(["--port", "41234", "--strictPort"])
        expect(sandbox.exposeService).toHaveBeenCalledWith(41234, expect.stringMatching(/^preview-fe-/))
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given two conversations of one sandbox, when each previews the same frontend, then their services are named apart", async () => {
        const dir = makeRepository({ "package.json": manifest({ dev: "vite" }) })
        const first = { ...recording(), root: "/sandbox/spaces/one" }
        const second = { ...recording(), root: "/sandbox/spaces/two" }
        const repository = { slug: "shop", kind: "frontend" as const, workingCopy: workingCopyOf(dir) }

        await new AiChangeScriptRunner([repository], async () => first, { previewsEnabled: true }).startPreview(repository)
        await new AiChangeScriptRunner([repository], async () => second, { previewsEnabled: true }).startPreview(repository)

        expect(first.exposeService.mock.calls[0][1]).not.toBe(second.exposeService.mock.calls[0][1])
        // Each asks for a port of its own: starting together, they no longer both find 5173 free and race for it.
        expect(first.exposeService.mock.calls[0][0]).not.toBe(second.exposeService.mock.calls[0][0])
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given enabled previews, when a command succeeds, then no preview is started: only a script may have installed what it needs", async () => {
        const dir = makeRepository({ "package.json": manifest({ dev: "vite" }) })
        const sandbox = recording()
        const repository = { slug: "shop", kind: "frontend" as const, workingCopy: workingCopyOf(dir) }
        const onPreview = vi.fn()

        await new AiChangeScriptRunner([repository], async () => sandbox, { previewsEnabled: true, onPreview }).runCommand(repository, "npx vite build")

        expect(sandbox.exposeService).not.toHaveBeenCalled()
        expect(onPreview).not.toHaveBeenCalled()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given a Vite, Angular or Vue package, then it uses the available development script and binds the preview port", () => {
        const vite = previewPlanFor({ slug: "shop", kind: "frontend", workingCopy: workingCopyOf(os.tmpdir()) }, new Set(), { scripts: { dev: "vite", serve: "vite preview" } }, "npm")
        const angular = previewPlanFor({ slug: "shop", kind: "frontend", workingCopy: workingCopyOf(os.tmpdir()) }, new Set(), { scripts: { start: "ng serve" } }, "npm")
        const vueCli = previewPlanFor({ slug: "shop", kind: "frontend", workingCopy: workingCopyOf(os.tmpdir()) }, new Set(), { scripts: { serve: "vue-cli-service serve" } }, "npm")
        expect(vite?.command).toEqual(["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"])
        expect(angular?.command).toEqual(["npm", "run", "start", "--", "--host", "0.0.0.0", "--port", "5173"])
        expect(vueCli?.command).toEqual(["npm", "run", "serve", "--", "--host", "0.0.0.0", "--port", "5173"])
    })

    it("Given pnpm or yarn, then the flags of the preview reach the dev server without a `--` it would ignore them after", () => {
        const frontend = { slug: "shop", kind: "frontend" as const, workingCopy: workingCopyOf(os.tmpdir()) }
        expect(previewPlanFor(frontend, new Set(), { scripts: { dev: "vite" } }, "pnpm")?.command).toEqual(["corepack", "pnpm", "run", "dev", "--host", "0.0.0.0", "--port", "5173", "--strictPort"])
        expect(previewPlanFor(frontend, new Set(), { scripts: { dev: "vite" } }, "yarn")?.command).toEqual(["corepack", "yarn", "run", "dev", "--host", "0.0.0.0", "--port", "5173", "--strictPort"])
    })

    it("Given registered Java, Python, Go and .NET stacks, then it chooses their local development servers and ports", () => {
        const cases: {
            repository: ScriptRepository
            files: string[]
            command: string[]
        }[] = [
            {
                repository: { slug: "orders", kind: "backend", runtime: "JAVA", framework: "Spring Boot", port: 8081, workingCopy: workingCopyOf(os.tmpdir()) },
                files: ["pom.xml", "mvnw"],
                command: ["sh", "./mvnw", "spring-boot:run"]
            },
            {
                repository: { slug: "catalog", kind: "backend", runtime: "PYTHON", framework: "FastAPI", port: 8000, workingCopy: workingCopyOf(os.tmpdir()) },
                files: ["requirements.txt", "app/main.py"],
                command: ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
            },
            {
                repository: { slug: "ledger", kind: "backend", runtime: "GO", port: 8082, workingCopy: workingCopyOf(os.tmpdir()) },
                files: ["go.mod"],
                command: ["go", "run", "."]
            },
            {
                repository: { slug: "accounts", kind: "backend", runtime: "DOTNET", port: 8083, workingCopy: workingCopyOf(os.tmpdir()) },
                files: ["Accounts.csproj"],
                command: ["dotnet", "run", "--project", "./Accounts.csproj", "--", "--urls", "http://0.0.0.0:8083"]
            }
        ]

        for (const { repository, files, command } of cases) {
            expect(previewPlanFor(repository, new Set(files), undefined)?.command).toEqual(command)
        }
    })

    it("Given a Python backend with requirements, when its preview starts, then it installs dependencies, launches it and exposes its configured port", async () => {
        const dir = makeRepository({ "README.md": "backend\n" })
        fs.writeFileSync(path.join(dir, "requirements.txt"), "fastapi\nuvicorn\n")
        fs.mkdirSync(path.join(dir, "app"))
        fs.writeFileSync(path.join(dir, "app/main.py"), "from fastapi import FastAPI\napp = FastAPI()\n")
        const repository: ScriptRepository = {
            slug: "catalog",
            kind: "backend",
            runtime: "PYTHON",
            framework: "FastAPI",
            port: 8000,
            workingCopy: workingCopyOf(dir)
        }
        const sandbox = recording()
        const onPreview = vi.fn()
        const runner = new AiChangeScriptRunner([repository], async () => sandbox, { previewsEnabled: true, onPreview })
        runner.touch(repository, "requirements.txt")
        runner.touch(repository, "app/main.py")
        await runner.startPreview(repository)

        expect(sandbox.exec).toHaveBeenCalledWith(["python3", "-m", "pip", "install", "-r", "requirements.txt"], expect.objectContaining({ workdir: "/sandbox/repositories/catalog" }))
        expect(sandbox.exec.mock.calls.some(([command]) => command.includes("uvicorn"))).toBe(true)
        expect(sandbox.exposeService).toHaveBeenCalledWith(8000, expect.stringMatching(/^preview-be-/))
        expect(onPreview).toHaveBeenCalledWith("info", "preview-ready|backend|catalog|https%3A%2F%2Fpreview.example.test")
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given a standalone preview, when no development server is configured, then the startup error can be propagated", async () => {
        const dir = makeRepository({ "package.json": manifest({}) })
        const repository = { slug: "shop", kind: "frontend" as const, workingCopy: workingCopyOf(dir) }
        const runner = new AiChangeScriptRunner([repository], async () => recording(), { previewsEnabled: true })

        await expect(runner.startPreview(repository, true)).rejects.toThrow(`No development server is known for frontend: add ${PREVIEW_FILE}`)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given a repository without package.json, then the script is refused", async () => {
        const dir = makeRepository({ "pom.xml": "<project/>" })
        const repository = { slug: "orders", workingCopy: workingCopyOf(dir) }
        await expect(new AiChangeScriptRunner([repository], async () => recording()).run(repository, "install")).rejects.toThrow(/no package.json/)
        fs.rmSync(dir, { recursive: true, force: true })
    })
})

describe("previewPlanFor of every stack", () => {
    const anywhere = workingCopyOf(os.tmpdir())

    it("Given Java, Go and .NET, then what they need is prepared before the server starts, not while it is waited for", () => {
        const spring = previewPlanFor({ slug: "orders", kind: "backend", runtime: "JAVA", framework: "Spring Boot", port: 8081, workingCopy: anywhere }, new Set(["pom.xml", "mvnw"]), undefined)
        const gradle = previewPlanFor({ slug: "orders", kind: "backend", runtime: "JAVA", framework: "Spring Boot", workingCopy: anywhere }, new Set(["build.gradle.kts"]), undefined)
        const go = previewPlanFor({ slug: "ledger", kind: "backend", runtime: "GO", workingCopy: anywhere }, new Set(["go.mod"]), undefined)
        const dotnet = previewPlanFor({ slug: "accounts", kind: "backend", runtime: "DOTNET", workingCopy: anywhere }, new Set(["Accounts.csproj"]), undefined)
        expect(spring?.prepare).toEqual(["sh", "./mvnw", "-B", "-q", "-DskipTests", "compile"])
        expect(gradle?.prepare).toEqual(["gradle", "classes", "--no-daemon", "-q"])
        expect(go?.prepare).toEqual(["go", "build", "./..."])
        expect(dotnet?.prepare).toEqual(["dotnet", "build", "./Accounts.csproj"])
    })

    it("Given a preview file, then its commands win over the stack, and a stack nobody recognizes previews too", () => {
        const override = parsePreviewOverride(JSON.stringify({ prepare: "cargo build", start: "cargo run", port: 7000 }))
        const rust = { slug: "billing", kind: "backend" as const, runtime: "RUST", workingCopy: anywhere }
        expect(previewPlanFor(rust, new Set(["Cargo.toml"]), undefined)).toBeUndefined()
        expect(previewPlanFor(rust, new Set(["Cargo.toml", PREVIEW_FILE]), undefined, undefined, 7000, override)).toEqual({
            prepare: ["sh", "-c", "cargo build"],
            command: ["sh", "-c", "cargo run"],
            port: 7000,
            environment: { HOST: "0.0.0.0", PORT: "7000", HTTP_PORT: "7000" }
        })
    })

    it("Given a preview file without a start command, with a port that is none or not JSON, then it says what is wrong", () => {
        expect(() => parsePreviewOverride("{")).toThrow("not valid JSON")
        expect(() => parsePreviewOverride(JSON.stringify({ prepare: "make" }))).toThrow('needs "start"')
        expect(() => parsePreviewOverride(JSON.stringify({ start: "make run", port: 70_000 }))).toThrow('"port"')
        expect(parsePreviewOverride(JSON.stringify({ start: "make run", prepare: " " }))).toEqual({ start: "make run" })
    })
})

describe.skipIf(!hasTools)("AiChangeScriptRunner live preview", () => {
    let root: string
    const dirs: string[] = []

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-preview-"))
    })

    afterEach(() => {
        // The servers started here are stopped whole, their group as in the sandbox.
        for (const pidfile of fs.existsSync(path.join(root, "previews")) ? fs.readdirSync(path.join(root, "previews")) : []) {
            const pid = Number(fs.readFileSync(path.join(root, "previews", pidfile), "utf8"))
            for (const target of [-pid, pid]) {
                try {
                    process.kill(target)
                } catch {
                    // Already gone
                }
            }
        }
        fs.rmSync(root, { recursive: true, force: true })
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    const backendWith = (files: Record<string, string>, extra: Partial<ScriptRepository> = {}): ScriptRepository => {
        const dir = makeRepository(files)
        dirs.push(dir)
        return { slug: "backend-orders-be", kind: "backend", runtime: "RUST", serviceSlug: "orders-be", workingCopy: workingCopyOf(dir), ...extra }
    }

    const exposing = () => Object.assign(new LocalSandbox(root), { exposeService: vi.fn(async (port: number, _name: string) => `https://preview.example.test/${port}`) })

    it("Given a server that stops at once, when the preview starts, then the error says so with the end of its log, not after minutes", async () => {
        const repository = backendWith({ [PREVIEW_FILE]: JSON.stringify({ start: "echo 'Cannot find module express'; exit 1" }) })
        const startedAt = Date.now()

        await expect(new AiChangeScriptRunner([repository], async () => exposing(), { previewsEnabled: true }).startPreview(repository, true)).rejects.toThrow(
            /The development server stopped:\nCannot find module express/
        )
        expect(Date.now() - startedAt).toBeLessThan(15_000)
    })

    it("Given a backend of a stack nobody recognizes with a preview file, when it starts, then it runs prepare, listens on $PORT and is exposed", async () => {
        const repository = backendWith({
            [PREVIEW_FILE]: JSON.stringify({
                prepare: "echo prepared > prepared.txt",
                start: "exec node -e \"require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\""
            })
        })
        const sandbox = exposing()
        const runner = new AiChangeScriptRunner([repository], async () => sandbox, { previewsEnabled: true })

        expect(await runner.canPreview(repository)).toBe(true)
        const url = await runner.startPreview(repository, true)

        expect(fs.readFileSync(path.join(root, "repositories", "backend-orders-be", "prepared.txt"), "utf8").trim()).toBe("prepared")
        const port = sandbox.exposeService.mock.calls[0][0]
        expect(url).toBe(`https://preview.example.test/${port}`)
        expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ok")
    })

    it("Given a backend of a stack nobody recognizes and no preview file, then it cannot be previewed", async () => {
        const repository = backendWith({ "Cargo.toml": "[package]\n" })
        expect(await new AiChangeScriptRunner([repository], async () => exposing(), { previewsEnabled: true }).canPreview(repository)).toBe(false)
    })

    it("Given a backend started first, when the frontend starts, then it reaches the backend as <SLUG>_URL, as in an environment", async () => {
        const backend = backendWith({ "package.json": manifest({ dev: "node server.js" }) }, { runtime: "NODE", port: 8081 })
        const frontendDir = makeRepository({ "package.json": manifest({ dev: "vite" }) })
        dirs.push(frontendDir)
        const frontend: ScriptRepository = { slug: "frontend-shop-fe", kind: "frontend", serviceSlug: "shop-fe", workingCopy: workingCopyOf(frontendDir) }
        const sandbox = {
            root: "/sandbox",
            exec: vi.fn(async (_command: string[], _options?: SandboxExecOptions) => ({ exitCode: 0, output: "", cutBytes: 0 })),
            exposeService: vi.fn(async () => "https://preview.example.test")
        }
        const runner = new AiChangeScriptRunner([backend, frontend], async () => sandbox, { previewsEnabled: true })

        await runner.startPreview(backend, true)
        await runner.startPreview(frontend, true)

        const starts = sandbox.exec.mock.calls.filter(([command]) => command[2]?.includes("nohup"))
        expect(starts[0][1]?.environment).not.toHaveProperty("ORDERS_BE_URL")
        expect(starts[1][1]?.environment).toMatchObject({ ORDERS_BE_URL: "http://127.0.0.1:8081" })
    })

    it("Given the variables of an environment, when the preview starts, then the server gets them, the sandbox's own and the previews' URLs winning", async () => {
        const backend = backendWith({ "package.json": manifest({ dev: "node server.js" }) }, { runtime: "NODE", port: 8081 })
        const frontendDir = makeRepository({ "package.json": manifest({ dev: "vite" }) })
        dirs.push(frontendDir)
        const frontend: ScriptRepository = {
            slug: "frontend-shop-fe",
            kind: "frontend",
            serviceSlug: "shop-fe",
            workingCopy: workingCopyOf(frontendDir),
            environment: { VITE_API_KEY: "dev-key", HOME: "/elsewhere", ORDERS_BE_URL: "http://orders-be" }
        }
        const sandbox = {
            root: "/sandbox",
            exec: vi.fn(async (_command: string[], _options?: SandboxExecOptions) => ({ exitCode: 0, output: "", cutBytes: 0 })),
            exposeService: vi.fn(async () => "https://preview.example.test")
        }
        const runner = new AiChangeScriptRunner([backend, frontend], async () => sandbox, { previewsEnabled: true })

        await runner.startPreview(backend, true)
        await runner.startPreview(frontend, true)

        const starts = sandbox.exec.mock.calls.filter(([command]) => command[2]?.includes("nohup"))
        expect(starts[1][1]?.environment).toMatchObject({ VITE_API_KEY: "dev-key", HOME: "/sandbox/home", ORDERS_BE_URL: "http://127.0.0.1:8081" })
        const install = sandbox.exec.mock.calls.find(([command]) => command.includes("install"))
        expect(install?.[1]?.environment).not.toHaveProperty("VITE_API_KEY")
    })

    it("Given a frontend and a backend exposed under a path, when the gateway runs, then the path goes to the backend stripped and the rest to the frontend", async () => {
        const listening = (handler: http.RequestListener) =>
            new Promise<http.Server>(resolve => {
                const server = http.createServer(handler)
                server.listen(0, "127.0.0.1", () => resolve(server))
            })
        const portOf = (server: http.Server) => (server.address() as net.AddressInfo).port
        const backend = await listening((request, response) => response.end(`backend ${request.url} ${request.headers["x-forwarded-host"]}`))
        const frontend = await listening((request, response) => response.end(`frontend ${request.url} ${request.headers.host}`))
        const free = await listening(() => undefined)
        const port = portOf(free)
        await new Promise(resolve => free.close(resolve))
        const gateway = spawn("node", ["-e", PREVIEW_GATEWAY, String(port), String(portOf(frontend)), "/api/orders/", String(portOf(backend))], { stdio: "ignore" })

        try {
            const get = async (url: string) => {
                for (let attempt = 0; ; attempt++) {
                    try {
                        return await (await fetch(`http://127.0.0.1:${port}${url}`)).text()
                    } catch (error) {
                        if (attempt > 40) throw error
                        await new Promise(resolve => setTimeout(resolve, 100))
                    }
                }
            }
            expect(await get("/api/orders/items?page=2")).toBe(`backend /items?page=2 127.0.0.1:${port}`)
            expect(await get("/api/orders")).toBe(`backend / 127.0.0.1:${port}`)
            expect(await get("/api/orders-archive")).toBe(`frontend /api/orders-archive 127.0.0.1:${portOf(frontend)}`)
            expect(await get("/src/main.tsx")).toBe(`frontend /src/main.tsx 127.0.0.1:${portOf(frontend)}`)
        } finally {
            gateway.kill()
            backend.close()
            frontend.close()
        }
    })
})

describe.skipIf(!hasTools)("AiChangeToolbox run_script", () => {
    let dirs: string[]

    beforeEach(() => {
        dirs = [makeRepository({ "package.json": manifest({ test: "echo shop" }) }), makeRepository({ "package.json": manifest({ test: "echo cart" }) })]
    })

    afterEach(() => {
        for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    })

    const recording = () => ({ root: "/sandbox", exec: vi.fn(async (_command: string[], _options?: SandboxExecOptions) => ({ exitCode: 0, output: "", cutBytes: 0 })) })

    it("Given no sandbox, then run_script is neither offered nor run", async () => {
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }])
        expect(toolbox.tools().map(tool => tool.name)).not.toContain("run_script")
        await expect(toolbox.run("run_script", { script: "test" })).rejects.toThrow('Unknown tool "run_script"')
    })

    it("Given an npmrc, when a script runs, then it is written out of the copy on stdin and read as the user configuration", async () => {
        const sandbox = recording()
        const npmrc = "@tnb:registry=https://pkgs.dev.azure.com/tnb/_packaging/ui/npm/registry/\n//pkgs.dev.azure.com/:_authToken=s3cr3t"
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]), npmrc }], async () => sandbox)

        await toolbox.run("run_script", { script: "install" })

        const calls = sandbox.exec.mock.calls
        const written = calls.find(([, options]) => options?.stdin?.toString("utf8") === `${npmrc}\n`)
        expect(written?.[0]).toContain("/sandbox/npmrc/shop")
        // Never on a command line, which a gateway may log.
        for (const [command] of calls) expect(command.join(" ")).not.toContain("s3cr3t")
        expect(calls.find(([command]) => command[0] === "npm")?.[1]?.environment).toMatchObject({ npm_config_userconfig: "/sandbox/npmrc/shop" })
    })

    it("Given no npmrc, then the scripts get no user configuration of their own", async () => {
        const sandbox = recording()
        await new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }], async () => sandbox).run("run_script", { script: "install" })
        expect(sandbox.exec.mock.calls.find(([command]) => command[0] === "npm")?.[1]?.environment).not.toHaveProperty("npm_config_userconfig")
    })

    it("Given a sandbox, then run_script is offered and runs in it", async () => {
        const sandbox = recording()
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }], async () => sandbox)
        expect(toolbox.tools().map(tool => tool.name)).toContain("run_script")
        expect(await toolbox.run("run_script", { script: "test" })).toContain("exit code 0")
    })

    it("Given a script that fixes a file, then the working copy gets the fix and the agent is told", async () => {
        const dir = makeRepository({ "package.json": manifest({ "lint:fix": writes({ "src/a.js": "fixed" }) }), "src/a.js": "broken" })
        dirs.push(dir)
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-sandbox-"))
        try {
            const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => new LocalSandbox(root))
            expect(await toolbox.run("run_script", { script: "lint:fix" })).toContain("now part of your change: src/a.js")
            expect(fs.readFileSync(path.join(dir, "src/a.js"), "utf8")).toBe("fixed")
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it("Given a non-Node backend, when the agent finishes, then its live preview starts with the registered stack and port", async () => {
        const dir = makeRepository({
            "requirements.txt": "fastapi\nuvicorn\n",
            "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n"
        })
        dirs.push(dir)
        const sandbox = {
            ...recording(),
            exposeService: vi.fn(async () => "https://preview.example.test")
        }
        const onPreview = vi.fn()
        const toolbox = new AiChangeToolbox([{ slug: "catalog", kind: "backend", runtime: "PYTHON", framework: "FastAPI", port: 8000, workingCopy: workingCopyOf(dir) }], async () => sandbox, {
            previewsEnabled: true,
            onPreview
        })

        await expect(toolbox.run("finish", { summary: "API changed" })).resolves.toBe("Done.")
        expect(sandbox.exec.mock.calls.some(([command]) => command.includes("uvicorn"))).toBe(true)
        expect(sandbox.exposeService).toHaveBeenCalledWith(8000, expect.stringMatching(/^preview-be-/))
        expect(onPreview).toHaveBeenCalledWith("info", "preview-ready|backend|catalog|https%3A%2F%2Fpreview.example.test")
    })

    it("Given a domain with a Node backend, when the agent finishes, then its backend preview starts", async () => {
        const frontendDir = makeRepository({ "package.json": manifest({ dev: "vite" }) })
        const backendDir = makeRepository({ "package.json": manifest({ start: "node server.js" }), "server.js": "require('http').createServer().listen(3000)" })
        dirs.push(frontendDir, backendDir)
        const sandbox = {
            ...recording(),
            exposeService: vi.fn(async () => "https://preview.example.test")
        }
        const onPreview = vi.fn()
        const toolbox = new AiChangeToolbox(
            [
                { slug: "shop", kind: "frontend", workingCopy: workingCopyOf(frontendDir) },
                { slug: "api", kind: "backend", runtime: "NODE", port: 3000, workingCopy: workingCopyOf(backendDir) }
            ],
            async () => sandbox,
            { previewsEnabled: true, onPreview }
        )

        await expect(toolbox.run("finish", { summary: "Domain changed" })).resolves.toBe("Done.")
        expect(sandbox.exec.mock.calls.some(([command]) => command.includes("npm") && command.includes("start"))).toBe(true)
        expect(sandbox.exposeService).toHaveBeenCalledWith(3000, expect.stringMatching(/^preview-be-/))
        expect(onPreview).toHaveBeenCalledWith("info", "preview-ready|backend|api|https%3A%2F%2Fpreview.example.test")
    })

    it("Given a change and a build script, when the agent finishes, then finish is refused until a build ran after the last edit", async () => {
        const dir = makeRepository({ "package.json": manifest({ build: "echo built" }), "src/a.js": "old" })
        dirs.push(dir)
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => recording())

        await toolbox.run("write_file", { path: "src/a.js", content: "new" })
        await expect(toolbox.run("finish", { summary: "Changed a" })).rejects.toThrow('Run run_script "build"')
        await toolbox.run("run_script", { script: "build" })
        await toolbox.run("write_file", { path: "src/a.js", content: "newer" })
        await expect(toolbox.run("finish", { summary: "Changed a" })).rejects.toThrow("Not finished")
        await toolbox.run("run_script", { script: "build" })

        expect(await toolbox.run("finish", { summary: "Changed a" })).toBe("Done.")
        expect(toolbox.summary).toBe("Changed a")
    })

    it("Given a build that fails, then finish is not held: a build broken before the change is not the agent's to fix", async () => {
        const dir = makeRepository({ "package.json": manifest({ build: "exit 2" }), "src/a.js": "old" })
        dirs.push(dir)
        const sandbox = { root: "/sandbox", exec: vi.fn(async (command: string[]) => ({ exitCode: command[0] === "npm" ? 2 : 0, output: "", cutBytes: 0 })) }
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => sandbox)

        await toolbox.run("write_file", { path: "src/a.js", content: "new" })
        expect(await toolbox.run("run_script", { script: "build" })).toContain("exit code 2")
        expect(await toolbox.run("finish", { summary: "Changed a" })).toBe("Done.")
    })

    it("Given no build script, no change of this run, or no sandbox, then finish needs no build", async () => {
        const withBuild = makeRepository({ "package.json": manifest({ build: "echo built" }), "src/a.js": "old" })
        dirs.push(withBuild)
        const noBuild = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }], async () => recording())
        await noBuild.run("write_file", { path: "src/a.js", content: "new" })
        expect(await noBuild.run("finish", { summary: "Changed a" })).toBe("Done.")

        const followUp = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(withBuild), previousChanges: [{ path: "src/a.js", bytes: 3 }] }], async () => recording())
        expect(await followUp.run("finish", { summary: "Changed a" })).toBe("Done.")

        const noSandbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(withBuild) }])
        await noSandbox.run("write_file", { path: "src/a.js", content: "new" })
        expect(await noSandbox.run("finish", { summary: "Changed a" })).toBe("Done.")
    })

    it("Given several repositories, when one changed is not built, then finish names it", async () => {
        const shop = makeRepository({ "package.json": manifest({ build: "echo shop" }) })
        const cart = makeRepository({ "package.json": manifest({ build: "echo cart" }) })
        dirs.push(shop, cart)
        const toolbox = new AiChangeToolbox(
            [
                { slug: "shop", workingCopy: workingCopyOf(shop) },
                { slug: "cart", workingCopy: workingCopyOf(cart) }
            ],
            async () => recording()
        )
        await toolbox.run("write_file", { path: "shop/a.js", content: "a" })
        await toolbox.run("write_file", { path: "cart/b.js", content: "b" })
        await toolbox.run("run_script", { repository: "shop", script: "build" })

        await expect(toolbox.run("finish", { summary: "Both" })).rejects.toThrow("since the last build of cart,")
    })

    it("Given no sandbox, then run_command is neither offered nor run; with one it is offered beside run_script", async () => {
        const without = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }])
        expect(without.tools().map(tool => tool.name)).not.toContain("run_command")
        await expect(without.run("run_command", { command: "ls" })).rejects.toThrow('Unknown tool "run_command"')

        const sandbox = recording()
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }], async () => sandbox)
        expect(toolbox.tools().map(tool => tool.name)).toEqual(expect.arrayContaining(["run_script", "run_command"]))
        expect(await toolbox.run("run_command", { command: "ls -la", workdir: "src", timeout_seconds: 30 })).toContain("exit code 0")
        expect(sandbox.exec.mock.calls.find(([command]) => command[3] === "ls -la")).toEqual([
            ["sh", "-c", 'cd -- "$1" || exit 1; exec sh -c "$0"', "ls -la", "src"],
            expect.objectContaining({ workdir: "/sandbox/repositories/shop", timeoutSecs: 30, environment: expect.objectContaining({ CI: "true" }) })
        ])
        await expect(toolbox.run("run_command", { command: "ls", timeout_seconds: AI_SCRIPT_LIMITS.timeoutSecs + 1 })).rejects.toThrow()
        await expect(toolbox.run("run_command", { command: "cat x", workdir: "../cart" })).rejects.toThrow('".." is not allowed')
    })

    it("Given an npmrc, when a command runs, then it gets no registry configuration: that is the package manager's, through run_script", async () => {
        const sandbox = recording()
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]), npmrc: "//registry/:_authToken=s3cr3t" }], async () => sandbox)

        await toolbox.run("run_command", { command: "npm ls" })

        expect(sandbox.exec.mock.calls.find(([command]) => command[2] === "npm ls")?.[1]?.environment).not.toHaveProperty("npm_config_userconfig")
    })

    it("Given a command whose files weigh more than the agent may write, then none joins the change and the copy is sent again; a script's are not counted", async () => {
        const write = "node -e \"require('fs').writeFileSync('big.txt','a'.repeat(600000))\""
        const dir = makeRepository({ "package.json": manifest({ big: write }) })
        dirs.push(dir)
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-sandbox-"))
        try {
            const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => new LocalSandbox(root))

            expect(await toolbox.run("run_command", { command: write })).toContain("big.txt: more than the 500000 bytes written in one request, not part of your change")
            expect(fs.existsSync(path.join(dir, "big.txt"))).toBe(false)

            expect(await toolbox.run("run_script", { script: "big" })).toContain("now part of your change: big.txt")
            expect(fs.readFileSync(path.join(dir, "big.txt"), "utf8")).toHaveLength(600_000)
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it("Given code a script other than the build changed after the build, then finish waits for the build again; a lockfile alone does not", async () => {
        const dir = makeRepository({
            "package.json": manifest({ build: "node -e 0", "lint:fix": writes({ "src/a.js": "fixed" }), relock: writes({ "package-lock.json": '{"lockfileVersion":3,"packages":{}}' }) }),
            "package-lock.json": '{"lockfileVersion":3}',
            "src/a.js": "broken"
        })
        dirs.push(dir)
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-sandbox-"))
        try {
            const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => new LocalSandbox(root))
            await toolbox.run("write_file", { path: "src/b.js", content: "b" })
            await toolbox.run("run_script", { script: "build" })
            await toolbox.run("run_script", { script: "relock" })
            expect(await toolbox.run("finish", { summary: "B" })).toBe("Done.")

            await toolbox.run("run_script", { script: "lint:fix" })
            await expect(toolbox.run("finish", { summary: "B" })).rejects.toThrow('Run run_script "build"')
            await toolbox.run("run_script", { script: "build" })
            expect(await toolbox.run("finish", { summary: "B" })).toBe("Done.")
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it("Given a sandbox without the program a check needs, then finish does not wait for it, and the sandbox is asked once", async () => {
        const dir = makeRepository({ "go.mod": "module shop\n", "main.go": "package main" })
        dirs.push(dir)
        const sandbox = { root: "/sandbox", exec: vi.fn(async (command: string[]) => ({ exitCode: command[2]?.startsWith("command -v") ? 1 : 0, output: "", cutBytes: 0 })) }
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => sandbox)

        await toolbox.run("write_file", { path: "main.go", content: "package main\n" })
        await toolbox.run("run_command", { command: "ls" })

        expect(await toolbox.run("finish", { summary: "Main" })).toBe("Done.")
        expect(sandbox.exec.mock.calls.filter(([command]) => command[2]?.startsWith("command -v"))).toEqual([[["sh", "-c", 'command -v "$0" >/dev/null', "go"], expect.anything()]])
    })

    it("Given a command that fixes a file, then the working copy gets the fix and the agent is told", async () => {
        const dir = makeRepository({ "go.mod": "module shop\n", "main.go": "package main" })
        dirs.push(dir)
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-change-sandbox-"))
        try {
            const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => new LocalSandbox(root))
            expect(await toolbox.run("run_command", { command: "printf 'package main\\n' > main.go" })).toContain("now part of your change: main.go")
            expect(fs.readFileSync(path.join(dir, "main.go"), "utf8")).toBe("package main\n")
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it("Given a change of a Go repository, when the agent finishes, then finish is refused until its check command ran at the root", async () => {
        const dir = makeRepository({ "go.mod": "module shop\n", "main.go": "package main" })
        dirs.push(dir)
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dir) }], async () => recording())

        await toolbox.run("write_file", { path: "main.go", content: "package main\n\nfunc main() {}" })
        await expect(toolbox.run("finish", { summary: "Main" })).rejects.toThrow('Run run_command "go build ./... && go vet ./..."')
        // Not the check: another command, the check in a folder, or a build script the repository does not have.
        await toolbox.run("run_command", { command: "go test ./..." })
        await toolbox.run("run_command", { command: "go build ./... && go vet ./...", workdir: "cmd" })
        await expect(toolbox.run("run_script", { script: "build" })).rejects.toThrow(/no package.json/)
        await expect(toolbox.run("finish", { summary: "Main" })).rejects.toThrow("Not finished")

        await toolbox.run("run_command", { command: "  go build ./... && go vet ./...  " })
        expect(await toolbox.run("finish", { summary: "Main" })).toBe("Done.")
    })

    it("Given several repositories changed, one with a build script and one built by Maven, then finish names what to run in each", async () => {
        const shop = makeRepository({ "package.json": manifest({ build: "echo shop" }) })
        const orders = makeRepository({ "pom.xml": "<project/>" })
        dirs.push(shop, orders)
        const toolbox = new AiChangeToolbox(
            [
                { slug: "shop", workingCopy: workingCopyOf(shop) },
                { slug: "orders", workingCopy: workingCopyOf(orders) }
            ],
            async () => recording()
        )
        await toolbox.run("write_file", { path: "shop/a.js", content: "a" })
        await toolbox.run("write_file", { path: "orders/App.java", content: "class App {}" })

        await expect(toolbox.run("finish", { summary: "Both" })).rejects.toThrow('Run run_script "build" in shop, run_command "mvn -B -q verify" in orders,')
    })

    it("Given several repositories, then run_script names the one to run in, and refuses a slug of no repository", async () => {
        const sandbox = recording()
        const toolbox = new AiChangeToolbox(
            [
                { slug: "shop", workingCopy: workingCopyOf(dirs[0]) },
                { slug: "cart", workingCopy: workingCopyOf(dirs[1]) }
            ],
            async () => sandbox
        )
        const tool = toolbox.tools().find(candidate => candidate.name === "run_script")
        expect(tool?.inputSchema).toMatchObject({ required: ["repository", "script"], properties: { repository: { enum: ["shop", "cart"] } } })

        await toolbox.run("run_script", { repository: "cart", script: "test" })
        expect(sandbox.exec.mock.calls.find(([command]) => command[0] === "npm")).toEqual([["npm", "run", "test"], expect.objectContaining({ workdir: "/sandbox/repositories/cart" })])
        await expect(toolbox.run("run_script", { repository: "billing", script: "test" })).rejects.toThrow('"billing" is not a repository of this job: shop, cart')
    })
})
