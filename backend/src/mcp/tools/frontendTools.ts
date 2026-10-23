import { z } from "zod"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import { CanaryDeploymentType, CanaryType, FrontendKind, FrontendType, HostedOn } from "../../models/FrontendModel"
import { CONTEXT_MAX_LENGTH } from "../../models/ProjectModel"
import CodeRepositoryService from "../../service/CodeRepositoryService"
import DomainService from "../../service/DomainService"
import FrontendService from "../../service/FrontendService"
import ProjectService from "../../service/ProjectService"
import RepositoryRenameService, { isValidRepositoryName } from "../../service/RepositoryRenameService"
import StackDetectionService from "../../service/StackDetectionService"
import { StorageService } from "../../service/StorageService"
import { DESIGN_SYSTEM_MAX_LENGTH, NPM_PACKAGE_NAME } from "../../types/DesignSystem"
import { isExposurePath } from "../../types/Exposure"
import FrontendDTO from "../../types/FrontendDTO"
import { FrontendCompiler, FrontendFramework } from "../../types/FrontendStack"
import { SERVICE_HTTP_PATH } from "../../types/ServiceStack"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE, defineTool, McpToolContext, NO_INPUT, objectId, READ_ONLY, WRITE, WRITE_EXTERNAL } from "../toolDefinition"
import { domainFilter, filterByDomain, memberDomainId } from "./domainTools"

const frontendId = objectId("Id of the frontend")

const httpPath = z.string().regex(SERVICE_HTTP_PATH, 'starts with "/", at most 256 characters, no whitespace')

/**
 * The fields of what runs as a container of its own: a backend service, and a frontend of kind
 * DOCKER. Here rather than in serviceTools, which already imports this module.
 */
export const containerFields = {
    image: z
        .object({ repository: z.string().max(500).optional() })
        .optional()
        .describe("Image repository without tag, e.g. ghcr.io/acme/orders-api. Learnt from the first version the CI registers when not set"),
    port: z.number().int().min(1).max(65535).optional().describe("Port the container listens on, 8080 when omitted"),
    livenessPath: httpPath.optional().describe("Liveness probe path, /health/live when omitted"),
    readinessPath: httpPath.optional().describe("Readiness probe path, /health/ready when omitted"),
    docsPath: httpPath.nullable().optional().describe("Path of the API documentation UI, e.g. /docs; null when there is none"),
    openApiPath: httpPath.nullable().optional().describe("Path of the OpenAPI spec, e.g. /openapi.json; null when there is none"),
    exposurePath: z
        .string()
        .refine(isExposurePath, 'starts with "/", at most 256 characters of letters, digits, -._~!$&\'()*+,;=:@ or %XX; no query, fragment, // nor . or .. segment')
        .nullable()
        .optional()
        .describe("Path it is exposed at on the host of every environment (the subdomain of the environment on the domain of the project), e.g. /api/orders; null when it is not exposed"),
    env: z
        .array(
            z.object({
                name: z
                    .string()
                    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "letters, digits and underscores, not starting with a digit")
                    .max(255),
                required: z.boolean().optional(),
                secret: z.boolean().optional(),
                description: z.string().max(2000).optional()
            })
        )
        .max(200)
        .optional()
        .describe("Variables the image reads from its environment: names only, never values. Replaced as a whole"),
    configMapIds: z
        .array(objectId("Id of a config map of the project, from config_maps_list"))
        .max(50)
        .optional()
        .describe("Config maps whose keys reach the container as environment variables: a service, or a frontend of kind DOCKER. Replaced as a whole"),
    secretIds: z
        .array(objectId("Id of a secret of the project, from secrets_list"))
        .max(50)
        .optional()
        .describe("Secrets whose keys reach the container as environment variables: a service, or a frontend of kind DOCKER. Replaced as a whole")
}

/** The design system of a project or of a frontend, replaced as a whole: null removes it */
export const designSystemInput = z
    .object({
        packageName: z.string().trim().regex(NPM_PACKAGE_NAME, "an npm package name, e.g. @acme/ui").max(DESIGN_SYSTEM_MAX_LENGTH.packageName).describe("npm package of the UI library, e.g. @acme/ui"),
        version: z.string().max(DESIGN_SYSTEM_MAX_LENGTH.version).optional().describe("Semver range, e.g. ^3.2.0"),
        docsUrl: z.string().url().max(DESIGN_SYSTEM_MAX_LENGTH.docsUrl).optional(),
        npmrc: z.string().max(DESIGN_SYSTEM_MAX_LENGTH.npmrc).optional().describe("Content of the .npmrc the package installs with; agents read it with its credentials masked"),
        notes: z.string().max(DESIGN_SYSTEM_MAX_LENGTH.notes).optional().describe("Markdown for AI agents on how to use it, e.g. import from @acme/ui, use its tokens, no raw CSS colors")
    })
    .nullable()
    .optional()

