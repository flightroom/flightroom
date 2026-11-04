/**
 * Where the applications of a project send their telemetry, as the team picked it from a catalog of providers, the way
 * a resource is picked from its own. Each provider names the fields the team fills, the variables they reach the
 * containers as and how an AI agent instruments the code. On every deploy the containers of the environments switched on
 * get the variables of the provider picked, through the platform's Secret `telemetry.flightroom`; the agents instrument
 * the applications as its instructions say. Unset, the project is on plain OpenTelemetry with nothing delivered.
 */

export type TelemetryProvider = "openTelemetry" | "applicationInsights" | "awsCloudWatch" | "googleCloud" | "datadog"

export interface TelemetryFieldSpec {
    name: string
    /** The variable the containers get it as */
    variable: string
    /** Encrypted at rest, never sent back once written */
    secret: boolean
    /** Needed for the provider to be picked */
    required: boolean
    /** What a value has to match, past being one line of at most {@link MAX_TELEMETRY_VALUE_LENGTH} characters */
    pattern?: RegExp
    /** What the console shows in the empty field */
    example?: string
}

export interface TelemetryProviderSpec {
    fields: TelemetryFieldSpec[]
    /** Variables the provider always sets, along with its fields */
    fixed?: Record<string, string>
    /** How an agent instruments a backend or a DOCKER frontend */
    instructions: string[]
}

export const MAX_TELEMETRY_VALUE_LENGTH = 2_000

