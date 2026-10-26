import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import { CONTEXT_MAX_LENGTH } from "../../models/ProjectModel"
import MarketService from "../../service/MarketService"
import ProjectService, { ContextFocus } from "../../service/ProjectService"
import { matchesProjectTechnology } from "../../service/RepositoryCreationService"
import { CONTAINER_REGISTRY, isBackendTemplateType } from "../../types/BackendStack"
import { CERTIFICATE_ISSUER, DOMAIN_NAME } from "../../types/Exposure"
import { FrontendFramework } from "../../types/FrontendStack"
import { BackendTechnology } from "../../types/ProjectTechnology"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { defineTool, NO_INPUT, objectId, READ_ONLY, WRITE } from "../toolDefinition"
import { designSystemInput } from "./frontendTools"

/** The focus of context_get, at most one of the ids: none reads the whole project. */
const toFocus = ({ frontendId, backendId, domainId }: { frontendId?: string; backendId?: string; domainId?: string }): ContextFocus | undefined => {
    const given = [frontendId, backendId, domainId].filter(Boolean).length
    if (given > 1) {
        throw createBusinessException({ code: "CONTEXT_FOCUS_INVALID", message: "Pass at most one of frontendId, backendId and domainId" })
    }
    if (frontendId) return { frontendId }
    if (backendId) return { backendId }
    if (domainId) return { domainId }
    return undefined
}

export const projectTools = [
    defineTool({
        name: "project_get",
        title: "Get project",
        description: "The project this connection is bound to, with how many environments, frontends, members, storages, databases and code repositories it has.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: (_args, { principal, projectId }) => new ProjectService(principal).getSummary(projectId)
    }),
    defineTool({
        name: "context_get",
        title: "Get project context",
        description:
            "The notes the team wrote for AI agents: the context of the project (conventions, rules shared by everything) and the context of each functional domain, frontend and backend that has one. " +
            "Read it before working on the project or on its code. Working on one frontend or backend, pass its id: you get its context, the one of its domain and the project one. " +
            "Working on a domain, pass domainId: you get its context, the one of each of its frontends and backends and the project one. Without ids, every context of the project. " +
            "project.technologies holds the default frontend and backend technology the team chose: use them for new frontends and backends unless the user explicitly asks for another. " +
            "project.designSystem is the UI library of the frontends: the project's own, else the organization's (project.designSystemSource says which); with frontendId, designSystem is the one that frontend builds its UI with and designSystemSource the level it is set at.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({
            frontendId: objectId("Id of the frontend you work on, from frontends_list").optional(),
            backendId: objectId("Id of the backend you work on, from backends_list").optional(),
            domainId: objectId("Id of the domain you work on, from domains_list").optional()
        }),
        run: (args, { principal, projectId }) => new ProjectService(principal).getContext(projectId, toFocus(args))
    }),
    defineTool({
        name: "design_system_npmrc_get",
        title: "Get design system .npmrc",
        description:
            "The whole .npmrc the design system installs with, credentials included: write it as .npmrc next to package.json (or merge it into ~/.npmrc) to install the package. " +
            "With frontendId, the one of the design system that frontend builds with; without, the project's. source says which level it is set at. " +
            "The designSystem of context_get, frontend_get and the other tools carries the same npmrc. Keep it out of git: code_change_submit refuses an .npmrc.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        mcpOnly: true,
        inputSchema: z.object({ frontendId: objectId("Id of the frontend whose design system to read, from frontends_list").optional() }),
        run: (args, { principal, projectId }) => new ProjectService(principal).getDesignSystemNpmrc(projectId, args.frontendId)
    }),
    defineTool({
        name: "project_update",
        title: "Update project",
        description:
            "Renames the project or changes its description, its context (markdown notes for AI agents, replaced as a whole), its default technologies, its design system, where it is exposed or its container registry. Pass description, context, technologies, designSystem, exposure or containerRegistry null to remove it: without its own design system the project uses the organization's.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({
            name: z.string().min(1).max(255).optional(),
            description: z.string().max(2000).nullable().optional(),
            context: z.string().max(CONTEXT_MAX_LENGTH).nullable().optional(),
            exposure: z
                .object({
                    domain: z.string().regex(DOMAIN_NAME, "a lowercase domain of at least two labels, e.g. example.com").describe("Domain each environment is exposed on, under its subdomain"),
                    certificateIssuer: z
                        .string()
                        .regex(CERTIFICATE_ISSUER, "the name of a Kubernetes resource")
                        .nullable()
                        .optional()
                        .describe("cert-manager ClusterIssuer the TLS certificate of each environment is asked of; without one, HTTP only"),
                    httpPort: z.number().int().min(1).max(65535).nullable().optional().describe("Port of the HTTP listener: the one the Traefik web entry point listens on inside the pod. Default 80"),
                    httpsPort: z
                        .number()
                        .int()
                        .min(1)
                        .max(65535)
                        .nullable()
                        .optional()
                        .describe("Port of the HTTPS listener: the one the Traefik websecure entry point listens on inside the pod. Default 443")
                })
                .nullable()
                .optional()
                .describe("Where GitOps exposes the environments: a Traefik Gateway per environment, an HTTPRoute per application with its exposurePath. Replaced as a whole"),
            containerRegistry: z
                .string()
                .regex(CONTAINER_REGISTRY, "a host, with a port and a namespace if any, without scheme nor trailing slash, e.g. ghcr.io/acme")
                .nullable()
                .optional()
                .describe("Where the images are pushed, e.g. ghcr.io/acme: a backend or DOCKER frontend with no image repository of its own is deployed as <containerRegistry>/<slug>"),
            technologies: z
                .object({
                    frontend: z.enum(FrontendFramework).nullable().optional().describe("Default framework of new frontends; null removes it, left out it stays as it is"),
                    backend: z.enum(BackendTechnology).nullable().optional().describe("Default technology of new backends; null removes it, left out it stays as it is")
                })
                .nullable()
                .optional()
                .describe("The default technologies of the project: they guide who creates a frontend or a backend, and never block another choice"),
            designSystem: designSystemInput.describe("The design system of the frontends, which one may replace with its own; null goes back to the organization's. Replaced as a whole")
        }),
        run: (args, { principal, projectId }) => new ProjectService(principal).update(projectId, args)
    }),
    defineTool({
        name: "templates_list",
        title: "List templates",
        description:
            'The marketplace templates a repository can be scaffolded from: those of type "service" (backend templates) with backend_scaffold, the others with frontend_scaffold. ' +
            "Those built with the default technologies of the project carry matchesProjectTechnology: true, prefer them unless the user asks for another stack.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: async (_args, { principal, projectId }) => {
            const [templates, project] = await Promise.all([new MarketService(principal).getAll(), new ProjectService(principal).findById(projectId)])
            return templates.map(template => {
                // The ones stored in the database are documents: spread as they are, they would serialise their internals
                const plain = typeof template.toObject === "function" ? template.toObject() : template
                const kind = isBackendTemplateType(template.type) ? "backend" : "frontend"
                return matchesProjectTechnology(template, kind, project?.technologies) ? { ...plain, matchesProjectTechnology: true } : plain
            })
        }
    })
]
