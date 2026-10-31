import { setTimeout as sleep } from "node:timers/promises"
import { z } from "zod"
import { fastify } from "../.."
import { createBusinessException } from "../../errors/BusinessException"
import { describeToolError } from "../../mcp/server"
import { DESTRUCTIVE_EXTERNAL, defineTool, McpToolContext, objectId, READ_ONLY, WRITE_EXTERNAL } from "../../mcp/toolDefinition"
import AiChangeRequest, { AiChangeStatus } from "../../models/AiChangeRequestModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import AiChangeJobService from "../aiChange/AiChangeJobService"
import AiChangeService from "../aiChange/AiChangeService"
import AiMissionService from "../aiChange/AiMissionService"
import { ACTIVE_JOB_STATUSES } from "../aiChange/aiJobRecords"
import { LLM_EFFORTS } from "../llm"
import { conversationOf, describeAgentRun, ensureFollowUpAllowed, ensureNotUpdateTurn, ensureRoomForAgentRun, linkedJob, markJobNotified } from "./agentRuns"

/** The longest agent_run_wait: the answer streams meanwhile, kept open by the controller's heartbeats. */
export const MAX_WAIT_SECONDS = 60
/** How often a wait reads the job again. */
const WAIT_POLL_MS = 3_000

const jobId = objectId("Id of an agent run of this conversation, from agent_run_start or agent_run_follow_up")
const brief = z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe(
        "What the agent must do, written as a precise request to a developer, with the evidence you already gathered (the failing log lines, the env of the container, the pod state, the pipeline step) so that it does not investigate again"
    )
const effort = z.enum(LLM_EFFORTS).optional().describe("Reasoning effort of the agent. Leave it out unless the user asked for a level: the default fits most changes.")
const aiModelId = z.string().trim().min(1).max(64).optional().describe("Id of the AI the agent runs on, from ai_models_list. Leave it out unless the user named an AI.")
const ids = (description: string) => z.array(objectId(description)).min(1).max(10).optional()

const jobService = ({ principal }: McpToolContext) => new AiChangeJobService(principal, fastify.config)

/** What the supervisor reads right after starting an agent: what it works on, and how to follow it. */
const started = async (context: McpToolContext, id: string) => ({
    ...(await describeAgentRun(await jobService(context).get(id))),
    next: "The agent works in the background for minutes. Call agent_run_wait to wait for it, or end your answer: when it ends, you get a note in this conversation and answer it then."
})

/** The status, and the job marked as heard of once it ended: the supervisor read how it ended, no update turn follows. */
const statusOf = async (context: McpToolContext, id: string, path?: string, repositoryId?: string) => {
    const view = await jobService(context).get(id)
    if (!ACTIVE_JOB_STATUSES.includes(view.status)) await markJobNotified(toObjectId(id))
    return describeAgentRun(view, path ? { path, repositoryId } : undefined)
}

/** The proposals of the job that applying it would bring onto their base branches. */
const proposalsOf = (id: string) => AiChangeRequest.find({ jobId: toObjectId(id), status: AiChangeStatus.PROPOSED, "files.0": { $exists: true } }, { _id: 1, frontendId: 1, backendId: 1 }).lean()

const noProposal = () => createBusinessException({ code: "AI_CHANGE_NOT_PROPOSED", message: "No proposal of this run is left", statusCode: 409 })

/**
 * The orchestration tools of the assistant: it delegates code changes to the Edit with AI agent (the executor),
 * follows it, and proposes to apply what it did. Assistant only, never in the MCP catalog: an MCP client must not
 * start nor drive the agent. Each acts on the agents of the conversation it is called in, with the user's own
 * permissions and limits.
 */
