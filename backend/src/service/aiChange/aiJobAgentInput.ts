import { fastify } from "../.."
import AiChangeJob, { IAiChangeJob } from "../../models/AiChangeJobModel"
import Backend from "../../models/BackendModel"
import { IDomain } from "../../models/DomainModel"
import Environment from "../../models/EnvironmentModel"
import { IProject } from "../../models/ProjectModel"
import Resource, { IResource } from "../../models/ResourceModel"
import { ConfigMap, IVariableMap, Secret } from "../../models/VariableMapModel"
import { effectiveDesignSystem, IDesignSystem } from "../../types/DesignSystem"
import { effectiveSubdomain, exposedOrigin } from "../../types/Exposure"
import { resourceEnvKeys, resourceVariant } from "../../types/ResourceCatalog"
import { toObjectId } from "../../utils/mongooseUtils"
import { projectDesignSystemOf } from "../ProjectService"
import { keysOnly } from "../VariableMapService"
import { BackendComponent, componentsOfJob, RepositoryComponent } from "../workspace/repositoryComponent"
import { AiChangeAgentBackend, AiChangeAgentDomain, AiChangeAgentInput, AiChangeAgentRepository, AiChangeAgentResource } from "./aiChangeAgent"
import { sandboxForJob } from "./aiChangeSandboxes"
import { RunningRepository } from "./aiJobWorkingCopies"
import { AiChangeApiSpecSource } from "./apiSpecReader"

/** How far back a follow-up looks for the requests that came before it. */
const MAX_CHAIN_LENGTH = 50

/**
 * The slug the paths of each repository start with in a multi-repository job. A backend may share
 * its slug with a frontend of the project: the later one gets its kind appended, so every
 * path still points into exactly one repository.
 */
const pathSlugs = (components: RepositoryComponent[]) => {
    const taken = new Set<string>()
    return components.map(component => {
        let slug = component.slug
        while (taken.has(slug)) slug = `${slug}-${component.kind}`
        taken.add(slug)
        return slug
    })
}

/**
 * The fields of a resource whose shared value the agent is told: none is a credential, each tells how to use
 * the resource (where an api answers, which model an ai runs, which server an smtp is). A type left out, or
 * added later, is described by the names of its variables alone. A storage's provider is a fixed variable.
 */
const AGENT_VISIBLE_FIELDS: Record<string, string[]> = {
    api: ["baseUrl", "specUrl", "tokenUrl", "in", "name"],
    ai: ["model"],
    smtp: ["host", "port", "security", "from"],
    cosmosdb: ["endpoint", "database", "containerName"],
    sharepoint: ["siteUrl", "library"]
}

/** What is read of a resource for the agent: never its credentials, an override of an environment nor its pasted document */
const AGENT_RESOURCE_PROJECTION = "name type variant envPrefix customFields description context values.field values.value apiSpecBytes"

/** What the agent is told of a resource: its variables by name, and the value every environment shares of the visible fields */
const toAgentResource = (resource: Pick<IResource, "name" | "type" | "variant" | "envPrefix" | "customFields" | "description" | "context" | "values" | "apiSpecBytes">): AiChangeAgentResource => {
    const variant = resourceVariant(resource.type, resource.variant, resource.customFields)
    // Checked against the catalog too: a field that is a credential is never shown, whichever list it was found in
    const visible = new Set((AGENT_VISIBLE_FIELDS[resource.type] ?? []).filter(field => variant?.fields.some(spec => spec.name === field && !spec.secret)))
    const values = Object.fromEntries((resource.values ?? []).flatMap(({ field, value }) => (visible.has(field) && value ? [[field, value]] : [])))
    return {
        name: resource.name,
        type: resource.type,
        variant: resource.variant,
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.context ? { context: resource.context } : {}),
        keys: resourceEnvKeys(resource).map(({ key, field, secret, required, value }) => ({ key, ...(field !== undefined && { field }), secret, required, ...(value !== undefined && { value }) })),
        ...(Object.keys(values).length ? { values } : {}),
        ...(resource.type === "api" && resource.apiSpecBytes ? { apiSpec: true } : {})
    }
}

/** What the backends of a job get as environment variables and where they are reached, by backend id; the api documents read_api_spec reads */
interface JobBackendFacts {
    backends: Map<string, Partial<AiChangeAgentBackend>>
    apiSpecs: AiChangeApiSpecSource[]
}

/** The ids `pick` reads of each item, each once, as text. */
const uniqueIds = <T>(items: T[], pick: (item: T) => unknown[] | undefined) => [...new Set(items.flatMap(item => (pick(item) ?? []).map(String)))]

/**
 * The configuration of the backends of a job, as the agent may see it: the keys of their config maps and
 * secrets and the variables of their resources, never a value of a secret (nothing here is decrypted), the
 * URLs each one is reached at. A kind no backend attaches is not queried. `visibleResources`, for a job of a
 * domain-scoped member, keeps the resources they may read, as the console does: the agent is not told more.
 */
