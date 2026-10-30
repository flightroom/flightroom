import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import { CONTEXT_MAX_LENGTH } from "../../models/ProjectModel"
import BackendService from "../../service/BackendService"
import ProjectService from "../../service/ProjectService"
import { attachedVariableKeys } from "../../service/VariableMapService"
import BackendDTO from "../../types/BackendDTO"
import { BACKEND_SLUG, BACKEND_VERSION } from "../../types/BackendStack"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE, defineTool, McpToolContext, objectId, READ_ONLY, WRITE, WRITE_EXTERNAL } from "../toolDefinition"
import { domainFilter, filterByDomain, memberDomainId } from "./domainTools"
import { containerFields, ensureReferencesBelongToProject, createSchema as frontendCreateSchema } from "./frontendTools"

const backendId = objectId("Id of the backend, from backends_list")

/**
 * The fields a backend can be created or edited with.
 *
 * Deliberately narrower than the console route, as for frontends: no `projectId` (the token's
 * project is the only one), no `codeRepository.createData` (scaffolding a repository at the provider
 * is `backend_scaffold`'s), and nothing the CI or a template sets (`version`, `template`, `stack`).
 * Linking an existing repository is allowed, checked against the project first.
 */
const backendFields = {
    name: z.string().min(1).max(255),
    slug: z.string().regex(BACKEND_SLUG, "2 to 50 lowercase letters, digits or dashes, not starting with a dash"),
    description: z.string().max(2000).optional(),
    domainId: memberDomainId,
    context: z.string().max(CONTEXT_MAX_LENGTH).optional().describe("Markdown notes for AI agents about this backend, replaced as a whole"),
    codeRepository: frontendCreateSchema.shape.codeRepository,
    ...containerFields,
    // A backend only: a frontend never attaches a resource
    resourceIds: z
        .array(objectId("Id of a resource of the project, from resources_list"))
        .max(50)
        .optional()
        .describe("Resources (a database, an api, an ai...) whose variables reach the container as environment variables. Replaced as a whole")
}

export const createSchema = z.object(backendFields)
// The slug is in the registration URL the backend's CI calls: fixed after creation, as in the console
const updateSchema = z.object({ backendId, ...createSchema.omit({ slug: true }).partial().shape })

const getExisting = async (id: string, context: McpToolContext) => {
    const backend = await new BackendService(context.principal).getById(id)
    if (!backend) {
        throw new EntityNotFoundError(id)
    }
    return backend
}

export const backendTools = [
    defineTool({
        name: "backends_list",
        title: "List backends",
        description:
            "Every backend of the project, with its latest version, image, port, probes, base URL per environment, environment variables, repository and domainId. Pass domainId to list one domain only.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ domainId: domainFilter }),
        run: async (args, context) => filterByDomain(await new BackendService(context.principal).getByProjectId(context.projectId), args.domainId, context)
    }),
    defineTool({
        name: "backend_get",
        title: "Get backend",
        description:
            "One backend of the project, with aiContext: what the team wrote for AI agents about it, its domain and the project. Follow it when working on its code. " +
            "attachedVariables lists the environment variables its attached resources, config maps and secrets set on the container (keys only, never values): its code can read them.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ backendId }),
        run: async (args, context) => {
            const backend = await getExisting(args.backendId, context)
            const [aiContext, attachedVariables] = await Promise.all([
                new ProjectService(context.principal).getContext(context.projectId, { backendId: args.backendId }),
                attachedVariableKeys(backend, context.projectId)
            ])
            return { ...backend.toObject(), aiContext, attachedVariables }
        }
    }),
    defineTool({
        name: "backend_versions",
        title: "List backend versions",
        description: "The versions of a backend its CI has registered (an image tag each) and can be deployed.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ backendId }),
        run: (args, { principal }) => new BackendService(principal).getVersionsById(args.backendId)
    }),
    defineTool({
        name: "backend_trigger_build",
        title: "Trigger backend build",
        description:
            "Tags the given branch of the backend's repository with the version, which starts its CI pipeline: it builds the image and registers the version. The version must not be tagged yet, even by a run that failed or was canceled: pick a new one.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            backendId,
            version: z.string().regex(BACKEND_VERSION, "letters, digits, dots, dashes and underscores, at most 128").describe("Version to tag, e.g. 1.4.0: it becomes the image tag"),
            branch: z.string().min(1).max(255).optional().describe("Branch to tag, main when omitted")
        }),
        run: async (args, context) => {
            // Without a linked repository the backend tags nothing: say so rather than answer it started
            if (!(await getExisting(args.backendId, context)).codeRepository?.enabled) {
                throw createBusinessException({
                    code: "BACKEND_REPOSITORY_MISSING",
                    message: "The backend has no linked code repository to tag: link one with backend_update or create one with backend_scaffold"
                })
            }
            await new BackendService(context.principal).build(args.backendId, args.version, args.branch)
            return { triggered: true }
        }
    }),
    defineTool({
        name: "backend_create",
        title: "Create backend",
        description:
            "Adds a backend (a container image built by the CI of its repository) to the project. A code repository can be linked if it already exists at the provider; use backend_scaffold to create a new one from a template.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE,
        inputSchema: createSchema,
        run: async (args, context) => {
            await ensureReferencesBelongToProject(args, context)
            return new BackendService(context.principal).create(args as unknown as BackendDTO, context.projectId)
        }
    }),
    defineTool({
        name: "backend_update",
        title: "Update backend",
        description:
            "Changes the given fields of a backend. Nested objects (codeRepository, image), the env list and the configMapIds, secretIds and resourceIds (the resources it attaches, from resources_list) are replaced as a whole.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: updateSchema,
        run: async ({ backendId: id, ...changes }, context) => {
            await getExisting(id, context)
            await ensureReferencesBelongToProject(changes, context)
            return new BackendService(context.principal).update(id, changes as unknown as BackendDTO)
        }
    }),
    defineTool({
        name: "backend_delete",
        title: "Delete backend",
        description:
            "Removes a backend from the project together with the versions its CI registered, its AI change requests and its local workspace clone. Its repository at the provider is left untouched.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ backendId }),
        run: (args, { principal }) => new BackendService(principal).delete(args.backendId)
    })
]
