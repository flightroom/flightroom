import { Spinner } from "@flightroom/design-system"
import { lazy, Suspense, useMemo } from "react"
import { useGlobalParameters } from "@/contexts/GlobalParameterProvider"
import { Auth0ProviderConfig } from "@/types/ConfigResponseDTO"

const Auth0SdkProvider = lazy(() => import("./Auth0SdkProvider"))

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