const backendFactsOf = async (project: Pick<IProject, "_id" | "exposure">, components: RepositoryComponent[], visibleResources?: Set<string>): Promise<JobBackendFacts> => {
    const backends = components.filter((component): component is BackendComponent => component.kind === "backend")
    const configMapIds = uniqueIds(backends, backend => backend.configMapIds)
    const secretIds = uniqueIds(backends, backend => backend.secretIds)
    const resourceIds = uniqueIds(backends, backend => backend.resourceIds).filter(id => !visibleResources || visibleResources.has(id))
    const exposure = project.exposure?.domain ? project.exposure : undefined
    const inProject = (ids: string[]) => ({ _id: { $in: ids.map(id => toObjectId(id)) }, projectId: project._id })
    const [configMaps, secrets, resources, environments] = await Promise.all([
        configMapIds.length ? ConfigMap.find(inProject(configMapIds), keysOnly) : [],
        secretIds.length ? Secret.find(inProject(secretIds), keysOnly) : [],
        resourceIds.length ? Resource.find(inProject(resourceIds), AGENT_RESOURCE_PROJECTION) : [],
        exposure && backends.some(backend => backend.exposurePath) ? Environment.find({ projectId: project._id }, { slug: 1, subdomain: 1, isProduction: 1 }).sort({ order: 1, createdAt: 1 }) : []
    ])
    const mapsOf = (found: IVariableMap[], ids: unknown[]) =>
        ids.flatMap(id => {
            const map = found.find(candidate => String(candidate._id) === String(id))
            return map ? [{ name: map.name, keys: (map.entries ?? []).map(entry => entry.key) }] : []
        })
    const facts = new Map<string, Partial<AiChangeAgentBackend>>()
    for (const backend of backends) {
        const exposurePath = backend.exposurePath
        const publicUrls =
            exposure && exposurePath
                ? environments.map(environment => ({ environment: environment.slug, url: `${exposedOrigin(exposure, effectiveSubdomain(environment))}${exposurePath.replace(/\/+$/, "")}` }))
                : []
        const backendConfigMaps = mapsOf(configMaps, backend.configMapIds ?? [])
        const backendSecrets = mapsOf(secrets, backend.secretIds ?? [])
        const backendResources = (backend.resourceIds ?? []).flatMap(id => resources.filter(resource => String(resource._id) === String(id)).map(toAgentResource))
        facts.set(String(backend._id), {
            ...(exposurePath ? { exposurePath } : {}),
            // The chart names the Kubernetes Service after the release, the slug of the backend, on port 80
            clusterUrl: `http://${backend.slug}`,
            ...(publicUrls.length ? { publicUrls } : {}),
            ...(backendConfigMaps.length ? { configMaps: backendConfigMaps } : {}),
            ...(backendSecrets.length ? { secrets: backendSecrets } : {}),
            ...(backendResources.length ? { resources: backendResources } : {})
        })
    }
    // Only an api with a document to read: read_api_spec, and the rule about it, are not offered for nothing
    const apiSpecs = resources
        .filter(resource => resource.type === "api")
        .map(resource => ({ resource, specUrl: resource.values?.find(value => value.field === "specUrl")?.value || undefined }))
        .filter(({ resource, specUrl }) => specUrl || resource.apiSpecBytes)
        .map(({ resource, specUrl }) => ({
            resource: resource.name,
            specUrl,
            // Read only if the agent asks: it can take megabytes, and only the document is read
            loadPasted: resource.apiSpecBytes ? async () => (await Resource.findOne({ _id: resource._id, projectId: project._id }, { apiSpec: 1 }))?.apiSpec : undefined
        }))
    return { backends: facts, apiSpecs }
}

/**
 * The resources the backends of a domain attach, each with the slugs of the backends using it; none read when
 * no backend attaches one. Only those in `visibleResources` when given, as for {@link backendFactsOf}.
 */
