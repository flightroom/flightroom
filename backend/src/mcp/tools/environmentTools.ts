import { z } from "zod"
import { IDeployment } from "../../models/DeploymentModel"
import DeploymentCanaryUsersService from "../../service/DeploymentCanaryUsersService"
import DeploymentService from "../../service/DeploymentService"
import EnvironmentPromotionService, { PROMOTION_KINDS } from "../../service/EnvironmentPromotionService"
import EnvironmentReplicasService from "../../service/EnvironmentReplicasService"
import EnvironmentService from "../../service/EnvironmentService"
import { MAX_REPLICAS } from "../../types/ContainerResources"
import { EnvironmentDTO } from "../../types/EnvironmentDTO"
import { IP_ALLOW_LIST_MAX, isIpRange, SUBDOMAIN } from "../../types/Exposure"
import { isTimeZone } from "../../types/KubeGreen"
import { LOG_LEVELS } from "../../types/RuntimeVariables"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE, DESTRUCTIVE_EXTERNAL, defineTool, NO_INPUT, objectId, READ_ONLY, WRITE } from "../toolDefinition"

const environmentId = objectId("Id of the environment")
const deploymentId = objectId("Id of the deployment")

const KUBE_GREEN_OPTIONAL_TIME = /^(([01]\d|2[0-3]):[0-5]\d)?$/

export const environmentFields = {
    name: z.string().min(1).max(255),
    slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
        .max(100),
    description: z.string().max(2000).optional(),
    color: z.string().min(1).max(50).describe("Colour shown in the console, e.g. #22c55e"),
    isProduction: z.boolean().optional(),
    domains: z.array(z.string().min(1)).optional().describe("Domains the host application of this environment is served on"),
    namespace: z
        .string()
        .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)?$/, "a DNS label: up to 63 lowercase letters, digits and dashes")
        .optional()
        .describe("Kubernetes namespace GitOps commits the environment to; empty or left out, it is the slug in lowercase"),
    subdomain: z
        .string()
        .regex(SUBDOMAIN, "DNS labels separated by dots, e.g. dev or dev.eu")
        .optional()
        .describe(
            "What the environment is exposed under on the domain of the project, e.g. dev for dev.example.com; empty or left out, the domain itself for a production environment and the slug in lowercase for the others"
        ),
    ipAllowList: z
        .array(z.string().refine(isIpRange, "an IP address or a CIDR range, e.g. 203.0.113.7 or 203.0.113.0/24"))
        .max(IP_ALLOW_LIST_MAX)
        .optional()
        .describe("Addresses and CIDR ranges the host of the environment answers to, applied on its next deploy; an empty list lets every address in"),
    logLevel: z
        .enum(LOG_LEVELS)
        .optional()
        .describe("What the containers of the environment log at, handed to each of them as the LOG_LEVEL environment variable on its next deploy; info when never set"),
    logJson: z
        .boolean()
        .optional()
        .describe(
            "Whether the containers of the environment log JSON (true) or plain text (false), handed to each of them as the LOG_JSON environment variable on its next deploy; true when never set"
        ),
    kubeGreen: z
        .object({
            enabled: z.boolean(),
            days: z
                .array(
                    z.object({
                        weekday: z.number().int().min(0).max(6).describe("0 (Sunday) to 6"),
                        awake: z.boolean().describe("false: asleep all day, the times are ignored"),
                        wakeUpAt: z.string().regex(KUBE_GREEN_OPTIONAL_TIME, "HH:MM or empty").optional().describe("When it is scaled up that day, HH:MM; empty, awake from midnight"),
                        sleepAt: z.string().regex(KUBE_GREEN_OPTIONAL_TIME, "HH:MM or empty").optional().describe("When it is scaled down that day, HH:MM, after wakeUpAt; empty, awake until midnight")
                    })
                )
                .max(7)
                .optional()
                .describe(
                    "One entry per day of the week, each with its own hours; a day left out is awake all day. Every sleep ends at midnight: a night asleep is woken at 23:59 and put back to sleep at 00:00"
                ),
            timeZone: z.string().refine(isTimeZone, "an IANA time zone, e.g. Europe/Rome").optional(),
            suspendDeployments: z.boolean().optional(),
            suspendStatefulSets: z.boolean().optional(),
            suspendCronJobs: z.boolean().optional(),
            excludeApplications: z.array(z.string().min(1)).optional().describe("Slugs of the backends and frontends that never sleep")
        })
        .optional()
        .describe(
            "The kube-green schedule the environment sleeps on, committed by GitOps as SleepInfos in its namespace on its next deploy; the cluster needs the kube-green operator. It replaces the saved one as a whole: fields left out take their defaults (awake 08:00 to 20:00 Monday to Friday, asleep at the weekend, Europe/Rome, Deployments and StatefulSets, not CronJobs)"
        )
}

