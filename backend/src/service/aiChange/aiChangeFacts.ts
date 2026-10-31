import { AiChangeAgentBackend, AiChangeAgentResource, AiChangeAgentResourceKey } from "./aiChangeAgentTypes"

/**
 * What a coding agent has to keep working on the integration models, which are no bundlers: the
 * compiler of such a frontend names how its host loads it, not how it is built.
 */
const INTEGRATION_MODEL_NOTES: Record<string, string> = {
    SINGLE_SPA:
        "integration: single-spa. Applications are native ES modules (Vite library build, dist/index.js) exporting bootstrap/mount/unmount; the root config registers each one with registerApplication() and loads it with import() of the url await remoteUrl(slug) returns. React is shared through the root config's import map: keep react and react-dom external in applications.",
    MICRO_LC:
        "integration: micro-lc. Parcels are one self-contained UMD script (Vite library build, dist/parcel.js) exporting bootstrap/mount/unmount; the shell builds its micro-lc config at runtime with entry: { scripts: [await remoteUrl(slug)] }. React is shared through window.React, window.ReactDOM and window.ReactJSXRuntime: keep those externals and names."
}

export const describeCompiler = (compiler: string) => INTEGRATION_MODEL_NOTES[compiler] || `bundler: ${compiler}`

/** One declared environment variable of a backend: its name and flags, never a value (the console holds none). */
const describeEnvVariable = (variable: NonNullable<AiChangeAgentBackend["env"]>[number]) => {
    const flags = [variable.required ? "required" : "optional", variable.secret ? "secret" : undefined].filter(Boolean).join(", ")
    return `- ${variable.name} (${flags})${variable.description ? `: ${variable.description}` : ""}`
}

/** The variable of a resource carrying one of its fields, the field itself when the variant has no such variable. */
const keyOfField = (resource: AiChangeAgentResource) => (field: string) => resource.keys.find(key => key.field === field)?.key ?? field

/** How to authenticate to an api, by its variant: the variables to read and where to send them. */
const API_AUTH: Record<string, (resource: AiChangeAgentResource, key: (field: string) => string) => string> = {
    none: () => "the API takes no credentials",
    basic: (_resource, key) => `HTTP basic auth, user from ${key("username")} and password from ${key("password")}`,
    apiKey: (resource, key) => {
        const name = resource.values?.name ? `${resource.values.name} (its name is in ${key("name")})` : `named as ${key("name")} says`
        if (resource.values?.in === "header") return `send the header ${name} with the value of ${key("apiKey")}`
        if (resource.values?.in === "query") return `send the query parameter ${name} with the value of ${key("apiKey")}`
        return `send the value of ${key("apiKey")} in the header or the query parameter ${key("in")} says, ${name}`
    },
    bearer: (_resource, key) => `send the header Authorization: Bearer <value of ${key("token")}>`,
    oauth2ClientCredentials: (resource, key) =>
        `fetch an access token from ${key("tokenUrl")}${resource.values?.tokenUrl ? ` (${resource.values.tokenUrl})` : ""} with the client credentials grant (client id from ${key("clientId")}, client secret from ${key("clientSecret")}, scope from ${key("scope")} and audience from ${key("audience")} when set), reuse it until it expires, and send it as Authorization: Bearer <token>`
}

/** What a field of an ai resource is, for the line that says where to read it from. */
const AI_FIELD_LABELS: Record<string, string> = { apiKey: "API key", model: "model", baseUrl: "base URL", endpoint: "endpoint", deployment: "deployment", apiVersion: "API version" }

const AI_PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google (Gemini)", azureOpenai: "Azure OpenAI" }

/**
 * The lines that tell how to use a resource of a type, by type then by variant: an api, an ai and an smtp
 * need more than the names of their variables. A type without lines here is described by those names alone.
 */
