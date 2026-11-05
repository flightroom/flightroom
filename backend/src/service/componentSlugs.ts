import { Schema } from "mongoose"
import Backend from "../models/BackendModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import { toObjectId } from "../utils/mongooseUtils"

type ProjectId = string | Schema.Types.ObjectId

/**
 * A slug names one component of the project, whatever its kind: a frontend, a backend and a maintenance agent share
 * one space. It names the repository folder, the CI registration URL, the values file in the GitOps repository and
 * the in-cluster URL the others call it at, so two components with the same slug would collide in each of them.
 */
export const isComponentSlugTaken = async (slug: string, projectId: ProjectId): Promise<boolean> => {
    const filter = { slug, projectId: toObjectId(projectId) }
    const taken = await Promise.all([Frontend.exists(filter), Backend.exists(filter), MaintenanceAgent.exists(filter)])
    return taken.some(Boolean)
}

/** The slugs every frontend, backend and maintenance agent of the project already holds */
export const takenComponentSlugs = async (projectId: ProjectId): Promise<Set<string>> => {
    const filter = { projectId: toObjectId(projectId) }
    const members = await Promise.all([Frontend.find(filter, { slug: 1 }), Backend.find(filter, { slug: 1 }), MaintenanceAgent.find(filter, { slug: 1 })])
    return new Set(members.flat().map(member => member.slug))
}
