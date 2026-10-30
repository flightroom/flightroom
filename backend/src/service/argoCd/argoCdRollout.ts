import { Schema } from "mongoose"
import Backend from "../../models/BackendModel"
import Deployment, { IDeployment } from "../../models/DeploymentModel"
import { IEnvironment } from "../../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../../models/FrontendModel"
import { IProject } from "../../models/ProjectModel"
import { allInOrder } from "../../utils/allInOrder"
import { environmentSlug } from "../GitOpsService"
import { isDeployable } from "../gitops/applicationManifests"
import { applicationName, appProjectName, ENVIRONMENT_LABEL, PROJECT_ID_LABEL, selectorsOf } from "../gitops/argoCdManifests"
import { RolloutDTO, rolloutStateOf } from "../gitops/rollout"
import { clientOf, listUnder, projectOf } from "./argoCdProject"

/** What a deployment is read for by the rollout: its commit, and the version and image of each application it shipped */
export const DEPLOYED_VERSIONS = "environmentId applicationsRevision backends._id backends.version backends.image frontends._id frontends.version frontends.image"

type DeployedVersions = Pick<IDeployment, "_id" | "environmentId" | "applicationsRevision" | "backends" | "frontends">

/**
 * Where the deploy stands in Argo CD, application by application, for a project that deploys through it.
 * `domainScope` is the condition on the applications followed: those of the domain deployed, or those the user reaches.
 */
export const followRollout = async (
    projectId: Schema.Types.ObjectId,
    project: Pick<IProject, "slug" | "containerRegistry">,
    argoCd: { url: string; token: string; insecure?: boolean },
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
    const fields = { slug: 1, name: 1, version: 1, image: 1 }
    const [backends, frontends] = await allInOrder([Backend.find(scope, fields), Frontend.find({ ...scope, kind: FrontendKind.DOCKER }, fields)])
    const followed = [...backends.map(application => ({ kind: "backend" as const, application })), ...frontends.map(application => ({ kind: "frontend" as const, application }))]
    const members = followed.filter(({ application }) => isDeployable(application, project.containerRegistry))

    const client = clientOf(argoCd)
    const projectName = appProjectName(String(projectId), project.slug)
    const slug = environmentSlug(environment)
    const listed = await listUnder(selectorsOf(`${PROJECT_ID_LABEL}=${projectId},${ENVIRONMENT_LABEL}=${slug}`), labels => client.listApplications(labels, projectName))
    const byName = new Map(listed.filter(application => projectOf(application) === projectName).map(application => [application.metadata.name, application]))
    const applications = await Promise.all(
        members.map(async ({ kind, application }) => {
            const name = applicationName(String(projectId), project.slug, application.slug, slug)
            const state = rolloutStateOf(byName.get(name), revisions)
            // Which container is still starting, or crashing: a failure to read them leaves the rest as it is
            const pods = state.state === "progressing" || state.state === "degraded" ? await client.listPods(name, projectName).catch(() => undefined) : undefined
            return { _id: String(application._id), kind, name: application.name, slug: application.slug, updated: updated(String(application._id)), ...state, ...(pods ? { pods } : {}) }
        })
    )
    return {
        tracked: true,
        applications,
        done: applications.every(application => application.state === "healthy"),
        failed: applications.some(application => application.state === "failed")
    }
}
