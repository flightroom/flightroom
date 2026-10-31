import { redactSecrets } from "../../utils/redactSecrets"
import { LlmTool } from "../llm"
import { AI_CHANGE_LIMITS } from "./aiChangeLimits"

/** The tool that reads the Swagger/OpenAPI document of an api resource, offered only to a job with one. */
const readApiSpecTool = (resources: string[]): LlmTool => ({
    name: "read_api_spec",
    description:
        "Reads the Swagger/OpenAPI document of an api resource attached to a backend of the job. Without path: its title, version, servers, auth schemes and one line per operation (method, path, summary, auth). With path, and optionally method: the parameters, request body and responses of that operation with the schemas they reference. Read it before writing a client of the API.",
    inputSchema: {
        type: "object",
        properties: {
            resource: { type: "string", enum: resources, description: "Name of the api resource, as listed under the backend." },
            path: { type: "string", description: "Path of one operation exactly as the index lists it, e.g. '/payments/{id}'. Leave out for the index." },
            method: { type: "string", description: "HTTP method of the operation, e.g. 'POST'. Leave out for every operation of the path." }
        },
        required: ["resource"],
        additionalProperties: false
    }
})

export const toolsFor = (multipleRepositories: boolean, apiResources: string[] = []): LlmTool[] => {
    const filePath = multipleRepositories ? "Path starting with the slug of the repository, e.g. 'catalog/src/App.tsx'." : "Path relative to the repository root."
    return [
        {
            name: "list_files",
            description: multipleRepositories
                ? `Lists the files tracked by git under a repository or one of its folders; without prefix, lists the repositories. At most ${AI_CHANGE_LIMITS.maxListedFiles} paths.`
                : `Lists the files tracked by git, optionally only those under a folder. At most ${AI_CHANGE_LIMITS.maxListedFiles} paths.`,
            inputSchema: {
                type: "object",
                properties: {
                    prefix: {
                        type: "string",
                        description: multipleRepositories
                            ? "Repository or folder to list, e.g. 'catalog' or 'catalog/src/components'. Leave out to list the repositories."
                            : "Folder to list, e.g. 'src/components'. Leave out for the whole repository."
                    }
                },
                additionalProperties: false
            }
        },
        {
            name: "read_file",
            description: `Returns a text file of the repository as it is now, your own edits included: the whole file (at most ${AI_CHANGE_LIMITS.maxReadBytes} bytes), or only the lines from offset, at most limit of them.`,
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string", description: multipleRepositories ? filePath : "Path relative to the repository root, e.g. 'src/App.tsx'." },
                    offset: { type: "integer", minimum: 1, description: "First line to return, from 1: e.g. a few lines before the one search found. Leave out for the whole file." },
                    limit: { type: "integer", minimum: 1, description: "How many lines to return. Leave out to read to the end." }
                },
                required: ["path"],
                additionalProperties: false
            }
        },
        {
            name: "search",
            description: `Finds a literal text (case-insensitive) in the tracked text files${multipleRepositories ? " of every repository" : ""} and returns the matching lines with their path and line number, at most ${AI_CHANGE_LIMITS.maxSearchMatches}.`,
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Literal text to look for, not a regular expression." },
                    prefix: { type: "string", description: multipleRepositories ? "Only search under this repository or folder, e.g. 'catalog/src'." : "Only search under this folder." },
                    context: {
                        type: "integer",
                        minimum: 0,
                        maximum: AI_CHANGE_LIMITS.maxSearchContextLines,
                        description: "Lines to show before and after each match, marked with - instead of :. 0 when left out."
                    }
                },
                required: ["text"],
                additionalProperties: false
            }
        },
        {
            name: "edit_file",
            description:
                "Replaces one exact snippet of an existing file with new text. old_text must appear exactly once in the file as it is now, your own edits included: copy it character for character, with enough surrounding lines to make it unique. Prefer it to write_file for any change to an existing file.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string", description: filePath },
                    old_text: { type: "string", description: "The exact text to replace, whitespace and indentation included." },
                    new_text: { type: "string", description: "The text to put in its place. Empty to remove old_text." }
                },
                required: ["path", "old_text", "new_text"],
                additionalProperties: false
            }
        },
        {
            name: "write_file",
            description: "Creates a file or replaces the whole content of an existing one. Always pass the complete new content. To change part of an existing file use edit_file.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string", description: filePath },
                    content: { type: "string", description: "The complete new content of the file." }
                },
                required: ["path", "content"],
                additionalProperties: false
            }
        },
        {
            name: "delete_file",
            description: "Deletes a file of the repository.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string", description: filePath } },
                required: ["path"],
                additionalProperties: false
            }
        },
        {
            name: "finish",
            description: "Ends the work. The summary becomes the description of the pull request.",
            inputSchema: {
                type: "object",
                properties: { summary: { type: "string", description: "What changed and why, then what the reviewer should check." } },
                required: ["summary"],
                additionalProperties: false
            }
        },
        ...(apiResources.length ? [readApiSpecTool(apiResources)] : [])
    ]
}

export const readString = (input: unknown, key: string, required = true): string | undefined => {
    const value = (input as Record<string, unknown> | null)?.[key]
    if (typeof value === "string") return value
    if (required) throw new Error(`Missing argument "${key}"`)
    return undefined
}

/** A whole number argument between `min` and `max`, undefined when left out. */
export const readCount = (input: unknown, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined => {
    const value = (input as Record<string, unknown> | null)?.[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`"${key}" must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ""}`)
    }
    return value
}

/** What each tool call shows in the progress of the request: the path, never the content. */
export const describeToolCall = (name: string, input: unknown): string => {
    if (name === "read_api_spec") {
        return [name, readString(input, "resource", false), readString(input, "method", false)?.toUpperCase(), readString(input, "path", false)].filter(Boolean).join(" ")
    }
    if (name === "run_script") return [name, readString(input, "repository", false), readString(input, "script", false)].filter(Boolean).join(" ")
    if (name === "run_command") {
        // Kept in the events of the job, shown in the console: a token typed into the command is masked.
        const command = redactSecrets(readString(input, "command", false) ?? "")
        return [name, readString(input, "repository", false), readString(input, "workdir", false), command && command.length > 80 ? `${command.slice(0, 80)}…` : command].filter(Boolean).join(" ")
    }
    const path = readString(input, "path", false) ?? readString(input, "prefix", false)
    const text = readString(input, "text", false)
    if (name === "search" && text) return `search "${text.slice(0, 80)}"`
    return path ? `${name} ${path}` : name
}
