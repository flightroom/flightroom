import { Schema } from "mongoose"
import { fastify } from "../.."
import ArgoCdClient, { ArgoCdResource } from "../../client/ArgoCdClient"
import { createBusinessException } from "../../errors/BusinessException"
import Backend from "../../models/BackendModel"
import { ICodeRepository } from "../../models/CodeRepositoryModel"
import Environment from "../../models/EnvironmentModel"
import Frontend, { FrontendKind, ICodeRepositoryFrontend } from "../../models/FrontendModel"
import MaintenanceAgent from "../../models/MaintenanceAgentModel"
import { IProject, IProjectArgoCd, IProjectGitOps } from "../../models/ProjectModel"
import { allInOrder } from "../../utils/allInOrder"
import { SECRET_PLACEHOLDER } from "../../utils/secretCrypto"
import { environmentNamespace, environmentSlug } from "../GitOpsService"
import { GitOpsApplication, isDeployable } from "../gitops/applicationManifests"
import { repositoryNameFor } from "../RepositoryFileService"
import { cloneUrlFor } from "../workspace/RepositoryWorkspaceService"
import { ArgoCdRepositoryKind } from "./argoCdTypes"

/** The Argo CD settings of a project that deploys through it: GitOps on with an applications repository, Argo CD initialized */
type ArgoCdInUse = IProjectArgoCd & { url: string; token: string; initializedAt: Date }

/** The Argo CD the project deploys its applications through, none until GitOps has an applications repository and Argo CD is initialized */
export const argoCdInUse = (project: Pick<IProject, "gitOps" | "argoCd"> | null | undefined): ArgoCdInUse | undefined => {
    const argoCd = project?.argoCd
    if (!project?.gitOps?.enabled || !project.gitOps.applicationsCodeRepository || !argoCd?.initializedAt || !argoCd.url || !argoCd.token) return undefined
    return argoCd as ArgoCdInUse
}

export const clientOf = (argoCd: { url: string; token: string; insecure?: boolean }) => new ArgoCdClient(argoCd.url, argoCd.token, { insecure: argoCd.insecure })

export const retyped = (value: unknown): string | undefined => (typeof value === "string" && value.trim() && value !== SECRET_PLACEHOLDER ? value.trim() : undefined)

/** The base URL of Argo CD as it is stored: https, or http where the installation allows it; no credentials, no trailing slash */
export const normalizeUrl = (value: unknown): string => {
    const invalid = createBusinessException({ code: "ARGOCD_URL_INVALID", message: "The URL of Argo CD must be an https address, such as https://argocd.example.com" })
    let url: URL
    try {
        url = new URL(String(value ?? "").trim())
    } catch {
        throw invalid
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalid
    if (url.protocol === "http:" && !fastify.config.ARGOCD_ALLOW_INSECURE_HTTP) {
        throw createBusinessException({
            code: "ARGOCD_URL_INSECURE",
            message:
                "The URL of Argo CD must be https: the token and the repository credentials would cross the network in the clear. ARGOCD_ALLOW_INSECURE_HTTP=true allows http, for a local cluster only"
        })
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
}

/** The GitOps repositories of the project, configuration first; none while GitOps is off */
export const linksOf = (gitOps?: IProjectGitOps): Array<[ArgoCdRepositoryKind, ICodeRepositoryFrontend]> => {
    if (!gitOps?.enabled) return []
    const links: Array<[ArgoCdRepositoryKind, ICodeRepositoryFrontend | undefined]> = [
        ["configuration", gitOps.codeRepository],
        ["applications", gitOps.applicationsCodeRepository]
    ]
    return links.filter((entry): entry is [ArgoCdRepositoryKind, ICodeRepositoryFrontend] => Boolean(entry[1]))
}

/** The URL Argo CD clones the repository `link` points to from */
export const repoUrlOf = (link: ICodeRepositoryFrontend, connection: ICodeRepository): string =>
    cloneUrlFor({ component: { codeRepository: link }, codeRepository: connection, repositoryName: repositoryNameFor(link, connection) })

/**
 * The backends, frontends and maintenance agents a deploy writes the values of: those with an image, their own or one in
 * the registry of the project, and a version in some environment. The ApplicationSet of each one generates an
 * Application only on the branches that hold its values file.
 */
export const deployableSlugs = async (projectId: Schema.Types.ObjectId, containerRegistry?: string): Promise<string[]> => {
    const fields = { slug: 1, environmentVersions: 1, image: 1 }
    const [backends, frontends, agents] = await allInOrder([
        Backend.find({ projectId }, fields),
        Frontend.find({ projectId, kind: FrontendKind.DOCKER }, fields),
        MaintenanceAgent.find({ projectId }, fields)
    ])
    const applications: GitOpsApplication[] = [...backends, ...frontends, ...agents]
    return applications.filter(application => isDeployable(application, containerRegistry)).map(application => application.slug)
}

export const environmentsOf = async (projectId: Schema.Types.ObjectId) =>
    (await Environment.find({ projectId }, { slug: 1, namespace: 1 })).map(environment => ({ slug: environmentSlug(environment), namespace: environmentNamespace(environment) }))

/** The AppProject an Application, or the applications of an ApplicationSet, belong to */
export const projectOf = (resource: ArgoCdResource): unknown => {
    const spec = resource.spec as { project?: unknown; template?: { spec?: { project?: unknown } } } | undefined
    return resource.kind === "ApplicationSet" || spec?.template ? spec?.template?.spec?.project : spec?.project
}
