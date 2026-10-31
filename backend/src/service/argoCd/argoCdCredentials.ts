import { Schema } from "mongoose"
import { fastify } from "../.."
import ArgoCdClient, { sameRepoUrl } from "../../client/ArgoCdClient"
import GitlabClient from "../../client/GitlabClient"
import CodeRepository, { CodeRepositoryProvider, ICodeRepository } from "../../models/CodeRepositoryModel"
import { ICodeRepositoryFrontend } from "../../models/FrontendModel"
import Project, { IArgoCdRepositoryCredential, IArgoCdRepositoryRegistration, IProjectArgoCd } from "../../models/ProjectModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { toErrorMessage } from "../RepositoryFileService"
import { gitCredentialsFor } from "../workspace/RepositoryWorkspaceService"
import { deployTokenFailed, repositoryTokenRequired } from "./argoCdErrors"
import { ArgoCdRepositoryKind, PendingDeployToken, RepositoryTarget } from "./argoCdTypes"

/** Every initialization creates one per GitLab repository, under this name */
const DEPLOY_TOKEN_NAME = "flightroom-argocd"

const REPOSITORY_KINDS: ArgoCdRepositoryKind[] = ["configuration", "applications"]

/** GitLab takes the numeric id or the full path of a project, never a bare name */
const gitlabAddressOf = (link: ICodeRepositoryFrontend, codeRepository: ICodeRepository): string => {
    const groupPath = codeRepository.gitlabData?.groupPath
    return encodeURIComponent(link.repositoryId || link.gitlab?.path || (groupPath ? `${groupPath}/${link.name}` : link.name))
}

/**
 * The token pasted for GitHub and Azure DevOps is one: whichever repository stored it, the other may use it.
 * Only for the Argo CD it was handed to: another URL may be another server, and it is asked for again.
 */
export const storedRepositoryToken = (argoCd: IProjectArgoCd | undefined, url: string | undefined): string | undefined =>
    Object.values(argoCd?.repositories ?? {}).find(credential => credential?.source === "manual" && credential.password && url && credential.argoCdUrl === url)?.password

/** A project whose credentials hold `registration` on Argo CD, or that reads through them: `shared` for the second */
const registeredIn = (registration: IArgoCdRepositoryRegistration, extra: Record<string, unknown> = {}) => ({
    $or: REPOSITORY_KINDS.map(kind => ({
        [`argoCd.repositories.${kind}.argoCdUrl`]: registration.argoCdUrl,
        [`argoCd.repositories.${kind}.repoUrl`]: registration.repoUrl,
        ...Object.fromEntries(Object.entries(extra).map(([field, value]) => [`argoCd.repositories.${kind}.${field}`, value]))
    }))
})

/**
 * The project of the same organization that registered `repoUrl` globally on the Argo CD at `argoCdUrl` with credentials of
 * its own: a project linking the same repository reads it through that registration rather than fight over it. Argo CD
 * holds one registration per URL, and taking it over would leave the other project with credentials it does not know of.
 */
export const holderOf = async (projectId: Schema.Types.ObjectId, organizationId: Schema.Types.ObjectId, argoCdUrl: string, repoUrl: string) => {
    const candidates = await Project.find({ _id: { $ne: projectId }, organizationId, ...registeredIn({ argoCdUrl, repoUrl }) }, { slug: 1, argoCd: 1 })
    return candidates.find(candidate =>
        Object.values(candidate.argoCd?.repositories ?? {}).some(
            credential => credential?.argoCdUrl === argoCdUrl && credential.repoUrl === repoUrl && !credential.argoProject && credential.source !== "shared"
        )
    )
}

/** Whether another project reads the repository through `registration`: deleting it would cut that project off */
const sharedByOthers = async (projectId: Schema.Types.ObjectId, registration: IArgoCdRepositoryRegistration) =>
    Boolean(await Project.exists({ _id: { $ne: projectId }, ...registeredIn(registration, { source: "shared" }) }))

/**
 * The credentials Argo CD is to read `target` with: a new deploy token on GitLab, pending until it is stored, or the
 * read-only token pasted for the other providers, the one stored for `url` when none is pasted.
 */
