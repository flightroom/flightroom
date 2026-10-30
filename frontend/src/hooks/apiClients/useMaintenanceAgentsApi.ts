import { useTranslation } from "react-i18next"
import useApiClient, { errorCodeOf, IClientRequestMetadataExtended } from "../useApiClient"
import type { BackendCodeRepository, BackendEnvVariable, BuiltBackend, EnvironmentResources, EnvironmentVersion } from "./useBackendsApi"
import useGitOpsErrorMessage from "./useGitOpsErrorMessage"

/** An always-on container, called on its run path when it runs, or a Docker job that runs and exits. */
export type MaintenanceAgentKind = "container" | "job"

export interface MaintenanceAgentLastRun {
    at: string
    environmentId: string
    ok: boolean
    error?: string
}

/**
 * An agent that keeps backends and frontends of the project in shape: built and deployed like a backend,
 * run on a schedule or when someone asks for it.
 */
export interface MaintenanceAgent {
    _id: string
    projectId: string
    /** The functional domain it belongs to; null or missing when it is in none */
    domainId?: string | null
    slug: string
    name: string
    description?: string
    /** Markdown for the AI agents working on this agent's code */
    context?: string
    /** Market slug of the backend template it was scaffolded from */
    template?: string
    stack?: { runtime?: string; framework?: string; source: string }
    version?: string
    codeRepository?: BackendCodeRepository
    image?: { repository?: string }
    kind: MaintenanceAgentKind
    /** Cron in five fields or an @macro; without one it runs only when started by hand */
    schedule?: string | null
    /** IANA time zone the schedule is read in; the cluster's when missing */
    timeZone?: string | null
    /** A container only: the endpoint POSTed to when the agent runs */
    runPath?: string
    port?: number
    livenessPath?: string
    readinessPath?: string
    /** Kubernetes quantities; blank or null for the default of the chart. A job's CronJob runs with them too */
    cpuRequest?: string | null
    cpuLimit?: string | null
    memoryRequest?: string | null
    memoryLimit?: string | null
    /** As for a backend: the environments that run it with CPU and memory of their own */
    environmentResources?: EnvironmentResources[] | null
    /** As for a backend: the version each environment runs */
    environmentVersions?: EnvironmentVersion[] | null
    env: BackendEnvVariable[]
    configMapIds: string[]
    secretIds: string[]
    resourceIds: string[]
    /** The backends it maintains */
    backendIds: string[]
    /** The frontends it maintains */
    frontendIds: string[]
    lastRun?: MaintenanceAgentLastRun
    createdAt: string
    updatedAt: string
}

export interface MaintenanceRun {
    _id: string
    agentId: string
    environmentId: string
    trigger: "manual"
    /** Failed when Argo CD refused to start it; the outcome of the run itself is in the agent's logs */
    status: "started" | "failed"
    error?: string
    userId?: string
    createdAt: string
}

export type MaintenanceAgentDTO = Omit<MaintenanceAgent, "_id" | "projectId" | "stack" | "lastRun" | "createdAt" | "updatedAt">

/** The codes the maintenance agents are refused with, by translation key */
const MAINTENANCE_ERROR_KEYS: Record<string, string> = {
    MAINTENANCE_AGENT_SLUG_TAKEN: "maintenance.errors.slug_taken",
    MAINTENANCE_AGENT_SLUG_INVALID: "maintenance.errors.slug_invalid",
    MAINTENANCE_AGENT_SCHEDULE_INVALID: "maintenance.errors.schedule_invalid",
    MAINTENANCE_AGENT_TIMEZONE_INVALID: "maintenance.errors.timezone_invalid",
    MAINTENANCE_AGENT_INVALID: "maintenance.errors.invalid",
    MAINTENANCE_AGENT_TARGET_INVALID: "maintenance.errors.target_invalid",
    MAINTENANCE_AGENT_NOT_DEPLOYED: "maintenance.errors.not_deployed",
    MAINTENANCE_AGENT_RUN_FORBIDDEN: "maintenance.errors.run_forbidden",
    MAINTENANCE_AGENT_TOKEN_FORBIDDEN: "maintenance.errors.token_forbidden",
    ARGOCD_NOT_CONFIGURED: "maintenance.errors.argocd_not_configured",
    // Same refusals as a backend build
    BACKEND_BUILD_FORBIDDEN: "backends.build.forbidden",
    BUILD_REF_NOT_FOUND: "backends.build.ref_not_found",
    BUILD_REPOSITORY_NOT_FOUND: "backends.build.repository_not_found"
}

