import { createHash } from "node:crypto"
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import Backend from "../../models/BackendModel"
import Domain from "../../models/DomainModel"
import Environment from "../../models/EnvironmentModel"
import Frontend from "../../models/FrontendModel"
import Project from "../../models/ProjectModel"
import Resource from "../../models/ResourceModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { ConfigMap, Secret } from "../../models/VariableMapModel"
import { IDesignSystem } from "../../types/DesignSystem"
import { resourceEnvironmentValues } from "../../types/ResourceCatalog"
import { runtimeVariables } from "../../types/RuntimeVariables"
import { toObjectId } from "../../utils/mongooseUtils"
import { withRepositoryLock } from "../../utils/repositoryLock"
import BaseAuthorizedService, { AuthorizedPrincipal } from "../BaseAuthorizedService"
import { mapValues } from "../ContainerEnvironmentService"
import { projectDesignSystemOf } from "../ProjectService"
import { OpenShellConfiguration, openShellSandboxes } from "../sandbox/OpenShellSandboxes"
import { languagesOfComponents } from "../sandbox/sandboxLanguages"
import { effectiveOpenShellConfig } from "../sandbox/sandboxSettings"
import { RepositoryWorkspaceService } from "../workspace/RepositoryWorkspaceService"
import { BackendComponent, FrontendComponent, fromBackend, fromFrontend, RepositoryComponent } from "../workspace/repositoryComponent"
import { sandboxLifecycle } from "./aiChangeSandboxes"
import { AiChangeScriptRunner, ScriptRepository } from "./aiChangeScripts"

export interface StandalonePreviewInput {
    kind: "frontend" | "backend" | "domain"
    id: string
}

const unavailable = () =>
    createBusinessException({
        code: "OPENSHELL_PREVIEW_UNAVAILABLE",
        message: "OpenShell live previews are not available",
        statusCode: 503
    })

const noFrontend = () =>
    createBusinessException({
        code: "OPENSHELL_PREVIEW_NO_FRONTEND",
        message: "This target has no frontend with a code repository connected",
        statusCode: 422
    })

const noBackend = () =>
    createBusinessException({
        code: "OPENSHELL_PREVIEW_NO_BACKEND",
        message: "This backend has no code repository connected",
        statusCode: 422
    })

const tooManyRepositories = () =>
    createBusinessException({
        code: "OPENSHELL_PREVIEW_TOO_MANY_REPOSITORIES",
        message: "A live preview can start at most 10 repositories",
        statusCode: 422
    })

const isConnected = (component: RepositoryComponent) => Boolean(component.codeRepository?.enabled && component.codeRepository.codeRepositoryId)

/** An API has no page of its own at its root: its preview opens on its docs, when it has some. */
export const backendPreviewUrl = (url: string, docsPath: string | undefined) => (docsPath ? `${url.replace(/\/+$/, "")}/${docsPath.replace(/^\/+/, "")}` : url)

/** The design system of the project, else the organization's: the npmrc of the one a frontend builds with. */
const scriptRepositoryOf = (
    component: FrontendComponent | BackendComponent,
    workingCopy: ScriptRepository["workingCopy"],
    projectDesignSystem: IDesignSystem | undefined,
    environment: Record<string, string> | undefined
): ScriptRepository => ({
    slug: `${component.kind}-${component.slug}`,
    serviceSlug: component.slug,
    workingCopy,
    kind: component.kind,
    ...(environment ? { environment } : {}),
    ...(component.kind === "frontend" ? { framework: component.framework, npmrc: projectDesignSystem?.npmrc } : { framework: component.framework, runtime: component.runtime, port: component.port })
})

/** What reaches the container of a frontend or a backend through `envFrom`, and the LOG_LEVEL it may set apart. */
interface ContainerSources {
    _id: unknown
    logLevel?: string | null
    configMapIds?: unknown[]
    secretIds?: unknown[]
    resourceIds?: unknown[]
}

/**
 * What the containers previewed get in the first environment that is not production, the one furthest back: their
 * config maps, then their secrets, then their resources, a later one winning as in `envFrom`, then LOG_LEVEL, LOG_JSON
 * and ENVIRONMENT, as in `env`. Not the URLs of the services: from a sandbox they reach nothing, and the previews
 * started find each other on their own. By id of the component; empty when the project has no such environment.
 * Without Argo CD initialized none of the config maps, secrets and resources: they reach a container only through the
 * manifests it applies, and a preview with values no deploy would hand over would mislead.
 */