/**
 * The fields a frontend can be created or edited with.
 *
 * Deliberately narrower than the console route: no `projectId` (the token's project is the only
 * one), and no `codeRepository.createData`, which creates a repository at the provider and pushes
 * an API key into it: that is `frontend_scaffold`'s. Linking an existing repository is allowed.
 */
const frontendFields = {
    name: z.string().min(1).max(255),
    slug: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
        .max(100),
    description: z.string().max(2000).optional(),
    domainId: memberDomainId,
    context: z.string().max(CONTEXT_MAX_LENGTH).optional().describe("Markdown notes for AI agents about this frontend, replaced as a whole"),
    designSystem: designSystemInput.describe("Its own design system, in place of the project's; null goes back to the project's. Replaced as a whole"),
    version: z.string().min(1).max(100).optional().describe("Required for a BUNDLE. A DOCKER may omit it: the first version its CI registers sets it"),
    type: z.enum(FrontendType).optional(),
    kind: z
        .enum(FrontendKind)
        .optional()
        .describe(
            "BUNDLE (default): a static bundle uploaded to and served by the orchestrator. DOCKER: an app built into an image and served by its own container, like a backend service; it never has parentIds"
        ),
    path: z.string().max(500).optional(),
    continuousDeployment: z.boolean().optional(),
    parentIds: z.array(objectId("Id of a host frontend of this project")).optional(),
    host: z
        .object({
            type: z.enum(HostedOn),
            url: z.string().url().optional(),
            storageId: objectId("Id of a storage of this project").optional(),
            entryPoint: z.string().max(500).optional()
        })
        .optional()
        .describe("Where the bundle is served from. Omit it to use the project's default storage, or the Flightroom hub when the project has none"),
    codeRepository: z
        .object({
            enabled: z.boolean(),
            codeRepositoryId: objectId("Id of a code repository connection of this project"),
            repositoryId: z.string().min(1).describe("Id of the repository at the provider"),
            name: z.string().optional(),
            cloneUrlHttps: z.string().optional(),
            cloneUrlSsh: z.string().optional(),
            gitlab: z.object({ groupId: z.number().int().optional(), path: z.string().optional() }).optional()
        })
        .optional(),
    canary: z
        .object({
            enabled: z.boolean(),
            percentage: z.number().min(0).max(100),
            type: z.enum(CanaryType),
            deploymentType: z.enum(CanaryDeploymentType),
            version: z.string().optional(),
            url: z.string().url().optional()
        })
        .optional(),
    // Only meaningful for a DOCKER
    ...containerFields,
    exposurePath: containerFields.exposurePath.describe(
        "Path the DOCKER frontend is exposed at on the host of every environment (the subdomain of the environment on the domain of the project), e.g. / or /shell; null when it is not exposed. A BUNDLE frontend has none"
    )
}

export const createSchema = z.object(frontendFields)
// The slug is the frontend's identity in the upload URL its CI calls: fixed after creation, as in the console
const updateSchema = z.object({ frontendId, ...createSchema.omit({ slug: true }).partial().shape })

/**
 * References in the input are checked through the services before anything is written: the
 * frontend service resolves the code repository by id without an access check, so a foreign
 * repository id would otherwise link this project to another project's credentials. Services use
 * it too, for their code repository and domain.
 */
export const ensureReferencesBelongToProject = async (input: Partial<z.infer<typeof createSchema>>, { principal }: McpToolContext) => {
    if (input.codeRepository) {
        await new CodeRepositoryService(principal).findById(input.codeRepository.codeRepositoryId)
    }
    if (input.domainId && !(await new DomainService(principal).getById(input.domainId))) {
        throw new EntityNotFoundError(input.domainId)
    }
    if (input.host?.storageId) {
        await new StorageService(principal).getById(input.host.storageId)
    }
    for (const parentId of input.parentIds ?? []) {
        if (!(await new FrontendService(principal).getById(parentId))) {
            throw new EntityNotFoundError(parentId)
        }
    }
}

const getExisting = async (id: string, context: McpToolContext) => {
    const frontend = await new FrontendService(context.principal).getById(id)
    if (!frontend) {
        throw new EntityNotFoundError(id)
    }
    return frontend
}

