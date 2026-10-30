import GitlabClient from "../../client/GitlabClient"
import { CodeRepositoryProvider, ICodeRepository } from "../../models/CodeRepositoryModel"
import { ICodeRepositoryFrontend } from "../../models/FrontendModel"
import { IArgoCdError, IArgoCdRepositoryCredential, IProjectArgoCd } from "../../models/ProjectModel"

/** The token and the repository token come back as the placeholder, or not at all, when they are not retyped */
export interface ArgoCdInitializeInput {
    url: string
    token?: string
    /** Read-only token of GitHub or Azure DevOps, for the repositories GitLab does not hold */
    repositoryToken?: string
    /** Accepts the certificate of Argo CD without verifying it: for a self-signed one */
    insecure?: boolean
}

/** What the screen of logs asks for, as the query string brings it */
export interface ArgoCdLogsInput {
    pod?: string
    tailLines?: string | number
    sinceSeconds?: string | number
    previous?: string | boolean
    filter?: string
}

export type ArgoCdRepositoryKind = "configuration" | "applications"

export type ArgoCdRepositories = NonNullable<IProjectArgoCd["repositories"]>

/** What the settings screen shows of Argo CD: never a credential */
export interface ArgoCdStatusDTO {
    url?: string
    /** A URL and a token are stored: the token may be left out of the next initialization to the same URL */
    configured: boolean
    /** The certificate of Argo CD is not verified */
    insecure: boolean
    initializedAt?: Date
    lastError?: IArgoCdError
    /** Why the last deploy did not align the ApplicationSets of the applications */
    alignError?: IArgoCdError
    repositories: Partial<Record<ArgoCdRepositoryKind, { source: IArgoCdRepositoryCredential["source"] }>>
    /** Some repository is not on GitLab: Argo CD reads it with the token the owner pastes */
    needsRepositoryToken: boolean
    /** The providers that token is for, so the screen can say how to create it */
    repositoryTokenProviders: CodeRepositoryProvider[]
    /** A pasted token is stored for the stored URL: it may be left out of the next initialization to it */
    repositoryTokenStored: boolean
    /** The user is an owner of the project or an administrator of its organization */
    canInitialize: boolean
}

/** A deploy token created for this initialization, revoked when Argo CD never got it */
export interface PendingDeployToken {
    gitlab: GitlabClient
    gitlabProjectId: number
    id: number
}

export interface RepositoryTarget {
    kind: ArgoCdRepositoryKind
    link: ICodeRepositoryFrontend
    connection: ICodeRepository
    repoUrl: string
    /** The AppProject the credentials are scoped to; global when unset */
    argoProject?: string
}
