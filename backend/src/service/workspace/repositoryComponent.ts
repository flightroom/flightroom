import { IAiChangeRequest } from "../../models/AiChangeRequestModel"
import Backend, { IBackend, IBackendEnvVariable } from "../../models/BackendModel"
import Frontend, { ICodeRepositoryFrontend, IFrontend } from "../../models/FrontendModel"
import { BackendRuntime } from "../../types/BackendStack"
import { IDesignSystem } from "../../types/DesignSystem"
import { toObjectId } from "../../utils/mongooseUtils"
import { backendWorkspacePath, frontendWorkspacePath, WorkspaceOwner } from "../../utils/workspacePaths"

/**
 * What the workspace and the AI agent need of something backed by a repository: a frontend or
 * a backend. Its id is the document's: ObjectIds are unique across collections, so the id
 * alone names the component, the kind tells which collection it lives in.
 */
export type RepositoryComponentKind = "frontend" | "backend"

export interface RepositoryComponentRef {
    kind: RepositoryComponentKind
    id: string
}

interface RepositoryComponentBase {
    _id: IFrontend["_id"]
    projectId: IFrontend["projectId"]
    slug: string
    name: string
    codeRepository?: ICodeRepositoryFrontend
    /** Markdown for AI agents about this component only. */
    context?: string
    /** The functional domain it belongs to, if any. */
    domainId?: IFrontend["domainId"]
}

export interface FrontendComponent extends RepositoryComponentBase {
    kind: "frontend"
    framework?: string
    compiler?: string
    /** Its own, when it replaces the one of the project */
    designSystem?: IDesignSystem
}

export interface BackendComponent extends RepositoryComponentBase {
    kind: "backend"
    runtime?: BackendRuntime
    framework?: string
    port?: number
    livenessPath?: string
    readinessPath?: string
    docsPath?: string
    openApiPath?: string
    env: IBackendEnvVariable[]
    /** Where it is exposed on the host of every environment, if it is */
    exposurePath?: string
    /** What reaches its container as environment variables: names and keys only are ever read from them */
    configMapIds: IBackend["configMapIds"]
    secretIds: IBackend["secretIds"]
    resourceIds: IBackend["resourceIds"]
}

export type RepositoryComponent = FrontendComponent | BackendComponent

export const fromFrontend = (frontend: IFrontend): FrontendComponent => ({
    kind: "frontend",
    _id: frontend._id,
    projectId: frontend.projectId,
    slug: frontend.slug,
    name: frontend.name,
    codeRepository: frontend.codeRepository,
    context: frontend.context,
    domainId: frontend.domainId ?? undefined,
    framework: frontend.stack?.framework,
    compiler: frontend.stack?.compiler,
    designSystem: frontend.designSystem
})

export const fromBackend = (backend: IBackend): BackendComponent => ({
    kind: "backend",
    _id: backend._id as unknown as IFrontend["_id"],
    projectId: backend.projectId,
    slug: backend.slug,
    name: backend.name,
    codeRepository: backend.codeRepository,
    context: backend.context,
    domainId: backend.domainId ?? undefined,
    runtime: backend.stack?.runtime,
    framework: backend.stack?.framework,
    port: backend.port,
    livenessPath: backend.livenessPath,
    readinessPath: backend.readinessPath,
    docsPath: backend.docsPath ?? undefined,
    openApiPath: backend.openApiPath ?? undefined,
    env: backend.env ?? [],
    exposurePath: backend.exposurePath ?? undefined,
    configMapIds: backend.configMapIds ?? [],
    secretIds: backend.secretIds ?? [],
    resourceIds: backend.resourceIds ?? []
})

/** The component a request changes. */
export const componentOf = (request: Pick<IAiChangeRequest, "frontendId" | "backendId">): RepositoryComponentRef =>
    request.backendId ? { kind: "backend", id: String(request.backendId) } : { kind: "frontend", id: String(request.frontendId) }

/** The id of the component a request changes, whichever its kind. */
export const componentIdOf = (request: Pick<IAiChangeRequest, "frontendId" | "backendId">) => String(request.backendId ?? request.frontendId)

/** The field of a request that names its component. */
export const ownerFields = (component: Pick<RepositoryComponent, "kind" | "_id">) => (component.kind === "backend" ? { backendId: component._id } : { frontendId: component._id })

/** The components of a job in the order they are shown: its frontends, then its backends. */
export const componentsOfJob = (job: { frontendIds: unknown[]; backendIds?: unknown[] }): RepositoryComponentRef[] => [
    ...job.frontendIds.map(id => ({ kind: "frontend" as const, id: String(id) })),
    ...(job.backendIds ?? []).map(id => ({ kind: "backend" as const, id: String(id) }))
]

/** One component, or null when it no longer exists. Authorization is up to the caller. */
export const findComponent = async (ref: RepositoryComponentRef): Promise<RepositoryComponent | null> => {
    if (ref.kind === "backend") {
        const backend = await Backend.findById(ref.id)
        return backend ? fromBackend(backend) : null
    }
    const frontend = await Frontend.findById(ref.id)
    return frontend ? fromFrontend(frontend) : null
}

/** Several components, in the order of `refs`; those that no longer exist are left out. Authorization is up to the caller. */
export const findComponents = async (refs: RepositoryComponentRef[], projection?: Record<string, 0 | 1>): Promise<RepositoryComponent[]> => {
    const idsOf = (kind: RepositoryComponentKind) => refs.filter(ref => ref.kind === kind).map(ref => toObjectId(ref.id))
    const frontendIds = idsOf("frontend")
    const backendIds = idsOf("backend")
    // A kind the job does not use is not queried at all.
    const [frontends, backends] = await Promise.all([
        frontendIds.length ? Frontend.find({ _id: { $in: frontendIds } }, projection) : [],
        backendIds.length ? Backend.find({ _id: { $in: backendIds } }, projection) : []
    ])
    const found: RepositoryComponent[] = [...frontends.map(fromFrontend), ...backends.map(fromBackend)]
    return refs.flatMap(ref => found.filter(component => component.kind === ref.kind && String(component._id) === ref.id))
}

/** Where the working copy of a component lives: a frontend and a backend of the same slug never share it. */
export const componentWorkspacePath = (root: string, owner: Pick<WorkspaceOwner, "organization" | "project">, component: Pick<RepositoryComponent, "kind" | "slug">) =>
    component.kind === "backend" ? backendWorkspacePath(root, { ...owner, backendSlug: component.slug }) : frontendWorkspacePath(root, { ...owner, frontendSlug: component.slug })
