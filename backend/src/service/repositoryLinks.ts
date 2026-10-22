import { ObjectId, Schema } from "mongoose"
import { CodeRepositoryProvider } from "../models/CodeRepositoryModel"
import { ICodeRepositoryFrontend } from "../models/FrontendModel"

/**
 * What a link to a repository belongs to: a frontend or a service of the project. Without `kind` and
 * `_id`, only the links naming the same repository are found, not the owner by its own id.
 */
export interface RepositoryLinkOwner {
    projectId: string | Schema.Types.ObjectId | ObjectId
    kind?: "frontend" | "service"
    _id?: unknown
}

/**
 * What tells the repository of `link` among those of its connection: two links of the same connection point
 * to the same repository when any of these matches. Names are unique per owner on GitHub and per project on
 * Azure DevOps, but a GitLab connection can reach two groups with a repository of the same name: there the
 * path tells.
 */
export const repositoryKeys = (provider: CodeRepositoryProvider | undefined, link: ICodeRepositoryFrontend): { field: "repositoryId" | "gitlab.path" | "name"; value: string }[] => {
    const keys: { field: "repositoryId" | "gitlab.path" | "name"; value: string }[] = []
    if (link.repositoryId) keys.push({ field: "repositoryId", value: link.repositoryId })
    if (provider === CodeRepositoryProvider.GITLAB) {
        if (link.gitlab?.path) keys.push({ field: "gitlab.path", value: link.gitlab.path })
    } else if (link.name) {
        keys.push({ field: "name", value: link.name })
    }
    return keys
}

/**
 * The queries for what links to the same repository as `link` in the project: the owner itself among the
 * frontends or the services, and those of either kind with the same id, path or name. A query is
 * undefined when nothing can match it.
 */
export const linksToRepository = (owner: RepositoryLinkOwner, provider: CodeRepositoryProvider | undefined, link: ICodeRepositoryFrontend) => {
    const sameRepository: Record<string, unknown>[] = repositoryKeys(provider, link).map(({ field, value }) => ({ [`codeRepository.${field}`]: value }))
    const linksToIt: Record<string, unknown> = { projectId: owner.projectId, "codeRepository.codeRepositoryId": link.codeRepositoryId }
    const ofKind = (kind: RepositoryLinkOwner["kind"]) => {
        const conditions = owner.kind === kind && owner._id ? [{ _id: owner._id }, ...sameRepository] : sameRepository
        return conditions.length > 0 ? { ...linksToIt, $or: conditions } : undefined
    }
    return { frontends: ofKind("frontend"), services: ofKind("service") }
}
