import { BackendStackDTO } from "./BackendStack"
import FrontendDTO from "./FrontendDTO"

export interface BackendEnvVariableDTO {
    name: string
    required?: boolean
    secret?: boolean
    description?: string
}

export interface EnvironmentResourcesDTO {
    environmentId: string
    cpuRequest?: string | null
    cpuLimit?: string | null
    memoryRequest?: string | null
    memoryLimit?: string | null
}

export interface EnvironmentVersionDTO {
    environmentId: string
    version?: string | null
}

interface BackendDTO {
    id?: string
    name: string
    slug: string
    description?: string
    /** The functional domain of the project it belongs to; null or blank takes it out of any */
    domainId?: string | null
    /** Markdown for AI agents about this backend */
    context?: string
    /** Slug of the marketplace template the repository was scaffolded from */
    template?: string
    stack?: BackendStackDTO
    version?: string
    /** Same shape as a frontend's: `createData` creates the repository from a template */
    codeRepository?: FrontendDTO["codeRepository"]
    image?: {
        repository?: string
    }
    port?: number
    livenessPath?: string
    readinessPath?: string
    /** The UI of the public API documentation; blank or null when the backend has none */
    docsPath?: string | null
    /** The OpenAPI spec; blank or null when the backend has none */
    openApiPath?: string | null
    /** The path on the host of every environment, e.g. /api/orders; blank or null when it is not exposed */
    exposurePath?: string | null
    /** Kubernetes quantities, e.g. 250m or 0.5; blank or null for the default of the chart */
    cpuRequest?: string | null
    cpuLimit?: string | null
    /** Kubernetes quantities, e.g. 128Mi or 1Gi; blank or null for the default of the chart */
    memoryRequest?: string | null
    memoryLimit?: string | null
    /**
     * The environments that run it with CPU and memory of their own, replaced as a whole: each value left blank is the
     * one above. An environment appears once at most, and must be of the project
     */
    environmentResources?: EnvironmentResourcesDTO[] | null
    /**
     * The version each environment runs, replaced as a whole: an environment with none does not get it, whatever the
     * version above. An environment appears once at most, and must be of the project
     */
    environmentVersions?: EnvironmentVersionDTO[] | null
    env?: BackendEnvVariableDTO[]
    /** Config maps of the project to attach; replaced as a whole, and no key may be set by two attached maps */
    configMapIds?: string[]
    /** Secrets of the project to attach, as for the config maps */
    secretIds?: string[]
    /** Resources of the project to attach, as for the config maps: no key of theirs may be set by an attached map either */
    resourceIds?: string[]
    createdAt?: Date
    updatedAt?: Date
}

/** What the CI pipeline sends once it pushed the image of a tagged version */
export interface BackendVersionRegistrationDTO {
    image: string
    digest?: string
    commitSha?: string
}

export default BackendDTO
