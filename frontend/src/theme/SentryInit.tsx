import * as Sentry from "@sentry/react"
import { useEffect } from "react"

const SentryInit: React.FC<React.PropsWithChildren> = ({ children }) => {
    useEffect(() => {
        if (!window?.globalConfiguration?.SENTRY_DSN) {
            console.log("Sentry DSN not found")
            return
        }

        if (Sentry.isInitialized()) return

        Sentry.init({
            dsn: window?.globalConfiguration?.SENTRY_DSN,
            // User info, IP address included, is collected by default (`dataCollection`)
            enabled: true,
            release: window?.globalConfiguration?.VERSION,
            environment: window?.globalConfiguration?.ENVIRONMENT,
            // Replay and feedback are added below, once their chunk is in: the sample rates set here apply to them all the same
            integrations: [Sentry.browserTracingIntegration()],
            tracePropagationTargets: ["localhost", /^https:\/\/console\.mfe-orchestrator\.dev\/api/],
            tracesSampleRate: 0.1,
            replaysSessionSampleRate: 0.1, // This sets the sample rate at 10%. You may want to change it to 100% while in development and then sample at a lower rate in production.
            replaysOnErrorSampleRate: 0.5 // If you're not already sampling the entire session, change the sample rate to 100% when sampling sessions where errors occur.
        })

        import("./sentryLazyIntegrations")
            .then(({ feedbackIntegration, replayIntegration }) => {
                Sentry.addIntegration(
                    feedbackIntegration({
                        colorScheme: "system",
                        triggerLabel: ""
                    })
                )
                Sentry.addIntegration(replayIntegration())
            })
            .catch(error => console.error("Sentry replay and feedback could not be loaded:", error))

        console.log("Sentry initialized")
    }, [])

    return <>{children}</>
}

export default SentryInit
