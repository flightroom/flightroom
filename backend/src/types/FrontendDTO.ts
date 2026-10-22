import { CanaryDeploymentType, CanaryType, FrontendKind, FrontendType, IHostFrontend } from "../models/FrontendModel"
import { FrontendStackDTO } from "./FrontendStack"
import ServiceDTO from "./ServiceDTO"

/** The container fields of a DOCKER, the same as a service's and checked the same way */
type FrontendContainerDTO = Pick<ServiceDTO, "image" | "port" | "livenessPath" | "readinessPath" | "docsPath" | "openApiPath" | "exposurePath" | "env" | "configMapIds" | "secretIds">

interface FrontendDTO extends FrontendContainerDTO {
    id: string
    type?: FrontendType
    /** BUNDLE when omitted. A DOCKER never has parentIds */
    kind?: FrontendKind
    name: string
    slug: string
    url: string
    environment: string
    /** The functional domain of the project it belongs to; null or blank takes it out of any */
    domainId?: string | null
    version?: string
    /** Markdown for AI agents about this frontend */
    context?: string
    /** Slug of the marketplace template the repository was scaffolded from */
    template?: string
    stack?: FrontendStackDTO
    status?: "active" | "inactive"
    createdAt?: Date
    updatedAt?: Date
    parentIds?: string[]
    /** Omitted on create: the project's default hosting is used */
    host?: IHostFrontend
    codeRepository: {
        enabled: boolean
        codeRepositoryId: string
        repositoryId: string
        name?: string
        cloneUrlHttps?: string
        cloneUrlSsh?: string
        gitlab?: {
            groupPath?: string
            groupId?: number
        }
        createData?: {
            name: string
            private?: boolean
            groupPath?: string
            template?: string
        }
    }
    canary: {
        enabled: boolean
        percentage: number
        type: CanaryType
        deploymentType: CanaryDeploymentType
        version: string
        url: string
    }
}

export default FrontendDTO
