export default interface ConfigResponseDTO {
    frontendUrl: string
    canSendEmail: boolean
    canRegister: boolean
    allowEmbeddedLogin: boolean
    marketingOptInEnabled: boolean
    /** The name and the logo of the installation, when set: the console shows Flightroom's otherwise */
    branding: {
        name?: string
        logoUrl?: string
    }
    /** The remote MCP server: whether it is on, and the URL to give to MCP clients. */
    mcp: {
        enabled: boolean
        url: string
    }
    /** The operator's Application Insights, when set: the browser sends it page views and errors. Ingestion only, public by design */
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
    providers: {
        auth0?: {
            domain: string
            clientId: string
            apiAudience: string
            scope: string
        }
        azure?: {
            tenantId: string
            clientId: string
            redirectUri: string
            authority: string
            scopes: string
            apiAudience: string
        }
        google?: {
            clientId: string
            redirectUri: string
            authScope: string
            hostedDomain: string
            apiAudience: string
        }
    }
}
