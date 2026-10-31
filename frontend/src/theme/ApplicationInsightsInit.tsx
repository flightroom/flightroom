import { useEffect } from "react"
import { useGlobalParameters } from "@/contexts/GlobalParameterProvider"

/** Il ruolo della console nell'Application Map, distinto da quello del backend ("flightroom") */
const CLOUD_ROLE = "flightroom-console"

/**
 * Application Insights nel browser, solo se l'operatore ha impostato APPLICATIONINSIGHTS_CONNECTION_STRING: senza,
 * l'SDK non viene nemmeno scaricato. Niente cookie (nessun consenso da chiedere) e nessun dato dell'utente: pagine
 * viste, errori, tempi delle chiamate, correlati con il backend dall'header traceparent sulla stessa origine.
 */
const ApplicationInsightsInit: React.FC = () => {
    const { getParameter } = useGlobalParameters()
    const connectionString = getParameter("applicationInsights.connectionString") as string | undefined

    useEffect(() => {
        if (!connectionString) return
        let unload: (() => void) | undefined
        import("@microsoft/applicationinsights-web")
            .then(({ ApplicationInsights, DistributedTracingModes }) => {
                const insights = new ApplicationInsights({
                    config: {
                        connectionString,
                        enableAutoRouteTracking: true,
                        disableCookiesUsage: true,
                        distributedTracingMode: DistributedTracingModes.AI_AND_W3C
                    }
                })
                insights.loadAppInsights()
                insights.addTelemetryInitializer(item => {
                    item.tags = { ...item.tags, "ai.cloud.role": CLOUD_ROLE }
                })
                insights.trackPageView()
                unload = () => insights.unload()
            })
            .catch(error => console.error("Application Insights could not be loaded:", error))
        return () => unload?.()
    }, [connectionString])

    return null
}

export default ApplicationInsightsInit
