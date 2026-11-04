import { z } from "zod"
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import { CONTEXT_MAX_LENGTH } from "../../models/ProjectModel"
import BackendService from "../../service/BackendService"
import { AuthorizedPrincipal } from "../../service/BaseAuthorizedService"
import DomainDeploymentService from "../../service/DomainDeploymentService"
import EnvironmentService from "../../service/EnvironmentService"
import MaintenanceAgentService from "../../service/MaintenanceAgentService"
import MarketService from "../../service/MarketService"
import ProjectService, { ContextFocus } from "../../service/ProjectService"
import { matchesProjectTechnology } from "../../service/RepositoryCreationService"
import { CONTAINER_REGISTRY, isBackendTemplateType } from "../../types/BackendStack"
import { CERTIFICATE_ISSUER, DOMAIN_NAME } from "../../types/Exposure"
import { FrontendFramework } from "../../types/FrontendStack"
import { BackendTechnology } from "../../types/ProjectTechnology"
import { MAX_TELEMETRY_VALUE_LENGTH, TELEMETRY_CATALOG, TELEMETRY_PROVIDERS, TelemetryProvider } from "../../types/ProjectTelemetry"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { defineTool, NO_INPUT, objectId, READ_ONLY, WRITE } from "../toolDefinition"
import { designSystemInput, probeFields } from "./frontendTools"

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

type VersionsByEnvironment = Record<string, string | null>

/**
 * The project at a glance, from what the console already reads for its screens: its environments, the frontends and
 * backends of each domain with the version each environment serves (as domain_deployments_get says it), and its
 * maintenance agents. Of the domains the user reaches only.
 */
const projectOverview = async (principal: AuthorizedPrincipal, projectId: string) => {
    const [project, environments, domains, backends, agents] = await Promise.all([
        new ProjectService(principal).findById(projectId),
        new EnvironmentService(principal).getByProjectId(projectId),
        new DomainDeploymentService(principal).getByProjectId(projectId),
        new BackendService(principal).getByProjectId(projectId),
        new MaintenanceAgentService(principal).getByProjectId(projectId)
    ])
    if (!project) throw new EntityNotFoundError(projectId)
    const latestVersions = new Map(backends.map(backend => [String(backend._id), backend.version ?? null]))
    return {
        project: { _id: String(project._id), name: project.name, slug: project.slug, description: project.description ?? null, technologies: project.technologies ?? null },
        environments: environments.map(({ _id, name, slug, isProduction }) => ({ _id: String(_id), name, slug, isProduction: Boolean(isProduction) })),
        domains: domains.map(({ domain, environments: served }) => {
            const frontends = new Map<string, { _id: string; name: string; slug: string; kind: string; versions: VersionsByEnvironment }>()
            const domainBackends = new Map<string, { _id: string; name: string; slug: string; latestVersion: string | null; versions: VersionsByEnvironment }>()
            for (const { environment, frontends: servedFrontends, backends: servedBackends } of served) {
                for (const frontend of servedFrontends) {
                    const row = frontends.get(String(frontend._id)) ?? { _id: String(frontend._id), name: frontend.name, slug: frontend.slug, kind: frontend.kind, versions: {} }
                    row.versions[environment.slug] = frontend.version
                    frontends.set(row._id, row)
                }
                for (const backend of servedBackends) {
                    const id = String(backend._id)
                    const row = domainBackends.get(id) ?? { _id: id, name: backend.name, slug: backend.slug, latestVersion: latestVersions.get(id) ?? null, versions: {} }
                    row.versions[environment.slug] = backend.version
                    domainBackends.set(id, row)
                }
            }
            return {
                domain: domain ? { _id: String(domain._id), name: domain.name, slug: domain.slug } : null,
                frontends: [...frontends.values()],
                backends: [...domainBackends.values()]
            }
        }),
        maintenanceAgents: agents.map(({ _id, name, slug, kind, schedule, version, domainId }) => ({
            _id: String(_id),
            name,
            slug,
            kind,
            schedule: schedule ?? null,
            version: version ?? null,
            domainId: domainId ? String(domainId) : null
        }))
    }
}

