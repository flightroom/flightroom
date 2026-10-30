import type { EventMessage, PublicClientApplication } from "@azure/msal-browser"
import { MsalProvider } from "@azure/msal-react"
import React, { useEffect, useState } from "react"
import { useGlobalParameters } from "@/contexts/GlobalParameterProvider"
import { AzureProviderConfig } from "@/types/ConfigResponseDTO"
import AuthProviderLoadError from "./components/AuthProviderLoadError"

interface MicrosoftAuthWrapperProps {
    children: React.ReactNode
}

const MicrosoftAuthWrapper: React.FC<MicrosoftAuthWrapperProps> = ({ children }) => {
    const parameters = useGlobalParameters()
    const azureParameters = parameters.getParameter("providers.azure") as unknown as AzureProviderConfig
    const [msalInstance, setMsalInstance] = useState<PublicClientApplication | null>(null)
    const [isInitialized, setIsInitialized] = useState(false)
    const [loadFailed, setLoadFailed] = useState(false)

    useEffect(() => {
        if (!azureParameters?.clientId || !azureParameters?.tenantId) {
            return
        }

        let cancelled = false
        let instance: PublicClientApplication | undefined
        let callbackId: string | null = null

        const createInstance = async () => {
            // MSAL is downloaded only where Microsoft login is configured: it is the heaviest of the login SDKs
            const { EventType, PublicClientApplication } = await import("./msalBrowser")
            if (cancelled) return

            instance = new PublicClientApplication({
                auth: {
                    clientId: azureParameters.clientId,
                    authority: `https://login.microsoftonline.com/${azureParameters.tenantId}`,
                    redirectUri: window.location.origin
                },
                cache: {
                    cacheLocation: "localStorage"
                }
            })

            const eventCallback = (event: EventMessage) => {
                console.log("MSAL Event:", event.eventType)

                if (event.eventType === EventType.INITIALIZE_END) {
                    console.log("MSAL initialization complete")
                    setIsInitialized(true)
                }
            }

            callbackId = instance.addEventCallback(eventCallback)
            setMsalInstance(instance)

            // Inizializza MSAL
            try {
                await instance.initialize()
                console.log("MSAL initialize completed")
            } catch (error) {
                console.error("MSAL initialize failed:", error)
            }
        }

        createInstance().catch(error => {
            console.error("MSAL could not be loaded:", error)
            if (!cancelled) setLoadFailed(true)
        })

        // Cleanup
        return () => {
            cancelled = true
            if (instance && callbackId) {
                instance.removeEventCallback(callbackId)
            }
        }
    }, [azureParameters?.clientId, azureParameters?.tenantId])

    if (!azureParameters?.clientId || !azureParameters?.tenantId) {
        return <>{children}</>
    }

    if (loadFailed) {
        return <AuthProviderLoadError provider="Microsoft" />
    }

    if (!msalInstance || !isInitialized) {
        return <></>
    }

    return <MsalProvider instance={msalInstance}>{children}</MsalProvider>
}

export default MicrosoftAuthWrapper