export const previewEnvironments = async (projectId: ReturnType<typeof toObjectId>, attachedSources: ContainerSources[]): Promise<Map<string, Record<string, string>>> => {
    const environment = await Environment.findOne({ projectId, isProduction: false }, { slug: 1, logLevel: 1, logJson: 1 }).sort({ order: 1 })
    if (!environment) return new Map()
    const argoCdInitialized = Boolean((await Project.findById(projectId, { argoCd: 1 }))?.argoCd?.initializedAt)
    const sources: ContainerSources[] = argoCdInitialized ? attachedSources : attachedSources.map(({ _id, logLevel }) => ({ _id, logLevel }))
    const id = String(environment._id)
    const inProject = (ids: unknown[]) => ({ _id: { $in: ids.map(entry => toObjectId(String(entry))) }, projectId })
    // Read through the models, as the deploy reads them: a secret comes back decrypted
    const [configMaps, secrets, resources] = await Promise.all([
        ConfigMap.find(inProject(sources.flatMap(source => source.configMapIds ?? []))),
        Secret.find(inProject(sources.flatMap(source => source.secretIds ?? []))),
        Resource.find(inProject(sources.flatMap(source => source.resourceIds ?? [])))
    ])
    const byId = (values: [unknown, Record<string, string>][]) => new Map(values.map(([key, value]) => [String(key), value]))
    const held = {
        configMaps: byId(configMaps.map(map => [map._id, mapValues(map, id)])),
        secrets: byId(secrets.map(map => [map._id, mapValues(map, id)])),
        resources: byId(resources.map(resource => [resource._id, resourceEnvironmentValues(resource, id)]))
    }
    const pick = (ids: unknown[] | undefined, values: Map<string, Record<string, string>>) => (ids ?? []).map(entry => values.get(String(entry)) ?? {})
    const runtime = (source: ContainerSources) => Object.fromEntries(runtimeVariables(environment, undefined, source.logLevel).map(({ name, value }) => [name, value]))
    return new Map(
        sources.map(source => [
            String(source._id),
            Object.assign({}, ...pick(source.configMapIds, held.configMaps), ...pick(source.secretIds, held.secrets), ...pick(source.resourceIds, held.resources), runtime(source))
        ])
    )
}

export default class StandalonePreviewService extends BaseAuthorizedService {
    constructor(
        user: AuthorizedPrincipal | undefined,
        private readonly config: OpenShellConfiguration
    ) {
        super(user)
    }

