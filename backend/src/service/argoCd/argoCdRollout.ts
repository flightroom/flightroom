import { Schema } from "mongoose"
import { ArgoCdResource } from "../../client/ArgoCdClient"
import Backend from "../../models/BackendModel"
import Deployment, { IDeployment } from "../../models/DeploymentModel"
import { IEnvironment } from "../../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../../models/FrontendModel"
import { IArgoCdError, IProject } from "../../models/ProjectModel"
import { allInOrder } from "../../utils/allInOrder"
import { environmentSlug } from "../GitOpsService"
import { isDeployable } from "../gitops/applicationManifests"
import { applicationName, appProjectName, ENVIRONMENT_LABEL, PROJECT_ID_LABEL } from "../gitops/argoCdManifests"
import { RolloutDTO, rolloutStateOf } from "../gitops/rollout"
import { clientOf, projectOf } from "./argoCdProject"

/** What a deployment is read for by the rollout: its commit, and the version and image of each application it shipped */
export const DEPLOYED_VERSIONS = "environmentId applicationsRevision backends._id backends.version backends.image frontends._id frontends.version frontends.image"

type DeployedVersions = Pick<IDeployment, "_id" | "environmentId" | "applicationsRevision" | "backends" | "frontends">

/** How long an Application still on the revision before the deploy is left to Argo CD before the rollout asks it to read the repository again */
const REFRESH_AFTER_MS = 30_000

/** Argo CD compared it with the repository long enough ago, or never: it is asked to read the repository again */
const refreshDue = (application: ArgoCdResource) => {
    const reconciledAt = Date.parse(application.status?.reconciledAt ?? "")
    return Number.isNaN(reconciledAt) || Date.now() - reconciledAt > REFRESH_AFTER_MS
}

/**
 * Why the last deploy could not hand Argo CD the ApplicationSets, when that holds in the environment: there an application
 * without its Application never gets one until it is fixed. An error that names its environments holds in those only
 */
const alignErrorIn = (alignError: IArgoCdError | undefined, environment: string) => {
    const environments = alignError?.details?.slug
    return alignError && (typeof environments !== "string" || environments.split(", ").includes(environment)) ? alignError : undefined
}

/**
 * Where the deploy stands in Argo CD, application by application, for a project that deploys through it.
 * `domainScope` is the condition on the applications followed: those of the domain deployed, or those the user reaches.
 */
export const followRollout = async (
    projectId: Schema.Types.ObjectId,
    project: Pick<IProject, "slug" | "containerRegistry">,
    argoCd: { url: string; token: string; insecure?: boolean; alignError?: IArgoCdError },
    deployment: DeployedVersions,
    environment: Pick<IEnvironment, "slug">,
    domainScope: () => Promise<Record<string, unknown>>
): Promise<RolloutDTO> => {
    const [later, before, scopeFilter] = await allInOrder([
        // The commit of the deploy, and those deploys pushed after it on the same branch: they hold it. By creation, as a redeploy moves deployedAt
        deployment.applicationsRevision
            ? Deployment.find({ environmentId: deployment.environmentId, _id: { $gt: deployment._id }, applicationsRevision: { $exists: true } }, { applicationsRevision: 1 })
            : Promise.resolve([]),
        // What the deploy changed: a version or an image the deploy before it in the environment did not serve
        Deployment.findOne({ environmentId: deployment.environmentId, _id: { $lt: deployment._id } }, DEPLOYED_VERSIONS, { sort: { _id: -1 } }),
        domainScope()
    ])
    const revisions = new Set([deployment.applicationsRevision, ...later.map(newer => newer.applicationsRevision)].filter((revision): revision is string => Boolean(revision)))

    const versionsOf = (recorded?: { _id: unknown; version?: string; image?: unknown }[]) =>
        new Map((recorded ?? []).map(application => [String(application._id), JSON.stringify([application.version, application.image])]))
    const shipped = versionsOf([...(deployment.backends ?? []), ...(deployment.frontends ?? [])])
    const served = versionsOf([...(before?.backends ?? []), ...(before?.frontends ?? [])])
    // Without a deploy before, or without what it recorded, everything counts as updated
    const updated = (id: string) => !before || !shipped.has(id) || shipped.get(id) !== served.get(id)

    const scope = { projectId, ...scopeFilter }
    const fields = { slug: 1, name: 1, environmentVersions: 1, image: 1 }
    const [backends, frontends] = await allInOrder([Backend.find(scope, fields), Frontend.find({ ...scope, kind: FrontendKind.DOCKER }, fields)])
    const followed = [...backends.map(application => ({ kind: "backend" as const, application })), ...frontends.map(application => ({ kind: "frontend" as const, application }))]
    const members = followed.filter(({ application }) => isDeployable(application, project.containerRegistry, deployment.environmentId))

    const client = clientOf(argoCd)
    const projectName = appProjectName(String(projectId), project.slug)
    const slug = environmentSlug(environment)
    const listed = await client.listApplications(`${PROJECT_ID_LABEL}=${projectId},${ENVIRONMENT_LABEL}=${slug}`, projectName)
    const byName = new Map(listed.filter(application => projectOf(application) === projectName).map(application => [application.metadata.name, application]))
    const alignError = alignErrorIn(argoCd.alignError, slug)
    let stranded = false
    const applications = await Promise.all(
        members.map(async ({ kind, application }) => {
            const name = applicationName(String(projectId), project.slug, application.slug, slug)
            const argoCdApplication = byName.get(name)
            // Not waiting: no ApplicationSet will generate it until the alignment goes through
            if (!argoCdApplication && alignError) stranded = true
            const state = !argoCdApplication && alignError ? { state: "failed" as const } : rolloutStateOf(argoCdApplication, revisions)
            // The refresh after the commit may have come before Argo CD saw it, and its own poll may be minutes away, or off.
            // Not awaited: Argo CD answers once it has compared, and the next read sees it
            if (state.state === "waiting" && argoCdApplication && refreshDue(argoCdApplication)) client.refreshApplication(name, projectName).catch(() => undefined)
            // Which container is still starting, or crashing: a failure to read them leaves the rest as it is
            const pods = state.state === "progressing" || state.state === "degraded" ? await client.listPods(name, projectName).catch(() => undefined) : undefined
            return { _id: String(application._id), kind, name: application.name, slug: application.slug, updated: updated(String(application._id)), ...state, ...(pods ? { pods } : {}) }
        })
    )
    // Those the deploy updated, all of them when it updated none, as the overlay shows them: one it did not touch is not waited for
    const changed = applications.filter(application => application.updated)
    const awaited = changed.length > 0 ? changed : applications
    return {
        tracked: true,
        applications,
        done: awaited.every(application => application.state === "healthy"),
        failed: awaited.some(application => application.state === "failed"),
        ...(stranded ? { alignError } : {})
    }
}