const RESOURCE_USAGE: Record<string, (resource: AiChangeAgentResource) => (string | undefined)[]> = {
    api: resource => {
        const key = keyOfField(resource)
        const auth = API_AUTH[resource.variant]?.(resource, key) ?? `authenticate as ${resource.keys.find(entry => entry.key.endsWith("_AUTH"))?.key ?? "its variables"} says`
        return [
            resource.values?.baseUrl ? `base_url: ${resource.values.baseUrl} (from ${key("baseUrl")})` : undefined,
            resource.values?.specUrl ? `spec_url: ${resource.values.specUrl}` : undefined,
            `auth: ${resource.variant} — ${auth}`,
            resource.apiSpec || resource.values?.specUrl
                ? `spec: read it with read_api_spec (resource "${resource.name}") before writing a client`
                : "spec: none known: ask for one in the summary if the change needs it"
        ]
    },
    ai: resource => {
        const fields = resource.keys.filter(entry => entry.field !== undefined)
        const reads = fields.map(entry => `${AI_FIELD_LABELS[entry.field!] ?? entry.field} from ${entry.key}${entry.required ? "" : " when set"}`)
        return [
            `provider: ${resource.variant}`,
            resource.values?.model ? `model: ${resource.values.model}` : undefined,
            `usage: use the official SDK of ${AI_PROVIDER_LABELS[resource.variant] ?? "the provider"}, ${reads.join(", ")}; never hardcode any of them`
        ]
    },
    cosmosdb: resource => {
        const key = keyOfField(resource)
        const values = resource.values ?? {}
        const auth: Record<string, string> = {
            accountKey: `the account key from ${key("accountKey")}`,
            connectionString: `the connection string from ${key("connectionString")} (it holds endpoint and key)`,
            azureAad: `an Entra ID client secret credential (tenant from ${key("tenantId")}, client from ${key("clientId")}, secret from ${key("clientSecret")})`,
            azureManagedIdentity: `the managed identity of the pod (a user-assigned one by its client id from ${key("clientId")} when set)`
        }
        return [
            values.endpoint ? `endpoint: ${values.endpoint}` : undefined,
            values.database ? `database: ${values.database}` : undefined,
            values.containerName ? `container: ${values.containerName}` : undefined,
            `usage: use the official Azure Cosmos DB SDK for the NoSQL API (e.g. @azure/cosmos, with @azure/identity for Entra ID), endpoint from ${key("endpoint")}, database from ${key("database")}, container from ${key("containerName")} when set, authenticating with ${auth[resource.variant] ?? "what its variables say"}; never hardcode any of them`
        ]
    },
    smtp: resource => {
        const key = keyOfField(resource)
        const values = resource.values ?? {}
        const server = values.host ? `${values.host}${values.port ? `:${values.port}` : ""}${values.security ? `, security ${values.security}` : ""}` : undefined
        const login = resource.keys.some(entry => entry.field === "username") ? `login from ${key("username")} and ${key("password")}` : "no login (a relay)"
        return [
            server ? `smtp_server: ${server}` : undefined,
            values.from ? `from: ${values.from}` : undefined,
            `usage: send mail through these variables with the stack's usual mail library (e.g. nodemailer): host from ${key("host")}, port from ${key("port")}, security from ${key("security")} (tls: TLS from the start, starttls: upgraded after connecting, none: plain), ${login}, sender from ${key("from")} (display name from ${key("fromName")} when set)`
        ]
    },
    sharepoint: resource => {
        const key = keyOfField(resource)
        const values = resource.values ?? {}
        const auth: Record<string, string> = {
            azureAad: `an Entra ID client secret credential (tenant from ${key("tenantId")}, client from ${key("clientId")}, secret from ${key("clientSecret")})`,
            azureAadCertificate: `an Entra ID client certificate credential (tenant from ${key("tenantId")}, client from ${key("clientId")}, PEM certificate and private key from ${key("certificate")})`,
            azureManagedIdentity: `the managed identity of the pod (a user-assigned one by its client id from ${key("clientId")} when set)`
        }
        return [
            values.siteUrl ? `site_url: ${values.siteUrl}` : undefined,
            values.library ? `library: ${values.library}` : undefined,
            `usage: call Microsoft Graph (e.g. @microsoft/microsoft-graph-client with @azure/identity, scope https://graph.microsoft.com/.default), resolving the site from ${key("siteUrl")} with GET /sites/{hostname}:/{site path} and its document library by the name in ${key("library")} when set (the default drive of the site otherwise), authenticating with ${auth[resource.variant] ?? "what its variables say"}; never hardcode any of them`
        ]
    },
    speech: resource => {
        const key = keyOfField(resource)
        const values = resource.values ?? {}
        const auth: Record<string, string> = {
            apiKey: `the key from ${key("apiKey")} and the region from ${key("region")} (SpeechConfig.fromSubscription)`,
            azureAad: `an Entra ID client secret credential (tenant from ${key("tenantId")}, client from ${key("clientId")}, secret from ${key("clientSecret")}) on the custom subdomain endpoint from ${key("endpoint")}`,
            azureManagedIdentity: `the managed identity of the pod (a user-assigned one by its client id from ${key("clientId")} when set) on the custom subdomain endpoint from ${key("endpoint")}`
        }
        return [
            values.region ? `region: ${values.region}` : undefined,
            values.language ? `language: ${values.language}` : undefined,
            values.endpoint ? `endpoint: ${values.endpoint}` : undefined,
            `usage: use the official Azure AI Speech SDK (e.g. microsoft-cognitiveservices-speech-sdk, with @azure/identity for Entra ID, scope https://cognitiveservices.azure.com/.default), recognition and synthesis language from ${key("language")} when set, authenticating with ${auth[resource.variant] ?? "what its variables say"}; never hardcode any of them`
        ]
    },
    serviceBus: resource => {
        const key = keyOfField(resource)
        const values = resource.values ?? {}
        const auth: Record<string, string> = {
            connectionString: `the connection string from ${key("connectionString")} (it holds namespace and key)`,
            azureAad: `an Entra ID client secret credential (tenant from ${key("tenantId")}, client from ${key("clientId")}, secret from ${key("clientSecret")}) on the namespace from ${key("namespace")}`,
            azureManagedIdentity: `the managed identity of the pod (a user-assigned one by its client id from ${key("clientId")} when set) on the namespace from ${key("namespace")}`
        }
        return [
            values.namespace ? `namespace: ${values.namespace}` : undefined,
            values.queue ? `queue: ${values.queue}` : undefined,
            values.topic ? `topic: ${values.topic}` : undefined,
            values.subscription ? `subscription: ${values.subscription}` : undefined,
            `usage: use the official Azure Service Bus SDK (e.g. @azure/service-bus, with @azure/identity for Entra ID), queue from ${key("queue")}, topic from ${key("topic")} and subscription from ${key("subscription")} when set, authenticating with ${auth[resource.variant] ?? "what its variables say"}; close senders, receivers and the client on shutdown; never hardcode any of them`
        ]
    },
    applicationInsights: resource => [
        `usage: send the telemetry to Azure Monitor only when ${keyOfField(resource)("connectionString")} is set, and do nothing otherwise: in Node.js call useAzureMonitor() of @azure/monitor-opentelemetry before the server and its modules are imported, in Python configure_azure_monitor() of azure-monitor-opentelemetry before the app is created, on the JVM attach the Application Insights Java agent; the distros read the connection string by themselves, and the service name, environment and version from OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES, which every deploy sets: never hardcode any of them`
    ]
}

