import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandSandbox, SandboxExecOptions } from "../sandbox/commandSandbox"
import { GitWorkingCopy } from "../workspace/GitWorkingCopy"
import { AiChangeToolbox } from "./aiChangeAgent"
import { AI_SCRIPT_LIMITS, AiChangeScriptRunner, commandFor, previewPlanFor, ScriptRepository } from "./aiChangeScripts"

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
        const runner = new AiChangeScriptRunner([repository], async () => sandbox, undefined, true, onPreview)

        await expect(runner.startPreview(repository)).resolves.toBe("https://preview.example.test")

        expect(sandbox.exec.mock.calls.find(([command]) => command[2]?.includes("nohup"))).toEqual([
            ["sh", "-c", expect.any(String), "/sandbox/logs/shop-preview.log", "npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"],
            expect.objectContaining({ workdir: "/sandbox/repositories/shop" })
        ])
        expect(sandbox.exposeService).toHaveBeenCalledWith(5173, expect.stringMatching(/^preview-fe-/))
        expect(onPreview).toHaveBeenCalledWith("info", "preview-ready|frontend|shop|https%3A%2F%2Fpreview.example.test")
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("Given a Vite, Angular or Vue package, then it uses the available development script and binds the preview port", () => {
        const vite = previewPlanFor({ slug: "shop", kind: "frontend", workingCopy: workingCopyOf(os.tmpdir()) }, new Set(), { scripts: { dev: "vite", serve: "vite preview" } }, "npm")
        const angular = previewPlanFor({ slug: "shop", kind: "frontend", workingCopy: workingCopyOf(os.tmpdir()) }, new Set(), { scripts: { start: "ng serve" } }, "npm")
        const vueCli = previewPlanFor({ slug: "shop", kind: "frontend", workingCopy: workingCopyOf(os.tmpdir()) }, new Set(), { scripts: { serve: "vue-cli-service serve" } }, "npm")
        expect(vite?.command).toEqual(["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"])
        expect(angular?.command).toEqual(["npm", "run", "start", "--", "--host", "0.0.0.0", "--port", "5173"])
        expect(vueCli?.command).toEqual(["npm", "run", "serve", "--", "--host", "0.0.0.0", "--port", "5173"])
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
        const runner = new AiChangeScriptRunner([repository], async () => sandbox, undefined, true, onPreview)
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
        const runner = new AiChangeScriptRunner([repository], async () => recording(), undefined, true)

        await expect(runner.startPreview(repository, true)).rejects.toThrow("No development server is configured")
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
        const toolbox = new AiChangeToolbox(
            [{ slug: "catalog", kind: "backend", runtime: "PYTHON", framework: "FastAPI", port: 8000, workingCopy: workingCopyOf(dir) }],
            async () => sandbox,
            undefined,
            true,
            onPreview
        )

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
            undefined,
            true,
            onPreview
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
