interface DomainDTO {
    name: string
    /** Left out on create, it is derived from the name. Never changed by an update. */
    slug?: string
    description?: string
    /** Markdown notes for AI agents about this domain. `null` removes it on update. */
    context?: string | null
}

/** Microfrontends and services of the project to put in a domain */
export interface DomainMembersDTO {
    microfrontendIds?: string[]
    serviceIds?: string[]
}

/** Why a repository of a domain build was not tagged */
export type DomainBuildFailure = "CONNECTION_NOT_FOUND" | "DOMAIN_SCOPE_FORBIDDEN" | "REPOSITORY_NOT_FOUND" | "REF_NOT_FOUND" | "TAG_EXISTS" | "PROVIDER_ERROR"

/** One repository of a domain build, with the members linked to it: a repository two members share is tagged once */
export interface DomainBuildRepository {
    /** Stable across builds: the connection, the repository id or name, and the GitLab path when there is one */
    id: string
    repository: string
    members: { kind: "microfrontend" | "service"; _id: string; name: string }[]
    /** ready: checked, but left untagged because another repository failed its check */
    status: "tagged" | "ready" | "failed"
    reason?: DomainBuildFailure
    message?: string
}

/** What a domain build did: every repository was tagged with `version` on `ref`, unless its status says otherwise */
export interface DomainBuildResult {
    version: string
    ref: string
    repositories: DomainBuildRepository[]
}

export default DomainDTO