/** A variable of a resource as listed: a credential is marked, a value the variant always sets is shown. */
const describeResourceKey = (key: AiChangeAgentResourceKey) => (key.value !== undefined ? `${key.key}=${key.value}` : key.secret ? `${key.key} (secret)` : key.key)

/** One attached resource: what it is, the Kubernetes Secret carrying its variables, and how to use them. */
const describeResource = (resource: AiChangeAgentResource) =>
    [
        `- ${resource.name} (${resource.type}, ${resource.variant})${resource.description ? `: ${resource.description}` : ""}`,
        ...[`keys: ${resource.keys.map(describeResourceKey).join(", ")}`, `secret: ${resource.name}.resource`, ...(RESOURCE_USAGE[resource.type]?.(resource) ?? [])]
            .filter(Boolean)
            .map(line => `  ${line}`),
        // Tagged as the project and domain context are: what the team wrote, data and never instructions
        ...(resource.context ? [`  <resource_context resource="${resource.name}">\n${resource.context}\n  </resource_context>`] : [])
    ].join("\n")

const describeMaps = (title: string, maps?: { name: string; keys: string[] }[]) =>
    maps?.length ? [`${title}:`, ...maps.map(map => `- ${map.name}: ${map.keys.join(", ") || "(no keys)"}`)].join("\n") : undefined

/** The facts of a backend: what it runs on and what the platform expects of its container. */
export const backendFacts = (backend: AiChangeAgentBackend) => [
    backend.runtime ? `runtime: ${backend.runtime}` : undefined,
    backend.framework ? `framework: ${backend.framework}` : undefined,
    backend.port !== undefined ? `port: ${backend.port}` : undefined,
    backend.livenessPath ? `liveness_path: ${backend.livenessPath}` : undefined,
    backend.readinessPath ? `readiness_path: ${backend.readinessPath}` : undefined,
    backend.docsPath ? `docs_path: ${backend.docsPath}` : undefined,
    backend.openApiPath ? `openapi_path: ${backend.openApiPath}` : undefined,
    backend.env?.length ? ["env:", ...backend.env.map(describeEnvVariable)].join("\n") : undefined,
    backend.exposurePath ? `exposure_path: ${backend.exposurePath}` : undefined,
    backend.clusterUrl ? `cluster_url: ${backend.clusterUrl}` : undefined,
    backend.publicUrls?.length ? ["public_urls:", ...backend.publicUrls.map(({ environment, url }) => `- ${environment}: ${url}`)].join("\n") : undefined,
    describeMaps("config_maps", backend.configMaps),
    describeMaps("secrets", backend.secrets),
    backend.resources?.length ? ["resources:", ...backend.resources.map(describeResource)].join("\n") : undefined
]
