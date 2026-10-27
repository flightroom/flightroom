interface DomainDTO {
    name: string
    /** Left out on create, it is derived from the name. Never changed by an update. */
    slug?: string
    description?: string
    /** Markdown notes for AI agents about this domain. `null` removes it on update. */
    context?: string | null
}

/** Frontends and backends of the project to put in a domain */
export interface DomainMembersDTO {
    frontendIds?: string[]
    backendIds?: string[]
}

/** Why a repository of a domain build was not tagged */
export type DomainBuildFailure = "CONNECTION_NOT_FOUND" | "DOMAIN_SCOPE_FORBIDDEN" | "REPOSITORY_NOT_FOUND" | "REF_NOT_FOUND" | "TAG_EXISTS" | "PROVIDER_ERROR"

/** One repository of a domain build, with the members linked to it: a repository two members share is tagged once */
export interface DomainBuildRepository {
    /** Stable across builds: the connection, the repository id or name, and the GitLab path when there is one */
    id: string
    repository: string
    /** The branch it is tagged on */
    ref: string
    members: { kind: "frontend" | "backend"; _id: string; name: string }[]
    /**
     * ready: checked, but left untagged because another repository failed its check. unchanged: left untagged
     * because the branch is still on the commit of the version each of its members has
     */
    status: "tagged" | "ready" | "failed" | "unchanged"
    reason?: DomainBuildFailure
    message?: string
}

/** What a domain build did: every repository was tagged with `version` on its own `ref`, unless its status says otherwise. `ref` is the branch of the members given none */
export interface DomainBuildResult {
    version: string
    ref: string
    repositories: DomainBuildRepository[]
}

export default DomainDTO
