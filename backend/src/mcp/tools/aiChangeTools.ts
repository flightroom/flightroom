import { z } from "zod"
import { fastify } from "../.."
import { IAiChangeEvent, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import AiModelService from "../../service/AiModelService"
import AiChangeJobService from "../../service/aiChange/AiChangeJobService"
import AiChangeService from "../../service/aiChange/AiChangeService"
import { AiJobView } from "../../service/aiChange/aiJobViews"
import DomainPlanService from "../../service/aiChange/DomainPlanService"
import { AuthorizedPrincipal } from "../../service/BaseAuthorizedService"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { defineTool, NO_INPUT, objectId, READ_ONLY, WRITE_EXTERNAL } from "../toolDefinition"

const frontendId = objectId("Id of the frontend, from frontends_list")
const backendId = objectId("Id of the backend, from backends_list")

/** The repository a change works on: the one of a frontend or the one of a backend, never both. */
const componentFields = { frontendId: frontendId.optional(), backendId: backendId.optional() }
const oneComponent = (args: { frontendId?: string; backendId?: string }) => Boolean(args.frontendId) !== Boolean(args.backendId)
const ONE_COMPONENT = { message: "Pass frontendId or backendId, exactly one" }
const componentOf = (args: { frontendId?: string; backendId?: string }) => (args.backendId ? { kind: "backend" as const, id: args.backendId } : { kind: "frontend" as const, id: args.frontendId! })
const changeId = objectId("Id of the AI change, from ai_changes_list or the changeId of a repository in ai_job_get")
const jobId = objectId("Id of the AI job, from ai_jobs_list or the jobId of an AI change")
const prompt = z.string().trim().min(1).max(8_000).describe("What to change, written as a request to a developer")
const aiModelId = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe("Id of the AI the agent runs on, from ai_models_list. Leave it out unless the user named an AI: the project's default is used, the parent's for a follow-up.")

/** Progress lines kept in a view: the latest ones say where the agent is. */
const RECENT_EVENTS = 10

/**
 * The latest progress lines, without the agent's reasoning nor the output of its scripts: a summary every
 * turn, up to a thousand characters each, or pages of a build log would push the steps out of the view and
 * weigh on every later round.
 */
const recentEvents = (events: Pick<IAiChangeEvent, "at" | "kind" | "message">[]) =>
    events
        .filter(event => event.kind !== "thinking" && event.kind !== "output")
        .slice(-RECENT_EVENTS)
        .map(event => ({ at: event.at, kind: event.kind, message: event.message }))

const service = (principal: AuthorizedPrincipal) => new AiChangeService(principal, fastify.config)
const jobService = (principal: AuthorizedPrincipal) => new AiChangeJobService(principal, fastify.config)
const aiModelService = (principal: AuthorizedPrincipal) => new AiModelService(principal, fastify.config)

/**
 * A change request as the model sees it: what was asked, where it stands and which files it
 * touches. File contents stay out (the console shows the diff): they can be megabytes, and a tool
 * result is sent again on every later round.
 */
const toChangeView = (request: Omit<IAiChangeRequest, "events"> & Partial<Pick<IAiChangeRequest, "events">>) => ({
    id: request._id.toString(),
    jobId: request.jobId ? String(request.jobId) : undefined,
    conversationId: String(request.conversationId),
    // A change reached by its id (ai_change_get) may be a backend's.
    ...(request.backendId ? { backendId: String(request.backendId) } : { frontendId: String(request.frontendId) }),
    status: request.status,
    prompt: request.prompt,
    effort: request.effort,
    aiModelId: request.aiModelId,
    baseBranch: request.baseBranch,
    summary: request.summary,
    files: (request.files ?? []).map(file => ({ path: file.path, action: file.action })),
    branch: request.branch,
    commit: request.commit,
    pushError: request.pushError,
    pullRequestUrl: request.pullRequestUrl,
    pullRequestError: request.pullRequestError,
    error: request.error,
    // The job's usage: shared by every repository of the job.
    usage: request.usage,
    // Lists read the changes without their progress: an empty list would say nothing happened
    ...(request.events ? { recentEvents: recentEvents(request.events) } : {}),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt
})

/** A job as the model sees it: one line per repository, the latest progress lines, what it cost. */
const toJobView = (job: AiJobView) => ({
    jobId: job._id,
    rootJobId: job.rootJobId,
    parentJobId: job.parentJobId,
    status: job.status,
    prompt: job.prompt,
    scope: job.scope,
    domainId: job.domainId,
    effort: job.effort,
    aiModelId: job.aiModelId,
    summary: job.summary,
    error: job.error,
    usage: job.usage,
    // A global job also takes the backends of the project: their id is not one frontend_get knows
    repositories: job.repositories.map(repository => ({
        changeId: repository.requestId,
        kind: repository.kind,
        ...(repository.kind === "backend" ? { backendId: repository.frontendId, backend: repository.frontendName } : { frontendId: repository.frontendId, frontend: repository.frontendName }),
        status: repository.status,
        files: repository.files,
        error: repository.error,
        baseBranch: repository.baseBranch,
        branch: repository.branch,
        commit: repository.commit,
        pushError: repository.pushError,
        pullRequestUrl: repository.pullRequestUrl,
        pullRequestError: repository.pullRequestError
    })),
    // A listed job is read without its progress: the view has none rather than an empty one
    ...(job.events ? { recentEvents: recentEvents(job.events) } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
})

/**
 * Console-only tools reading the AI code changes and jobs of a project, whoever started them: an agent proposes a
 * change on a feature branch, the user applies it onto the base branch, opens a pull request from it or discards it.
 * The assistant starts, follows up and applies its own agents with the agent_run tools; MCP clients get none of these.
 */
export const aiChangeTools = [
    defineTool({
        name: "ai_models_list",
        title: "List AI models",
        description:
            "The AIs the project may run its agents on (id, name, provider, model, the effort levels each takes) and defaultId, the one used when aiModelId is left out. Pass an id as aiModelId to agent_run_start, agent_run_follow_up or mission_start only when the user asked for a specific AI.",
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: async (_args, { principal, projectId }) => aiModelService(principal).availableForProject(projectId)
    }),
    defineTool({
        name: "ai_changes_list",
        title: "List AI code changes",
        description: "The latest AI code changes of a frontend or of a backend (up to 20), newest first, with their status and the files they touch. Pass exactly one of frontendId and backendId.",
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: z.object(componentFields).refine(oneComponent, ONE_COMPONENT),
        run: async (args, { principal }) => (await service(principal).list(componentOf(args))).map(toChangeView)
    }),
    defineTool({
        name: "ai_change_get",
        title: "Get AI code change",
        description:
            "Status of one AI code change (PENDING, RUNNING, PROPOSED, APPLYING, APPLIED, DISCARDED, FAILED), its summary, the files it proposes to create, update or delete, its latest progress lines, the feature branch it is pushed on and its pull request once opened. The diff itself is shown in the console.",
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: z.object({ changeId }),
        run: async (args, { principal }) => toChangeView(await service(principal).get(args.changeId))
    }),
    defineTool({
        name: "ai_domain_plan",
        title: "Plan a new domain",
        description:
            "Asks the AI which frontends and backends a functional domain that has none yet needs for a request: for each a name, a slug, a repository name, the marketplace template to scaffold it from and why. It only proposes and answers in seconds: create them with frontend_scaffold and backend_scaffold, then start agent_run_start on the domain to implement the request.",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        // Nothing is written, but it is a paid model call: under mfe:write like every AI tool
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({ domainId: objectId("Id of the functional domain to plan, from domains_list"), prompt, aiModelId }),
        run: (args, { principal, projectId }) => new DomainPlanService(principal, fastify.config).plan(projectId, args)
    }),
    defineTool({
        name: "ai_jobs_list",
        title: "List AI jobs",
        description:
            "The latest AI jobs you started in the project, newest first, without their progress lines (ai_job_get has them). With active, only those still running or with proposals not yet applied nor discarded.",
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: z.object({ active: z.boolean().optional() }),
        run: async (args, { principal, projectId }) => (await jobService(principal).list(projectId, args.active)).map(toJobView)
    }),
    defineTool({
        name: "ai_job_get",
        title: "Get AI job",
        description:
            "Status of an AI job (PENDING, RUNNING, DONE, FAILED), its summary, the tokens it used, its latest progress lines and, per repository (a frontend's or a backend's, see kind), the status of its proposal (a changeId for ai_change_get), the files it touches, its feature branch and its pull request once opened.",
        scope: MCP_SCOPE_READ,
        consoleOnly: true,
        annotations: READ_ONLY,
        inputSchema: z.object({ jobId }),
        run: async (args, { principal }) => toJobView(await jobService(principal).get(args.jobId))
    })
]
