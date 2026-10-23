import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import { CONTEXT_MAX_LENGTH } from "../../models/ProjectModel"
import BackendService from "../../service/BackendService"
import FrontendService from "../../service/FrontendService"
import MaintenanceAgentService from "../../service/MaintenanceAgentService"
import { BACKEND_SLUG, BACKEND_VERSION } from "../../types/BackendStack"
import { isValidSchedule, MaintenanceAgentDTO, MaintenanceAgentKind } from "../../types/MaintenanceAgent"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE, defineTool, McpToolContext, objectId, READ_ONLY, WRITE, WRITE_EXTERNAL } from "../toolDefinition"
import { domainFilter, filterByDomain, memberDomainId } from "./domainTools"
import { containerFields, ensureReferencesBelongToProject, createSchema as frontendCreateSchema } from "./frontendTools"

const maintenanceAgentId = objectId("Id of the maintenance agent, from maintenance_agents_list")

/**
 * The fields a maintenance agent can be created or edited with: those of a backend, narrowed the same
 * way (no scaffolding, nothing the CI sets), with how it runs and what it maintains. It is never exposed on the
 * host of an environment, so it has no exposure path nor API documentation.
 */
const { exposurePath: _exposurePath, docsPath: _docsPath, openApiPath: _openApiPath, ...agentContainerFields } = containerFields
const maintenanceAgentFields = {
    name: z.string().min(1).max(255),
    slug: z.string().regex(BACKEND_SLUG, "2 to 50 lowercase letters, digits or dashes, not starting with a dash"),
    description: z.string().max(2000).optional(),
    domainId: memberDomainId,
    context: z.string().max(CONTEXT_MAX_LENGTH).optional().describe("Markdown notes for AI agents about this maintenance agent, replaced as a whole"),
    codeRepository: frontendCreateSchema.shape.codeRepository,
    ...agentContainerFields,
    kind: z.nativeEnum(MaintenanceAgentKind).optional().describe("container: always on, its CronJob POSTs to runPath; job (the default): a container that runs and exits"),
    schedule: z
        .string()
        .refine(value => !value.trim() || isValidSchedule(value), "five cron fields (minute hour day month weekday) or a macro such as @daily")
        .nullable()
        .optional()
        .describe("Cron expression it runs on, e.g. 0 3 * * *; null when it runs on Play only (maintenance_agent_run)"),
    timeZone: z.string().max(64).nullable().optional().describe("IANA time zone of the schedule, e.g. Europe/Rome; null for the one of the cluster"),
    runPath: z
        .string()
        .regex(/^\/[A-Za-z0-9._~/-]*$/, "starts with / and holds no spaces nor query")
        .optional()
        .describe("A container only: the path its CronJob POSTs to, /run when omitted"),
    resourceIds: z.array(objectId("Id of a resource of the project, from resources_list")).max(50).optional().describe("Resources whose variables reach the container. Replaced as a whole"),
    backendIds: z
        .array(objectId("Id of a backend of the project, from backends_list"))
        .max(100)
        .optional()
        .describe("Backends it maintains: they reach the container in MAINTAINED_TARGETS. Replaced as a whole"),
    frontendIds: z.array(objectId("Id of a frontend of the project, from frontends_list")).max(100).optional().describe("Frontends it maintains, as for the backends. Replaced as a whole")
}

const createSchema = z.object(maintenanceAgentFields)
// The slug names its values file and is in the registration URL its CI calls: fixed after creation
const updateSchema = z.object({ maintenanceAgentId, ...createSchema.omit({ slug: true }).partial().shape })

const getExisting = async (id: string, context: McpToolContext) => {
    const agent = await new MaintenanceAgentService(context.principal).getById(id)
    if (!agent) {
        throw new EntityNotFoundError(id)
    }
    return agent
}

