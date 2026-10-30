import { Schema } from "mongoose"
import { fastify } from "../.."
import ArgoCdClient, { ArgoCdResource } from "../../client/ArgoCdClient"
import { BusinessException } from "../../errors/BusinessException"
import { IProjectArgoCd, IProjectGitOps } from "../../models/ProjectModel"
import GitOpsService from "../GitOpsService"
import { buildArgoCdState, COMPONENT_LABEL, PROJECT_ID_LABEL, projectIdOf, selectorsOf, unprefixedProjectName } from "../gitops/argoCdManifests"
import { toErrorMessage } from "../RepositoryFileService"
import { holderOf } from "./argoCdCredentials"
import { nameConflict, repositoryConflict } from "./argoCdErrors"
import { linksOf, listUnder, projectOf, repoUrlOf } from "./argoCdProject"
import { ArgoCdRepositoryKind, RepositoryTarget } from "./argoCdTypes"

/** The GitOps repositories Argo CD is handed, configuration first: the configuration one for the AppProject `projectName` only */
export const repositoryTargets = async (gitOpsService: GitOpsService, gitOps: IProjectGitOps, projectId: Schema.Types.ObjectId, projectName: string): Promise<RepositoryTarget[]> => {
    const targets: RepositoryTarget[] = []
    for (const [kind, link] of linksOf(gitOps)) {
        const connection = await gitOpsService.connectionOf(link, projectId)
        targets.push({ kind, link, connection, repoUrl: repoUrlOf(link, connection), argoProject: kind === "configuration" ? projectName : undefined })
    }
    return targets
}

/**
 * Every name is checked before the first write: one taken by something else stops the run with nothing changed.
 * An object the account may not read is taken too, by something it cannot see
 */
export const ensureNamesFree = async (client: ArgoCdClient, state: ReturnType<typeof buildArgoCdState>, projectName: string, projectId: Schema.Types.ObjectId) => {
    const isOurs = (resource: ArgoCdResource | null) => !resource || projectIdOf(resource) === String(projectId)
    const probe = <T>(request: Promise<T>, conflict: () => BusinessException) =>
        request.catch(error => Promise.reject(error instanceof BusinessException && error.code === "ARGOCD_FORBIDDEN" ? conflict() : error))
    if (!isOurs(await probe(client.getProject(projectName), () => nameConflict("AppProject", projectName)))) throw nameConflict("AppProject", projectName)
    // Argo CD makes the Applications of the environments: one of the same name already there would not be its own
    for (const name of state.environmentApplications) {
        const conflict = () => nameConflict("Application", name)
        if (!isOurs(await probe(client.getApplication(name, projectName), conflict))) throw conflict()
    }
    for (const { metadata } of state.applicationSets) {
        const conflict = () => nameConflict("ApplicationSet", metadata.name)
        if (!isOurs(await probe(client.getApplicationSet(metadata.name), conflict))) throw conflict()
    }
}

/**
 * The AppProject an earlier version named otherwise, the one of the last initialization or 10.x's without the prefix: what the
 * project has in it moves to the one of now. Only guessed from the name, one the account may not read is none of its own
 */
export const earlierAppProjects = async (
    client: ArgoCdClient,
    previous: IProjectArgoCd | undefined,
    url: string,
    projectId: Schema.Types.ObjectId,
    projectSlug: string,
    projectName: string
): Promise<string[]> => {
    const recorded = previous?.repositories?.configuration?.argoCdUrl === url ? previous.repositories.configuration.argoProject : undefined
    const movedFrom: string[] = []
    for (const name of new Set([recorded, unprefixedProjectName(String(projectId), projectSlug)])) {
        if (!name || name === projectName) continue
        const earlier = await client.getProject(name).catch(error => (error instanceof BusinessException && error.code === "ARGOCD_FORBIDDEN" && name !== recorded ? null : Promise.reject(error)))
        if (projectIdOf(earlier) === String(projectId)) movedFrom.push(name)
    }
    return movedFrom
}

/**
 * The repositories read through the registration another project of the organization made globally, and refused are those
 * Argo CD holds a registration of that is not this project's. Only a global one is shared: a registration scoped to another
 * AppProject is of no use to this one
 */
export const sharedRepositories = async (
    client: ArgoCdClient,
    targets: RepositoryTarget[],
    previous: IProjectArgoCd | undefined,
    url: string,
    project: { _id: Schema.Types.ObjectId; organizationId: Schema.Types.ObjectId },
    movedFrom: string[]
): Promise<Set<ArgoCdRepositoryKind>> => {
    const shared = new Set<ArgoCdRepositoryKind>()
    for (const target of targets) {
        if (!target.argoProject && (await holderOf(project._id, project.organizationId, url, target.repoUrl))) {
            shared.add(target.kind)
            continue
        }
        const before = previous?.repositories?.[target.kind]
        const ours = before?.argoCdUrl === url && before.repoUrl === target.repoUrl && (before.argoProject === target.argoProject || movedFrom.includes(before.argoProject ?? ""))
        if (!ours && (await client.getRepository(target.repoUrl))) throw repositoryConflict(target.repoUrl)
    }
    return shared
}

/**
 * What the console created for an environment that is gone, or a repository no longer linked. The
 * applications an ApplicationSet generated are left to it: they carry the label of the project too.
 * The console makes no Application itself any more: those an earlier initialization made per
 * environment go, the ApplicationSet of the environments makes them again
 */
export const deleteLeftovers = async (client: ArgoCdClient, projectId: Schema.Types.ObjectId, projectName: string, movedFrom: string[], kept: Set<string>) => {
    // Under the labels of before the rename too: what an earlier version made carries those until it is saved again.
    // In the AppProject of an earlier name all of it goes, the ApplicationSets of now taking over its workloads
    const selector = `${PROJECT_ID_LABEL}=${projectId}`
    for (const appProject of [projectName, ...movedFrom]) {
        for (const application of await listUnder(selectorsOf(`${selector},${COMPONENT_LABEL}=configuration`), labels => client.listApplications(labels, appProject))) {
            if (projectOf(application) === appProject) await client.deleteApplication(application.metadata.name)
        }
        for (const applicationSet of await listUnder(selectorsOf(selector), labels => client.listApplicationSets(labels, appProject))) {
            if (!kept.has(applicationSet.metadata.name) && projectOf({ ...applicationSet, kind: "ApplicationSet" }) === appProject) await client.deleteApplicationSet(applicationSet.metadata.name)
        }
    }
    // Refused while the Applications of its ApplicationSets are still being deleted: the next initialization tries again
    for (const name of movedFrom) {
        await client.deleteProject(name).catch(error => fastify.log.warn({ error: toErrorMessage(error), appProject: name }, "Argo CD AppProject of an earlier name not deleted, retried next time"))
    }
}
