import type { AxiosError } from "axios"
import { useTranslation } from "react-i18next"
import useApiClient, { errorCodeOf } from "../useApiClient"

/** A functional domain: a named group of frontends and backends of the project */
export interface Domain {
    _id: string
    projectId: string
    slug: string
    name: string
    description?: string
    /** Markdown notes for AI agents about this domain */
    context?: string
    /** Only on the list */
    frontendsCount?: number
    /** Only on the list */
    backendsCount?: number
    createdAt?: Date
    updatedAt?: Date
}

export interface DomainDTO {
    name: string
    description?: string
    context?: string
}

/** Frontends and backends of the project to put in a domain */
export interface DomainMembersDTO {
    frontendIds?: string[]
    backendIds?: string[]
}

/** Why a repository of a domain build was not tagged */
export type DomainBuildFailure = "CONNECTION_NOT_FOUND" | "DOMAIN_SCOPE_FORBIDDEN" | "REPOSITORY_NOT_FOUND" | "REF_NOT_FOUND" | "TAG_EXISTS" | "PROVIDER_ERROR"

/** One repository of a domain build, with the members linked to it */
export interface DomainBuildRepository {
    /** Stable across builds: the connection, the repository id or name, and the GitLab path when there is one */
    id: string
    repository: string
    members: { kind: "frontend" | "backend"; _id: string; name: string }[]
    /** ready: checked, but left untagged because another repository failed its check */
    status: "tagged" | "ready" | "failed"
    reason?: DomainBuildFailure
    /** The backend's English wording, shown only for a provider error that has no translation */
    message?: string
}

/** What a domain build did, or, in the refusal of its check, what each repository would have done */
export interface DomainBuildResult {
    version: string
    ref: string
    repositories: DomainBuildRepository[]
}

/** Where a build and deploy of a domain stands: building, then the console waits for the CI, sets the versions and deploys */
export type DomainReleaseStatus = "building" | "waiting_ci" | "updating_versions" | "deploying" | "deployed" | "failed"

/** A frontend or a backend of the domain, as the release found it when it started */
export interface DomainReleaseMember {
    kind: "frontend" | "backend"
    _id: string
    name: string
    /** Its repository was tagged: without one it is left out of the release, its version untouched */
    tagged: boolean
    /** The CI registered the version of the release for it */
    built: boolean
}

/** One build and deploy of a domain to an environment */
export interface DomainRelease {
    _id: string
    domainId: string
    version: string
    ref: string
    environmentId: string
    status: DomainReleaseStatus
    members: DomainReleaseMember[]
    /** What the build did, repository by repository */
    repositories: DomainBuildRepository[]
    failedStep?: Exclude<DomainReleaseStatus, "deployed" | "failed">
    errorCode?: string
    /** The backend's English wording, shown when the code has no translation */
    errorMessage?: string
    deploymentId?: string
    createdAt: string
    finishedAt?: string
}

/** Whether the release still has steps to take: deployed and failed are the end */
export const isReleaseRunning = (release?: DomainRelease | null): boolean => Boolean(release) && release?.status !== "deployed" && release?.status !== "failed"

/** The codes the backend raises about domains, by translation key */
const DOMAIN_ERROR_KEYS: Record<string, string> = {
    DOMAIN_SLUG_TAKEN: "domains.errors.slug_taken",
    DOMAIN_SLUG_INVALID: "domains.errors.slug_invalid",
    DOMAIN_NAME_REQUIRED: "domains.errors.name_required",
    DOMAIN_INVALID: "domains.errors.invalid",
    DOMAIN_NOT_FOUND: "domains.errors.not_found",
    DOMAIN_BUILD_VERSION_INVALID: "domains.build.errors.version_invalid",
    DOMAIN_BUILD_REF_INVALID: "domains.build.errors.ref_invalid",
    DOMAIN_BUILD_EMPTY: "domains.build.errors.empty",
    DOMAIN_BUILD_NO_REPOSITORIES: "domains.build.errors.no_repositories",
    DOMAIN_BUILD_CHECK_FAILED: "domains.build.errors.check_failed",
    DOMAIN_BUILD_FORBIDDEN: "domains.build.errors.forbidden",
    DOMAIN_RELEASE_RUNNING: "domains.release.errors.running",
    DOMAIN_RELEASE_ENVIRONMENT_INVALID: "domains.release.errors.environment_invalid",
    DOMAIN_RELEASE_ENVIRONMENT_NOT_FOUND: "domains.release.errors.environment_not_found"
}

