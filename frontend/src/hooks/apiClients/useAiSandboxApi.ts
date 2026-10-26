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

const useAiSandboxApi = () => {
    const apiClient = useApiClient()

    // Silent: the card says it could not load in place
    const getStatus = async (organizationId: string): Promise<AiSandboxStatusSummary> => {
        const response = await apiClient.doRequest<AiSandboxStatusSummary>({ url: `/api/organizations/${organizationId}/ai-sandbox`, silent: true })
        return response.data
    }

    return { getStatus }
}

export default useAiSandboxApi
