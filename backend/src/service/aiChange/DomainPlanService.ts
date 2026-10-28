import { fastify } from "../.."
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import Backend from "../../models/BackendModel"
import Domain from "../../models/DomainModel"
import Frontend from "../../models/FrontendModel"
import MaintenanceAgent from "../../models/MaintenanceAgentModel"
import { IMarket } from "../../models/MarketModel"
import Project, { IProject } from "../../models/ProjectModel"
import Resource from "../../models/ResourceModel"
import { BACKEND_SLUG } from "../../types/BackendStack"
import { describeProjectTechnologies, IProjectTechnologies } from "../../types/ProjectTechnology"
import { toObjectId } from "../../utils/mongooseUtils"
import { aiProviderError } from "../llm"
import MarketService from "../MarketService"
import { projectDesignSystemOf } from "../ProjectService"
import { defaultTemplateOf, isTemplateOfKind, matchesProjectTechnology, REPOSITORY_NAME_SUFFIXES } from "../RepositoryCreationService"
import { isValidRepositoryName } from "../RepositoryRenameService"
import { resourceIdsInScope } from "../ResourceService"
import { RepositoryComponentKind } from "../workspace/repositoryComponent"
import { AiChangeBaseService, loggable } from "./aiChangeShared"

/** Components of each kind a plan may propose: a domain starts small, the agent can be asked for more later. */
export const MAX_PLANNED_PER_KIND = 3
const MAX_TOKENS = 4_000
const MAX_NAME_LENGTH = 100
const MAX_REASON_LENGTH = 500
const MAX_REPOSITORY_NAME_LENGTH = 100

export interface DomainPlanInput {
    domainId: string
    prompt: string
    /** The AI that plans, one the project may use: the project's default when left out. */
    aiModelId?: string
}

/** A frontend or a backend the AI proposes to create, with the repository it would be scaffolded in. */
export interface DomainPlanComponent {
    name: string
    slug: string
    /** Slug of a marketplace template of the right kind. */
    template: string
    repositoryName: string
    /** Why the request needs it, in the words of the model. */
    reason: string
}

export interface DomainPlan {
    frontends: DomainPlanComponent[]
    backends: DomainPlanComponent[]
}

/** How each proposed component is written: shared with the conversation that drafts a new domain. */
export const COMPONENT_RULES = `- name: a short human name, e.g. "Orders".
- slug: lowercase letters, digits and dashes, 2 to 50 characters, starting with a letter or a digit, not one of the slugs already taken.
- repositoryName: the slug followed by "${REPOSITORY_NAME_SUFFIXES.frontend}" for a frontend and by "${REPOSITORY_NAME_SUFFIXES.backend}" for a backend, e.g. orders${REPOSITORY_NAME_SUFFIXES.frontend} and orders${REPOSITORY_NAME_SUFFIXES.backend}.
- template: the slug of one of the listed templates of the same kind. Unless the request explicitly asks for another stack, prefer one marked "project technology": it is built with the default technology the team chose for that kind (see project_technologies). Otherwise the one whose stack fits the project best; when nothing hints at a stack, the one marked default.
- reason: one sentence, in the language of the request, on what the component does for it.
- Shared resources of the project are listed: a backend can attach them, so do not plan a component that only provides one of them.`

const PLAN_SYSTEM_PROMPT = `You plan the first components of a functional domain on Flightroom, a platform where a project is made of frontends (each in its own repository) and backends (each in its own repository, deployed as a container). The domain has no component yet. From the user's request, propose the frontends and the backends to create so that an AI agent can then implement the request in them.
- Propose the smallest set the request needs: usually one frontend and one backend, none of a kind the request does not need, at most ${MAX_PLANNED_PER_KIND} of each.
${COMPONENT_RULES}
Follow the project and domain context: it is what the team wrote for AI agents.`

export const PLAN_COMPONENT_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string" },
        slug: { type: "string" },
        template: { type: "string" },
        repositoryName: { type: "string" },
        reason: { type: "string" }
    },
    required: ["name", "slug", "template", "repositoryName", "reason"],
    additionalProperties: false
}

const PLAN_SCHEMA = {
    type: "object",
    properties: {
        frontends: { type: "array", items: PLAN_COMPONENT_SCHEMA },
        backends: { type: "array", items: PLAN_COMPONENT_SCHEMA }
    },
    required: ["frontends", "backends"],
    additionalProperties: false
}

type Template = Pick<IMarket, "slug" | "type" | "framework" | "compiler" | "description" | "comingSoon">

/** What the model is told of the project to plan components in it, and what their sanitizing needs. */
export interface PlanningBrief {
    project: Pick<IProject, "name" | "context" | "technologies" | "exposure"> | null
    templates: Template[]
    taken: Record<RepositoryComponentKind, Set<string>>
    technologies?: IProjectTechnologies
    /** Blocks of the user message on the project itself: its context, technologies and design system. */
    projectBlocks: string[]
    /** Blocks of the user message on what components can be made of: templates, taken slugs, resources. */
    componentBlocks: string[]
}