/** Said in the user's language from the code, the other Argo CD refusals as the settings say them, anything else as the backend tells it */
export const useMaintenanceErrorMessage = () => {
    const { t } = useTranslation()
    const gitOpsErrorMessage = useGitOpsErrorMessage()

    return (error: Error): string | undefined => {
        const key = MAINTENANCE_ERROR_KEYS[errorCodeOf(error) ?? ""]
        return key ? t(key) : gitOpsErrorMessage(error)
    }
}

const useMaintenanceAgentsApi = () => {
    const apiClient = useApiClient()
    const customErrorMessage = useMaintenanceErrorMessage()

    const getAll = async (): Promise<MaintenanceAgent[]> => {
        const response = await apiClient.doRequest<MaintenanceAgent[]>({ url: "/api/maintenance-agents" })
        return response.data
    }

    const getSingle = async (id: string): Promise<MaintenanceAgent> => {
        const response = await apiClient.doRequest<MaintenanceAgent>({ url: `/api/maintenance-agents/${id}` })
        return response.data
    }

    const getVersions = async (id: string): Promise<BuiltBackend[]> => {
        const response = await apiClient.doRequest<BuiltBackend[]>({ url: `/api/maintenance-agents/${id}/versions` })
        return response.data
    }

    /** The last runs, newest first */
    const getRuns = async (id: string): Promise<MaintenanceRun[]> => {
        const response = await apiClient.doRequest<MaintenanceRun[]>({ url: `/api/maintenance-agents/${id}/runs` })
        return response.data
    }

    const create = async (agent: Partial<MaintenanceAgentDTO>, metadata?: IClientRequestMetadataExtended): Promise<MaintenanceAgent> => {
        const response = await apiClient.doRequest<MaintenanceAgent>({ url: "/api/maintenance-agents", method: "POST", data: agent, customErrorMessage, ...metadata })
        return response.data
    }

    /** The slug is left as it was: the backend never changes it */
    const update = async (id: string, agent: Partial<MaintenanceAgentDTO>, metadata?: IClientRequestMetadataExtended): Promise<MaintenanceAgent> => {
        const response = await apiClient.doRequest<MaintenanceAgent>({ url: `/api/maintenance-agents/${id}`, method: "PUT", data: agent, customErrorMessage, ...metadata })
        return response.data
    }

    const deleteSingle = async (id: string) => {
        const response = await apiClient.doRequest({ url: `/api/maintenance-agents/${id}`, method: "DELETE", customErrorMessage })
        return response.data
    }

    const build = async (id: string, version: string, branch?: string) => {
        const response = await apiClient.doRequest({ url: `/api/maintenance-agents/${id}/build`, method: "POST", data: { version, branch }, customErrorMessage })
        return response.data
    }

    /** Starts it now in one environment: a run refused by Argo CD comes back failed, with its error */
    const run = async (id: string, environmentId: string): Promise<MaintenanceRun> => {
        const response = await apiClient.doRequest<MaintenanceRun>({ url: `/api/maintenance-agents/${id}/run`, method: "POST", data: { environmentId }, customErrorMessage })
        return response.data
    }

    /** Revokes the tokens its container reads logs and builds with, in every environment: the next deploys mint new ones */
    const revokeTokens = async (id: string): Promise<{ revoked: number }> => {
        const response = await apiClient.doRequest<{ revoked: number }>({ url: `/api/maintenance-agents/${id}/revoke-tokens`, method: "POST", data: {}, customErrorMessage })
        return response.data
    }

    return { getAll, getSingle, getVersions, getRuns, create, update, deleteSingle, build, run, revokeTokens }
}

export default useMaintenanceAgentsApi