/** The repositories a refused domain build checked, each with its outcome: undefined for any other error */
export const buildCheckOf = (error: Error): DomainBuildResult | undefined => {
    const payload = (error as AxiosError<{ error?: { code?: string; details?: DomainBuildResult } }>)?.response?.data?.error
    return payload?.code === "DOMAIN_BUILD_CHECK_FAILED" ? payload.details : undefined
}

const useDomainsApi = () => {
    const apiClient = useApiClient()
    const { t } = useTranslation()

    /** The translated message of a domain error, undefined for any other so the generic one is shown */
    const errorMessage = (error: Error): string | undefined => {
        const key = DOMAIN_ERROR_KEYS[errorCodeOf(error) ?? ""]
        return key ? t(key) : undefined
    }

    const getAll = async (): Promise<Domain[]> => {
        const response = await apiClient.doRequest<Domain[]>({ url: "/api/domains" })
        return response.data
    }

    const getSingle = async (id: string): Promise<Domain> => {
        const response = await apiClient.doRequest<Domain>({ url: `/api/domains/${id}` })
        return response.data
    }

    const create = async (domain: DomainDTO): Promise<Domain> => {
        const response = await apiClient.doRequest<Domain>({ url: "/api/domains", method: "POST", data: domain, customErrorMessage: errorMessage })
        return response.data
    }

    const update = async (id: string, domain: DomainDTO): Promise<Domain> => {
        const response = await apiClient.doRequest<Domain>({ url: `/api/domains/${id}`, method: "PUT", data: domain, customErrorMessage: errorMessage })
        return response.data
    }

    /** Moves the members into the domain, out of the one they were in; answers how many it now groups of each */
    const addMembers = async (id: string, members: DomainMembersDTO): Promise<{ frontends: number; backends: number }> => {
        const response = await apiClient.doRequest<{ frontends: number; backends: number }>({
            url: `/api/domains/${id}/members`,
            method: "POST",
            data: members,
            customErrorMessage: errorMessage
        })
        return response.data
    }

    /** Tags the repository of every member with `version` on `ref` (main when left out): each tag starts the pipeline of its repository */
    const build = async (id: string, version: string, ref?: string): Promise<DomainBuildResult> => {
        const response = await apiClient.doRequest<DomainBuildResult>({ url: `/api/domains/${id}/build`, method: "POST", data: { version, ref }, customErrorMessage: errorMessage })
        return response.data
    }

    /** Builds the domain now; the console then waits for the CI, sets the version on its members and deploys it to `environmentId` */
    const startRelease = async (id: string, version: string, environmentId: string, ref?: string): Promise<DomainRelease> => {
        const response = await apiClient.doRequest<DomainRelease>({
            url: `/api/domains/${id}/build-and-deploy`,
            method: "POST",
            data: { version, ref, environmentId },
            customErrorMessage: errorMessage
        })
        return response.data
    }

    /** The last build and deploy of the domain, over or not: null when it never had one */
    const getLatestRelease = async (id: string): Promise<DomainRelease | null> => {
        // Polled while a release runs: a request that fails is retried by the next, not told every few seconds
        const response = await apiClient.doRequest<DomainRelease | null>({ url: `/api/domains/${id}/releases/latest`, silent: true })
        return response.data || null
    }

    const deleteSingle = async (id: string) => {
        const response = await apiClient.doRequest({ url: `/api/domains/${id}`, method: "DELETE" })
        return response.data
    }

    return { getAll, getSingle, create, update, addMembers, build, startRelease, getLatestRelease, deleteSingle, errorMessage }
}

export default useDomainsApi