export const projectTools = [
    defineTool({
        name: "project_overview",
        title: "Project overview",
        description:
            "The project at a glance, in one call, with the ids every other tool takes: its environments in their order, its functional domains (domain null: the frontends and backends in none) with their frontends and backends, " +
            "the version each one runs in every environment, keyed by environment slug (from the deployment the environment serves; null: not deployed there), and for a backend the latest version its CI registered, and its maintenance agents. " +
            "Read context_get too before working on the code.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: (_args, { principal, projectId }) => projectOverview(principal, projectId)
    }),
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
            "project.designSystem is the UI library of the frontends: the project's own, else the organization's (project.designSystemSource says which); with frontendId, designSystem and designSystemSource repeat them as the one that frontend builds its UI with.",
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
            "The one of the design system the frontends build with: the project's, else the organization's; source says which. " +
            "The designSystem of context_get, frontend_get and the other tools carries the same npmrc. Keep it out of git: code_change_submit refuses an .npmrc.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        mcpOnly: true,
        inputSchema: NO_INPUT,
        run: (_args, { principal, projectId }) => new ProjectService(principal).getDesignSystemNpmrc(projectId)
    }),
    defineTool({
        name: "project_update",
        title: "Update project",
        description:
            "Renames the project or changes its description, its context (markdown notes for AI agents, replaced as a whole), its default technologies, its design system, the probe templates of its backends and frontends, where it is exposed, its container registry or its telemetry. Pass description, context, technologies, designSystem, probes, exposure, containerRegistry or telemetry null to remove it: without its own design system the project uses the organization's.",
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
            probes: z
                .object({
                    backend: z
                        .object(probeFields())
                        .nullable()
                        .optional()
                        .describe(
                            "What the backends and the maintenance agents of kind container are probed with when they do not set it; null removes it, left out it stays as it is. Replaced as a whole"
                        ),
                    frontend: z
                        .object(probeFields())
                        .nullable()
                        .optional()
                        .describe("What the DOCKER frontends are probed with when they do not set it; null removes it, left out it stays as it is. Replaced as a whole")
                })
                .nullable()
                .optional()
                .describe(
                    "The probe templates of the project: each backend, frontend or maintenance agent overrides any field by setting it, and inherits it when null. Applied by the next deploy of each environment"
                ),
            designSystem: designSystemInput.describe("The design system of the frontends; null goes back to the organization's. Replaced as a whole"),
            telemetry: z
                .object({
                    provider: z
                        .enum(TELEMETRY_PROVIDERS as [TelemetryProvider, ...TelemetryProvider[]])
                        .optional()
                        .describe("Where the applications send their telemetry; it needs its required fields in settings, given now or saved before. Left out it stays as it is"),
                    settings: z
                        .object(
                            Object.fromEntries(
                                TELEMETRY_PROVIDERS.map(provider => [
                                    provider,
                                    z
                                        .object(
                                            Object.fromEntries(
                                                TELEMETRY_CATALOG[provider].fields.map(field => [
                                                    field.name,
                                                    z
                                                        .string()
                                                        .max(MAX_TELEMETRY_VALUE_LENGTH)
                                                        .nullable()
                                                        .optional()
                                                        .describe(
                                                            `${field.variable} of the containers${field.required ? ", required" : ""}${field.secret ? ", secret: never returned" : ""}${field.example ? `, e.g. ${field.example}` : ""}; null removes it, left out it stays as it is`
                                                        )
                                                ])
                                            )
                                        )
                                        .optional()
                                ])
                            )
                        )
                        .optional()
                        .describe("What each provider is configured with, by provider then field: what is filled for a provider not picked stays saved"),
                    environmentIds: z
                        .array(z.string())
                        .nullable()
                        .optional()
                        .describe("Ids of the environments whose containers get the variables of the provider; null for every one, the ones added later included; left out it stays as it is")
                })
                .nullable()
                .optional()
                .describe(
                    "The telemetry of the applications: openTelemetry (OTLP, the default), applicationInsights (Azure), awsCloudWatch (CloudWatch and X-Ray through ADOT), googleCloud (Cloud Trace, Monitoring and Logging) or datadog. Each deploy hands the variables of the provider picked to the containers of the environments switched on, and agents instrument the code for it. Secret fields are never returned"
                )
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