export const maintenanceAgentTools = [
    defineTool({
        name: "maintenance_agents_list",
        title: "List maintenance agents",
        description:
            "Every maintenance agent of the project: containers that look after backends and frontends, run on a cron schedule or on Play. With kind, schedule, the backends and frontends each maintains, version, image and last run. Pass domainId to list one domain only.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ domainId: domainFilter }),
        run: async (args, context) => filterByDomain(await new MaintenanceAgentService(context.principal).getByProjectId(context.projectId), args.domainId, context)
    }),
    defineTool({
        name: "maintenance_agent_get",
        title: "Get maintenance agent",
        description:
            "One maintenance agent, with targets: the backends and frontends it maintains, with their slug, name and exposure path. The container receives them as JSON in the MAINTAINED_TARGETS environment variable, with the URL of each inside the environment.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ maintenanceAgentId }),
        run: async (args, context) => {
            const agent = await getExisting(args.maintenanceAgentId, context)
            // Through the lists of the caller: a domain-scoped one sees the targets of their domains only
            const among = <T extends { _id: unknown; slug: string; name: string; exposurePath?: string | null }>(items: T[], ids: unknown[]) => {
                const wanted = new Set(ids.map(String))
                return items.filter(item => wanted.has(String(item._id))).map(({ _id, slug, name, exposurePath }) => ({ _id, slug, name, exposurePath }))
            }
            const backends = await new BackendService(context.principal).getByProjectId(context.projectId)
            const frontends = await new FrontendService(context.principal).getByProjectId(context.projectId)
            return { ...agent.toObject(), targets: { backends: among(backends, agent.backendIds), frontends: among(frontends, agent.frontendIds) } }
        }
    }),
    defineTool({
        name: "maintenance_agent_versions",
        title: "List maintenance agent versions",
        description: "The versions of a maintenance agent its CI has registered (an image tag each).",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ maintenanceAgentId }),
        run: (args, { principal }) => new MaintenanceAgentService(principal).getVersionsById(args.maintenanceAgentId)
    }),
    defineTool({
        name: "maintenance_agent_runs",
        title: "List maintenance agent runs",
        description:
            "The last runs of a maintenance agent started with Play, newest first, with the environment and whether Argo CD started it. Scheduled runs happen in the cluster and are not listed.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ maintenanceAgentId }),
        run: (args, { principal }) => new MaintenanceAgentService(principal).getRuns(args.maintenanceAgentId)
    }),
    defineTool({
        name: "maintenance_agent_run",
        title: "Run maintenance agent",
        description:
            "Play: runs a maintenance agent now in one environment, through Argo CD, which creates a Job from its CronJob there. The agent must have been deployed to that environment. Answers with the run, failed with the reason when Argo CD refused it.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({ maintenanceAgentId, environmentId: objectId("Id of the environment, from environments_list") }),
        run: (args, { principal }) => new MaintenanceAgentService(principal).run(args.maintenanceAgentId, args.environmentId)
    }),
    defineTool({
        name: "maintenance_agent_trigger_build",
        title: "Trigger maintenance agent build",
        description: "Tags the given branch of the maintenance agent's repository with the version, which starts its CI pipeline: it builds the image and registers the version.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            maintenanceAgentId,
            version: z.string().regex(BACKEND_VERSION, "letters, digits, dots, dashes and underscores, at most 128").describe("Version to tag, e.g. 1.4.0: it becomes the image tag"),
            branch: z.string().min(1).max(255).optional().describe("Branch to tag, main when omitted")
        }),
        run: async (args, context) => {
            if (!(await getExisting(args.maintenanceAgentId, context)).codeRepository?.enabled) {
                throw createBusinessException({
                    code: "BACKEND_REPOSITORY_MISSING",
                    message: "The maintenance agent has no linked code repository to tag: link one with maintenance_agent_update"
                })
            }
            await new MaintenanceAgentService(context.principal).build(args.maintenanceAgentId, args.version, args.branch)
            return { triggered: true }
        }
    }),
    defineTool({
        name: "maintenance_agent_create",
        title: "Create maintenance agent",
        description:
            "Adds a maintenance agent to the project: a container image built by the CI of its repository, deployed in every environment with a CronJob that runs it on its schedule or on Play. A code repository can be linked if it already exists at the provider.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE,
        inputSchema: createSchema,
        run: async (args, context) => {
            await ensureReferencesBelongToProject({ codeRepository: args.codeRepository, domainId: args.domainId }, context)
            return new MaintenanceAgentService(context.principal).create(args as unknown as MaintenanceAgentDTO, context.projectId)
        }
    }),
    defineTool({
        name: "maintenance_agent_update",
        title: "Update maintenance agent",
        description:
            "Changes the given fields of a maintenance agent. Nested objects (codeRepository, image), the env list and the configMapIds, secretIds, resourceIds, backendIds and frontendIds are replaced as a whole. A new schedule reaches the cluster with the next deploy.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: updateSchema,
        run: async ({ maintenanceAgentId: id, ...changes }, context) => {
            await getExisting(id, context)
            await ensureReferencesBelongToProject({ codeRepository: changes.codeRepository, domainId: changes.domainId }, context)
            return new MaintenanceAgentService(context.principal).update(id, changes as unknown as MaintenanceAgentDTO)
        }
    }),
    defineTool({
        name: "maintenance_agent_delete",
        title: "Delete maintenance agent",
        description: "Removes a maintenance agent from the project together with the versions its CI registered and its runs. Its repository at the provider is left untouched.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ maintenanceAgentId }),
        run: (args, { principal }) => new MaintenanceAgentService(principal).delete(args.maintenanceAgentId)
    })
]
