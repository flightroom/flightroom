import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandSandbox, SandboxExecOptions } from "../sandbox/commandSandbox"
import { GitWorkingCopy } from "../workspace/GitWorkingCopy"
import { AiChangeToolbox } from "./aiChangeAgent"
import { AI_SCRIPT_LIMITS, AiChangeScriptRunner, commandFor, ScriptRepository } from "./aiChangeScripts"

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
        const output = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "show")
        expect(output).toContain("$ npm run show")
        expect(output).toContain("exit code 0 (success)")
        expect(output).toContain("from the repository")
        expect(fs.readFileSync(copy("src/a.txt"), "utf8")).toBe("from the repository")
    })

    it("Given a .env in the repository, when it is copied, then the secret stays out of the sandbox", async () => {
        await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "show")
        expect(fs.existsSync(copy(".env"))).toBe(false)
    })

    it("Given a failing script, then its exit code and the end of its output come back as a result, not an error", async () => {
        const output = await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "fail")
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

        expect(await runner.run(repository, "show")).toContain("edited by the agent")
        expect(fs.existsSync(copy("src/old.txt"))).toBe(false)
        // Neither the folders prepared again nor the copy replaced: one command sends the change, one runs the script.
        expect(sandbox.commands).toHaveLength(2)
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
        expect(await runner.run(repository, "show")).toContain("from the repository")
        expect(open).toHaveBeenCalledTimes(2)
    })

    it("Given an output longer than the agent reads, then only its end comes back, said to be cut", async () => {
        const long: CommandSandbox = { root, exec: vi.fn(async () => ({ exitCode: 0, output: `${"x".repeat(AI_SCRIPT_LIMITS.maxOutputChars)}THE END`, cutBytes: 0 })) }
        const output = await new AiChangeScriptRunner([repository], async () => long).run(repository, "show")
        expect(output).toContain("the start of the output is cut")
        expect(output.endsWith("THE END")).toBe(true)
    })
})

describe("commandFor", () => {
    it("Given each package manager, then npm runs as itself and pnpm and yarn through corepack", () => {
        expect(commandFor("npm", "install")).toEqual(["npm", "install"])
        expect(commandFor("npm", "test")).toEqual(["npm", "run", "test"])
        expect(commandFor("pnpm", "install")).toEqual(["corepack", "pnpm", "install"])
        expect(commandFor("yarn", "lint")).toEqual(["corepack", "yarn", "run", "lint"])
    })
})

describe.skipIf(!hasTools)("AiChangeScriptRunner package manager", () => {
    const recording = () => ({ root: "/sandbox", exec: vi.fn(async (_command: string[], _options?: SandboxExecOptions) => ({ exitCode: 0, output: "", cutBytes: 0 })) })

    const lastCommand = (sandbox: ReturnType<typeof recording>) => sandbox.exec.mock.calls.at(-1)?.[0]

    it("Given a pnpm lockfile, when a script runs, then pnpm runs it in the folder of the repository", async () => {
        const dir = makeRepository({ "package.json": manifest({ test: "vitest" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })
        const sandbox = recording()
        const repository = { slug: "shop", workingCopy: workingCopyOf(dir) }
        await new AiChangeScriptRunner([repository], async () => sandbox).run(repository, "test")
        expect(lastCommand(sandbox)).toEqual(["corepack", "pnpm", "run", "test"])
        expect(sandbox.exec.mock.calls.at(-1)?.[1]).toMatchObject({
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
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given a repository without package.json, then the script is refused", async () => {
        const dir = makeRepository({ "pom.xml": "<project/>" })
        const repository = { slug: "orders", workingCopy: workingCopyOf(dir) }
        await expect(new AiChangeScriptRunner([repository], async () => recording()).run(repository, "install")).rejects.toThrow(/no package.json/)
        fs.rmSync(dir, { recursive: true, force: true })
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

    const recording = () => ({ root: "/sandbox", exec: vi.fn(async () => ({ exitCode: 0, output: "", cutBytes: 0 })) })

    it("Given no sandbox, then run_script is neither offered nor run", async () => {
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }])
        expect(toolbox.tools().map(tool => tool.name)).not.toContain("run_script")
        await expect(toolbox.run("run_script", { script: "test" })).rejects.toThrow('Unknown tool "run_script"')
    })

    it("Given a sandbox, then run_script is offered and runs in it", async () => {
        const sandbox = recording()
        const toolbox = new AiChangeToolbox([{ slug: "shop", workingCopy: workingCopyOf(dirs[0]) }], async () => sandbox)
        expect(toolbox.tools().map(tool => tool.name)).toContain("run_script")
        expect(await toolbox.run("run_script", { script: "test" })).toContain("exit code 0")
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
        expect(sandbox.exec.mock.calls.at(-1)).toEqual([["npm", "run", "test"], expect.objectContaining({ workdir: "/sandbox/repositories/cart" })])
        await expect(toolbox.run("run_script", { repository: "billing", script: "test" })).rejects.toThrow('"billing" is not a repository of this job: shop, cart')
    })
})