export const agentRunTools = [
    defineTool({
        name: "agent_run_start",
        title: "Start an agent run",
        description:
            "Delegates a code change to the Edit with AI agent: it clones the repositories, edits them, runs commands and the build in a sandbox, and proposes one change per repository on a feature branch of its own. Nothing reaches a base branch until agent_run_apply. With domainId it works on the frontends and backends of that domain, with frontendIds and/or backendIds on those, with all on every frontend and backend of the project with a repository (at most 10). Investigate first with the console, pipeline, runtime and env tools, then write the brief with what you found: the agent does not investigate again. It runs for minutes in the background; at most 3 agents of this conversation work at once. Not in an update turn: then propose it to the user.",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        // Clones the repositories, and once done pushes the proposals on feature branches: never on a base
        annotations: WRITE_EXTERNAL,
        inputSchema: z
            .object({
                brief,
                domainId: objectId("Id of a functional domain, from domains_list: the agent works on its frontends and backends").optional(),
                all: z.boolean().optional().describe("Every frontend and backend of the project with a repository, at most 10, instead of a domain or a selection"),
                frontendIds: ids("Id of a frontend, from frontends_list").describe("The frontends to change, without domainId"),
                backendIds: ids("Id of a backend, from backends_list").describe("The backends to change, without domainId"),
                baseBranches: z
                    .record(z.string().regex(/^[a-fA-F0-9]{24}$/), z.string().trim().min(1).max(255))
                    .refine(branches => Object.keys(branches).length <= 10, { message: "At most 10 base branches" })
                    .optional()
                    .describe("The branch each repository starts from, by frontend or backend id; its default branch when left out"),
                effort,
                aiModelId
            })
            .refine(args => [Boolean(args.domainId), Boolean(args.frontendIds || args.backendIds), args.all === true].filter(Boolean).length === 1, {
                message: "Pass domainId, or frontendIds and/or backendIds, or all"
            }),
        run: async (args, context) => {
            const conversationId = conversationOf(context)
            ensureNotUpdateTurn(context)
            await ensureRoomForAgentRun(conversationId)
            const job = await jobService(context).create(context.projectId, {
                prompt: args.brief,
                effort: args.effort,
                aiModelId: args.aiModelId,
                baseBranches: args.baseBranches,
                assistantConversationId: conversationId,
                ...(args.domainId ? { scope: "domain", domainId: args.domainId } : args.all ? { scope: "global" } : { scope: "selection", frontendIds: args.frontendIds, backendIds: args.backendIds })
            })
            return started(context, job._id)
        }
    }),
    defineTool({
        name: "agent_run_status",
        title: "Read an agent run",
        description:
            "Where an agent run of this conversation stands: its status (PENDING, RUNNING, DONE, FAILED), summary or error, latest steps, the commands it ran with their exit code (the final check among them), per repository the files it changed with lines added and removed, its branch and pull request, and what it spent (tokens, cost, sandbox time). With path, also the diff of that file (repositoryId picks the repository when two have the path), cut at 20 000 characters: ask for a diff only when the summary is not enough.",
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: z.object({
            jobId,
            path: z.string().trim().min(1).max(500).optional().describe("A file of the proposals, as listed in files: its diff is returned"),
            repositoryId: objectId("The id of a repository of the run (its frontend or backend id), when the path is in more than one").optional()
        }),
        run: async (args, context) => {
            await linkedJob(context, args.jobId)
            return statusOf(context, args.jobId, args.path, args.repositoryId)
        }
    }),
    defineTool({
        name: "agent_run_wait",
        title: "Wait for an agent run",
        description: `Waits for an agent run of this conversation to end, at most ${MAX_WAIT_SECONDS} seconds, then returns what agent_run_status returns. Still running after that: end your answer saying so; you get a note in this conversation when it ends.`,
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: z.object({
            jobId,
            seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait at most, ${MAX_WAIT_SECONDS} when left out`)
        }),
        run: async (args, context) => {
            await linkedJob(context, args.jobId)
            const deadline = Date.now() + (args.seconds ?? MAX_WAIT_SECONDS) * 1_000
            const service = jobService(context)
            // The job read through the service: one that died with its process is reported failed, as the console would.
            while (ACTIVE_JOB_STATUSES.includes((await service.get(args.jobId)).status) && Date.now() < deadline && !context.signal?.aborted) {
                await sleep(Math.min(WAIT_POLL_MS, Math.max(deadline - Date.now(), 0)), undefined, { signal: context.signal }).catch(() => undefined)
            }
            return statusOf(context, args.jobId)
        }
    }),
    defineTool({
        name: "agent_run_follow_up",
        title: "Follow up an agent run",
        description:
            "Asks the agent to refine a finished run of this conversation (status DONE): a new run starts from what it proposed, on the same branches, and replaces its proposals once done. Write the brief as for agent_run_start: what is wrong or missing, with the evidence. At most 3 follow-ups of one run are started without the user writing in between.",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            jobId,
            brief,
            repositoryIds: ids("Id of a repository of the run: its frontend or backend id in agent_run_status").describe(
                "The repositories of the run to refine; all those still proposed when left out"
            ),
            effort,
            aiModelId
        }),
        run: async (args, context) => {
            const conversationId = conversationOf(context)
            const parent = await linkedJob(context, args.jobId)
            await ensureRoomForAgentRun(conversationId)
            await ensureFollowUpAllowed(conversationId, parent.rootJobId)
            const job = await jobService(context).followUp(args.jobId, {
                prompt: args.brief,
                frontendIds: args.repositoryIds,
                effort: args.effort,
                aiModelId: args.aiModelId,
                assistantConversationId: conversationId
            })
            return started(context, job._id)
        }
    }),
    defineTool({
        name: "agent_run_stop",
        title: "Stop an agent run",
        description: "Stops an agent run of this conversation still queued or working: what it did so far is dropped and nothing is pushed.",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({ jobId }),
        run: async (args, context) => {
            await linkedJob(context, args.jobId)
            const view = await jobService(context).stop(args.jobId)
            // Stopped by the supervisor itself: no note comes back to tell it.
            await markJobNotified(toObjectId(args.jobId))
            return { jobId: view._id, status: view.status, error: view.error }
        }
    }),
    defineTool({
        name: "agent_run_apply",
        title: "Apply an agent run",
        description:
            "Applies the proposals of a finished run of this conversation (status DONE), every repository still proposed, once the user confirms in the console. mode pull_request opens a pull request (a merge request on GitLab) from each feature branch onto its base: the change is reviewed in the repository first, and the proposals stay open. mode push pushes them straight onto their base branches without a review; a protected base refuses it. Propose pull_request unless the user asked for a direct push. Never call it before the user has seen what the run did.",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        requiresConfirmation: true,
        annotations: DESTRUCTIVE_EXTERNAL,
        // A pull request asks the user, a push to the base is destructive: it reaches what is built and deployed.
        destructiveFor: input => input.mode !== "pull_request",
        inputSchema: z.object({
            jobId,
            mode: z.enum(["pull_request", "push"]).describe("pull_request: a pull request per repository, for a review. push: straight onto the base branches")
        }),
        run: async (args, context) => {
            await linkedJob(context, args.jobId)
            if (args.mode === "push") {
                const view = await jobService(context).apply(args.jobId)
                return { ...(await describeAgentRun(view)), next: "The proposals are being pushed in the background: agent_run_status tells when each is APPLIED." }
            }
            const proposals = await proposalsOf(args.jobId)
            if (proposals.length === 0) throw noProposal()
            const service = new AiChangeService(context.principal, fastify.config)
            // One after the other: each description names the pull requests of the others opened so far. One
            // refused does not stop the others, and what was opened is told either way.
            const pullRequests: { repositoryId: string; branch?: string; baseBranch?: string; pullRequestUrl?: string; pullRequestError?: string; error?: string }[] = []
            for (const proposal of proposals) {
                const repositoryId = String(proposal.backendId ?? proposal.frontendId)
                try {
                    const request = await service.openPullRequest(String(proposal._id))
                    pullRequests.push({ repositoryId, branch: request.branch, baseBranch: request.baseBranch, pullRequestUrl: request.pullRequestUrl, pullRequestError: request.pullRequestError })
                } catch (error) {
                    pullRequests.push({ repositoryId, error: describeToolError(error) })
                }
            }
            return { jobId: args.jobId, pullRequests }
        }
    }),
    defineTool({
        name: "agent_run_discard",
        title: "Discard an agent run",
        description:
            "Discards the proposals of a finished run of this conversation, every repository still proposed, once the user confirms in the console: nothing is written to the repositories and the feature branches without a pull request are deleted. For a run the user does not want.",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        // A discarded proposal cannot be brought back
        requiresConfirmation: true,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({ jobId }),
        run: async (args, context) => {
            await linkedJob(context, args.jobId)
            const proposals = await proposalsOf(args.jobId)
            if (proposals.length === 0) throw noProposal()
            const service = new AiChangeService(context.principal, fastify.config)
            const discarded: { repositoryId: string; error?: string }[] = []
            for (const proposal of proposals) {
                const repositoryId = String(proposal.backendId ?? proposal.frontendId)
                await service.discard(String(proposal._id)).then(
                    () => discarded.push({ repositoryId }),
                    error => discarded.push({ repositoryId, error: describeToolError(error) })
                )
            }
            return { jobId: args.jobId, discarded }
        }
    }),
    defineTool({
        name: "mission_start",
        title: "Start a mission",
        description:
            "Starts a mission once the user confirms in the console: one brief run by the agent over many repositories (up to 200), in batches of 10. mode global gives each batch one agent that sees all its repositories, perRepository gives each repository an agent of its own (concurrency of them at once). Unlike agent_run_start, a mission pushes its changes directly to baseBranch, or to each repository's default branch: use it for the same mechanical change everywhere (a dependency upgrade, a renamed setting), not for a fix to review. all takes every frontend and backend of the project with a repository.",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        requiresConfirmation: true,
        // Pushes directly to the branches of many repositories, and runs paid agents for a long while
        annotations: WRITE_EXTERNAL,
        inputSchema: z
            .object({
                brief,
                mode: z.enum(["global", "perRepository"]),
                all: z.boolean().optional().describe("Every frontend and backend of the project with a repository, instead of frontendIds and backendIds"),
                frontendIds: z.array(objectId("Id of a frontend, from frontends_list")).min(1).max(200).optional(),
                backendIds: z.array(objectId("Id of a backend, from backends_list")).min(1).max(200).optional(),
                concurrency: z.number().int().min(1).max(10).optional().describe("In perRepository mode, the agents at work at once: 3 when left out"),
                baseBranch: z.string().trim().min(1).max(255).optional().describe("The branch every repository's changes are pushed to; each default branch when left out"),
                effort,
                aiModelId
            })
            .refine(args => (args.all === true) !== Boolean(args.frontendIds || args.backendIds), { message: "Pass all, or frontendIds and/or backendIds" }),
        run: async (args, context) => {
            const conversationId = conversationOf(context)
            ensureNotUpdateTurn(context)
            await ensureRoomForAgentRun(conversationId)
            const { brief: prompt, ...options } = args
            const mission = await new AiMissionService(context.principal, fastify.config).create(context.projectId, { prompt, ...options, assistantConversationId: conversationId })
            return {
                missionId: mission._id,
                status: mission.status,
                mode: mission.mode,
                repositories: mission.repositories.length,
                batchCount: mission.batchCount,
                baseBranch: mission.baseBranch,
                next: "The mission runs in the background, batch after batch, and is followed on the Fleet page: you get a note in this conversation when it ends."
            }
        }
    })
]