/**
 * A deployment as the MCP client sees it. The snapshot of the storages is left out: it carries
 * their credentials (encrypted at best), and nothing a client does with a deployment needs them.
 */
const toDeploymentView = (deployment: IDeployment | null) => {
    if (!deployment) return null
    const { storages: _storages, ...view } = deployment.toObject()
    return view
}

export const environmentTools = [
    defineTool({
        name: "environments_list",
        title: "List environments",
        description: "The environments of the project, in display order.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: (_args, { principal, projectId }) => new EnvironmentService(principal).getByProjectId(projectId)
    }),
    defineTool({
        name: "environment_create",
        title: "Create environment",
        description: "Adds an environment to the project, appended after the existing ones.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE,
        inputSchema: z.object(environmentFields),
        run: (args, { principal, projectId }) => new EnvironmentService(principal).create(args as EnvironmentDTO, projectId)
    }),
    defineTool({
        name: "environment_update",
        title: "Update environment",
        description: "Changes the given fields of an environment.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ environmentId, ...z.object(environmentFields).partial().shape }),
        run: ({ environmentId: id, ...changes }, { principal }) => new EnvironmentService(principal).update(id, changes as EnvironmentDTO)
    }),
    defineTool({
        name: "environment_delete",
        title: "Delete environment",
        description: "Deletes an environment together with its deployments, canary enrolments and global variable values.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ environmentId }),
        run: async (args, { principal }) => {
            await new EnvironmentService(principal).deleteSingle(args.environmentId)
            return { deleted: true }
        }
    }),
    defineTool({
        name: "environments_reorder",
        title: "Reorder environments",
        description: "Sets the display order of the environments: pass every environment id of the project, in the new order.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ environmentIds: z.array(environmentId).min(1) }),
        run: (args, { principal, projectId }) => new EnvironmentService(principal).updateOrder(projectId, args.environmentIds)
    }),
    defineTool({
        name: "environment_promotion_preview",
        title: "Preview version promotion",
        description:
            "What promoting the versions of one environment to another would change, e.g. from development to UAT: each backend, DOCKER frontend and maintenance agent with the version it runs in the source (from) and in the target (to). One without a version in the source keeps what it runs in the target.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ environmentId: objectId("Id of the environment the versions go to"), fromEnvironmentId: objectId("Id of the environment the versions come from") }),
        run: (args, { principal }) => new EnvironmentPromotionService(principal).preview(args.environmentId, args.fromEnvironmentId)
    }),
    defineTool({
        name: "environment_promote",
        title: "Promote versions",
        description:
            "Sets, in the target environment, the version each application runs in the source one, e.g. from UAT to production. It writes the version per environment only: the next deploy of the target applies it, call deploy for that. Returns the rows of environment_promotion_preview after the change.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({
            environmentId: objectId("Id of the environment the versions go to"),
            fromEnvironmentId: objectId("Id of the environment the versions come from"),
            applications: z
                .array(z.object({ kind: z.enum(PROMOTION_KINDS), _id: objectId("Id of the backend, frontend or maintenance agent") }))
                .optional()
                .describe("The applications to promote, as environment_promotion_preview lists them; left out, every one the promotion changes")
        }),
        run: (args, { principal }) => new EnvironmentPromotionService(principal).promote(args.environmentId, { from: args.fromEnvironmentId, applications: args.applications })
    }),
    defineTool({
        name: "environment_replicas_set",
        title: "Set the replicas of an environment",
        description: `Sets the pods of every container an environment runs at once, from 0 to ${MAX_REPLICAS}, e.g. 0 to stop UAT for the night: each backend, DOCKER frontend and maintenance agent of kind CONTAINER with a version there gets them in that environment, its CPU and memory kept. It writes the replicas per environment only: the next deploy of the environment applies them, call deploy for that. Returns each container with the replicas it runs there after the change.`,
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({
            environmentId: objectId("Id of the environment"),
            replicas: z.number().int().min(0).max(MAX_REPLICAS).describe(`Pods of each container, 0 to ${MAX_REPLICAS}; 0 runs none and leaves its route out`)
        }),
        run: (args, { principal }) => new EnvironmentReplicasService(principal).scale(args.environmentId, { replicas: args.replicas })
    }),
    defineTool({
        name: "deployments_list",
        title: "List deployments",
        description: "The deployments of an environment, newest first.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ environmentId }),
        run: async (args, { principal }) => (await new DeploymentService(principal).getByEnvironmentId(args.environmentId)).map(toDeploymentView)
    }),
    defineTool({
        name: "deployment_get_active",
        title: "Get active deployment",
        description: "The deployment an environment is serving right now, or null when it was never deployed.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ environmentId }),
        run: async (args, { principal }) => {
            const deployments = await new DeploymentService(principal).getByEnvironmentId(args.environmentId)
            return toDeploymentView(deployments.find(deployment => deployment.active) ?? deployments[0] ?? null)
        }
    }),
    defineTool({
        name: "deploy",
        title: "Deploy",
        description:
            "Deploys the current configuration (frontends, versions, global variables) to the given environments: what they serve changes immediately. With GitOps on for the project, the Namespace, the config maps and the secrets of each environment are committed to its repository first, secrets base64 encoded (not encrypted); when that commit fails nothing is deployed.",
        scope: MCP_SCOPE_WRITE,
        // With GitOps on it pushes to the project's repository
        annotations: DESTRUCTIVE_EXTERNAL,
        inputSchema: z.object({
            environmentIds: z.array(environmentId).min(1),
            domainId: objectId("Id of a functional domain: only its frontends and backends are deployed, the others keep what the environments serve now").optional()
        }),
        run: async (args, { principal }) => (await new DeploymentService(principal).createMultiple(args.environmentIds, args.domainId)).map(toDeploymentView)
    }),
    defineTool({
        name: "deployment_rollback",
        title: "Roll back",
        description: "Makes an earlier deployment the active one of its environment again.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ deploymentId }),
        run: async (args, { principal }) => toDeploymentView(await new DeploymentService(principal).redeploy(args.deploymentId))
    }),
    defineTool({
        name: "canary_users_list",
        title: "List canary users",
        description: "The users enrolled in the canary of a deployment.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ deploymentId }),
        run: (args, { principal }) => new DeploymentCanaryUsersService(principal).getCanaryUsersByDeploymentWithPermissionCheck(args.deploymentId)
    }),
    defineTool({
        name: "canary_users_set",
        title: "Set canary users",
        description: "Enrolls users in (or excludes them from) the canary of a deployment. User ids are the ids the host application reports.",
        scope: MCP_SCOPE_WRITE,
        // Decides which users are served the canary: the assistant asks the user first.
        requiresConfirmation: true,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ deploymentId, userIds: z.array(z.string().min(1)).min(1), enabled: z.boolean() }),
        run: (args, { principal }) => new DeploymentCanaryUsersService(principal).setCanaryUserMultipleWithPermissionCheck(args.deploymentId, args.userIds, args.enabled)
    }),
    defineTool({
        name: "canary_users_remove",
        title: "Remove canary users",
        description: "Removes users from the canary list of a deployment.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ deploymentId, userIds: z.array(z.string().min(1)).min(1) }),
        run: (args, { principal }) => new DeploymentCanaryUsersService(principal).deleteCanaryUsersWithPermissionCheck(args.deploymentId, args.userIds)
    })
]