const URL = /^https?:\/\/[^\s/?#]+(:\d+)?(\/[^\s?#]*)?$/
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/

const ENABLE_ONLY_WHEN = (variable: string) =>
    `Enable it only when ${variable} is set, and start normally without it (e.g. on a developer's machine); never hardcode a value, never put one in a file, never log one.`

const ADD_WHEN_MISSING =
    "Every backend and DOCKER frontend must send traces, metrics and logs this way, with the auto-instrumentations of its HTTP server, HTTP clients and database drivers: when one you work on does not yet, add it as part of the change and say so in the summary. One that already sends telemetry elsewhere is left as it is unless the request asks."

const SERVICE_IDENTITY =
    "The service name, environment and version come from OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES (deployment.environment, service.version), and the environment slug from ENVIRONMENT, which every deploy sets on every container: never hardcode them."

const STATIC_FRONTENDS = "A static frontend runs in the browser and gets no container variables: add browser telemetry only when the request asks for it."

export const TELEMETRY_CATALOG: Record<TelemetryProvider, TelemetryProviderSpec> = {
    /** Vendor-neutral: any backend speaking OTLP, a collector, Grafana, Honeycomb, Elastic, New Relic... */
    openTelemetry: {
        fields: [
            { name: "endpoint", variable: "OTEL_EXPORTER_OTLP_ENDPOINT", secret: false, required: false, pattern: URL, example: "https://otlp.example.com:4318" },
            // Where the API keys of most OTLP backends go
            { name: "headers", variable: "OTEL_EXPORTER_OTLP_HEADERS", secret: true, required: false, pattern: /^[^=,\s]+=[^,]*(,[^=,\s]+=[^,]*)*$/, example: "api-key=..." }
        ],
        instructions: [
            "Instrument with the OpenTelemetry SDK of the stack and the OTLP exporter, configured only from the standard OTEL_* variables (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, OTEL_EXPORTER_OTLP_PROTOCOL...).",
            "When OTEL_EXPORTER_OTLP_ENDPOINT is not set, export nothing and start normally. Never hardcode an endpoint or a header, and never add a vendor SDK for it."
        ]
    },
    applicationInsights: {
        fields: [
            {
                name: "connectionString",
                variable: "APPLICATIONINSIGHTS_CONNECTION_STRING",
                secret: true,
                required: true,
                // Every connection string of Application Insights carries the instrumentation key
                pattern: /(^|;)\s*InstrumentationKey=[^;]+/i,
                example: "InstrumentationKey=...;IngestionEndpoint=https://..."
            }
        ],
        instructions: [
            "Instrument with the Azure Monitor OpenTelemetry distro: in Node.js useAzureMonitor() of @azure/monitor-opentelemetry before the server and its modules are imported, in Python configure_azure_monitor() of azure-monitor-opentelemetry before the app is created, in .NET UseAzureMonitor() of Azure.Monitor.OpenTelemetry.AspNetCore, on the JVM the Application Insights Java agent (applicationinsights-agent), in Go the OpenTelemetry SDK with the Azure Monitor exporter.",
            ENABLE_ONLY_WHEN("APPLICATIONINSIGHTS_CONNECTION_STRING"),
            "The distros read the connection string from APPLICATIONINSIGHTS_CONNECTION_STRING by themselves."
        ]
    },
    /** CloudWatch and X-Ray, through the CloudWatch agent or an ADOT collector in the cluster: the AWS credentials stay with them */
    awsCloudWatch: {
        fields: [
            { name: "region", variable: "AWS_REGION", secret: false, required: true, pattern: /^[a-z]{2}(-[a-z]+)+-\d+$/, example: "eu-west-1" },
            { name: "endpoint", variable: "OTEL_EXPORTER_OTLP_ENDPOINT", secret: false, required: true, pattern: URL, example: "http://cloudwatch-agent.amazon-cloudwatch:4316" }
        ],
        fixed: { OTEL_PROPAGATORS: "tracecontext,baggage,xray" },
        instructions: [
            "Instrument with the AWS Distro for OpenTelemetry (ADOT): in Node.js @aws/aws-distro-opentelemetry-node-autoinstrumentation (registered before the server and its modules are imported), in Python aws-opentelemetry-distro (opentelemetry-instrument), on the JVM the aws-opentelemetry-agent, in .NET AWS.Distro.OpenTelemetry.AutoInstrumentation, in Go the OpenTelemetry SDK with the X-Ray ID generator and propagator.",
            "Export over OTLP to OTEL_EXPORTER_OTLP_ENDPOINT, the CloudWatch agent or ADOT collector of the cluster, which signs and forwards to CloudWatch and X-Ray: the application never holds AWS credentials for it.",
            ENABLE_ONLY_WHEN("OTEL_EXPORTER_OTLP_ENDPOINT")
        ]
    },
    /** Cloud Trace, Cloud Monitoring and Cloud Logging */
    googleCloud: {
        fields: [{ name: "projectId", variable: "GOOGLE_CLOUD_PROJECT", secret: false, required: true, pattern: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, example: "acme-prod" }],
        instructions: [
            "Instrument with the OpenTelemetry SDK of the stack and the Google Cloud exporters (Node.js @google-cloud/opentelemetry-cloud-trace-exporter and @google-cloud/opentelemetry-cloud-monitoring-exporter, Python opentelemetry-exporter-gcp-trace and opentelemetry-exporter-gcp-monitoring, Java and Go those of opentelemetry-operations-java and opentelemetry-operations-go), with the GCP resource detector, writing to the project in GOOGLE_CLOUD_PROJECT; logs go to stdout as one JSON object per line carrying the trace id, which Cloud Logging correlates.",
            "Authenticate with Application Default Credentials: the Workload Identity of the pod, or a serviceAccount resource attached to the backend. Never add a key file to the code.",
            ENABLE_ONLY_WHEN("GOOGLE_CLOUD_PROJECT")
        ]
    },
    /** Through the Datadog Agent of the cluster, which holds the API key: the applications never do */
    datadog: {
        fields: [{ name: "agentHost", variable: "DD_AGENT_HOST", secret: false, required: true, pattern: HOST, example: "datadog-agent.datadog.svc.cluster.local" }],
        fixed: { DD_LOGS_INJECTION: "true" },
        instructions: [
            "Instrument with the Datadog tracing library, loaded before anything else: in Node.js require('dd-trace').init() as the first line of the entry point, in Python ddtrace (ddtrace-run, or import ddtrace.auto first), on the JVM the dd-java-agent, in .NET the Datadog .NET tracer, in Go dd-trace-go.",
            "It sends to the Datadog Agent at DD_AGENT_HOST; logs go to stdout as one JSON object per line, with the trace ids DD_LOGS_INJECTION adds, for the Agent to collect.",
            "Set service, env and version of the tracer from OTEL_SERVICE_NAME, ENVIRONMENT and the service.version of OTEL_RESOURCE_ATTRIBUTES, unless the tracer reads them by itself.",
            ENABLE_ONLY_WHEN("DD_AGENT_HOST")
        ]
    }
}

export const TELEMETRY_PROVIDERS = Object.keys(TELEMETRY_CATALOG) as TelemetryProvider[]

export const isTelemetryProvider = (value: unknown): value is TelemetryProvider => typeof value === "string" && Object.hasOwn(TELEMETRY_CATALOG, value)

export interface IProjectTelemetry {
    /** What the team picked; unset, OpenTelemetry. What was filled for another provider stays saved */
    provider?: TelemetryProvider
    /** What was filled for each provider, by field name; the secret ones encrypted at rest and never sent back */
    settings?: Partial<Record<TelemetryProvider, Record<string, string | undefined>>>
    /**
     * The environments whose containers get the variables, by id. Unset: all of them, the ones added later included.
     * Empty: none
     */
    environmentIds?: string[]
}

/** A field as a client reads it: that it is set, and its value unless it is secret */
export interface TelemetryFieldView {
    set: true
    value?: string
}

/** What a client reads of the telemetry of a project: never the value of a secret field */
export interface ProjectTelemetryView {
    provider: TelemetryProvider
    settings: Partial<Record<TelemetryProvider, Record<string, TelemetryFieldView>>>
    /** Unset: every environment */
    environmentIds?: string[]
}

/** Paths of the project encrypted at rest: the secret fields of every provider */
export const TELEMETRY_SECRET_PATHS = TELEMETRY_PROVIDERS.flatMap(provider =>
    TELEMETRY_CATALOG[provider].fields.filter(field => field.secret).map(field => `telemetry.settings.${provider}.${field.name}`)
)

/** Whether a value fits a field: one line, not too long, matching its pattern */
export const isTelemetryValue = (field: TelemetryFieldSpec, value: string): boolean =>
    value.length <= MAX_TELEMETRY_VALUE_LENGTH && !/[\r\n]/.test(value) && (!field.pattern || field.pattern.test(value))

export const telemetryView = (telemetry?: IProjectTelemetry | null): ProjectTelemetryView => ({
    provider: telemetry?.provider ?? "openTelemetry",
    settings: Object.fromEntries(
        TELEMETRY_PROVIDERS.flatMap(provider => {
            const values = telemetry?.settings?.[provider]
            const fields = TELEMETRY_CATALOG[provider].fields.filter(field => values?.[field.name])
            return fields.length ? [[provider, Object.fromEntries(fields.map(field => [field.name, field.secret ? { set: true } : { set: true, value: values?.[field.name] }]))]] : []
        })
    ),
    ...(telemetry?.environmentIds ? { environmentIds: telemetry.environmentIds.map(String) } : {})
})

/** The fields a provider is missing to be picked */
export const missingTelemetryFields = (provider: TelemetryProvider, values?: Record<string, string | undefined>): string[] =>
    TELEMETRY_CATALOG[provider].fields.filter(field => field.required && !values?.[field.name]).map(field => field.name)

/** The provider picked when it has every field it needs, which saving it requires; OpenTelemetry otherwise */
export const telemetryProviderOf = (telemetry?: IProjectTelemetry | null): TelemetryProvider => {
    const provider = telemetry?.provider ?? "openTelemetry"
    return missingTelemetryFields(provider, telemetry?.settings?.[provider]).length ? "openTelemetry" : provider
}

/** Whether the containers of an environment get the variables: unset, every environment does */
export const isTelemetryEnvironment = (telemetry: IProjectTelemetry | null | undefined, environmentId: unknown): boolean =>
    !telemetry?.environmentIds || telemetry.environmentIds.map(String).includes(String(environmentId))

/** The variables of the provider in effect, those of its fields set and the ones it always sets; none when no field is set */
const providerVariables = (telemetry?: IProjectTelemetry | null): Record<string, string> => {
    const provider = telemetryProviderOf(telemetry)
    const values = telemetry?.settings?.[provider]
    const spec = TELEMETRY_CATALOG[provider]
    const fields = spec.fields.flatMap(field => (values?.[field.name] ? [[field.variable, values[field.name] as string] as const] : []))
    return fields.length ? { ...Object.fromEntries(fields), ...spec.fixed } : {}
}

/** The names of the variables the provider in effect hands the containers: none when it hands them nothing */
export const telemetryVariableNames = (telemetry?: IProjectTelemetry | null): string[] => Object.keys(providerVariables(telemetry))

/**
 * The variables the containers of an environment get, the content of the Secret of the telemetry: none when the
 * provider has nothing to hand them, or the environment is switched off
 */
export const telemetryVariablesOf = (telemetry: IProjectTelemetry | null | undefined, environmentId: unknown): Record<string, string> | undefined => {
    const variables = providerVariables(telemetry)
    return Object.keys(variables).length && isTelemetryEnvironment(telemetry, environmentId) ? variables : undefined
}

/**
 * How an agent instruments the applications of a project, the same words for Edit with AI and for MCP clients: which
 * variables reach which containers, never their values. `environments` are the slugs of those switched on, all of them
 * when left out.
 */
export const describeTelemetry = (telemetry: IProjectTelemetry | null | undefined, environments?: string[]): string => {
    const provider = telemetryProviderOf(telemetry)
    const variables = telemetryVariableNames(telemetry)
    const switchedOn = environments?.length ? environments.join(", ") : "(none at the moment)"
    const where = environments ? `in the environments ${switchedOn} only; elsewhere they are not set` : "in every environment"
    return [
        `The project sends its telemetry with the provider ${provider}.`,
        variables.length
            ? `Every deploy hands each backend, DOCKER frontend and maintenance agent ${variables.join(", ")} ${where}.`
            : "Flightroom hands the containers no telemetry variable: the team sets them in config maps or secrets when it wants the telemetry exported.",
        ADD_WHEN_MISSING,
        ...TELEMETRY_CATALOG[provider].instructions,
        SERVICE_IDENTITY,
        STATIC_FRONTENDS
    ].join(" ")
}
