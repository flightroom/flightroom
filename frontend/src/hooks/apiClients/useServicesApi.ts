import { useTranslation } from "react-i18next"
import useApiClient, { errorCodeOf, IClientRequestMetadataExtended } from "../useApiClient"
import type { CreateMemberRepositoryDTO, Frontend } from "./useFrontendsApi"

export enum ServiceRuntime {
    NODE = "NODE",
    PYTHON = "PYTHON",
    GO = "GO",
    DOTNET = "DOTNET",
    JAVA = "JAVA",
    OTHER = "OTHER"
}

export interface ServiceEnvVariable {
    name: string
    required: boolean
    secret: boolean
    description?: string
}

/** Same shape as the frontend repository link: the backend reuses the subdocument. */
export type ServiceCodeRepository = Frontend["codeRepository"]

export interface Service {
    _id?: string
    projectId?: string
    /** The functional domain it belongs to; null or missing when it is in none */
    domainId?: string | null
    slug: string
    name: string
    description?: string
    /** Markdown per gli agenti AI su questo solo servizio */
    context?: string
    /** Market slug of the template the service was created from */
    template?: string
    stack?: {
        runtime?: ServiceRuntime
        framework?: string
        source?: string
        detectedAt?: Date
    }
    /** Latest registered version, or the one set by hand: the tag of the image deployed */
    version?: string
    codeRepository?: ServiceCodeRepository
    image?: {
        repository?: string
    }
    port: number
    /** Kubernetes restarts the container when it fails */
    livenessPath: string
    /** Kubernetes sends traffic only while it answers */
    readinessPath: string
    /** The UI of the public API documentation; blank or null when the service has none */
    docsPath?: string | null
    /** Il path su cui e' esposto sull'host di ogni ambiente, es. /api/orders; null se non e' esposto */
    exposurePath?: string | null
    /** The OpenAPI spec; blank or null when the service has none */
    openApiPath?: string | null
    env: ServiceEnvVariable[]
    /** Config maps of the project it receives as environment variables */
    configMapIds?: string[]
    /** Secrets of the project it receives as environment variables */
    secretIds?: string[]
    createdAt?: Date
    updatedAt?: Date
}

export type ServiceDTO = Omit<Service, "_id" | "projectId" | "stack" | "createdAt" | "updatedAt">

/** Port and probe paths left out come from the template, the platform defaults after it. */
export type ServiceCreateDTO = Omit<ServiceDTO, "port" | "livenessPath" | "readinessPath"> & Partial<Pick<ServiceDTO, "port" | "livenessPath" | "readinessPath">>

export interface BuiltService {
    _id?: string
    serviceId: string
    version: string
    /** Full image reference, e.g. ghcr.io/acme/orders-api:1.2.0 */
    image: string
    digest?: string
    commitSha?: string
    createdAt?: Date
    updatedAt?: Date
}

/** The codes a service build is refused with, by translation key */
const SERVICE_BUILD_ERROR_KEYS: Record<string, string> = {
    SERVICE_BUILD_FORBIDDEN: "services.build.forbidden",
    BUILD_REF_NOT_FOUND: "services.build.ref_not_found",
    BUILD_REPOSITORY_NOT_FOUND: "services.build.repository_not_found"
}

const useServicesApi = () => {
    const apiClient = useApiClient()
    const { t } = useTranslation()

    const getAll = async (): Promise<Service[]> => {
        const response = await apiClient.doRequest<Service[]>({ url: "/api/services" })
        return response.data
    }

    const getSingle = async (id: string): Promise<Service> => {
        const response = await apiClient.doRequest<Service>({ url: `/api/services/${id}` })
        return response.data
    }

    const getVersions = async (id: string): Promise<BuiltService[]> => {
        const response = await apiClient.doRequest<BuiltService[]>({ url: `/api/services/${id}/versions` })
        return response.data
    }

    const create = async (service: ServiceCreateDTO, metadata?: IClientRequestMetadataExtended): Promise<Service> => {
        const response = await apiClient.doRequest<Service>({ url: "/api/services", method: "POST", data: service, ...metadata })
        return response.data
    }

    const update = async (id: string, service: ServiceDTO, metadata?: IClientRequestMetadataExtended): Promise<Service> => {
        const response = await apiClient.doRequest<Service>({ url: `/api/services/${id}`, method: "PUT", data: service, ...metadata })
        return response.data
    }

    const deleteSingle = async (id: string) => {
        const response = await apiClient.doRequest({ url: `/api/services/${id}`, method: "DELETE" })
        return response.data
    }

    const build = async (id: string, version: string, branch?: string) => {
        const response = await apiClient.doRequest({
            url: `/api/services/${id}/build`,
            method: "POST",
            data: { version, branch },
            // Said in the user's language, any other error as the backend tells it
            customErrorMessage: error => {
                const key = SERVICE_BUILD_ERROR_KEYS[errorCodeOf(error) ?? ""]
                return key ? t(key) : undefined
            }
        })
        return response.data
    }

    const createRepository = async (id: string, data: CreateMemberRepositoryDTO, metadata?: IClientRequestMetadataExtended): Promise<Service> => {
        const response = await apiClient.doRequest<Service>({ url: `/api/services/${id}/repository`, method: "POST", data, ...metadata })
        return response.data
    }

    return { getAll, getSingle, getVersions, create, update, deleteSingle, build, createRepository }
}

export default useServicesApi
