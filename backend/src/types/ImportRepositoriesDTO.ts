/** What a repository is imported as */
export type ImportTarget = "frontend" | "backend"

interface ImportRepositoriesDTO {
    /** Provider repository ids to import. When empty or omitted, every repository that is not imported yet is taken. */
    repositoryIds?: string[]
    /** GitLab only: import from this group instead of the one configured on the connection. */
    groupId?: number
    /** Initial version given to every created frontend. A backend gets its version from the CI. */
    version?: string
    /** One frontend per repository when omitted, one backend otherwise. */
    target?: ImportTarget
    /** The functional domain of the project every created member is put in. */
    domainId?: string
}

export default ImportRepositoriesDTO