export const frontendTools = [
    defineTool({
        name: "frontends_list",
        title: "List frontends",
        description: "Every frontend of the project, with its version, hosting, canary and repository settings and its domainId. Pass domainId to list one domain only.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ domainId: domainFilter }),
        run: async (args, context) => filterByDomain(await new FrontendService(context.principal).getByProjectId(context.projectId), args.domainId, context)
    }),
    defineTool({
        name: "frontend_get",
        title: "Get frontend",
        description:
            "One frontend of the project, with aiContext: what the team wrote for AI agents about it, its domain and the project. Follow it when working on its code. " +
            "aiContext.designSystem is the design system its UI is built with: its own, else the project's.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ frontendId }),
        run: async (args, context) => {
            const frontend = await getExisting(args.frontendId, context)
            const aiContext = await new ProjectService(context.principal).getContext(context.projectId, { frontendId: args.frontendId })
            return { ...frontend.toObject(), aiContext }
        }
    }),
    defineTool({
        name: "frontend_versions",
        title: "List frontend versions",
        description: "The versions of a frontend that have been uploaded and can be deployed.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ frontendId }),
        run: (args, { principal }) => new FrontendService(principal).getVersionsById(args.frontendId)
    }),
    defineTool({
        name: "frontend_create",
        title: "Create frontend",
        description: "Adds a frontend to the project. A code repository can be linked if it already exists at the provider; use frontend_scaffold to create a new one from a template.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE,
        inputSchema: createSchema,
        run: async (args, context) => {
            await ensureReferencesBelongToProject(args, context)
            return new FrontendService(context.principal).create(args as unknown as FrontendDTO, context.projectId)
        }
    }),
    defineTool({
        name: "frontend_update",
        title: "Update frontend",
        description: "Changes the given fields of a frontend. Nested objects (host, canary, codeRepository) are replaced as a whole.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: updateSchema,
        run: async ({ frontendId: id, ...changes }, context) => {
            await getExisting(id, context)
            await ensureReferencesBelongToProject(changes, context)
            return new FrontendService(context.principal).update(id, changes as unknown as FrontendDTO)
        }
    }),
    defineTool({
        name: "frontend_delete",
        title: "Delete frontend",
        description: "Removes a frontend from the project. Deployments already made keep their snapshot.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ frontendId }),
        run: (args, { principal }) => new FrontendService(principal).delete(args.frontendId)
    }),
    defineTool({
        name: "frontend_relation_set",
        title: "Link remote to host",
        description: "Declares that the host frontend loads the remote one (module federation parent/child relation). A DOCKER can be the host, never the remote.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ hostId: objectId("Id of the host frontend"), remoteId: objectId("Id of the remote frontend") }),
        run: (args, { principal }) => new FrontendService(principal).setRelation(args.hostId, args.remoteId)
    }),
    defineTool({
        name: "frontend_relation_delete",
        title: "Unlink remote from host",
        description: "Removes the relation between a host and a remote frontend.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ hostId: objectId("Id of the host frontend"), remoteId: objectId("Id of the remote frontend") }),
        run: (args, { principal }) => new FrontendService(principal).deleteRelation(args.hostId, args.remoteId)
    }),
    defineTool({
        name: "frontend_trigger_build",
        title: "Trigger build",
        description: "Tags the given branch of the frontend's repository with the version, which starts its CI pipeline.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            frontendId,
            version: z.string().min(1).max(100).describe("Version to tag, e.g. 1.4.0"),
            branch: z.string().min(1).optional().describe("Branch to tag, main when omitted")
        }),
        run: async (args, { principal }) => {
            await new FrontendService(principal).build(args.frontendId, args.version, args.branch)
            return { triggered: true }
        }
    }),
    defineTool({
        name: "frontend_repository_rename",
        title: "Rename repository",
        description:
            "Renames the git repository of a frontend at its provider (GitHub, GitLab, Azure DevOps) and updates the repository name and clone URLs the console keeps. The frontend's own name and slug do not change. Local clones must point their remote to the new URL: GitHub and GitLab redirect the old one, Azure DevOps does not.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE_EXTERNAL, idempotentHint: true },
        // Every clone and pipeline of the team follows the repository URL: the user says yes first.
        requiresConfirmation: true,
        inputSchema: z.object({
            frontendId,
            name: z
                .string()
                .trim()
                .refine(isValidRepositoryName, "letters, digits, '.', '_' and '-' (up to 100), starting with a letter or a digit, not ending with '.', '.git' or '.atom'")
                .describe("New name of the repository at the provider, ending in -fe, e.g. checkout-fe")
        }),
        run: (args, { principal }) => new RepositoryRenameService(principal).renameFrontendRepository(args.frontendId, args.name)
    }),
    defineTool({
        name: "frontends_detect_stacks",
        title: "Detect stacks",
        description: "Reads each linked repository to detect framework and bundler (or the single-spa / micro-lc integration model), and stores what it finds (manual choices are kept).",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        inputSchema: NO_INPUT,
        run: (_args, { principal, projectId }) => new StackDetectionService(principal).detectForProject(projectId)
    }),
    defineTool({
        name: "frontend_set_stack",
        title: "Set stack",
        description: "Sets framework and bundler (or integration model: SINGLE_SPA, MICRO_LC, WEBCOMPONENT) of a frontend by hand. Detection never overwrites a manual choice.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ frontendId, framework: z.enum(FrontendFramework).optional(), compiler: z.enum(FrontendCompiler).optional() }),
        run: (args, { principal }) => new StackDetectionService(principal).setManualStack(args.frontendId, args.framework, args.compiler)
    })
]
