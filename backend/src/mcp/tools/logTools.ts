import { setTimeout as sleep } from "node:timers/promises"
import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import { ApiKeyRole } from "../../models/ApiKeyModel"
import ArgoCdService from "../../service/ArgoCdService"
import { DEFAULT_SEARCH_MAX_LINES, DEFAULT_SEARCH_TAIL_LINES, inBatches, MAX_SEARCH_ANSWER_LINES, MAX_SEARCH_LINES, MAX_SEARCH_TARGETS, MAX_SEARCHED_PODS } from "../../service/argoCd/argoCdLogSearch"
import BuildStatusService, { BuildRunOwner } from "../../service/BuildStatusService"
import EnvironmentService from "../../service/EnvironmentService"
import { RolloutDTO } from "../../service/gitops/rollout"
import { VersionBuildState } from "../../types/BuildStatusDTO"
import { LOG_LEVELS } from "../../types/RuntimeVariables"
import { MCP_SCOPE_READ } from "../../utils/oauthConfig"
import { defineTool, McpToolContext, objectId, READ_ONLY_EXTERNAL } from "../toolDefinition"

const slug = z.string().min(1).max(100).describe("Slug of a backend, of a frontend that runs as a container, or of a maintenance agent, from backends_list, frontends_list or maintenance_agents_list")
const environmentId = objectId("Id of the environment, from environments_list")

/** The longest wait of deployment_wait and build_wait: under the 300 seconds the proxy in front of the console keeps a request open */
export const MAX_TOOL_WAIT_SECONDS = 240
const DEFAULT_WAIT_SECONDS = 120
const ENVIRONMENT_STATUS_CONCURRENCY = 2
/** How often a wait reads Argo CD again, and the CI provider: this one is read live, and less often */
const ROLLOUT_POLL_MS = 5_000
const BUILD_POLL_MS = 10_000
/** The end of the log of a failed job build_wait answers with: where a failing step says why */
const BUILD_LOG_TAIL_CHARS = 6_000

const waitSeconds = z.number().int().min(1).max(MAX_TOOL_WAIT_SECONDS).optional().describe(`How long to wait at most, ${DEFAULT_WAIT_SECONDS} seconds when left out`)

/** A project API key with the VIEWER role: a person is checked by the services, against their membership; a key has none */
const isViewerKey = (context: McpToolContext) => context.credential.kind === "api_key" && context.session.projects.find(project => project.projectId === context.projectId)?.role === ApiKeyRole.VIEWER

/** Logs may hold what the configuration hides: the console refuses them to a viewer of the project, and so to a VIEWER key */
const ensureNotViewerKey = (context: McpToolContext) => {
    if (isViewerKey(context)) {
        throw createBusinessException({ code: "ARGOCD_LOGS_FORBIDDEN", message: "A VIEWER API key cannot read the pods and logs of the applications", statusCode: 403 })
    }
}

/** The frontend or the backend a build is of, refused before the provider is read unless exactly one is given */
const buildOwner = (args: { frontendId?: string; backendId?: string }): BuildRunOwner => {
    if (Boolean(args.frontendId) === Boolean(args.backendId)) {
        throw createBusinessException({ code: "BUILD_RUN_OWNER_INVALID", message: "Pass exactly one of frontendId and backendId" })
    }
    return args.backendId ? { backendId: args.backendId } : { frontendId: args.frontendId! }
}

/**
 * Reads again every `everyMs` until `settled` says so, the time is up, or nobody waits for the answer any more. Only the
 * first read may fail the wait: a later one that fails, Argo CD or the provider out for a moment, keeps the last answer.
 */
const pollUntil = async <T>(read: () => Promise<T>, settled: (value: T) => boolean, seconds: number, everyMs: number, signal?: AbortSignal) => {
    const deadline = Date.now() + seconds * 1_000
    let value = await read()
    while (!settled(value) && Date.now() < deadline && !signal?.aborted) {
        await sleep(Math.min(everyMs, Math.max(deadline - Date.now(), 0)), undefined, { signal }).catch(() => undefined)
        if (signal?.aborted) break
        const last = value
        value = await read().catch(() => last)
    }
    return { value, timedOut: !settled(value) }
}

/** Over: done, failed, or every application it waits for healthy, degraded or failed, which waiting longer rarely mends */
const rolloutSettled = (rollout: RolloutDTO) => {
    if (!rollout.tracked || rollout.done || rollout.failed) return true
    const updated = rollout.applications.filter(application => application.updated)
    return (updated.length > 0 ? updated : rollout.applications).every(application => ["healthy", "degraded", "failed"].includes(application.state))
}

const BUILD_OVER = new Set<VersionBuildState>(["registered", "failed", "canceled"])