const domainResourcesOf = async (projectId: IAiChangeJob["projectId"], domain: IDomain, visibleResources?: Set<string>): Promise<NonNullable<AiChangeAgentDomain["resources"]>> => {
    const backends = await Backend.find({ projectId, domainId: domain._id }, { slug: 1, resourceIds: 1 })
    const ids = uniqueIds(backends, backend => backend.resourceIds).filter(id => !visibleResources || visibleResources.has(id))
    if (ids.length === 0) return []
    const resources = await Resource.find({ _id: { $in: ids.map(id => toObjectId(id)) }, projectId }, "name type description")
    return resources
        .map(resource => ({
            name: resource.name,
            type: resource.type,
            ...(resource.description ? { description: resource.description } : {}),
            usedBy: backends.filter(backend => (backend.resourceIds ?? []).some(id => String(id) === String(resource._id))).map(backend => backend.slug)
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * What the agent is told of a repository: a frontend's stack and the design system it builds its UI with (its own,
 * else the one of its project, which falls back on the organization's), or what the platform expects of a backend's container.
 */
const agentRepository = (
    component: RepositoryComponent,
    slug: string,
    rest: Omit<AiChangeAgentRepository, "frontend" | "backend">,
    facts?: Partial<AiChangeAgentBackend>,
    projectDesignSystem?: IDesignSystem
): AiChangeAgentRepository =>
    component.kind === "backend"
        ? {
              ...rest,
              backend: {
                  name: component.name,
                  slug,
                  runtime: component.runtime,
                  framework: component.framework,
                  port: component.port,
                  livenessPath: component.livenessPath,
                  readinessPath: component.readinessPath,
                  docsPath: component.docsPath,
                  openApiPath: component.openApiPath,
                  env: component.env.map(({ name, required, secret, description }) => ({ name, required, secret, description })),
                  context: component.context,
                  ...facts
              }
          }
        : {
              ...rest,
              frontend: {
                  name: component.name,
                  slug,
                  framework: component.framework,
                  compiler: component.compiler,
                  context: component.context,
                  designSystem: effectiveDesignSystem(component.designSystem, projectDesignSystem)
              }
          }

const toAgentDomain = (domain: IDomain, resources: AiChangeAgentDomain["resources"] = []): AiChangeAgentDomain => ({
    name: domain.name,
    description: domain.description,
    context: domain.context,
    ...(resources.length ? { resources } : {})
})

/** Whether two jobs work on the same repositories in the same order: the paths the agent knows then still point where they did. */
const sameRepositories = (a: IAiChangeJob, b: IAiChangeJob) => {
    const ids = (job: IAiChangeJob) => componentsOfJob(job).map(ref => `${ref.kind}:${ref.id}`)
    return ids(a).join(",") === ids(b).join(",")
}

/**
 * The conversation a follow-up carries on from: its parent's, when the parent worked on the same
 * repositories and kept one. Otherwise the agent starts over, told only what was asked before.
 */
const historyOf = async (job: IAiChangeJob): Promise<IAiChangeJob["transcript"]> => {
    if (!job.parentJobId) return undefined
    const parent = await AiChangeJob.findById(job.parentJobId, { transcript: 1, frontendIds: 1, backendIds: 1 })
    return parent?.transcript?.length && sameRepositories(parent, job) ? parent.transcript : undefined
}

/** What was asked before this job in its chain, oldest first. */
const previousRequests = async (job: IAiChangeJob): Promise<{ prompt: string; summary?: string }[]> => {
    const previous: { prompt: string; summary?: string }[] = []
    let parentId = job.parentJobId
    while (parentId && previous.length < MAX_CHAIN_LENGTH) {
        const parent = await AiChangeJob.findById(parentId, { prompt: 1, summary: 1, parentJobId: 1 })
        if (!parent) break
        previous.unshift({ prompt: parent.prompt, summary: parent.summary })
        parentId = parent.parentJobId
    }
    return previous
}

/**
 * What the agent of a job is given: the project, the domain it works on or those its repositories are in, each
 * repository with its working copy, and what came before in the conversation. `visibleResources`, for a job of a
 * domain-scoped member, keeps the resources they may read: the job runs as whoever started it, and sees no more.
 */
export const agentInputOf = async (
    job: IAiChangeJob,
    project: IProject,
    domain: IDomain | null,
    memberDomains: IDomain[],
    repositories: RunningRepository[],
    visibleResources?: Set<string>
): Promise<AiChangeAgentInput> => {
    const components = repositories.map(repository => repository.component)
    // Independent reads, side by side
    const [history, { designSystem: projectDesignSystem }, facts, domainResources] = await Promise.all([
        historyOf(job),
        // The one a frontend without its own builds with: the project's, else the organization's
        projectDesignSystemOf(project),
        backendFactsOf(project, components, visibleResources),
        domain ? domainResourcesOf(job.projectId, domain, visibleResources) : []
    ])
    const slugs = pathSlugs(components)
    return {
        prompt: job.prompt,
        images: job.images?.map(({ mediaType, data }) => ({ mediaType, data })),
        effort: job.effort,
        project: { name: project.name, context: project.context, technologies: project.technologies },
        domain: domain ? toAgentDomain(domain, domainResources) : undefined,
        memberDomains: memberDomains.map(memberDomain => toAgentDomain(memberDomain)),
        repositories: repositories.map(({ component, request, workspace, previousFiles }, index) =>
            agentRepository(
                component,
                slugs[index],
                {
                    baseBranch: request.baseBranch,
                    workingCopy: workspace.workingCopy,
                    previousChanges: (previousFiles ?? []).map(file => ({
                        path: file.path,
                        bytes: file.proposedContent === undefined ? 0 : Buffer.byteLength(file.proposedContent, "utf8")
                    }))
                },
                facts.backends.get(String(component._id)),
                projectDesignSystem
            )
        ),
        previousRequests: history ? undefined : await previousRequests(job),
        history,
        ...(facts.apiSpecs.length ? { apiSpecs: facts.apiSpecs } : {}),
        sandbox: sandboxForJob(fastify.config, job),
        previewsEnabled: fastify.config.OPENSHELL_PREVIEWS_ENABLED
    }
}
