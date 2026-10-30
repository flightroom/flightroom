import { Auth0ContextInterface, Auth0Provider } from "@auth0/auth0-react"
import { Auth0ProviderConfig } from "@/types/ConfigResponseDTO"
import { Auth0Context } from "./auth0Context"

interface Auth0SdkProviderProps {
    config: Auth0ProviderConfig
    children: React.ReactNode
}

/** The Auth0 SDK, on a chunk of its own: Auth0AuthWrapper loads it only where Auth0 login is configured. */
const Auth0SdkProvider = ({ config, children }: Auth0SdkProviderProps) => (
    <Auth0Provider
        domain={config.domain}
        clientId={config.clientId}
        authorizationParams={{
            redirect_uri: window.location.origin,
            audience: config.apiAudience
        }}
        cacheLocation="localstorage"
        useRefreshTokens={true}
        // The provider fills the whole interface; the app reads only the Auth0State part of it
        context={Auth0Context as unknown as React.Context<Auth0ContextInterface>}
    >
        <>{children}</>
    </Auth0Provider>
)

export default Auth0SdkProvider
