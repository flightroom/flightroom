import { z } from "zod"
import { defineTool, objectId, READ_ONLY, READ_ONLY_EXTERNAL } from "../../mcp/toolDefinition"
import { MCP_SCOPE_READ } from "../../utils/oauthConfig"
import { redactSecrets } from "../../utils/redactSecrets"
import BuildStatusService, { BuildRunOwner } from "../BuildStatusService"
import { searchDocs } from "./docsSearch"

/** Logs are read from the end: that is where a failing step prints why it failed. */
const MAX_LOG_CHARS_PER_JOB = 15_000
/** All the logs of one tool call together: the result is sent again on every later round. */
const MAX_LOG_CHARS_TOTAL = 40_000
const MAX_DOCS_SECTION_CHARS = 3_000

const tail = (value: string, max: number) => (value.length > max ? { text: value.slice(-max), truncated: true } : { text: value, truncated: false })

/**
 * The tools only the assistant has: everything else it can do comes from the MCP tools, run in
 * process. These two have no MCP counterpart (the documentation is the console's own, and build
 * logs are free text a CI job wrote, redacted here before they reach the model).
 */
export const assistantOnlyTools = [
    defineTool({
        name: "get_failed_build_logs",
        title: "Read failed build logs",
        description: `Downloads the logs of the failed jobs of one CI run of a frontend or of a backend: pass exactly one of frontendId and backendId. Each log is cut to its last ${MAX_LOG_CHARS_PER_JOB} characters, where the error usually is; "truncated" says when that happened. Get run ids from build_status_get.`,
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z
            .object({
                frontendId: objectId("Id of the frontend, as returned by frontends_list or build_status_get").optional(),
                backendId: objectId("Id of the backend, as returned by backends_list or build_status_get").optional(),
                runId: z.string().trim().min(1).describe("Id of the CI run, as returned by build_status_get")
            })
            .refine(args => Boolean(args.frontendId) !== Boolean(args.backendId), { message: "Pass exactly one of frontendId and backendId" }),
        run: async (args, { principal, projectId }) => {
            const owner: BuildRunOwner = args.backendId ? { backendId: args.backendId } : { frontendId: args.frontendId as string }
            const logs = await new BuildStatusService(principal).getFailedRunLogs(projectId, owner, args.runId)
            let budget = MAX_LOG_CHARS_TOTAL
            return logs.map(job => {
                const { text, truncated } = tail(redactSecrets(job.log), Math.min(MAX_LOG_CHARS_PER_JOB, budget))
                budget = Math.max(budget - text.length, 0)
                return { job: job.name, truncated, log: text }
            })
        }
    }),
    defineTool({
        name: "search_docs",
        title: "Search the documentation",
        description:
            "Searches the Flightroom documentation (written in English) and returns the best matching sections with their URL. Use it for any how-to or concept question, and cite the URL of the sections you relied on.",
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: z.object({
            query: z.string().trim().min(1).describe("Keywords in English, e.g. 'canary release percentage' or 'connect S3 bucket'")
        }),
        run: async args =>
            searchDocs(args.query).map(section => ({
                title: section.title,
                url: section.url,
                text: section.text.length > MAX_DOCS_SECTION_CHARS ? `${section.text.slice(0, MAX_DOCS_SECTION_CHARS)}…` : section.text
            }))
    })
]