    async start(projectId: string, input: StandalonePreviewInput): Promise<{ url: string }> {
        if (!(await effectiveOpenShellConfig(this.config)).OPENSHELL_PREVIEWS_ENABLED) throw unavailable()
        const sandboxes = openShellSandboxes(this.config)
        if (!sandboxes) throw unavailable()

        const projectObjectId = toObjectId(projectId)
        let components: RepositoryComponent[]
        let sources: ContainerSources[]
        // The domain the preview counts for: the one previewed, or the frontend's own.
        let domainId: unknown
        if (input.kind === "frontend") {
            const frontend = await Frontend.findById(input.id)
            if (!frontend) throw new EntityNotFoundError(input.id)
            if (String(frontend.projectId) !== String(projectObjectId)) throw new EntityNotFoundError(input.id)
            await this.ensureAccessToFrontend(frontend)
            await this.ensureNotViewer(frontend.projectId, { code: "LIVE_PREVIEW_FORBIDDEN", message: "A viewer cannot start a live preview" })
            components = [fromFrontend(frontend)]
            sources = [frontend]
            domainId = frontend.domainId
        } else if (input.kind === "backend") {
            const backend = await Backend.findById(input.id)
            if (!backend || String(backend.projectId) !== String(projectObjectId)) throw new EntityNotFoundError(input.id)
            await this.ensureAccessToBackend(backend)
            await this.ensureNotViewer(backend.projectId, { code: "LIVE_PREVIEW_FORBIDDEN", message: "A viewer cannot start a live preview" })
            components = [fromBackend(backend)]
            sources = [backend]
            domainId = backend.domainId
        } else {
            const domain = await Domain.findById(input.id)
            if (!domain || String(domain.projectId) !== String(projectObjectId)) throw new EntityNotFoundError(input.id)
            await this.ensureAccessToProject(domain.projectId)
            await this.ensureInDomainScope(domain.projectId, domain._id)
            await this.ensureNotViewer(domain.projectId, { code: "LIVE_PREVIEW_FORBIDDEN", message: "A viewer cannot start a live preview" })
            const [frontends, backends] = await Promise.all([Frontend.find({ projectId: domain.projectId, domainId: domain._id }), Backend.find({ projectId: domain.projectId, domainId: domain._id })])
            components = [...frontends.map(fromFrontend), ...backends.map(fromBackend)]
            sources = [...frontends, ...backends]
            domainId = domain._id
        }

        const connected = components.filter(isConnected)
        // A backend opens on its own server; a frontend or a domain opens on a frontend
        if (input.kind === "backend" && connected.length === 0) throw noBackend()
        if (input.kind !== "backend" && !connected.some(component => component.kind === "frontend")) throw noFrontend()
        if (connected.length > 10) throw tooManyRepositories()

        const workspaceService = new RepositoryWorkspaceService(this.getUser())
        const workspaces = await Promise.all(connected.map(async component => ({ component, workspace: await workspaceService.open(component) })))
        const targetId = input.id.toLowerCase()
        const sessionId = createHash("sha256").update(`${projectObjectId}:${input.kind}:${targetId}`).digest("hex").slice(0, 24)
        const sessionObjectId = toObjectId(sessionId)
        const expiresAt = new Date(Date.now() + 60 * 60_000)
        await StandalonePreviewSession.updateOne({ _id: sessionObjectId }, { $set: { projectId: projectObjectId, targetKind: input.kind, targetId: input.id, expiresAt } }, { upsert: true })

        const ordered = [...workspaces].sort((left, right) => left.workspace.workingCopy.dir.localeCompare(right.workspace.workingCopy.dir))
        const project = await Project.findById(projectObjectId, { organizationId: 1, designSystem: 1 }).lean()
        // A preview runs no command of an agent: the secrets of the environment reach its development servers only.
        const [{ designSystem: projectDesignSystem }, environments] = await Promise.all([
            project ? projectDesignSystemOf(project) : { designSystem: undefined },
            previewEnvironments(
                projectObjectId,
                sources.filter(source => connected.some(component => String(component._id) === String(source._id)))
            )
        ])
        const repositories = workspaces.map(({ component, workspace }) => scriptRepositoryOf(component, workspace.workingCopy, projectDesignSystem, environments.get(String(component._id))))
        // A preview runs no command of an agent: only the lifetime of its sandbox is counted, against what it previews.
        // The organization the sandbox serves: a warm one goes back only to the organization it last served.
        const organizationId = project?.organizationId
        const lifecycle = sandboxLifecycle({
            projectId: projectObjectId,
            organizationId,
            userId: this.getUser()?._id,
            source: "preview",
            ...(domainId ? { domainId: String(domainId) } : {}),
            frontendIds: connected.filter(component => component.kind === "frontend").map(component => component._id),
            backendIds: connected.filter(component => component.kind === "backend").map(component => component._id)
        })
        const runner = new AiChangeScriptRunner(
            repositories,
            () => sandboxes.acquire(sessionId, lifecycle, sessionId, organizationId ? String(organizationId) : undefined, languagesOfComponents(connected)),
            { previewsEnabled: true }
        )
        const startLocked = (index: number): Promise<string | undefined> =>
            index < ordered.length
                ? withRepositoryLock(ordered[index].workspace.workingCopy.dir, async () => {
                      await workspaceService.prepare(ordered[index].workspace, ordered[index].workspace.defaultBranch)
                      return startLocked(index + 1)
                  })
                : input.kind === "backend"
                  ? this.startBackend(connected[0] as BackendComponent, repositories[0], runner)
                  : this.startRepositories(connected, repositories, runner)
        try {
            const url = await startLocked(0)
            if (!url) throw new Error("The development server could not be started")
            await StandalonePreviewSession.updateOne({ _id: sessionObjectId }, { $set: { expiresAt: new Date(Date.now() + (await sandboxes.idleMs())) } })
            return { url }
        } catch (error) {
            await StandalonePreviewSession.updateOne({ _id: sessionObjectId }, { $set: { expiresAt: new Date(Date.now() + (await sandboxes.idleMs())) } })
            throw error
        }
    }

    /** A backend alone: its stack unrecognized and without a preview file, the preview fails saying so. */
    private async startBackend(component: BackendComponent, repository: ScriptRepository, runner: AiChangeScriptRunner): Promise<string | undefined> {
        const url = await runner.startPreview(repository, true)
        return url && backendPreviewUrl(url, component.docsPath)
    }

    /**
     * The backends first, so that the frontends start knowing where they are (`<SLUG>_URL`). A backend whose stack is
     * not recognized and that has no preview file is left out rather than stopping the preview of the frontend. With
     * backends exposed under a path, the preview opens on a gateway that routes them as the host of an environment does.
     */
    private async startRepositories(components: RepositoryComponent[], repositories: ScriptRepository[], runner: AiChangeScriptRunner): Promise<string | undefined> {
        const routes: { path: string; repository: ScriptRepository }[] = []
        for (let index = 0; index < components.length; index++) {
            const component = components[index]
            if (component.kind !== "backend" || !(await runner.canPreview(repositories[index]))) continue
            if (!(await runner.startPreview(repositories[index], true))) throw new Error(`The backend development server for ${component.slug} could not be started`)
            if (component.exposurePath) routes.push({ path: component.exposurePath, repository: repositories[index] })
        }
        let frontend: { url: string; repository: ScriptRepository } | undefined
        for (let index = 0; index < components.length; index++) {
            if (components[index].kind !== "frontend") continue
            const url = await runner.startPreview(repositories[index], true)
            if (url && !frontend) frontend = { url, repository: repositories[index] }
        }
        if (!frontend) return undefined
        return routes.length ? runner.startGateway(frontend.repository, routes) : frontend.url
    }
}
