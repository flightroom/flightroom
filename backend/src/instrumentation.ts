import dotenv from "dotenv"

/**
 * Azure Monitor Application Insights for the console itself, off unless the operator sets
 * APPLICATIONINSIGHTS_CONNECTION_STRING: the telemetry then goes to the operator's own resource, never to us
 * (docs/APPLICATION-INSIGHTS.md). Imported first by index.ts: OpenTelemetry instruments http, Fastify and MongoDB
 * only when it is set up before they are loaded, so the .env file is read here already.
 */
dotenv.config()

if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim()) {
    // The cloud role of the console in the Application Map, unless the operator names it
    process.env.OTEL_SERVICE_NAME ||= "flightroom"
    // Required only here, and synchronously: off, the SDK is never loaded; on, it is set up before the next import
    // biome-ignore lint/style/noCommonJs: an import() would resolve after index.ts has loaded the modules to instrument
    const { useAzureMonitor } = require("@azure/monitor-opentelemetry") as typeof import("@azure/monitor-opentelemetry")
    useAzureMonitor()
}
