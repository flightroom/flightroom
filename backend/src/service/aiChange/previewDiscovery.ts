import fs from "node:fs/promises"
import path from "node:path"
import { isSecretPath, resolveInsideWorkingCopy } from "../../utils/workspacePaths"
import { LlmClient, LlmTool, LlmToolCall, LlmToolResult, LlmUsage } from "../llm"
import { runAgentLoop } from "../llm/agentLoop"
import { GitAuthor, GitWorkingCopy, isPushRefused } from "../workspace/GitWorkingCopy"
import { AI_SCRIPT_LIMITS, AiChangeScriptRunner, PREVIEW_FILE, parsePreviewOverride, ScriptRepository } from "./aiChangeScripts"

/** How far the agent looking for a development server goes: the request that started the preview waits for it. */
export const PREVIEW_DISCOVERY_LIMITS = {
    maxRounds: 30,
    maxTokensPerTurn: 8_000,
    maxListedFiles: 500,
    maxReadChars: 40_000,
    /** Whole minutes: the live preview request is given 15 by nginx, the servers started take some of them. */
    maxCommandSecs: Math.min(300, AI_SCRIPT_LIMITS.timeoutSecs)
}

export interface PreviewDiscovery {
    /** The address of the server it started */
    url: string
    /** The preview file that started it, as written in the working copy */
    content: string
    usage: LlmUsage
}

const SYSTEM = [
    "You start the development server of one repository for a live preview, inside an isolated sandbox. Flightroom could not start it on its own.",
    `You do so by writing ${PREVIEW_FILE}, through try_preview: "prepare" (optional) is a shell command run once in the root of the repository before the server, to install its dependencies or build what it serves; "start" is the shell command that runs the server in the foreground; "port" is where it listens.`,
    "The server must listen on 0.0.0.0, not only on localhost: HOST, PORT and HTTP_PORT are set to the port, use them or pass it as a flag.",
    "The repository may hold a backend and a frontend together: then the preview must show the pages, as the deployed application does. Serve the frontend from the backend, or start both from one command, or build the frontend in prepare.",
    "Read the code first: README, Dockerfile, package.json, pom.xml, build.gradle, pyproject.toml, Procfile, docker-compose files, the entry points. The Dockerfile tells how the application is built and started once deployed.",
    "run_command runs a short command in the sandbox to check something (the versions installed, a build); never a server there, it is stopped after its timeout.",
    "The sandbox reaches the public package registries only: no database, no Docker, no internal service. A server that needs one at start may be given an in-memory or embedded alternative through the command, never through a change of the code.",
    "try_preview starts the server and waits for it to listen: on failure it answers with the end of its log. Fix the command and try again. Stop as soon as one try succeeds."
].join("\n")

const TOOLS: LlmTool[] = [
    {
        name: "list_files",
        description: "Lists the files of the repository, under a folder when given.",
        inputSchema: { type: "object", properties: { prefix: { type: "string", description: 'A folder, e.g. "src/main". Leave out for the whole repository.' } } }
    },
    {
        name: "read_file",
        description: "Reads a file of the repository.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
        name: "run_command",
        description: "Runs a short shell command (sh -c) in the root of the repository in the sandbox, and returns its exit code and the end of its output. Never a server.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string" },
                timeout_seconds: { type: "integer", minimum: 1, maximum: PREVIEW_DISCOVERY_LIMITS.maxCommandSecs }
            },
            required: ["command"]
        }
    },
    {
        name: "try_preview",
        description: `Writes ${PREVIEW_FILE} with these commands and starts the server with it. Answers the address once it listens, else why it did not.`,
        inputSchema: {
            type: "object",
            properties: {
                prepare: { type: "string", description: 'Run once before the server, e.g. "npm ci && npm run build --prefix web".' },
                start: { type: "string", description: 'Runs the server in the foreground, e.g. "node server.js" or "./mvnw spring-boot:run".' },
                port: { type: "integer", minimum: 1, maximum: 65535, description: "Where the server listens." }
            },
            required: ["start", "port"]
        }
    }
]

const text = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)

