import { z } from "zod"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import { DOMAIN_DESCRIPTION_MAX_LENGTH, DOMAIN_NAME_MAX_LENGTH } from "../../models/DomainModel"
import { CONTEXT_MAX_LENGTH } from "../../models/ProjectModel"
import DomainService from "../../service/DomainService"
import FrontendService from "../../service/FrontendService"
import ProjectService from "../../service/ProjectService"
import { ResourceService } from "../../service/ResourceService"
import ServiceService from "../../service/ServiceService"
import DomainDTO from "../../types/DomainDTO"
import { resourceEnvKeys } from "../../types/ResourceCatalog"
import { SERVICE_VERSION } from "../../types/ServiceStack"
import { isValidRefName } from "../../utils/gitRefUtils"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE, defineTool, McpToolContext, NO_INPUT, objectId, READ_ONLY, WRITE, WRITE_EXTERNAL } from "../toolDefinition"

const domainId = objectId("Id of the domain, from domains_list")

const domainFields = {
    name: z.string().min(1).max(DOMAIN_NAME_MAX_LENGTH),
    description: z.string().max(DOMAIN_DESCRIPTION_MAX_LENGTH).optional(),
    context: z.string().max(CONTEXT_MAX_LENGTH).optional().describe("Markdown notes for AI agents about this domain, replaced as a whole")
}

const getExisting = async (id: string, { principal }: McpToolContext) => {
    const domain = await new DomainService(principal).getById(id)
    if (!domain) {
        throw new EntityNotFoundError(id)
    }
    return domain
}

/** The domain a frontend or a service is put in, for its create and update tools. */
export const memberDomainId = objectId("Id of a domain of this project, from domains_list")
    .nullable()
    .optional()
    .describe("Id of a domain of this project, from domains_list, to put it in; null takes it out of any domain")

/** Narrows a list tool to one domain, or to the items in none. */
export const NO_DOMAIN = "none"
export const domainFilter = z
    .union([objectId("Id of a domain, from domains_list"), z.literal(NO_DOMAIN)])
    .optional()
    .describe(`Only the items of this domain (its id), or "${NO_DOMAIN}" for the items in no domain`)

export const matchesDomain = (member: { domainId?: unknown }, filter: string | undefined) => {
    if (filter === undefined) return true
    if (filter === NO_DOMAIN) return !member.domainId
    // Ids are accepted in either case: stored ones are lowercase
    return String(member.domainId ?? "").toLowerCase() === filter.toLowerCase()
}

/**
 * The members of a list tool that match its domain filter. A domain id is looked up first, so an
 * unknown domain, or one of another project, is refused as not found rather than listing nothing.
 */
export const filterByDomain = async <Member extends { domainId?: unknown }>(members: Member[], filter: string | undefined, context: McpToolContext) => {
    if (filter !== undefined && filter !== NO_DOMAIN) {
        await getExisting(filter, context)
    }
    return members.filter(member => matchesDomain(member, filter))
}

/**
 * The resources the services of a domain attach, each with the variables it sets and the services using it:
 * read only when one of them attaches any, never a value.
 */
const domainResources = async (services: { slug: string; resourceIds?: unknown[] }[], context: McpToolContext) => {
    const ids = new Set(services.flatMap(service => (service.resourceIds ?? []).map(String)))
    if (ids.size === 0) return []
    const resources = await new ResourceService(context.principal).getByProjectId(context.projectId)
    return resources
        .filter(resource => ids.has(String(resource._id)))
        .map(resource => ({
            _id: resource._id,
            name: resource.name,
            type: resource.type,
            variant: resource.variant,
            env: resourceEnvKeys(resource).map(({ key }) => key),
            usedBy: services.filter(service => (service.resourceIds ?? []).some(id => String(id) === String(resource._id))).map(service => service.slug)
        }))
}

/** A member of a domain as `domain_get` lists it: enough to address it with the other tools. */
const toMember = (member: { _id: unknown; name: string; slug: string }) => ({ _id: member._id, name: member.name, slug: member.slug })

export const domainTools = [
    defineTool({
        name: "domains_list",
        title: "List domains",
        description: "The functional domains of the project, by name, each with how many frontends and services (backend) it groups.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: (_args, { principal, projectId }) => new DomainService(principal).getByProjectId(projectId)
    }),
    defineTool({
        name: "domain_get",
        title: "Get domain",
        description:
            "One functional domain of the project, with the id, name and slug of each frontend and service in it, the resources its services attach (with the environment variables each sets), and aiContext: what the team wrote for AI agents about the domain, each of its frontends and services, and the project. Follow it when working on the domain.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ domainId }),
        run: async (args, context) => {
            const domain = await getExisting(args.domainId, context)
            const [frontends, services, aiContext] = await Promise.all([
                new FrontendService(context.principal).getByProjectId(context.projectId),
                new ServiceService(context.principal).getByProjectId(context.projectId),
                new ProjectService(context.principal).getContext(context.projectId, { domainId: String(domain._id) })
            ])
            const inDomain = (member: { domainId?: unknown }) => matchesDomain(member, String(domain._id))
            const resources = await domainResources(services.filter(inDomain), context)
            return {
                ...domain.toObject(),
                frontends: frontends.filter(inDomain).map(toMember),
                services: services.filter(inDomain).map(toMember),
                ...(resources.length ? { resources } : {}),
                aiContext
            }
        }
    }),
    defineTool({
        name: "domain_create",
        title: "Create domain",
        description: "Adds a functional domain to the project, a named group of frontends and services. Put members in it with frontend_update or service_update and its id as domainId.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE,
        inputSchema: z.object({
            ...domainFields,
            slug: z
                .string()
                .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
                .max(100)
                .optional()
                .describe("Derived from the name when omitted. Fixed after creation")
        }),
        run: (args, { principal, projectId }) => new DomainService(principal).create(args, projectId)
    }),
    defineTool({
        name: "domain_update",
        title: "Update domain",
        description: "Changes the name, the description or the context (markdown notes for AI agents) of a domain. The slug is fixed after creation.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({
            domainId,
            name: domainFields.name.optional(),
            description: z.string().max(DOMAIN_DESCRIPTION_MAX_LENGTH).nullable().optional().describe("null clears it"),
            context: domainFields.context.nullable().describe("Markdown notes for AI agents about this domain, replaced as a whole; null clears it")
        }),
        // null reaches the service as is: it accepts it and stores no description nor context
        run: ({ domainId: id, ...changes }, { principal }) => new DomainService(principal).update(id, changes as DomainDTO)
    }),
    defineTool({
        name: "domain_trigger_build",
        title: "Trigger domain build",
        description:
            "Tags the repository of every frontend and service of the domain with the same version, on the same branch, which starts the CI pipeline of each. A repository shared by members is tagged once. Every repository is checked first (connection, branch, a tag of that version): when one fails, none is tagged and the error lists each. The result tells, per repository, whether it was tagged.",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            domainId,
            version: z.string().regex(SERVICE_VERSION, "letters, digits, dots, dashes and underscores, at most 128").describe("Version to tag every repository with, e.g. 1.4.0"),
            branch: z.string().refine(isValidRefName, "a valid git branch name, at most 255 characters").optional().describe("Branch to tag in every repository, main when omitted")
        }),
        run: (args, { principal }) => new DomainService(principal).build(args.domainId, args.version, args.branch)
    }),
    defineTool({
        name: "domain_delete",
        title: "Delete domain",
        description: 'Deletes a functional domain. Its frontends and services are kept: they become "no domain".',
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ domainId }),
        run: (args, { principal }) => new DomainService(principal).delete(args.domainId)
    })
]
