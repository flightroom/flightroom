import { useTranslation } from "react-i18next"
import { AuthenticationType } from "@/api/apiClient"
import useApiClient, { errorCodeOf } from "@/hooks/useApiClient"
import type { AiCurrency } from "./useAiModelsApi"

export interface ProjectUser {
    _id: string
    email: string
    name?: string
    surname?: string
    role: string
    /** Domains the member is limited to: empty with `domainScoped` false means the whole project */
    domainIds?: string[]
    /** Whether the member is limited to domains at all: true with no domain left means they reach none */
    domainScoped: boolean
    status?: string
    invitationPending?: boolean
    invitationExpiresAt?: string
    /** The AI tokens the member may spend in the project each month: none without a limit */
    aiTokenLimit?: number
    /** What the member spent this month: only for whoever manages the members, and for the member themselves */
    aiTokensSpent?: number
    /** What those tokens cost this month, one amount per currency: only the AIs given their prices count */
    aiCostsSpent?: { amount: number; currency: AiCurrency }[]
    createdAt: string
    updatedAt: string
}

export interface UpdateProjectUserDTO {
    role: string
    /** Empty means the whole project; left out, the stored scope stays as it is */
    domainIds?: string[]
    /** Null takes the limit away; left out, the stored one stays */
    aiTokenLimit?: number | null
}

/** The codes the backend raises about domain-scoped membership, and the AI token limit, by translation key */
const DOMAIN_SCOPE_ERROR_KEYS: Record<string, string> = {
    DOMAIN_SCOPE_FORBIDDEN: "project_users.errors.domain_scope_forbidden",
    INVALID_DOMAIN: "project_users.errors.invalid_domain",
    DOMAIN_SCOPE_NOT_FOR_OWNER: "project_users.errors.domain_scope_not_for_owner",
    INVALID_AI_TOKEN_LIMIT: "project_users.errors.invalid_ai_token_limit"
}

/** The translated message of a domain scope error, undefined for any other so the generic one is shown */
export const domainScopeErrorMessage = (t: (key: string) => string, error: Error): string | undefined => {
    const key = DOMAIN_SCOPE_ERROR_KEYS[errorCodeOf(error) ?? ""]
    return key ? t(key) : undefined
}

const useProjectUserApi = () => {
    const apiClient = useApiClient()
    const { t } = useTranslation()

    const getProjectUsers = async (projectId: string): Promise<ProjectUser[]> => {
        const response = await apiClient.doRequest<ProjectUser[]>({
            url: `/api/projects/${projectId}/users`,
            method: "GET",
            authenticated: AuthenticationType.REQUIRED
        })
        return response.data
    }

    const removeUserFromProject = async (projectId: string, userId: string): Promise<void> => {
        await apiClient.doRequest({
            url: `/api/projects/${projectId}/users/${userId}`,
            method: "DELETE",
            authenticated: AuthenticationType.REQUIRED
        })
    }

    const resendInvitation = async (projectId: string, userId: string): Promise<void> => {
        await apiClient.doRequest({
            url: `/api/projects/${projectId}/users/${userId}/resend-invitation`,
            method: "POST",
            authenticated: AuthenticationType.REQUIRED
        })
    }

    const updateProjectUser = async (projectId: string, userId: string, dto: UpdateProjectUserDTO): Promise<void> => {
        await apiClient.doRequest({
            url: `/api/projects/${projectId}/users/${userId}`,
            method: "PUT",
            data: dto,
            authenticated: AuthenticationType.REQUIRED,
            customErrorMessage: error => domainScopeErrorMessage(t, error)
        })
    }

    return {
        getProjectUsers,
        updateProjectUser,
        removeUserFromProject,
        resendInvitation
    }
}

export default useProjectUserApi
