/**
 * I provider di telemetria che un progetto puo' scegliere, con i campi di ciascuno: lo specchio di TELEMETRY_CATALOG del
 * backend, che resta l'arbitro. Etichette e suggerimenti stanno nelle traduzioni, sotto settings.telemetry.
 */

export type TelemetryProvider = "openTelemetry" | "applicationInsights" | "awsCloudWatch" | "googleCloud" | "datadog"

export interface TelemetryFieldSpec {
    name: string
    /** La variabile che ricevono i container */
    variable: string
    /** Non torna mai indietro: lasciato vuoto conserva quello salvato */
    secret: boolean
    required: boolean
    /** Stessa regola del backend */
    pattern?: RegExp
    example?: string
}

const URL = /^https?:\/\/[^\s/?#]+(:\d+)?(\/[^\s?#]*)?$/

export const TELEMETRY_PROVIDERS: Record<TelemetryProvider, TelemetryFieldSpec[]> = {
    openTelemetry: [
        { name: "endpoint", variable: "OTEL_EXPORTER_OTLP_ENDPOINT", secret: false, required: false, pattern: URL, example: "https://otlp.example.com:4318" },
        { name: "headers", variable: "OTEL_EXPORTER_OTLP_HEADERS", secret: true, required: false, pattern: /^[^=,\s]+=[^,]*(,[^=,\s]+=[^,]*)*$/, example: "api-key=..." }
    ],
    applicationInsights: [
        {
            name: "connectionString",
            variable: "APPLICATIONINSIGHTS_CONNECTION_STRING",
            secret: true,
            required: true,
            pattern: /(^|;)\s*InstrumentationKey=[^;]+/i,
            example: "InstrumentationKey=...;IngestionEndpoint=https://..."
        }
    ],
    awsCloudWatch: [
        { name: "region", variable: "AWS_REGION", secret: false, required: true, pattern: /^[a-z]{2}(-[a-z]+)+-\d+$/, example: "eu-west-1" },
        { name: "endpoint", variable: "OTEL_EXPORTER_OTLP_ENDPOINT", secret: false, required: true, pattern: URL, example: "http://cloudwatch-agent.amazon-cloudwatch:4316" }
    ],
    googleCloud: [{ name: "projectId", variable: "GOOGLE_CLOUD_PROJECT", secret: false, required: true, pattern: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, example: "acme-prod" }],
    datadog: [
        { name: "agentHost", variable: "DD_AGENT_HOST", secret: false, required: true, pattern: /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/, example: "datadog-agent.datadog.svc.cluster.local" }
    ]
}

export const TELEMETRY_PROVIDER_IDS = Object.keys(TELEMETRY_PROVIDERS) as TelemetryProvider[]
