import { createHash } from "node:crypto"
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import Backend from "../../models/BackendModel"
import Domain from "../../models/DomainModel"
import Frontend from "../../models/FrontendModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { withRepositoryLock } from "../../utils/repositoryLock"
import BaseAuthorizedService, { AuthorizedPrincipal } from "../BaseAuthorizedService"
import { OpenShellConfiguration, openShellSandboxes } from "../sandbox/OpenShellSandboxes"
import { RepositoryWorkspaceService } from "../workspace/RepositoryWorkspaceService"
import { BackendComponent, FrontendComponent, fromBackend, fromFrontend, RepositoryComponent } from "../workspace/repositoryComponent"
import { AiChangeScriptRunner, ScriptRepository } from "./aiChangeScripts"

export interface StandalonePreviewInput {
    kind: "frontend" | "domain"
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

const tooManyRepositories = () =>
    createBusinessException({
        code: "OPENSHELL_PREVIEW_TOO_MANY_REPOSITORIES",
        message: "A live preview can start at most 10 repositories",
        statusCode: 422
    })

const isConnected = (component: RepositoryComponent) => Boolean(component.codeRepository?.enabled && component.codeRepository.codeRepositoryId)

const scriptRepositoryOf = (component: FrontendComponent | BackendComponent, workingCopy: ScriptRepository["workingCopy"]): ScriptRepository => ({
    slug: `${component.kind}-${component.slug}`,
    workingCopy,
    kind: component.kind,
    ...(component.kind === "frontend" ? { framework: component.framework, npmrc: component.designSystem?.npmrc } : { framework: component.framework, runtime: component.runtime, port: component.port })
})

export default class StandalonePreviewService extends BaseAuthorizedService {
    constructor(
        user: AuthorizedPrincipal | undefined,
        private readonly config: OpenShellConfiguration
    ) {
        super(user)
    }

    async start(projectId: string, input: StandalonePreviewInput): Promise<{ url: string }> {
        if (!this.config.OPENSHELL_PREVIEWS_ENABLED) throw unavailable()
        const sandboxes = openShellSandboxes(this.config)
        if (!sandboxes) throw unavailable()

        const projectObjectId = toObjectId(projectId)
        let components: RepositoryComponent[]
        if (input.kind === "frontend") {
            const frontend = await Frontend.findById(input.id)
            if (!frontend) throw new EntityNotFoundError(input.id)
            if (String(frontend.projectId) !== String(projectObjectId)) throw new EntityNotFoundError(input.id)
            await this.ensureAccessToFrontend(frontend)
            await this.ensureNotViewer(frontend.projectId, { code: "LIVE_PREVIEW_FORBIDDEN", message: "A viewer cannot start a live preview" })
            components = [fromFrontend(frontend)]
        } else {
            const domain = await Domain.findById(input.id)
            if (!domain || String(domain.projectId) !== String(projectObjectId)) throw new EntityNotFoundError(input.id)
            await this.ensureAccessToProject(domain.projectId)
            await this.ensureInDomainScope(domain.projectId, domain._id)
            await this.ensureNotViewer(domain.projectId, { code: "LIVE_PREVIEW_FORBIDDEN", message: "A viewer cannot start a live preview" })
            const [frontends, backends] = await Promise.all([Frontend.find({ projectId: domain.projectId, domainId: domain._id }), Backend.find({ projectId: domain.projectId, domainId: domain._id })])
            components = [...frontends.map(fromFrontend), ...backends.map(fromBackend)]
        }

        const connected = components.filter(isConnected)
        if (!connected.some(component => component.kind === "frontend")) throw noFrontend()
        if (connected.length > 10) throw tooManyRepositories()

        const workspaceService = new RepositoryWorkspaceService(this.getUser())
        const workspaces = await Promise.all(connected.map(async component => ({ component, workspace: await workspaceService.open(component) })))
        const targetId = input.id.toLowerCase()
        const sessionId = createHash("sha256").update(`${projectObjectId}:${input.kind}:${targetId}`).digest("hex").slice(0, 24)
        const sessionObjectId = toObjectId(sessionId)
        const expiresAt = new Date(Date.now() + 60 * 60_000)
        await StandalonePreviewSession.updateOne({ _id: sessionObjectId }, { $set: { projectId: projectObjectId, targetKind: input.kind, targetId: input.id, expiresAt } }, { upsert: true })

        const ordered = [...workspaces].sort((left, right) => left.workspace.workingCopy.dir.localeCompare(right.workspace.workingCopy.dir))
        const repositories = workspaces.map(({ component, workspace }) => scriptRepositoryOf(component, workspace.workingCopy))
        const runner = new AiChangeScriptRunner(repositories, () => sandboxes.acquire(sessionId), undefined, true)
        const startLocked = (index: number): Promise<string | undefined> =>
            index < ordered.length
                ? withRepositoryLock(ordered[index].workspace.workingCopy.dir, async () => {
                      await workspaceService.prepare(ordered[index].workspace, ordered[index].workspace.defaultBranch)
                      return startLocked(index + 1)
                  })
                : this.startRepositories(connected, repositories, runner)
        try {
            const url = await startLocked(0)
            if (!url) throw new Error("The frontend development server could not be started")
            await StandalonePreviewSession.updateOne({ _id: sessionObjectId }, { $set: { expiresAt: new Date(Date.now() + sandboxes.idleMs) } })
            return { url }
        } catch (error) {
            await StandalonePreviewSession.updateOne({ _id: sessionObjectId }, { $set: { expiresAt: new Date(Date.now() + sandboxes.idleMs) } })
            throw error
        }
    }

    private async startRepositories(components: RepositoryComponent[], repositories: ScriptRepository[], runner: AiChangeScriptRunner): Promise<string | undefined> {
        let frontendUrl: string | undefined
        for (let index = 0; index < components.length; index++) {
            const component = components[index]
            const url = await runner.startPreview(repositories[index], true)
            if (component.kind === "frontend" && !frontendUrl) frontendUrl = url
            if (component.kind === "backend" && !url) throw new Error(`The backend development server for ${component.slug} could not be started`)
        }
        return frontendUrl
    }
}