export const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "")

/** A slug the platform accepts, from whatever the model wrote: lowercase kebab case, 2 to 50 characters. */
const toSlug = (value: string, fallback: string) => {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .slice(0, 50)
        .replace(/-+$/, "")
    return BACKEND_SLUG.test(slug) ? slug : fallback
}

/** The slug itself when free, otherwise the first `slug-2`, `slug-3`... that is: two members of a kind cannot share one. */
const freeSlug = (slug: string, taken: Set<string>) => {
    let candidate = slug
    for (let index = 2; taken.has(candidate); index++) candidate = `${slug.slice(0, 50 - String(index).length - 1)}-${index}`
    taken.add(candidate)
    return candidate
}

const describeTemplate = (template: Template, isDefault: boolean, isProjectTechnology: boolean) =>
    `- ${template.slug}${isDefault ? " (default)" : ""}${isProjectTechnology ? " (project technology)" : ""}: ${[template.type, template.framework, template.compiler].filter(Boolean).join(", ")}${template.description ? ` — ${template.description}` : ""}`

/**
 * What the model proposed, made safe to show as a starting point: unknown or wrong-kind templates
 * become the default of the kind, one matching the technologies of the project when there is one, slugs and repository names valid and free in the project, at
 * most {@link MAX_PLANNED_PER_KIND} of each kind. The user still reviews it before anything is created.
 */
export const sanitizePlan = (answer: unknown, templates: Template[], taken: Record<RepositoryComponentKind, Set<string>>, technologies?: IProjectTechnologies): DomainPlan => {
    const proposed = (answer ?? {}) as Partial<Record<"frontends" | "backends", unknown>>
    const sanitize = (items: unknown, kind: RepositoryComponentKind): DomainPlanComponent[] => {
        const ofKind = templates.filter(template => isTemplateOfKind(template, kind))
        const fallbackTemplate = defaultTemplateOf(templates, kind, technologies)
        // Without a template of the kind nothing of it can be scaffolded: the plan leaves it out.
        if (!fallbackTemplate || !Array.isArray(items)) return []
        const suffix = REPOSITORY_NAME_SUFFIXES[kind]
        const repositoryNames = new Set<string>()
        return items.slice(0, MAX_PLANNED_PER_KIND).map((item: Record<string, unknown>, index) => {
            const name = text(item?.name, MAX_NAME_LENGTH)
            const askedSlug = text(item?.slug, 100)
            const slug = freeSlug(toSlug(askedSlug || name, `${kind === "backend" ? "backend" : "frontend"}-${index + 1}`), taken[kind])
            const template = ofKind.find(candidate => candidate.slug === text(item?.template, 255)) ?? fallbackTemplate
            // The model's name only while its slug survived as is: a renamed slug renames the repository too.
            const asked = text(item?.repositoryName, MAX_REPOSITORY_NAME_LENGTH)
            const base = slug === askedSlug && asked.endsWith(suffix) && isValidRepositoryName(asked) ? asked : slug.endsWith(suffix) ? slug : `${slug}${suffix}`
            let repositoryName = base
            // The stem is cut so that the numbered name still fits the 100 characters every provider accepts
            for (let copy = 2; repositoryNames.has(repositoryName); copy++) {
                repositoryName = `${base.slice(0, -suffix.length).slice(0, MAX_REPOSITORY_NAME_LENGTH - suffix.length - String(copy).length - 1)}-${copy}${suffix}`
            }
            repositoryNames.add(repositoryName)
            return { name: name || slug, slug, template: template.slug, repositoryName, reason: text(item?.reason, MAX_REASON_LENGTH) }
        })
    }
    return { frontends: sanitize(proposed.frontends, "frontend"), backends: sanitize(proposed.backends, "backend") }
}

/**
 * Proposes the frontends and backends a domain without any should start with, for the change
 * the user asked for: one model call answered with JSON, no agent and no repository. The console
 * shows the plan for review and creates what the user keeps, then starts the domain job on it.
 */
export class DomainPlanService extends AiChangeBaseService {
    async plan(projectId: string, input: DomainPlanInput): Promise<DomainPlan> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureCanChangeProject(projectIdObj)
        const { client } = await this.aiModels().resolveForProject(projectIdObj, input.aiModelId)
        const domain = await Domain.findOne({ _id: toObjectId(input.domainId), projectId: projectIdObj })
        if (!domain) throw new EntityNotFoundError(input.domainId)
        await this.ensureInDomainScope(projectIdObj, domain._id)

        // Members already there are what the job works on: planning new ones would duplicate them.
        const inDomain = { projectId: projectIdObj, domainId: domain._id }
        if ((await Frontend.exists(inDomain)) || (await Backend.exists(inDomain))) {
            throw createBusinessException({ code: "AI_DOMAIN_PLAN_HAS_MEMBERS", message: `The domain ${domain.name} already has frontends or backends`, statusCode: 422 })
        }

