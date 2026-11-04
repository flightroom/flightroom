import { BackendStackDTO } from "./BackendStack"
import FrontendDTO from "./FrontendDTO"
import { ProbeTimings } from "./Probes"

export interface BackendEnvVariableDTO {
    name: string
    secret?: boolean
    description?: string
    /**
     * What the deploy hands the container in every environment, never empty. Left out (or null), the value stored under the
     * same name stays, unless the variable stops being secret; a variable left with no value is refused: remove it instead.
     */
    value?: string | null
    /** What the API answers for a secret variable in place of its value: ignored when sent back */
    valueSet?: boolean
}

export interface EnvironmentResourcesDTO {
    environmentId: string
    cpuRequest?: string | null
    cpuLimit?: string | null
    memoryRequest?: string | null
    memoryLimit?: string | null
    replicas?: number | null
}

export interface EnvironmentVersionDTO {
    environmentId: string
    version?: string | null
}

/** The probe timings are in seconds, null to inherit the template of the project, else the default of the chart (30) */
interface BackendDTO extends ProbeTimings {
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
    /** Blank or null inherits the backend template of the project (its frontend one for a DOCKER), else /health/live */
    livenessPath?: string | null
    /** As the liveness path, else /health/ready */
    readinessPath?: string | null
    /** trace, debug, info, warn, error or fatal: its LOG_LEVEL in every environment; null for the level of each environment */
    logLevel?: string | null
    /** The UI of the public API documentation; blank or null when the backend has none */
    docsPath?: string | null
    /** The OpenAPI spec; blank or null when the backend has none */
    openApiPath?: string | null
    /** The path on the host of every environment, e.g. /api/orders; blank or null when it is not exposed. Always null for a backend on a schedule */
    exposurePath?: string | null
    /**
     * A cron expression, e.g. 0 3 * * *: the backend runs as a Kubernetes CronJob, a container that starts on it, does its work
     * and exits, with no port, probes, Service nor route. Blank or null: always on, as a Deployment
     */
    schedule?: string | null
    /** The IANA time zone of the schedule, e.g. Europe/Rome; blank or null for the one of the cluster */
    timeZone?: string | null
    /** Kubernetes quantities, e.g. 250m or 0.5; blank or null for the default of the chart */
    cpuRequest?: string | null
    cpuLimit?: string | null
    /** Kubernetes quantities, e.g. 128Mi or 1Gi; blank or null for the default of the chart */
    memoryRequest?: string | null
    memoryLimit?: string | null
    /** The pods it runs, from 0 (none, and no route) to MAX_REPLICAS; null for the default of the chart (1) */
    replicas?: number | null
    /**
     * The environments that run it with CPU, memory or replicas of their own, replaced as a whole: each value left blank is the
     * one above. An environment appears once at most, and must be of the project
     */
    environmentResources?: EnvironmentResourcesDTO[] | null
    /**
     * The version each environment runs, replaced as a whole: an environment with none does not get it, whatever the
     * version above. An environment appears once at most, and must be of the project
     */
    environmentVersions?: EnvironmentVersionDTO[] | null
    /**
     * The environments where it is deployed continuously, replaced as a whole: each deploy there pulls its image again and
     * rolls its pods out, even with the same tag. Each must be of the project
     */
    continuousDeploymentEnvironmentIds?: string[] | null
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
