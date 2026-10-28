import fs from "node:fs/promises"
import path from "node:path"
import { fastify } from "../.."
import AiChangeRequest from "../../models/AiChangeRequestModel"
import { IBackend } from "../../models/BackendModel"
import { IFrontend } from "../../models/FrontendModel"
import Organization from "../../models/OrganizationModel"
import Project, { IProject } from "../../models/ProjectModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { isJobWorkspacePath, projectWorkspacePath, sharedWorkspacePath } from "../../utils/workspacePaths"
import { componentWorkspacePath, fromBackend, fromFrontend, RepositoryComponent } from "./repositoryComponent"

/**
 * What goes away with a frontend, a backend or a project besides its documents: the local clones of its
 * repositories and the AI change requests made on them.
 *
 * Kept apart from the workspace service so the services that delete things can call it without
 * importing the repository clients. Never throws: a leftover folder is harmless and eviction
 * removes it eventually, while a failure here must not undo a deletion the user asked for.
 */
const ownerOf = async (project: IProject | null) => {
    const organization = project && (await Organization.findById(project.organizationId, { slug: 1 }))
    if (!project || !organization) return undefined
    return { organization: { slug: organization.slug, id: organization._id.toString() }, project: { slug: project.slug, id: project._id.toString() } }
}

const removeFolder = async (folder: string) => {
    await fs.rm(folder, { recursive: true, force: true })
}

/** The shared copy of a component and the copies of its jobs, next to it. */
const removeComponentFolders = async (folder: string) => {
    await removeFolder(folder)
    const siblings = await fs.readdir(path.dirname(folder)).catch(() => [])
    for (const name of siblings) {
        const sibling = path.join(path.dirname(folder), name)
        if (isJobWorkspacePath(sibling) && sharedWorkspacePath(sibling) === folder) await removeFolder(sibling)
    }
}

const forgetComponents = async (components: RepositoryComponent[]) => {
    try {
        for (const component of components) {
            const owner = await ownerOf(await Project.findById(component.projectId))
            if (owner) await removeComponentFolders(componentWorkspacePath(fastify.config.REPOSITORIES_FOLDER, owner, component))
        }
        const idsOf = (kind: RepositoryComponent["kind"]) => components.filter(component => component.kind === kind).map(component => component._id)
        await AiChangeRequest.deleteMany({ $or: [{ frontendId: { $in: idsOf("frontend") } }, { backendId: { $in: idsOf("backend") } }] })
    } catch (error) {
        fastify.log.warn({ err: error }, "Could not clean up after deleted components")
    }
}

export const forgetFrontends = (frontends: IFrontend[]) => forgetComponents(frontends.map(fromFrontend))

export const forgetBackends = (backends: IBackend[]) => forgetComponents(backends.map(fromBackend))

/** Resolves the folder before the project is deleted, removes it once the deletion went through. */
export const prepareProjectCleanup = async (projectId: string) => {
    const owner = await ownerOf(await Project.findById(projectId)).catch(() => undefined)
    return async () => {
        try {
            if (owner) await removeFolder(projectWorkspacePath(fastify.config.REPOSITORIES_FOLDER, owner))
            await AiChangeRequest.deleteMany({ projectId: toObjectId(projectId) })
        } catch (error) {
            fastify.log.warn({ err: error, projectId }, "Could not clean up after a deleted project")
        }
    }
}
