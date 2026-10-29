import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import BackendService from "../../service/BackendService"
import FrontendService from "../../service/FrontendService"
import MarketService from "../../service/MarketService"
import { REPOSITORY_NAME_SUFFIXES } from "../../service/RepositoryCreationService"
import { isValidRepositoryName } from "../../service/RepositoryRenameService"
import { RepositoryComponentKind } from "../../service/workspace/repositoryComponent"
import BackendDTO from "../../types/BackendDTO"
import FrontendDTO from "../../types/FrontendDTO"
import { MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { defineTool, McpToolContext, objectId, WRITE_EXTERNAL } from "../toolDefinition"
import { createSchema as backendCreateSchema } from "./backendTools"
import { ensureReferencesBelongToProject, createSchema as frontendCreateSchema } from "./frontendTools"

/**
 * Where and how the new repository is created: the connection's credentials are never part of the
 * input.
 */
const repositoryToCreate = {
    template: z.string().trim().min(1).describe("Slug of the template, from templates_list"),
    codeRepositoryId: objectId("Id of a code repository connection of this project, from code_repositories_list: the new repository is created there"),
    private: z.boolean().optional().describe("Create the repository as private (default false)"),
    gitlab: z
        .object({ groupId: z.number().int().describe("Id of the GitLab group to create the repository in") })
        .optional()
        .describe("GitLab connections only: the group of the new repository, the connection's own group when omitted")
}

/**
 * The name of the new repository, which is also the slug of the member, so the two never differ: it
 * ends in -fe for a frontend and in -be for a backend, as the server instructions tell agents, and
 * it is a name the providers accept and a slug of the member's kind at once.
 */
const repositoryName = (slug: z.ZodString, kind: RepositoryComponentKind, example: string) => {
    const suffix = REPOSITORY_NAME_SUFFIXES[kind]
    return z
        .string()
        .trim()
        .min(3)
        .max(100)
        .refine(isValidRepositoryName, "letters, digits, '.', '_' and '-', starting with a letter or a digit, not ending with '.', '.git' or '.atom'")
        .refine(value => slug.safeParse(value).success, `it is also the slug of the ${kind}: lowercase letters, digits and dashes`)
        .refine(value => value.endsWith(suffix), `ends in ${suffix}, e.g. ${example}`)
        .describe(`Name of the new repository, ending in ${suffix} (e.g. ${example}). It is also the slug of the ${kind}`)
}

type RepositoryToCreate = z.infer<z.ZodObject<typeof repositoryToCreate>> & { repositoryName: string }

/**
 * The member to create with the repository it asks for, once the connection and the domain are
 * checked against the project and the template is known: an unknown slug would otherwise create an
 * empty repository at the provider.
 */
const withRepositoryToCreate = async <Fields extends { domainId?: string | null }>(
    { template, codeRepositoryId, repositoryName, private: isPrivate, gitlab, ...fields }: Fields & RepositoryToCreate,
    context: McpToolContext
) => {
    const codeRepository = { enabled: true, codeRepositoryId, repositoryId: "", gitlab }
    await ensureReferencesBelongToProject({ ...fields, codeRepository }, context)
    if (!(await new MarketService(context.principal).getSingle(template))) {
        throw createBusinessException({ code: "TEMPLATE_NOT_FOUND", message: `There is no template "${template}": see templates_list` })
    }
    return { ...fields, slug: repositoryName, codeRepository: { ...codeRepository, createData: { name: repositoryName, private: isPrivate, template } } }
}

/**
 * Scaffolding a repository from a marketplace template: the repository is created at the provider
 * with the connection's stored credentials, with its CI pipeline and, on GitHub, a deploy API key in
 * its secrets. Neither secret is ever part of the input or of the result. It cannot be undone from
 * here, so the console assistant asks the user first.
 */
export const scaffoldTools = [
    defineTool({
        name: "frontend_scaffold",
        title: "Create frontend from template",
        description:
            "Adds a frontend whose code repository is created at the provider from a marketplace template (a frontend one), through a code repository connection of the project (with its CI pipeline and, on GitHub, the deploy secret). Prefer a template built with the project's default frontend technology (project.technologies from context_get, matchesProjectTechnology in templates_list) unless the user asks for another. Use frontend_create instead to link a repository that already exists.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        requiresConfirmation: true,
        inputSchema: frontendCreateSchema
            .omit({ codeRepository: true, slug: true })
            .extend({ ...repositoryToCreate, repositoryName: repositoryName(frontendCreateSchema.shape.slug, "frontend", "checkout-fe") }),
        run: async (args, context) => new FrontendService(context.principal).create((await withRepositoryToCreate(args, context)) as unknown as FrontendDTO, context.projectId)
    }),
    defineTool({
        name: "backend_scaffold",
        title: "Create backend from template",
        description:
            "Adds a backend whose code repository is created at the provider from a marketplace template (a backend one), through a code repository connection of the project (with its CI pipeline and, on GitHub, the deploy secret). Port and probe paths left out come from the template. Prefer a template built with the project's default backend technology (project.technologies from context_get, matchesProjectTechnology in templates_list) unless the user asks for another. Use backend_create instead to link a repository that already exists.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        requiresConfirmation: true,
        inputSchema: backendCreateSchema
            .omit({ codeRepository: true, slug: true })
            .extend({ ...repositoryToCreate, repositoryName: repositoryName(backendCreateSchema.shape.slug, "backend", "orders-be") }),
        run: async (args, context) => new BackendService(context.principal).create((await withRepositoryToCreate(args, context)) as unknown as BackendDTO, context.projectId)
    })
]
