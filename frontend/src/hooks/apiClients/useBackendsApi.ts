import { useTranslation } from "react-i18next"
import useApiClient, { errorCodeOf, IClientRequestMetadataExtended } from "../useApiClient"
import type { CreateMemberRepositoryDTO, Frontend } from "./useFrontendsApi"

export enum BackendRuntime {
    NODE = "NODE",
    PYTHON = "PYTHON",
    GO = "GO",
    DOTNET = "DOTNET",
    JAVA = "JAVA",
    OTHER = "OTHER"
}

export interface BackendEnvVariable {
    name: string
    required: boolean
    secret: boolean
    description?: string
}

/** Same shape as the frontend repository link: the backend reuses the subdocument. */
export type BackendCodeRepository = Frontend["codeRepository"]

/** The version one environment runs apart from the one of a container */
export interface EnvironmentVersion {
    environmentId: string
    version?: string | null
}

/** What one environment sets apart from the CPU and memory of a container */
export interface EnvironmentResources {
    environmentId: string
    cpuRequest?: string | null
    cpuLimit?: string | null
    memoryRequest?: string | null
    memoryLimit?: string | null
}

export interface Backend {
    _id?: string
    projectId?: string
    /** The functional domain it belongs to; null or missing when it is in none */
    domainId?: string | null
    slug: string
    name: string
    description?: string
    /** Markdown per gli agenti AI su questo solo servizio */
    context?: string
    /** Market slug of the template the backend was created from */
    template?: string
    stack?: {
        runtime?: BackendRuntime
        framework?: string
        source?: string
        detectedAt?: Date
    }
    /** Latest registered version, or the one set by hand: the tag of the image deployed */
    version?: string
    codeRepository?: BackendCodeRepository
    image?: {
        repository?: string
    }
    port: number
    /** Kubernetes restarts the container when it fails */
    livenessPath: string
    /** Kubernetes sends traffic only while it answers */
    readinessPath: string
    /** The UI of the public API documentation; blank or null when the backend has none */
    docsPath?: string | null
    /** Il path su cui e' esposto sull'host di ogni ambiente, es. /api/orders; null se non e' esposto */
    exposurePath?: string | null
    /** The OpenAPI spec; blank or null when the backend has none */
    openApiPath?: string | null
    /** Kubernetes quantities, e.g. 250m or 0.5; blank or null for the default of the chart */
    cpuRequest?: string | null
    cpuLimit?: string | null
    /** Kubernetes quantities, e.g. 128Mi or 1Gi; blank or null for the default of the chart */
    memoryRequest?: string | null
    memoryLimit?: string | null
    /** The environments that run it with CPU and memory of their own: each value left blank is the one above */
    environmentResources?: EnvironmentResources[] | null
    /** The environments that run a version of their own: one left blank runs the version above */
    environmentVersions?: EnvironmentVersion[] | null
    env: BackendEnvVariable[]
    /** Config maps of the project it receives as environment variables */
    configMapIds?: string[]
    /** Secrets of the project it receives as environment variables */
    secretIds?: string[]
    /** Resources of the project it receives as environment variables; a frontend never has any */
    resourceIds?: string[]
    createdAt?: Date
    updatedAt?: Date
}

export type BackendDTO = Omit<Backend, "_id" | "projectId" | "stack" | "createdAt" | "updatedAt">

/** Port and probe paths left out come from the template, the platform defaults after it. */
export type BackendCreateDTO = Omit<BackendDTO, "port" | "livenessPath" | "readinessPath"> & Partial<Pick<BackendDTO, "port" | "livenessPath" | "readinessPath">>

export interface BuiltBackend {
    _id?: string
    backendId: string
    version: string
    /** Full image reference, e.g. ghcr.io/acme/orders-api:1.2.0 */
    image: string
    digest?: string
    commitSha?: string
    createdAt?: Date
    updatedAt?: Date
}

/** The codes a backend build is refused with, by translation key */
const BACKEND_BUILD_ERROR_KEYS: Record<string, string> = {
    BACKEND_BUILD_FORBIDDEN: "backends.build.forbidden",
    BUILD_REF_NOT_FOUND: "backends.build.ref_not_found",
    BUILD_REPOSITORY_NOT_FOUND: "backends.build.repository_not_found"
}

const useBackendsApi = () => {
    const apiClient = useApiClient()
    const { t } = useTranslation()

    const getAll = async (): Promise<Backend[]> => {
        const response = await apiClient.doRequest<Backend[]>({ url: "/api/backends" })
        return response.data
    }

    const getSingle = async (id: string): Promise<Backend> => {
        const response = await apiClient.doRequest<Backend>({ url: `/api/backends/${id}` })
        return response.data
    }

    const getVersions = async (id: string): Promise<BuiltBackend[]> => {
        const response = await apiClient.doRequest<BuiltBackend[]>({ url: `/api/backends/${id}/versions` })
        return response.data
    }

    const create = async (backend: BackendCreateDTO, metadata?: IClientRequestMetadataExtended): Promise<Backend> => {
        const response = await apiClient.doRequest<Backend>({ url: "/api/backends", method: "POST", data: backend, ...metadata })
        return response.data
    }

    const update = async (id: string, backend: Partial<BackendDTO>, metadata?: IClientRequestMetadataExtended): Promise<Backend> => {
        const response = await apiClient.doRequest<Backend>({ url: `/api/backends/${id}`, method: "PUT", data: backend, ...metadata })
        return response.data
    }

    const deleteSingle = async (id: string) => {
        const response = await apiClient.doRequest({ url: `/api/backends/${id}`, method: "DELETE" })
        return response.data
    }

    const build = async (id: string, version: string, branch?: string) => {
        const response = await apiClient.doRequest({
            url: `/api/backends/${id}/build`,
            method: "POST",
            data: { version, branch },
            // Said in the user's language, any other error as the backend tells it
            customErrorMessage: error => {
                const key = BACKEND_BUILD_ERROR_KEYS[errorCodeOf(error) ?? ""]
                return key ? t(key) : undefined
            }
        })
        return response.data
    }

    const createRepository = async (id: string, data: CreateMemberRepositoryDTO, metadata?: IClientRequestMetadataExtended): Promise<Backend> => {
        const response = await apiClient.doRequest<Backend>({ url: `/api/backends/${id}/repository`, method: "POST", data, ...metadata })
        return response.data
    }

    return { getAll, getSingle, getVersions, create, update, deleteSingle, build, createRepository }
}

export default useBackendsApi