/** What the console reads of the applications it deployed, as it reads them: through Argo CD and from the CI providers */
export const logTools = [
    defineTool({
        name: "application_pods_list",
        title: "List application pods",
        description:
            "The pods a backend, a container frontend or a maintenance agent runs in one environment now, read through the Argo CD the project deploys with: their names, for application_logs_get, with their health, status, ready containers and restarts, and in containerDetails each container's CPU and memory requests and limits, restart count, current state with its reason (CrashLoopBackOff, ImagePullBackOff...) and how its previous run ended (OOMKilled, Error..., exit code). Not for a viewer of the project.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({ slug, environmentId }),
        run: async (args, context) => {
            ensureNotViewerKey(context)
            return new ArgoCdService(context.principal).listPods(context.projectId, args.slug, args.environmentId, { details: true })
        }
    }),
    defineTool({
        name: "application_logs_get",
        title: "Get application logs",
        description:
            "The last lines one pod of a backend, a container frontend or a maintenance agent wrote in one environment, read through Argo CD. Take the pod from application_pods_list. For several applications or environments at once, or without knowing the pod, use application_logs_search. Logs may hold what the configuration hides: not for a viewer of the project.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({
            slug,
            environmentId,
            pod: z.string().min(1).max(253).describe("Name of the pod, from application_pods_list"),
            tailLines: z.number().int().min(1).max(5000).optional().describe("Lines to read from the end, 500 when omitted"),
            sinceSeconds: z.number().int().min(1).max(604800).optional().describe("Only the lines of the last seconds, at most a week"),
            previous: z.boolean().optional().describe("The container that ran before the last restart, to see why it crashed"),
            filter: z.string().max(200).optional().describe("Only the lines holding this text, case sensitive")
        }),
        run: async ({ slug: application, environmentId: environment, ...query }, context) => {
            ensureNotViewerKey(context)
            return new ArgoCdService(context.principal).getLogs(context.projectId, application, environment, query)
        }
    }),
    defineTool({
        name: "application_logs_search",
        title: "Search application logs",
        description:
            "The logs of several applications in one or more environments in one call, read through Argo CD from every pod of each, no pod name needed: by default every backend and container frontend each environment runs, else the slugs given. " +
            "Lines come merged oldest first, the newest maxLines of them, each as `<time> <environment>/<pod> <text>`; `(previous)` after the pod marks those of the container before the restart of a pod that restarted. " +
            "filter and exclude ignore case; minLevel keeps the lines at that level or above, read from the level of a JSON line or a level word at the start of a text one. " +
            `sources says, per environment and application, how many pods it has, how many lines it gave, and why it could not be read. At most ${MAX_SEARCH_TARGETS} applications, all environments together, and ${MAX_SEARCHED_PODS} pods are read: notes says which were left out. Not for a viewer of the project.`,
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({
            environmentIds: z.array(environmentId).min(1).max(10).describe("The environments to read, from environments_list"),
            slugs: z.array(slug).max(30).optional().describe("The applications to read; every backend and container frontend each environment runs when left out"),
            tailLines: z.number().int().min(1).max(MAX_SEARCH_LINES).optional().describe(`Lines to read from the end of each pod, ${DEFAULT_SEARCH_TAIL_LINES} when omitted`),
            sinceSeconds: z.number().int().min(1).max(604800).optional().describe("Only the lines of the last seconds, at most a week"),
            filter: z.string().max(200).optional().describe("Only the lines holding this text, whatever its case"),
            exclude: z.string().max(200).optional().describe("Without the lines holding this text, whatever its case: the health checks, say"),
            minLevel: z
                .enum(LOG_LEVELS)
                .optional()
                .describe("Only the lines at this level or above. A line with no level takes the one of the line before it, as a stack trace; with none before it, it is left out"),
            previous: z.boolean().optional().describe("false: without the lines of the container before the restart of a pod that restarted, read by default"),
            maxLines: z.number().int().min(1).max(MAX_SEARCH_ANSWER_LINES).optional().describe(`Lines to answer with at most, the newest, ${DEFAULT_SEARCH_MAX_LINES} when omitted`)
        }),
        run: async (args, context) => {
            ensureNotViewerKey(context)
            return new ArgoCdService(context.principal).searchLogs(context.projectId, args)
        }
    }),
    defineTool({
        name: "environment_status",
        title: "Get environment status",
        description:
            "How the backends and container frontends of one or more environments are doing now, in one call: per environment the deployment it serves, and per application the version it ships, where Argo CD stands with it " +
            "(healthy, progressing, degraded, syncing, waiting, failed, with Argo CD's health, sync and message) and its pods with their status, ready containers and restarts. " +
            "Read what a crashing one logs with application_logs_search. tracked false: the project deploys through no Argo CD. Not for a viewer of the project.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({
            environmentIds: z.array(environmentId).min(1).max(10).optional().describe("The environments to read; every environment of the project when left out")
        }),
        run: async (args, context) => {
            ensureNotViewerKey(context)
            const ids = args.environmentIds ?? (await new EnvironmentService(context.principal).getByProjectId(context.projectId)).map(environment => String(environment._id))
            const service = new ArgoCdService(context.principal)
            // A couple at a time: each one reads Argo CD application by application
            return inBatches(ids, ENVIRONMENT_STATUS_CONCURRENCY, id => service.environmentStatus(context.projectId, id))
        }
    }),
    defineTool({
        name: "deployment_wait",
        title: "Wait for a deploy to roll out",
        description:
            `Waits, at most ${MAX_TOOL_WAIT_SECONDS} seconds, for deploys to roll out through Argo CD, then says per deployment where each backend and container frontend stands: ` +
            "waiting (Argo CD has not read the commit of the deploy yet), syncing, progressing (its pods are being replaced), healthy, degraded (crashing, or past its deadline) or failed (Argo CD could not apply it), with its pods while it is not healthy. " +
            "It stops early once every application the deploy updated is healthy (done), or degraded or failed. Unless done, logs holds the last lines of the pods that restarted or are not ready. " +
            "Pass the _id of each deployment deploy returned, and the domainId of the deploy if it had one. timedOut: still rolling out, call it again. tracked false: the project deploys through no Argo CD, there is nothing to wait for.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({
            deploymentIds: z.array(objectId("Id of a deployment: the _id of one of those deploy returned")).min(1).max(10),
            domainId: objectId("Id of the domain the deploy was made for: only its applications are followed").optional(),
            seconds: waitSeconds
        }),
        run: async (args, context) => {
            const service = new ArgoCdService(context.principal)
            const read = () => Promise.all(args.deploymentIds.map(id => service.rollout(context.projectId, id, args.domainId)))
            const { value: rollouts, timedOut } = await pollUntil(read, all => all.every(rolloutSettled), args.seconds ?? DEFAULT_WAIT_SECONDS, ROLLOUT_POLL_MS, context.signal)
            const deployments = await Promise.all(
                rollouts.map(async (rollout, index) => {
                    const deploymentId = args.deploymentIds[index]
                    // What a crash printed, for whoever may read the logs: a viewer gets the states alone
                    const logs = rollout.done || isViewerKey(context) ? [] : await service.rolloutLogs(context.projectId, deploymentId, rollout.applications).catch(() => [])
                    return { deploymentId, ...rollout, ...(logs.length ? { logs } : {}) }
                })
            )
            return { done: rollouts.every(rollout => rollout.done), timedOut, deployments }
        }
    }),
    defineTool({
        name: "build_run_logs_get",
        title: "Get build run logs",
        description:
            "The logs of the failed jobs of one CI run of a frontend or a backend, read from its git provider: why a build failed. Take the run id from the builds of build_status_get. Pass exactly one of frontendId and backendId.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({
            frontendId: objectId("Id of the frontend, from frontends_list").optional(),
            backendId: objectId("Id of the backend, from backends_list").optional(),
            runId: z.string().min(1).max(100).describe("Id of the run, as build_status_get lists it")
        }),
        run: async (args, { principal, projectId }) => new BuildStatusService(principal).getFailedRunLogs(projectId, buildOwner(args), args.runId)
    }),
    defineTool({
        name: "build_wait",
        title: "Wait for a build",
        description:
            `Waits, at most ${MAX_TOOL_WAIT_SECONDS} seconds, for the build of one version of a backend or a frontend, started by backend_trigger_build or frontend_trigger_build, then says where it stands: ` +
            "registered (it can be deployed: set it per environment, then deploy), failed or canceled, with the end of the logs of its failed jobs when it failed, " +
            "or, when the time ran out (timedOut), not_started (no run of its tag yet), queued, running or registering (its run succeeded, the version is not registered yet): call it again. " +
            "run is the CI run of its tag, with its link. Pass exactly one of frontendId and backendId.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({
            frontendId: objectId("Id of the frontend, from frontends_list").optional(),
            backendId: objectId("Id of the backend, from backends_list").optional(),
            version: z.string().min(1).max(128).describe("The version the build was triggered with: the tag of its run"),
            seconds: waitSeconds
        }),
        run: async (args, context) => {
            const owner = buildOwner(args)
            const service = new BuildStatusService(context.principal)
            const read = () => service.buildOf(context.projectId, owner, args.version)
            const { value: build, timedOut } = await pollUntil(read, current => BUILD_OVER.has(current.state), args.seconds ?? DEFAULT_WAIT_SECONDS, BUILD_POLL_MS, context.signal)
            const logs =
                build.state === "failed" && build.run
                    ? (await service.getFailedRunLogs(context.projectId, owner, build.run.id).catch(() => [])).map(job => ({ name: job.name, log: job.log.slice(-BUILD_LOG_TAIL_CHARS) }))
                    : []
            return { ...build, timedOut, ...(logs.length ? { logs } : {}) }
        }
    })
]
