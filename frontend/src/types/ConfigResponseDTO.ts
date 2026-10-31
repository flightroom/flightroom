export interface Auth0ProviderConfig {
    domain: string
    clientId: string
    apiAudience: string
}

export interface AzureProviderConfig {
    tenantId: string
    clientId: string
    redirectUri: string
    authority: string
    scopes: string
    apiAudience: string
}

export interface GoogleProviderConfig {
    clientId: string
    redirectUri: string
    authScope: string
    hostedDomain: string
    apiAudience: string
}

export interface AuthProvidersConfig {
    auth0?: Auth0ProviderConfig
    azure?: AzureProviderConfig
    google?: GoogleProviderConfig
}

/** How hard the model reasons before answering, lowest first. */
export const LLM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type LlmEffort = (typeof LLM_EFFORTS)[number]

export default interface GlobalConfigDTO {
    frontendUrl: string
    registrationAllowed: boolean
    canSendEmail: boolean
    marketingOptInEnabled: boolean
    /** Nome e logo dell'installazione, se impostati */
    branding?: {
        name?: string
        logoUrl?: string
    }
    providers: AuthProvidersConfig
    mcp: {
        enabled: boolean
        url: string
    }
    /** L'Application Insights dell'operatore, se impostato: il browser gli manda pagine viste ed errori */
    applicationInsights?: {
        connectionString: string
    }
    codeRepository?: {
        github?: {
            clientId: string
        }
        azure?: {
            clientId: string
        }
    }
}
