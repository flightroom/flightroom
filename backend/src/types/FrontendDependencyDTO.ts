import { CodeRepositoryProvider } from "../models/CodeRepositoryModel"

export enum DependencyKind {
    PROD = "PROD",
    DEV = "DEV",
    PEER = "PEER",
    OPTIONAL = "OPTIONAL"
}

export enum DependencyUpdateStatus {
    UP_TO_DATE = "UP_TO_DATE",
    PATCH_BEHIND = "PATCH_BEHIND",
    MINOR_BEHIND = "MINOR_BEHIND",
    MAJOR_BEHIND = "MAJOR_BEHIND",
    UNKNOWN = "UNKNOWN"
}

export interface DependencyDTO {
    name: string
    kind: DependencyKind
    /** Range as declared in the package.json, e.g. "^18.2.0" */
    range: string
    /** Lowest version satisfying the range, when it can be resolved */
    declaredVersion?: string
    /** Version currently tagged as `latest` on the registry */
    latestVersion?: string
    status: DependencyUpdateStatus
    deprecated?: boolean
}

/**
 * Branch to compare for each frontend, keyed by frontend id.
 * Frontends left out fall back to the default branch of their repository.
 */
export interface DependencyScanRequestDTO {
    branches?: Record<string, string>
}

export interface FrontendScanTargetDTO {
    frontendId: string
    slug: string
    name: string
    provider?: CodeRepositoryProvider
    repositoryName?: string
    defaultBranch?: string
    branches: string[]
    /** Set when the branch list could not be read (revoked token, deleted repository, ...) */
    error?: string
}

export interface FrontendDependenciesDTO {
    frontendId: string
    slug: string
    name: string
    provider?: CodeRepositoryProvider
    repositoryName?: string
    /** Branch the dependencies were actually read from */
    branch?: string
    defaultBranch?: string
    packageName?: string
    packageVersion?: string
    dependencies: DependencyDTO[]
    /** Set when the package.json could not be read (missing file, revoked token, ...) */
    error?: string
}

export interface DependencyOccurrenceDTO {
    frontendId: string
    slug: string
    name: string
    range: string
    aligned: boolean
}

export interface DependencyAlignmentIssueDTO {
    name: string
    kind: DependencyKind
    /** Range every frontend should converge to */
    suggestedRange: string
    latestVersion?: string
    /** Status of the suggested range against the registry */
    status: DependencyUpdateStatus
    occurrences: DependencyOccurrenceDTO[]
}

export interface ProjectDependenciesReportDTO {
    projectId: string
    scannedAt: string
    /** False when the npm registry could not be reached at all */
    registryAvailable: boolean
    frontends: FrontendDependenciesDTO[]
    /** Cross-frontend mismatches on peerDependencies */
    peerDependencyIssues: DependencyAlignmentIssueDTO[]
    /** Cross-frontend mismatches on dependencies, reported but never auto-applied */
    sharedDependencyIssues: DependencyAlignmentIssueDTO[]
}

export interface FrontendAlignmentChangeDTO {
    name: string
    kind: DependencyKind
    currentRange: string
    targetRange: string
}

export interface FrontendAlignmentPlanDTO {
    frontendId: string
    slug: string
    name: string
    provider: CodeRepositoryProvider
    repositoryName: string
    /** Branch the changes are computed from, and the alignment branch is created from */
    baseBranch: string
    changes: FrontendAlignmentChangeDTO[]
}

export interface AlignmentPlanDTO {
    projectId: string
    targetBranch: string
    frontends: FrontendAlignmentPlanDTO[]
}

export interface AlignmentApplyRequestDTO extends DependencyScanRequestDTO {
    /** Restricts the alignment to these frontends. Defaults to all of them. */
    frontendIds?: string[]
    /** Restricts the alignment to these package names. Defaults to every misaligned package. */
    packages?: string[]
    branchName?: string
    commitMessage?: string
}

export interface AlignmentApplyResultItemDTO {
    frontendId: string
    slug: string
    name: string
    provider: CodeRepositoryProvider
    repositoryName: string
    baseBranch: string
    branch: string
    applied: boolean
    changes: FrontendAlignmentChangeDTO[]
    error?: string
}

export interface AlignmentApplyResultDTO {
    projectId: string
    targetBranch: string
    results: AlignmentApplyResultItemDTO[]
}
