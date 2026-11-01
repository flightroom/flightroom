import { useQuery } from "@tanstack/react-query"
import useApiClient from "../useApiClient"

/** The gateway answers healthy, answers degraded, does not answer or answers unhealthy, or is not configured at all. */
export type AiSandboxStatus = "online" | "degraded" | "offline" | "notConfigured"

export interface AiSandboxStatusSummary {
    status: AiSandboxStatus
    /** What the gateway reports, when it answers */
    version?: string
    checkedAt: string
}

export const AI_SANDBOX_QUERY_KEY = "ai-sandbox"

/** The server asks the gateway at most every 30 seconds: polling faster would only read the same answer */
const REFRESH_MS = 60_000

const useAiSandboxApi = () => {
    const apiClient = useApiClient()

    // Silent: the card says it could not load in place
    const getStatus = async (organizationId: string): Promise<AiSandboxStatusSummary> => {
        const response = await apiClient.doRequest<AiSandboxStatusSummary>({ url: `/api/organizations/${organizationId}/ai-sandbox`, silent: true })
        return response.data
    }

    return { getStatus }
}

/** The status of the gateway of an organization, one answer shared by every screen that asks */
export const useAiSandboxStatusQuery = (organizationId?: string) => {
    const { getStatus } = useAiSandboxApi()
    return useQuery({ queryKey: [AI_SANDBOX_QUERY_KEY, organizationId], queryFn: () => getStatus(organizationId!), enabled: !!organizationId, refetchInterval: REFRESH_MS })
}

export default useAiSandboxApi
