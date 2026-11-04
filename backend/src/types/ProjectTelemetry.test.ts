import { describe, expect, it } from "vitest"
import { describeTelemetry, isTelemetryValue, TELEMETRY_CATALOG, TELEMETRY_PROVIDERS, TELEMETRY_SECRET_PATHS, telemetryProviderOf, telemetryVariablesOf, telemetryView } from "./ProjectTelemetry"

const connectionString = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/"
const applicationInsights = { provider: "applicationInsights", settings: { applicationInsights: { connectionString } } } as const

describe("ProjectTelemetry", () => {
    it.each([
        ["nothing", undefined, "openTelemetry"],
        ["a connection string with no provider picked", { settings: { applicationInsights: { connectionString } } }, "openTelemetry"],
        ["Application Insights picked with no connection string", { provider: "applicationInsights" }, "openTelemetry"],
        ["Application Insights picked with its connection string", applicationInsights, "applicationInsights"],
        ["Datadog picked with its Agent", { provider: "datadog", settings: { datadog: { agentHost: "dd-agent" } } }, "datadog"]
    ] as const)("Given %s, when the provider is read, then it is %s", (_case, telemetry, provider) => {
        expect(telemetryProviderOf(telemetry)).toBe(provider)
    })

    it("Given environments switched on, when the variables of each are read, then only theirs get them, and every one when none is picked", () => {
        expect(telemetryVariablesOf({ ...applicationInsights, environmentIds: ["prod"] }, "prod")).toEqual({ APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString })
        expect(telemetryVariablesOf({ ...applicationInsights, environmentIds: ["prod"] }, "dev")).toBeUndefined()
        expect(telemetryVariablesOf(applicationInsights, "dev")).toEqual({ APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString })
    })

    it("Given each provider configured, when its variables are read, then the fixed ones come along, and plain OpenTelemetry with nothing set hands none", () => {
        expect(telemetryVariablesOf({ provider: "awsCloudWatch", settings: { awsCloudWatch: { region: "eu-west-1", endpoint: "http://agent:4316" } } }, "dev")).toEqual({
            AWS_REGION: "eu-west-1",
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://agent:4316",
            OTEL_PROPAGATORS: "tracecontext,baggage,xray"
        })
        expect(telemetryVariablesOf({ provider: "googleCloud", settings: { googleCloud: { projectId: "acme-prod" } } }, "dev")).toEqual({ GOOGLE_CLOUD_PROJECT: "acme-prod" })
        expect(telemetryVariablesOf({ provider: "openTelemetry", settings: { openTelemetry: { endpoint: "https://otlp.example.com" } } }, "dev")).toEqual({
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example.com"
        })
        expect(telemetryVariablesOf({ provider: "openTelemetry" }, "dev")).toBeUndefined()
    })

    it("Given values set, when the view is read, then a secret field comes out as set only and a plain one with its value", () => {
        expect(telemetryView({ provider: "datadog", settings: { applicationInsights: { connectionString }, datadog: { agentHost: "dd-agent" } }, environmentIds: ["prod"] })).toEqual({
            provider: "datadog",
            settings: { applicationInsights: { connectionString: { set: true } }, datadog: { agentHost: { set: true, value: "dd-agent" } } },
            environmentIds: ["prod"]
        })
        expect(telemetryView(undefined)).toEqual({ provider: "openTelemetry", settings: {} })
    })

    it("Given the catalog, when its secret paths are read, then the connection string and the OTLP headers are encrypted", () => {
        expect(TELEMETRY_SECRET_PATHS).toEqual(["telemetry.settings.openTelemetry.headers", "telemetry.settings.applicationInsights.connectionString"])
    })

    it("Given a field, when a value is checked, then its pattern and a single line are required", () => {
        const [connection] = TELEMETRY_CATALOG.applicationInsights.fields
        expect(isTelemetryValue(connection, connectionString)).toBe(true)
        expect(isTelemetryValue(connection, "IngestionEndpoint=https://example.com/")).toBe(false)
        expect(isTelemetryValue(TELEMETRY_CATALOG.datadog.fields[0], "dd-agent\nx")).toBe(false)
    })

    it.each(TELEMETRY_PROVIDERS)("Given %s, when it is described, then the agent gets its instructions", provider => {
        // Every field filled with its example: without the required ones the provider is not in effect
        const values = Object.fromEntries(TELEMETRY_CATALOG[provider].fields.map(field => [field.name, field.example ?? "x"]))
        const description = describeTelemetry({ provider, settings: { [provider]: values } })
        expect(description).toContain(`with the provider ${provider}.`)
        expect(description).toContain(TELEMETRY_CATALOG[provider].instructions[0])
    })

    it("Given environments switched on, when the telemetry is described, then the variables and where they arrive are said, never the values", () => {
        const description = describeTelemetry(applicationInsights, [])
        expect(description).toContain("APPLICATIONINSIGHTS_CONNECTION_STRING in the environments (none at the moment) only")
        expect(description).not.toContain(connectionString)
    })
})
