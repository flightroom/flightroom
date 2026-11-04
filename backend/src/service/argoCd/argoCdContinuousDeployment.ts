import { Schema } from "mongoose"
import { fastify } from "../.."
import Environment from "../../models/EnvironmentModel"
import Project from "../../models/ProjectModel"
import { ContinuousDeployment, VersionByEnvironment, versionIn } from "../../types/EnvironmentVersions"
import { toObjectId } from "../../utils/mongooseUtils"
import { environmentNamespace, environmentSlug } from "../GitOpsService"
import { applicationName, appProjectName } from "../gitops/argoCdManifests"
import { toErrorMessage } from "../RepositoryFileService"
import { argoCdInUse, clientOf } from "./argoCdProject"

type ContinuousApplication = ContinuousDeployment & Pick<VersionByEnvironment, "environmentVersions">

/**
 * Where a version just registered reaches by itself: the environments the container is deployed continuously in and that
 * run that very version, its tag, when the project deploys through Argo CD. A tag the CI moves (latest, a branch) is
 * pushed again under the same name: there a restart pulls it, no deploy needed. An environment running another version
 * needs a deploy to change tag, so it is not one of them.
 */
const continuousTargets = async (projectId: Schema.Types.ObjectId, application: ContinuousApplication, version: string) => {
    const ids = application.continuousDeploymentEnvironmentIds ?? []
    if (ids.length === 0) return undefined
    const project = await Project.findById(projectId, { slug: 1, gitOps: 1, argoCd: 1 })
    const argoCd = argoCdInUse(project)
    if (!project || !argoCd) return undefined
    const environments = (await Environment.find({ projectId, _id: { $in: ids.map(id => toObjectId(String(id))) } }, { slug: 1, namespace: 1 })).filter(
        environment => versionIn(application, environment._id) === version.trim()
    )
    return environments.length > 0 ? { project, argoCd, environments } : undefined
}

/**
 * Once the CI registered `version` of the container `slug`, restarts its pods through Argo CD in the environments it
 * reaches by itself ({@link continuousTargets}): they pull the image again, their pull policy being Always. Best effort:
 * the registration went through, and a failure is only logged. Gives the slugs of the environments restarted.
 */
export const restartContinuouslyDeployed = async (projectId: Schema.Types.ObjectId, application: ContinuousApplication & { slug: string }, version: string): Promise<string[]> => {
    try {
        const targets = await continuousTargets(projectId, application, version)
        if (!targets) return []
        const { project, argoCd, environments } = targets
        const client = clientOf(argoCd)
        const appProject = appProjectName(String(projectId), project.slug)
        const restarts = await Promise.allSettled(
            environments.map(async environment => {
                const name = applicationName(String(projectId), project.slug, application.slug, environmentSlug(environment))
                // Argo CD reads the Application again first, so it acts on what it holds now rather than on a stale cache
                await client.refreshApplication(name, appProject)
                await client.restartDeployment(name, appProject, environmentNamespace(environment), application.slug)
            })
        )
        const failed = restarts.flatMap((restart, index) => (restart.status === "rejected" ? [{ environment: environments[index].slug, error: toErrorMessage(restart.reason) }] : []))
        if (failed.length > 0) fastify.log.warn({ projectId: String(projectId), slug: application.slug, version, failed }, "Continuous deployment: pods not restarted after a registration")
        return environments.filter((_, index) => restarts[index].status === "fulfilled").map(environment => environment.slug)
    } catch (error) {
        fastify.log.warn({ error: toErrorMessage(error), projectId: String(projectId), slug: application.slug, version }, "Continuous deployment: pods not restarted after a registration")
        return []
    }
}