export const newCredential = async (
    { link, connection }: Pick<RepositoryTarget, "link" | "connection">,
    common: Pick<IArgoCdRepositoryCredential, "argoCdUrl" | "repoUrl" | "argoProject" | "codeRepositoryId">,
    repositoryToken: string | undefined,
    previous: IProjectArgoCd | undefined
): Promise<{ credential: IArgoCdRepositoryCredential; pending?: PendingDeployToken }> => {
    if (connection.provider === CodeRepositoryProvider.GITLAB) {
        const gitlab = new GitlabClient(connection.gitlabData?.url ?? "", connection.accessToken)
        const gitlabProject = await gitlab.getProject(gitlabAddressOf(link, connection)).catch(error => Promise.reject(deployTokenFailed(link.name, error)))
        const deployToken = await gitlab
            .createDeployToken(gitlabProject.id, { name: DEPLOY_TOKEN_NAME, scopes: ["read_repository"] })
            .catch(error => Promise.reject(deployTokenFailed(link.name, error)))
        return {
            pending: { gitlab, gitlabProjectId: gitlabProject.id, id: deployToken.id },
            credential: { source: "deployToken", username: deployToken.username, password: deployToken.token, deployTokenId: deployToken.id, gitlabProjectId: gitlabProject.id, ...common }
        }
    }
    const password = repositoryToken ?? storedRepositoryToken(previous, common.argoCdUrl)
    if (!password) throw repositoryTokenRequired(link.name, connection.provider)
    return { credential: { source: "manual", username: gitCredentialsFor(connection).username, password, ...common } }
}

/**
 * Withdraws the credentials Argo CD read a repository with until now, once the next ones are in, or once
 * the repository is no longer linked. The registration goes from the Argo CD it was made on when that is
 * still the one initialized, and is not the one just made; one on an Argo CD the project moved away from is
 * left there, as the console no longer trusts that instance. A deploy token is revoked on GitLab in any
 * case, through the connection it was created with.
 */
export const retire = async (
    client: ArgoCdClient,
    url: string,
    projectId: Schema.Types.ObjectId,
    before: IArgoCdRepositoryCredential,
    next?: IArgoCdRepositoryCredential
): Promise<IArgoCdRepositoryRegistration[]> => {
    const undeleted: IArgoCdRepositoryRegistration[] = []
    // As Argo CD compares the URLs: the upsert of a URL written otherwise updated this very registration
    const sameRegistration = next && next.argoCdUrl === before.argoCdUrl && sameRepoUrl(next.repoUrl, before.repoUrl) && next.argoProject === before.argoProject
    // A shared registration is the other project's to delete, and so are its credentials
    if (before.argoCdUrl === url && !sameRegistration && before.source !== "shared") {
        const registration = { argoCdUrl: before.argoCdUrl, repoUrl: before.repoUrl, argoProject: before.argoProject }
        if (!(await deleteRegistration(client, projectId, registration))) undeleted.push(registration)
    }
    if (before.source !== "deployToken" || before.deployTokenId === undefined || before.gitlabProjectId === undefined) return undeleted
    const connection = await CodeRepository.findOne({ _id: toObjectId(before.codeRepositoryId), projectId })
    if (connection?.provider !== CodeRepositoryProvider.GITLAB || !connection.gitlabData?.url) {
        fastify.log.warn({ gitlabProjectId: before.gitlabProjectId, deployTokenId: before.deployTokenId }, "Argo CD deploy token left in place: its GitLab connection is gone")
        return undeleted
    }
    await revoke({ gitlab: new GitlabClient(connection.gitlabData.url, connection.accessToken), gitlabProjectId: before.gitlabProjectId, id: before.deployTokenId })
    return undeleted
}

/**
 * Whether the registration is gone from Argo CD, one already gone included: when not, the next run tries again. One another
 * project reads through is left in place, and done with for this one: its credentials stop being rotated, nothing else.
 */
export const deleteRegistration = async (client: ArgoCdClient, projectId: Schema.Types.ObjectId, registration: IArgoCdRepositoryRegistration): Promise<boolean> => {
    if (await sharedByOthers(projectId, registration)) {
        fastify.log.warn({ repository: registration.repoUrl }, "Argo CD registration of a repository no longer used left in place: another project reads through it")
        return true
    }
    return client.deleteRepository(registration.repoUrl, registration.argoProject).then(
        () => true,
        error => {
            fastify.log.error({ error: toErrorMessage(error), repository: registration.repoUrl }, "Argo CD registration of a repository no longer used not deleted, retried next time")
            return false
        }
    )
}

/** Best effort: a token that cannot be revoked now is still read-only, and the initialization is not undone for it */
export const revoke = async ({ gitlab, gitlabProjectId, id }: PendingDeployToken) => {
    await gitlab.revokeDeployToken(gitlabProjectId, id).catch(error => fastify.log.error({ error: toErrorMessage(error), gitlabProjectId, deployTokenId: id }, "Argo CD deploy token not revoked"))
}