const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}\n… cut, ${value.length - max} more characters` : value)

/**
 * Has an agent read the repository and find how to start its development server, when Flightroom does not know it or
 * the one it knows fails: it writes the preview file in the working copy and starts the preview with it, until the
 * server listens. Throws when it does not get there, with the last reason the server gave.
 */
export const discoverPreview = async (
    client: LlmClient,
    runner: AiChangeScriptRunner,
    repository: ScriptRepository,
    reason: string,
    /** The tokens of each turn, as they are spent: counted even when no server is found */
    onUsage?: (usage: LlmUsage) => Promise<void> | void,
    signal?: AbortSignal
): Promise<PreviewDiscovery> => {
    const workingCopy = repository.workingCopy as GitWorkingCopy
    let found: { url: string; content: string } | undefined
    let lastFailure = reason

    const run = async (call: LlmToolCall): Promise<string> => {
        const input = call.input
        switch (call.name) {
            case "list_files": {
                const prefix = (text(input, "prefix") ?? "").split("/").filter(Boolean).join("/")
                const files = (await workingCopy.listFiles()).filter(file => !prefix || file.startsWith(`${prefix}/`))
                const shown = files.slice(0, PREVIEW_DISCOVERY_LIMITS.maxListedFiles)
                return [shown.join("\n") || "(no file)", files.length > shown.length ? `… ${files.length - shown.length} more: list a folder` : undefined].filter(Boolean).join("\n")
            }
            case "read_file": {
                const requested = text(input, "path") ?? ""
                const { absolute, relative } = await resolveInsideWorkingCopy(workingCopy.dir, requested)
                if (isSecretPath(relative)) throw new Error(`"${relative}" may hold secrets: it is not read`)
                return cut(await fs.readFile(absolute, "utf8"), PREVIEW_DISCOVERY_LIMITS.maxReadChars)
            }
            case "run_command": {
                const command = text(input, "command") ?? ""
                const requested = typeof input.timeout_seconds === "number" ? input.timeout_seconds : PREVIEW_DISCOVERY_LIMITS.maxCommandSecs
                const timeoutSecs = Math.max(1, Math.min(PREVIEW_DISCOVERY_LIMITS.maxCommandSecs, Math.floor(requested)))
                return (await runner.runCommand(repository, command, { timeoutSecs })).output
            }
            case "try_preview": {
                const content = `${JSON.stringify({ ...(text(input, "prepare")?.trim() ? { prepare: text(input, "prepare") } : {}), start: text(input, "start"), port: input.port }, null, 4)}\n`
                parsePreviewOverride(content)
                const { absolute } = await resolveInsideWorkingCopy(workingCopy.dir, PREVIEW_FILE)
                await fs.mkdir(path.dirname(absolute), { recursive: true })
                await fs.writeFile(absolute, content, "utf8")
                try {
                    found = { url: await runner.restartPreview(repository), content }
                    return `The server listens at ${found.url}.`
                } catch (error) {
                    lastFailure = error instanceof Error ? error.message : String(error)
                    throw error
                }
            }
            default:
                throw new Error(`Unknown tool "${call.name}"`)
        }
    }

    const { usage } = await runAgentLoop({
        client,
        system: SYSTEM,
        tools: TOOLS,
        messages: [
            {
                role: "user",
                text: [
                    `Repository: ${repository.serviceSlug ?? repository.slug}, a ${repository.kind}${repository.runtime ? ` on ${repository.runtime}` : ""}${repository.framework ? ` with ${repository.framework}` : ""}${repository.port ? `, deployed on port ${repository.port}` : ""}.`,
                    `Flightroom could not start its development server: ${reason}`,
                    `Files at its root:\n${(await workingCopy.listFiles()).filter(file => !file.includes("/")).join("\n")}`
                ].join("\n\n")
            }
        ],
        maxRounds: PREVIEW_DISCOVERY_LIMITS.maxRounds,
        maxTokens: PREVIEW_DISCOVERY_LIMITS.maxTokensPerTurn,
        effort: "medium",
        signal,
        onTurn: result => onUsage?.(result.usage),
        runTools: async calls => {
            const results: LlmToolResult[] = []
            for (const call of calls) {
                try {
                    results.push({ callId: call.id, name: call.name, content: await run(call) })
                } catch (error) {
                    results.push({ callId: call.id, name: call.name, content: error instanceof Error ? error.message : String(error), isError: true })
                }
            }
            return { results, stop: found !== undefined }
        }
    })
    if (!found) throw new Error(`No way to start the development server of ${repository.serviceSlug ?? repository.slug} was found: ${lastFailure}`)
    return { ...found, usage }
}

/**
 * Commits the preview file found on the default branch, so that the next preview starts at once. Never forced: a
 * branch that moved on or that refuses direct pushes keeps it out, and the preview still opens.
 */
export const commitPreviewFile = async (workingCopy: GitWorkingCopy, defaultBranch: string, content: string, author: GitAuthor): Promise<"committed" | "refused"> => {
    try {
        await workingCopy.commitAndPush({
            branch: "flightroom/preview-file",
            pushTo: defaultBranch,
            message: `chore: add ${PREVIEW_FILE}, how Flightroom starts the live preview`,
            author,
            files: [{ path: PREVIEW_FILE, content, action: (await workingCopy.readHeadFile(PREVIEW_FILE)) === undefined ? "create" : "update" }]
        })
        return "committed"
    } catch (error) {
        if (isPushRefused(error)) return "refused"
        throw error
    }
}
