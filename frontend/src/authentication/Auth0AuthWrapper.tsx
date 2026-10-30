import { Spinner } from "@flightroom/design-system"
import { lazy, Suspense, useMemo } from "react"
import { useGlobalParameters } from "@/contexts/GlobalParameterProvider"
import { Auth0ProviderConfig } from "@/types/ConfigResponseDTO"
import AuthProviderLoadError from "./components/AuthProviderLoadError"

const Auth0LoadError = () => <AuthProviderLoadError provider="Auth0" />

// A chunk that fails to load (a release removed it, the network dropped) leaves a way out instead of a blank app.
// Caught here rather than by an ErrorBoundary: around the provider, a boundary would also catch every render error of the app beneath it.
const Auth0SdkProvider = lazy(() =>
    import("./Auth0SdkProvider").catch(error => {
        console.error("Auth0 could not be loaded:", error)
        return { default: Auth0LoadError }
    })
)

interface Auth0AuthWrapperProps {
    children: React.ReactNode
}

const Auth0AuthWrapper = ({ children }: Auth0AuthWrapperProps) => {
    const parameters = useGlobalParameters()
    const auth0Config = useMemo(() => {
        const config = parameters.getParameter("providers.auth0")
        return config as unknown as Auth0ProviderConfig | undefined
    }, [parameters])

    if (!auth0Config || !auth0Config.domain || !auth0Config.clientId) {
        return <>{children}</>
    }

    return (
        <Suspense fallback={<Spinner />}>
            <Auth0SdkProvider config={auth0Config}>{children}</Auth0SdkProvider>
        </Suspense>
    )
}

export default Auth0AuthWrapper
