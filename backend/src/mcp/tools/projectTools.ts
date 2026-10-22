import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import { CONTEXT_MAX_LENGTH } from "../../models/ProjectModel"
import MarketService from "../../service/MarketService"
import ProjectService, { ContextFocus } from "../../service/ProjectService"
import { matchesProjectTechnology } from "../../service/RepositoryCreationService"
import { CERTIFICATE_ISSUER, DOMAIN_NAME } from "../../types/Exposure"
import { FrontendFramework } from "../../types/FrontendStack"
import { BackendTechnology } from "../../types/ProjectTechnology"
import { CONTAINER_REGISTRY, isServiceTemplateType } from "../../types/ServiceStack"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { defineTool, NO_INPUT, objectId, READ_ONLY, WRITE } from "../toolDefinition"

/** The focus of context_get, at most one of the ids: none reads the whole project. */
const toFocus = ({ frontendId, serviceId, domainId }: { frontendId?: string; serviceId?: string; domainId?: string }): ContextFocus | undefined => {
    const given = [frontendId, serviceId, domainId].filter(Boolean).length
    if (given > 1) {
        throw createBusinessException({ code: "CONTEXT_FOCUS_INVALID", message: "Pass at most one of frontendId, serviceId and domainId" })
    }
    if (frontendId) return { frontendId }
    if (serviceId) return { serviceId }
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
            "The notes the team wrote for AI agents: the context of the project (conventions, rules shared by everything) and the context of each functional domain, frontend and service (backend) that has one. " +
            "Read it before working on the project or on its code. Working on one frontend or service, pass its id: you get its context, the one of its domain and the project one. " +
            "Working on a domain, pass domainId: you get its context, the one of each of its frontends and services and the project one. Without ids, every context of the project. " +
            "project.technologies holds the default frontend and backend technology the team chose: use them for new frontends and services unless the user explicitly asks for another.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({
            frontendId: objectId("Id of the frontend you work on, from frontends_list").optional(),
            serviceId: objectId("Id of the service you work on, from services_list").optional(),
            domainId: objectId("Id of the domain you work on, from domains_list").optional()
        }),
        run: (args, { principal, projectId }) => new ProjectService(principal).getContext(projectId, toFocus(args))
    }),
    defineTool({
        name: "project_update",
        title: "Update project",
        description:
            "Renames the project or changes its description, its context (markdown notes for AI agents, replaced as a whole), its default technologies, where it is exposed or its container registry. Pass description, context, technologies, exposure or containerRegistry null to remove it.",
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
                .describe("Where the images are pushed, e.g. ghcr.io/acme: a service or DOCKER frontend with no image repository of its own is deployed as <containerRegistry>/<slug>"),
            technologies: z
                .object({
                    frontend: z.enum(FrontendFramework).nullable().optional().describe("Default framework of new frontends; null removes it, left out it stays as it is"),
                    backend: z.enum(BackendTechnology).nullable().optional().describe("Default technology of new services; null removes it, left out it stays as it is")
                })
                .nullable()
                .optional()
                .describe("The default technologies of the project: they guide who creates a frontend or a service, and never block another choice")
        }),
        run: (args, { principal, projectId }) => new ProjectService(principal).update(projectId, args)
    }),
    defineTool({
        name: "templates_list",
        title: "List templates",
        description:
            'The marketplace templates a repository can be scaffolded from: those of type "service" with service_scaffold, the others with frontend_scaffold. ' +
            "Those built with the default technologies of the project carry matchesProjectTechnology: true, prefer them unless the user asks for another stack.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: async (_args, { principal, projectId }) => {
            const [templates, project] = await Promise.all([new MarketService(principal).getAll(), new ProjectService(principal).findById(projectId)])
            return templates.map(template => {
                // The ones stored in the database are documents: spread as they are, they would serialise their internals
                const plain = typeof template.toObject === "function" ? template.toObject() : template
                const kind = isServiceTemplateType(template.type) ? "service" : "frontend"
                return matchesProjectTechnology(template, kind, project?.technologies) ? { ...plain, matchesProjectTechnology: true } : plain
            })
        }
    })
]
