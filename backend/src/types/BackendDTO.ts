import { BackendStackDTO } from "./BackendStack"
import FrontendDTO from "./FrontendDTO"

export interface BackendEnvVariableDTO {
    name: string
    required?: boolean
    secret?: boolean
    description?: string
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
