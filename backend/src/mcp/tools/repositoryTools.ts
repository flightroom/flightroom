import { z } from "zod"
import CodeRepositoryImportService from "../../service/CodeRepositoryImportService"
import CodeRepositoryService from "../../service/CodeRepositoryService"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE, defineTool, NO_INPUT, objectId, READ_ONLY, READ_ONLY_EXTERNAL, WRITE, WRITE_EXTERNAL } from "../toolDefinition"

/**
 * Code repository connections. Creating or editing one takes a provider token as input, so those
 * stay in the console: a secret typed into a chat ends up in the client's history. Everything
 * returned goes through `toFrontendObject`, which masks the stored token.
 */
const codeRepositoryId = objectId("Id of the code repository connection")
const importTarget = z.enum(["frontend", "backend"]).optional().describe("What each repository is imported as: frontend when omitted")

export const repositoryTools = [
    defineTool({
        name: "code_repositories_list",
        title: "List code repository connections",
        description: "The active GitHub, GitLab and Azure DevOps connections of the project. Tokens are masked.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: async (_args, { principal, projectId }) => (await new CodeRepositoryService(principal).getByProjectId(projectId)).map(repository => repository.toFrontendObject())
    }),
    defineTool({
        name: "code_repository_get",
        title: "Get code repository connection",
        description: "One code repository connection. The token is masked.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ codeRepositoryId }),
        run: async (args, { principal }) => (await new CodeRepositoryService(principal).findById(args.codeRepositoryId))?.toFrontendObject() ?? null
    }),
    defineTool({
        name: "code_repository_branches",
        title: "List branches",
        description: "The branches of a repository reachable through a connection.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({ codeRepositoryId, repositoryId: z.string().min(1).describe("Id (or path, on GitLab) of the repository at the provider") }),
        run: (args, { principal }) => new CodeRepositoryService(principal).getBranches(args.codeRepositoryId, args.repositoryId)
    }),
    defineTool({
        name: "code_repository_remote_repositories",
        title: "List remote repositories",
        description: "The repositories the connection can see at the provider.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({ codeRepositoryId, groupPath: z.string().optional(), groupId: z.number().int().optional().describe("GitLab only: group to list") }),
        run: (args, { principal }) => new CodeRepositoryService(principal).getRepositories(args.codeRepositoryId, args.groupPath, args.groupId)
    }),
    defineTool({
        name: "code_repository_check_name",
        title: "Check repository name",
        description: "Whether a repository name is still free at the provider. New repositories end in -fe (frontend) or -be (backend).",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({ codeRepositoryId, name: z.string().min(1).max(255), groupPath: z.string().optional(), groupId: z.number().int().optional() }),
        run: async (args, { principal }) => ({
            available: await new CodeRepositoryService(principal).isRepositoryNameAvailable(args.codeRepositoryId, args.name, args.groupPath, args.groupId)
        })
    }),
    defineTool({
        name: "code_repository_set_default",
        title: "Set default connection",
        description: "Makes a connection the project's default one.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ codeRepositoryId }),
        run: async (args, { principal }) => {
            await new CodeRepositoryService(principal).makeDefault(args.codeRepositoryId)
            return { default: true }
        }
    }),
    defineTool({
        name: "code_repository_pipelines_set",
        title: "Set pipeline templates repository",
        description:
            "Picks the repository the pipelines of every frontend and backend scaffolded from a template through the connection codeRepositoryId are copied from, in place of the official mfe-orchestrator/template-pipelines; a connection without one uses the official ones. It has the same layout: <type>/<compiler>/<provider>/ (provider github, gitlab or azure_dev_ops), or <type>/<compiler>/<template slug>/<provider>/ for one template, e.g. service/docker/github/workflows/release.yml, starting from its root or from the folder given as path; %microfrontendSlug%, %serviceSlug% and %domain% are replaced. A template it has no folder for keeps the pipeline it ships with. The repository is reached through templatesCodeRepositoryId, any active connection of the project, the same connection when left out. Pass repositoryId null to go back to the official ones. Only an owner of the project (or an administrator of its organization) can do it. The current setting is in code_repository_get (pipelines).",
        scope: MCP_SCOPE_WRITE,
        consoleOnly: true,
        // Every repository scaffolded afterwards through the connection runs the pipelines of that repository: confirmed by the user
        requiresConfirmation: true,
        annotations: WRITE,
        inputSchema: z.object({
            codeRepositoryId: objectId("Id of the code repository connection whose scaffolded repositories get the pipelines, from code_repositories_list"),
            templatesCodeRepositoryId: objectId("Id of the connection the templates repository is reached through, from code_repositories_list; codeRepositoryId when left out").optional(),
            repositoryId: z
                .string()
                .trim()
                .min(1)
                .max(255)
                .nullable()
                .describe('The repositoryId of the repository, from code_repository_importable with target "backend" on the templates connection; null for the official templates'),
            ref: z.string().trim().max(255).optional().describe("Branch or tag to read; the default branch of the repository when left out"),
            path: z.string().trim().max(255).optional().describe("Folder of the repository the layout starts from, e.g. ci/templates; its root when left out")
        }),
        run: async ({ codeRepositoryId: id, templatesCodeRepositoryId, repositoryId, ref, path }, { principal }) => {
            const pipelines = repositoryId === null ? null : { codeRepositoryId: templatesCodeRepositoryId ?? id, repositoryId, ref, path }
            const repository = await new CodeRepositoryService(principal).setPipelines(id, pipelines)
            return { pipelines: repository.pipelines?.codeRepository ? repository.pipelines : null }
        }
    }),
    defineTool({
        name: "code_repository_set_active",
        title: "Activate or deactivate connection",
        description: "Activates or deactivates a connection. A deactivated one is hidden from the lists but kept.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ codeRepositoryId, active: z.boolean() }),
        run: async (args, { principal }) => {
            const service = new CodeRepositoryService(principal)
            const repository = args.active ? await service.activate(args.codeRepositoryId) : await service.deactivate(args.codeRepositoryId)
            return repository?.toFrontendObject() ?? null
        }
    }),
    defineTool({
        name: "code_repository_delete",
        title: "Delete connection",
        description: "Deletes a code repository connection. The repositories at the provider are not touched.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ codeRepositoryId }),
        run: async (args, { principal }) => {
            await new CodeRepositoryService(principal).delete(args.codeRepositoryId)
            return { deleted: true }
        }
    }),
    defineTool({
        name: "code_repository_importable",
        title: "List importable repositories",
        description: "The repositories of a connection, flagging the ones already linked to a frontend or a backend of the project: those are never imported again.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY_EXTERNAL,
        inputSchema: z.object({ codeRepositoryId, groupId: z.number().int().optional().describe("GitLab only: group to list"), target: importTarget }),
        run: (args, { principal }) => new CodeRepositoryImportService(principal).getImportableRepositories(args.codeRepositoryId, args.groupId, args.target)
    }),
    defineTool({
        name: "code_repository_import",
        title: "Import repositories",
        description: "Creates one frontend, or one backend with the backend target, per repository of the connection. With no repositoryIds, every repository not imported yet is taken.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            codeRepositoryId,
            repositoryIds: z.array(z.string().min(1)).optional(),
            groupId: z.number().int().optional(),
            version: z.string().min(1).max(100).optional().describe("Initial version of the created frontends; ignored for backends, whose version the CI registers"),
            target: importTarget,
            domainId: objectId("Functional domain of the project every created frontend or backend is put in").optional()
        }),
        run: ({ codeRepositoryId: id, ...body }, { principal }) => new CodeRepositoryImportService(principal).importRepositories(id, body)
    })
]