        const brief = await this.planningBrief(projectIdObj)
        const answer = await client
            .json({
                system: PLAN_SYSTEM_PROMPT,
                user: [
                    `<request>\n${input.prompt}\n</request>`,
                    ...brief.projectBlocks,
                    [`<domain_context domain="${domain.name}">`, domain.description, domain.context, "</domain_context>"].filter(Boolean).join("\n"),
                    ...brief.componentBlocks
                ].join("\n\n"),
                schema: PLAN_SCHEMA,
                maxTokens: MAX_TOKENS,
                effort: "low"
            })
            .catch(error => {
                // The provider's own message stays in the log: it may quote what the endpoint answered.
                fastify.log.warn({ error: loggable(error), projectId }, "AI domain plan failed")
                throw aiProviderError(error)
            })
        if (!answer) {
            throw createBusinessException({
                code: "AI_DOMAIN_PLAN_FAILED",
                message: "The AI could not propose the components of the domain: try again or describe the request differently",
                statusCode: 502
            })
        }
        return sanitizePlan(answer, brief.templates, brief.taken, brief.technologies)
    }

    /**
     * What a model planning components needs to know of the project: its context, technologies and design system, the
     * templates it may scaffold from, the slugs already taken and the resources a backend can attach.
     */
    protected async planningBrief(projectIdObj: ReturnType<typeof toObjectId>): Promise<PlanningBrief> {
        // A domain-scoped member is told of the resources they may read only, as the console lists them
        const scope = await this.getDomainScope(projectIdObj)
        const visibleResources = scope ? { _id: { $in: [...(await resourceIdsInScope(projectIdObj, scope))].map(id => toObjectId(id)) } } : {}
        const [project, templates, frontends, backends, resources, agents] = await Promise.all([
            Project.findById(projectIdObj, { name: 1, context: 1, technologies: 1, designSystem: 1, organizationId: 1, exposure: 1 }),
            new MarketService().getAll(),
            Frontend.find({ projectId: projectIdObj }, { slug: 1 }),
            Backend.find({ projectId: projectIdObj }, { slug: 1 }),
            // What a backend of the domain can attach instead of a component of its own: never a value of one
            Resource.find({ projectId: projectIdObj, ...visibleResources }, { name: 1, type: 1, description: 1 }),
            // A maintenance agent takes its slug from both
            MaintenanceAgent.find({ projectId: projectIdObj }, { slug: 1 })
        ])
        const taken = { frontend: new Set([...frontends, ...agents].map(item => item.slug)), backend: new Set([...backends, ...agents].map(item => item.slug)) }
        const technologies = project?.technologies
        // The one its frontends build their UI with: it may decide which frontend template fits
        const designSystem = project ? (await projectDesignSystemOf(project)).designSystem : undefined
        const templateList = (kind: RepositoryComponentKind) => {
            const fallback = defaultTemplateOf(templates, kind, technologies)
            return templates
                .filter(template => isTemplateOfKind(template, kind))
                .map(template => describeTemplate(template, template.slug === fallback?.slug, matchesProjectTechnology(template, kind, technologies)))
                .join("\n")
        }
        const present = (blocks: (string | undefined)[]) => blocks.filter((block): block is string => Boolean(block))
        return {
            project,
            templates,
            taken,
            technologies,
            projectBlocks: present([
                project?.context ? `<project_context project="${project.name}">\n${project.context}\n</project_context>` : `<project name="${project?.name ?? ""}" />`,
                describeProjectTechnologies(technologies),
                // Its name and where it is documented only: the npmrc and the notes are for the agent writing the code
                designSystem
                    ? present([
                          "<project_design_system>",
                          `package: ${designSystem.packageName}`,
                          designSystem.version ? `version: ${designSystem.version}` : undefined,
                          designSystem.docsUrl ? `docs: ${designSystem.docsUrl}` : undefined,
                          "The frontends of the project build their UI with this design system: prefer a frontend template whose framework can use it.",
                          "</project_design_system>"
                      ]).join("\n")
                    : undefined
            ]),
            componentBlocks: present([
                `<frontend_templates>\n${templateList("frontend")}\n</frontend_templates>`,
                `<backend_templates>\n${templateList("backend")}\n</backend_templates>`,
                `<taken_slugs>\nfrontends: ${[...taken.frontend].join(", ") || "none"}\nbackends: ${[...taken.backend].join(", ") || "none"}\n</taken_slugs>`,
                resources.length
                    ? `<project_resources>\n${resources.map(resource => `- ${resource.name} (${resource.type})${resource.description ? `: ${resource.description}` : ""}`).join("\n")}\n</project_resources>`
                    : undefined
            ])
        }
    }
}

export default DomainPlanService
