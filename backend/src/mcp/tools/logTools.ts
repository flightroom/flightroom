import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import { ApiKeyRole } from "../../models/ApiKeyModel"
import ArgoCdService from "../../service/ArgoCdService"
import BuildStatusService from "../../service/BuildStatusService"
import { MCP_SCOPE_READ } from "../../utils/oauthConfig"
import { defineTool, McpToolContext, objectId, READ_ONLY_EXTERNAL } from "../toolDefinition"

const slug = z.string().min(1).max(100).describe("Slug of a backend, of a frontend that runs as a container, or of a maintenance agent, from backends_list, frontends_list or maintenance_agents_list")
const environmentId = objectId("Id of the environment, from environments_list")

/**
 * Logs may hold what the configuration hides: the console refuses them to a viewer of the project. A person is
 * checked by the service, against their membership; a project API key has none, so its role is checked here.
 */
const ensureNotViewerKey = (context: McpToolContext) => {
    const role = context.session.projects.find(project => project.projectId === context.projectId)?.role
    if (context.credential.kind === "api_key" && role === ApiKeyRole.VIEWER) {
        throw createBusinessException({ code: "ARGOCD_LOGS_FORBIDDEN", message: "A VIEWER API key cannot read the pods and logs of the applications", statusCode: 403 })
    }
}

/** What the console reads of the applications it deployed, as it reads them: through Argo CD and from the CI providers */
export const logTools = [
    defineTool({
        name: "application_pods_list",
        title: "List application pods",
        description:
            "The pods a backend, a container frontend or a maintenance agent runs in one environment now, read through the Argo CD the project deploys with: their names, for application_logs_get, with their health, status, ready containers and restarts. Not for a viewer of the project.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({ slug, environmentId }),
        run: async (args, context) => {
            ensureNotViewerKey(context)
            return new ArgoCdService(context.principal).listPods(context.projectId, args.slug, args.environmentId)
        }
    }),
    defineTool({
        name: "application_logs_get",
        title: "Get application logs",
        description:
            "The last lines one pod of a backend, a container frontend or a maintenance agent wrote in one environment, read through Argo CD. Take the pod from application_pods_list. Logs may hold what the configuration hides: not for a viewer of the project.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({
            slug,
            environmentId,
            pod: z.string().min(1).max(253).describe("Name of the pod, from application_pods_list"),
            tailLines: z.number().int().min(1).max(5000).optional().describe("Lines to read from the end, 500 when omitted"),
            sinceSeconds: z.number().int().min(1).max(604800).optional().describe("Only the lines of the last seconds, at most a week"),
            previous: z.boolean().optional().describe("The container that ran before the last restart, to see why it crashed"),
            filter: z.string().max(200).optional().describe("Only the lines holding this text")
        }),
        run: async ({ slug: application, environmentId: environment, ...query }, context) => {
            ensureNotViewerKey(context)
            return new ArgoCdService(context.principal).getLogs(context.projectId, application, environment, query)
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
        run: async (args, { principal, projectId }) => {
            if (Boolean(args.frontendId) === Boolean(args.backendId)) {
                throw createBusinessException({ code: "BUILD_RUN_OWNER_INVALID", message: "Pass exactly one of frontendId and backendId" })
            }
            const owner = args.backendId ? { backendId: args.backendId } : { frontendId: args.frontendId! }
            return new BuildStatusService(principal).getFailedRunLogs(projectId, owner, args.runId)
        }
    })
]
