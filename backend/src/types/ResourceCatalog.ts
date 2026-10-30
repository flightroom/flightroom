import { DatabaseType } from "../models/DatabaseModel"

/**
 * What a resource can be. Each type is a package of variables a backend receives once it
 * attaches the resource: the platform knows its fields, so it names the variables and keeps the
 * credentials among them encrypted, where a config map or a secret leaves both to whoever fills it.
 */
export type ResourceType =
    | "database"
    | "mongodb"
    | "cosmosdb"
    | "bigquery"
    | "storage"
    | "redis"
    | "serviceAccount"
    | "auth0"
    | "api"
    | "ai"
    | "smtp"
    | "sharepoint"
    | "speech"
    | "serviceBus"
    | "generic"

/** How the console asks for a field; the backend checks number, boolean, select, url and email against it too */
export type ResourceFieldInput = "text" | "number" | "boolean" | "select" | "multiline" | "url" | "email"

export interface ResourceFieldSpec {
    name: string
    /** The variable is `<prefix>_<envSuffix>`, e.g. DB_ORDERS_PASSWORD */
    envSuffix: string
    /** Encrypted at rest and never sent back once written */
    secret: boolean
    /**
     * A required field that is not secret must have a value in every environment to be saved. A
     * required secret is not held to it: like the values of a secret map, it can be typed later.
     */
    required: boolean
    input: ResourceFieldInput
    /** The values a select takes */
    options?: string[]
    /** What the console fills in for a new resource; the backend never applies it on its own */
    default?: string
    /**
     * Where the credentials of the resource are sent: changing it would send the stored ones somewhere
     * else, so the credentials kept there must be typed again (ResourceService, normalizeResourceFields)
     */
    connection?: boolean
}

/** One way of reaching the same kind of resource, e.g. a database by host and password or by connection string */
export interface ResourceVariantSpec {
    id: string
    fields: ResourceFieldSpec[]
    /** Variables the variant always sets, by suffix, e.g. the provider of a storage */
    fixed?: Record<string, string>
}

export interface ResourceTypeSpec {
    type: ResourceType
    /** The start of the variables of a resource of this type, before its name */
    envPrefix: string
    variants: ResourceVariantSpec[]
}

/** A prefix typed by hand in place of the one derived from the name: what starts an environment variable name */
export const RESOURCE_ENV_PREFIX = /^[A-Z_][A-Z0-9_]{0,190}$/

/** Set by the chart on every container (applicationManifests.ts): a resource setting it too would be there twice */
export const RESERVED_ENV_KEYS = ["HTTP_PORT"]

/** The Kubernetes Secret a resource becomes: a map name cannot hold a dot, so it never collides with a secret map */
export const resourceSecretName = (resource: { name: string }): string => `${resource.name}.resource`

const field = (name: string, envSuffix: string, options: Partial<Omit<ResourceFieldSpec, "name" | "envSuffix">> = {}): ResourceFieldSpec => ({
    name,
    envSuffix,
    secret: false,
    required: true,
    input: "text",
    ...options
})

const secret = (name: string, envSuffix: string, options: Partial<Omit<ResourceFieldSpec, "name" | "envSuffix" | "secret">> = {}) => field(name, envSuffix, { ...options, secret: true })

/** The engines of the platform's databases; MongoDB is a type of its own, with the fields its drivers take */
const engine = field("engine", "ENGINE", { input: "select", options: Object.values(DatabaseType) })
const schema = (options: Partial<Omit<ResourceFieldSpec, "name" | "envSuffix">> = {}) => field("schema", "SCHEMA", { required: false, ...options })

/** An Azure SQL database reached with an Entra ID identity: always SQL Server, always encrypted */
const azureSqlVariant = (id: string, fields: ResourceFieldSpec[]): ResourceVariantSpec => ({
    id,
    fields: [
        field("host", "HOST", { connection: true }),
        field("port", "PORT", { input: "number", default: "1433", connection: true }),
        field("database", "NAME", { connection: true }),
        schema({ default: "dbo" }),
        ...fields
    ],
    // The variant is the way to authenticate: the client reads it rather than guessing from the keys set
    fixed: { ENGINE: DatabaseType.SQLSERVER, AUTH: id }
})

/** A Cosmos DB account reached at its endpoint: the variant is the way to authenticate, which the client reads rather than guesses */
const cosmosVariant = (id: string, fields: ResourceFieldSpec[]): ResourceVariantSpec => ({
    id,
    fields: [
        field("endpoint", "ENDPOINT", { input: "url", connection: true }),
        field("database", "DATABASE", { connection: true }),
        field("containerName", "CONTAINER", { required: false }),
        ...fields
    ],
    fixed: { AUTH: id }
})

/** An SMTP server, by the fields both variants share: where it is, how the connection is secured, who mail comes from */
const smtpServer = [
    field("host", "HOST", { connection: true }),
    field("port", "PORT", { input: "number", default: "587", connection: true }),
    field("security", "SECURITY", { input: "select", options: ["none", "starttls", "tls"], default: "starttls" })
]
const smtpSender = [field("from", "FROM", { input: "email" }), field("fromName", "FROM_NAME", { required: false })]

/** A SharePoint site reached through Microsoft Graph: the variant is the way to authenticate, which the client reads rather than guesses */
const sharepointVariant = (id: string, fields: ResourceFieldSpec[]): ResourceVariantSpec => ({
    id,
    // Without a library the client uses the default one of the site
    fields: [field("siteUrl", "SITE_URL", { input: "url", connection: true }), field("library", "LIBRARY", { required: false }), ...fields],
    fixed: { AUTH: id }
})

/** An Azure AI Speech resource in its region: the variant is the way to authenticate, which the client reads rather than guesses */
const speechVariant = (id: string, fields: ResourceFieldSpec[]): ResourceVariantSpec => ({
    id,
    fields: [field("region", "REGION", { connection: true }), field("language", "LANGUAGE", { required: false }), ...fields],
    fixed: { AUTH: id }
})

/** An Azure Service Bus namespace and, when the backend uses one, its queue or topic and subscription */
const serviceBusEntities = [field("queue", "QUEUE", { required: false }), field("topic", "TOPIC", { required: false }), field("subscription", "SUBSCRIPTION", { required: false })]
const serviceBusVariant = (id: string, fields: ResourceFieldSpec[]): ResourceVariantSpec => ({
    id,
    // The fully qualified namespace, e.g. orders.servicebus.windows.net
    fields: [field("namespace", "NAMESPACE", { connection: true }), ...serviceBusEntities, ...fields],
    fixed: { AUTH: id }
})

/**
 * An external HTTP API: where it answers and where its Swagger/OpenAPI document is, in every variant. A
 * document that cannot be reached is pasted instead, into the apiSpec of the resource: it is no field
 * and no variable, so it never reaches a container nor the Kubernetes Secret.
 */
const apiVariant = (id: string, fields: ResourceFieldSpec[]): ResourceVariantSpec => ({
    id,
    fields: [field("baseUrl", "BASE_URL", { input: "url", connection: true }), field("specUrl", "SPEC_URL", { input: "url", required: false, connection: true }), ...fields],
    // The variant is the way to authenticate: the client reads it rather than guessing from the keys set
    fixed: { AUTH: id }
})

/**
 * The secret fields keep the names they have on a storage and on a database of the platform
 * (STORAGE_SECRET_KEYS, DATABASE_SECRET_KEYS), so the same credential is called the same everywhere.
 */
export const RESOURCE_CATALOG: Record<ResourceType, ResourceTypeSpec> = {
    database: {
        type: "database",
        envPrefix: "DB",
        variants: [
            {
                id: "credentials",
                fields: [
                    engine,
                    field("host", "HOST", { connection: true }),
                    field("port", "PORT", { input: "number", connection: true }),
                    field("database", "NAME", { connection: true }),
                    schema(),
                    field("username", "USER"),
                    secret("password", "PASSWORD"),
                    field("ssl", "SSL", { input: "boolean", required: false, default: "false" })
                ]
            },
            { id: "connectionString", fields: [engine, secret("connectionString", "URL"), schema()] },
            azureSqlVariant("azureAad", [field("tenantId", "TENANT_ID"), field("clientId", "CLIENT_ID"), secret("clientSecret", "CLIENT_SECRET")]),
            // A user-assigned identity is picked by its client id; without one the system-assigned identity is used
            azureSqlVariant("azureManagedIdentity", [field("clientId", "CLIENT_ID", { required: false })])
        ]
    },
    /** Mostly reached by a mongodb+srv URI, so that comes first; by host and credentials otherwise */
    mongodb: {
        type: "mongodb",
        envPrefix: "MONGO",
        variants: [
            { id: "connectionString", fields: [secret("connectionString", "URL"), field("database", "NAME", { required: false })] },
            {
                id: "credentials",
                fields: [
                    field("host", "HOST", { connection: true }),
                    field("port", "PORT", { input: "number", default: "27017", connection: true }),
                    field("database", "NAME", { connection: true }),
                    field("username", "USER"),
                    secret("password", "PASSWORD"),
                    field("authSource", "AUTH_SOURCE", { required: false, default: "admin" }),
                    field("replicaSet", "REPLICA_SET", { required: false }),
                    field("tls", "TLS", { input: "boolean", required: false, default: "false" })
                ]
            }
        ]
    },
    /**
     * An Azure Cosmos DB account through its NoSQL API: by account key, connection string, an Entra ID app or the
     * identity of the pod. The API for MongoDB is reached as a mongodb resource, with the connection string it gives
     */
    cosmosdb: {
        type: "cosmosdb",
        envPrefix: "COSMOS",
        variants: [
            cosmosVariant("accountKey", [secret("accountKey", "KEY")]),
            {
                id: "connectionString",
                fields: [secret("connectionString", "CONNECTION_STRING"), field("database", "DATABASE"), field("containerName", "CONTAINER", { required: false })],
                fixed: { AUTH: "connectionString" }
            },
            cosmosVariant("azureAad", [field("tenantId", "TENANT_ID"), field("clientId", "CLIENT_ID"), secret("clientSecret", "CLIENT_SECRET")]),
            // A user-assigned identity is picked by its client id; without one the system-assigned identity is used
            cosmosVariant("azureManagedIdentity", [field("clientId", "CLIENT_ID", { required: false })])
        ]
    },
    /**
     * A Google BigQuery project, by a service account key or by the identity the cluster gives the pod
     * (Application Default Credentials, e.g. GKE Workload Identity), which then needs no credential at all
     */
    bigquery: {
        type: "bigquery",
        envPrefix: "BQ",
        variants: [
            {
                id: "serviceAccountKey",
                fields: [
                    field("projectId", "PROJECT_ID", { connection: true }),
                    field("dataset", "DATASET", { required: false }),
                    field("location", "LOCATION", { required: false }),
                    secret("jsonKey", "CREDENTIALS_JSON", { input: "multiline" })
                ],
                // The variant is the way to authenticate: the client reads it rather than guessing from the keys set
                fixed: { AUTH: "serviceAccountKey" }
            },
            {
                id: "applicationDefault",
                fields: [field("projectId", "PROJECT_ID", { connection: true }), field("dataset", "DATASET", { required: false }), field("location", "LOCATION", { required: false })],
                fixed: { AUTH: "applicationDefault" }
            }
        ]
    },
    storage: {
        type: "storage",
        envPrefix: "STORAGE",
        variants: [
            {
                id: "aws",
                fields: [
                    field("region", "REGION", { connection: true }),
                    field("bucketName", "BUCKET", { connection: true }),
                    field("accessKeyId", "ACCESS_KEY_ID"),
                    secret("secretAccessKey", "SECRET_ACCESS_KEY")
                ],
                fixed: { PROVIDER: "AWS" }
            },
            {
                id: "azureConnectionString",
                fields: [field("containerName", "CONTAINER", { connection: true }), secret("connectionString", "CONNECTION_STRING")],
                fixed: { PROVIDER: "AZURE" }
            },
            {
                id: "azureSharedKey",
                fields: [field("accountName", "ACCOUNT_NAME", { connection: true }), field("containerName", "CONTAINER", { connection: true }), secret("accountKey", "ACCOUNT_KEY")],
                fixed: { PROVIDER: "AZURE" }
            },
            {
                id: "azureAad",
                fields: [
                    field("accountName", "ACCOUNT_NAME", { connection: true }),
                    field("containerName", "CONTAINER", { connection: true }),
                    field("tenantId", "TENANT_ID"),
                    field("clientId", "CLIENT_ID"),
                    secret("clientSecret", "CLIENT_SECRET")
                ],
                fixed: { PROVIDER: "AZURE" }
            },
            {
                id: "google",
                fields: [field("bucketName", "BUCKET", { connection: true }), secret("jsonKey", "CREDENTIALS_JSON", { input: "multiline" })],
                fixed: { PROVIDER: "GOOGLE" }
            }
        ]
    },
    redis: {
        type: "redis",
        envPrefix: "REDIS",
        variants: [
            {
                id: "credentials",
                fields: [
                    field("host", "HOST", { connection: true }),
                    field("port", "PORT", { input: "number", default: "6379", connection: true }),
                    field("username", "USER", { required: false }),
                    secret("password", "PASSWORD", { required: false }),
                    field("tls", "TLS", { input: "boolean", required: false, default: "false" })
                ]
            },
            { id: "connectionString", fields: [secret("url", "URL")] }
        ]
    },
    /**
     * The provider is the variant, which the client reads rather than guesses. The ids of the Google key and of the
     * generic client credentials predate the providers: resources already saved keep them
     */
    serviceAccount: {
        type: "serviceAccount",
        envPrefix: "SA",
        variants: [
            { id: "jsonKey", fields: [secret("jsonKey", "JSON", { input: "multiline" })], fixed: { PROVIDER: "google" } },
            {
                id: "microsoft",
                // The token comes from the tenant on Entra ID: login.microsoftonline.com/<tenantId>/oauth2/v2.0/token
                fields: [field("tenantId", "TENANT_ID"), field("clientId", "CLIENT_ID"), secret("clientSecret", "CLIENT_SECRET"), field("scope", "SCOPE", { required: false })],
                fixed: { PROVIDER: "microsoft" }
            },
            {
                id: "clientCredentials",
                fields: [
                    field("clientId", "CLIENT_ID"),
                    secret("clientSecret", "CLIENT_SECRET"),
                    field("tokenUrl", "TOKEN_URL", { required: false, connection: true }),
                    field("scope", "SCOPE", { required: false })
                ]
            }
        ]
    },
    auth0: {
        type: "auth0",
        envPrefix: "AUTH0",
        variants: [
            {
                id: "default",
                fields: [field("domain", "DOMAIN", { connection: true }), field("clientId", "CLIENT_ID"), secret("clientSecret", "CLIENT_SECRET"), field("audience", "AUDIENCE", { required: false })]
            }
        ]
    },
    api: {
        type: "api",
        envPrefix: "API",
        variants: [
            apiVariant("none", []),
            apiVariant("basic", [field("username", "USERNAME"), secret("password", "PASSWORD")]),
            apiVariant("apiKey", [
                field("in", "API_KEY_IN", { input: "select", options: ["header", "query"], default: "header" }),
                field("name", "API_KEY_NAME", { default: "X-API-Key" }),
                secret("apiKey", "API_KEY")
            ]),
            apiVariant("bearer", [secret("token", "TOKEN")]),
            apiVariant("oauth2ClientCredentials", [
                field("tokenUrl", "TOKEN_URL", { input: "url", connection: true }),
                field("clientId", "CLIENT_ID"),
                secret("clientSecret", "CLIENT_SECRET"),
                field("scope", "SCOPE", { required: false }),
                field("audience", "AUDIENCE", { required: false })
            ])
        ]
    },
    /** An LLM provider the backend calls: the variant is the provider, which the client reads rather than guesses */
    ai: {
        type: "ai",
        envPrefix: "AI",
        variants: [
            {
                id: "anthropic",
                fields: [secret("apiKey", "API_KEY"), field("model", "MODEL", { default: "claude-opus-5-5" }), field("baseUrl", "BASE_URL", { input: "url", required: false, connection: true })],
                fixed: { PROVIDER: "anthropic" }
            },
            {
                id: "openai",
                fields: [
                    secret("apiKey", "API_KEY"),
                    field("model", "MODEL"),
                    field("organization", "ORGANIZATION", { required: false }),
                    field("baseUrl", "BASE_URL", { input: "url", required: false, connection: true })
                ],
                fixed: { PROVIDER: "openai" }
            },
            { id: "google", fields: [secret("apiKey", "API_KEY"), field("model", "MODEL")], fixed: { PROVIDER: "google" } },
            {
                id: "azureOpenai",
                fields: [field("endpoint", "ENDPOINT", { input: "url", connection: true }), field("deployment", "DEPLOYMENT"), field("apiVersion", "API_VERSION"), secret("apiKey", "API_KEY")],
                fixed: { PROVIDER: "azureOpenai" }
            }
        ]
    },
    /** An email channel the backend sends mail through; a relay inside the network may take no account */
    smtp: {
        type: "smtp",
        envPrefix: "SMTP",
        variants: [
            { id: "credentials", fields: [...smtpServer, field("username", "USERNAME"), secret("password", "PASSWORD"), ...smtpSender] },
            { id: "noAuth", fields: [...smtpServer, ...smtpSender] }
        ]
    },
    /**
     * A SharePoint Online site and its documents, by an Entra ID app (client secret or certificate) or by the identity
     * of the pod. The certificate is the PEM of the certificate and its private key, as @azure/identity reads it
     */
    sharepoint: {
        type: "sharepoint",
        envPrefix: "SHAREPOINT",
        variants: [
            sharepointVariant("azureAad", [field("tenantId", "TENANT_ID"), field("clientId", "CLIENT_ID"), secret("clientSecret", "CLIENT_SECRET")]),
            sharepointVariant("azureAadCertificate", [field("tenantId", "TENANT_ID"), field("clientId", "CLIENT_ID"), secret("certificate", "CERTIFICATE", { input: "multiline" })]),
            // A user-assigned identity is picked by its client id; without one the system-assigned identity is used
            sharepointVariant("azureManagedIdentity", [field("clientId", "CLIENT_ID", { required: false })])
        ]
    },
    /**
     * An Azure AI Speech resource, for speech to text and text to speech: by its key or by Entra ID. Entra ID takes
     * the custom subdomain endpoint of the resource, as the regional one accepts keys only
     */
    speech: {
        type: "speech",
        envPrefix: "SPEECH",
        variants: [
            speechVariant("apiKey", [secret("apiKey", "KEY")]),
            speechVariant("azureAad", [
                field("endpoint", "ENDPOINT", { input: "url", connection: true }),
                field("tenantId", "TENANT_ID"),
                field("clientId", "CLIENT_ID"),
                secret("clientSecret", "CLIENT_SECRET")
            ]),
            // A user-assigned identity is picked by its client id; without one the system-assigned identity is used
            speechVariant("azureManagedIdentity", [field("endpoint", "ENDPOINT", { input: "url", connection: true }), field("clientId", "CLIENT_ID", { required: false })])
        ]
    },
    /** An Azure Service Bus namespace: by connection string, an Entra ID app or the identity of the pod */
    serviceBus: {
        type: "serviceBus",
        envPrefix: "SERVICEBUS",
        variants: [
            { id: "connectionString", fields: [secret("connectionString", "CONNECTION_STRING"), ...serviceBusEntities], fixed: { AUTH: "connectionString" } },
            serviceBusVariant("azureAad", [field("tenantId", "TENANT_ID"), field("clientId", "CLIENT_ID"), secret("clientSecret", "CLIENT_SECRET")]),
            // A user-assigned identity is picked by its client id; without one the system-assigned identity is used
            serviceBusVariant("azureManagedIdentity", [field("clientId", "CLIENT_ID", { required: false })])
        ]
    },
    /** Anything the catalog lacks: the resource defines its own variables (customFields), none of them a connection */
    generic: {
        type: "generic",
        envPrefix: "RES",
        variants: [{ id: "custom", fields: [] }]
    }
}

export const isResourceType = (type: unknown): type is ResourceType => typeof type === "string" && Object.hasOwn(RESOURCE_CATALOG, type)

/** A variable a `generic` resource defines itself: `<prefix>_<name>`, optional, a credential when `secret` */
export interface ResourceCustomField {
    name: string
    secret: boolean
}

/**
 * What the name of a custom field may be: the end of a variable name. At most 61 characters, so that with the
 * longest prefix (RESOURCE_ENV_PREFIX) and its underscore the key stays within the 253 of a Kubernetes Secret key.
 */
export const RESOURCE_CUSTOM_FIELD_NAME = /^[A-Z0-9_]{1,61}$/

/** Well past what a backend reads from one resource */
export const MAX_RESOURCE_CUSTOM_FIELDS = 100

/**
 * The variant of a type, undefined when either is not in the catalog. The variant of a `generic` resource
 * takes the fields it defines, each named as its variable ends; any other type ignores them.
 */
export const resourceVariant = (type: unknown, variant: unknown, customFields?: ResourceCustomField[] | null): ResourceVariantSpec | undefined => {
    const spec = isResourceType(type) ? RESOURCE_CATALOG[type].variants.find(candidate => candidate.id === variant) : undefined
    if (!spec || type !== "generic" || !customFields?.length) return spec
    return { ...spec, fields: [...spec.fields, ...customFields.map(custom => (custom.secret ? secret : field)(custom.name, custom.name, { required: false }))] }
}

/** What the variables of a resource are named from */
export interface ResourceNaming {
    name: string
    type: string
    variant: string
    envPrefix?: string | null
    /** A `generic` resource only: the variables it defines */
    customFields?: ResourceCustomField[] | null
}

/** The prefix typed for the resource, otherwise the one of its type followed by its name: `orders-db` → DB_ORDERS_DB */
export const resourceEnvPrefix = (resource: ResourceNaming): string =>
    resource.envPrefix || `${isResourceType(resource.type) ? RESOURCE_CATALOG[resource.type].envPrefix : ""}_${resource.name.toUpperCase().replace(/-/g, "_")}`

/** A variable a resource sets on the containers attaching it */
export interface ResourceEnvKey {
    key: string
    /** The field it carries; none for a variable the variant always sets */
    field?: string
    secret: boolean
    required: boolean
    /** The value of a variable the variant always sets */
    value?: string
}

/**
 * Every variable the variant of the resource sets, whether its field has a value or not: an attached
 * resource claims all of them, so a value typed later cannot clash with a map attached in the meantime.
 */
export const resourceEnvKeys = (resource: ResourceNaming): ResourceEnvKey[] => {
    const variant = resourceVariant(resource.type, resource.variant, resource.customFields)
    if (!variant) return []
    const prefix = resourceEnvPrefix(resource)
    return [
        ...variant.fields.map(({ name, envSuffix, secret, required }) => ({ key: `${prefix}_${envSuffix}`, field: name, secret, required })),
        ...Object.entries(variant.fixed ?? {}).map(([envSuffix, value]) => ({ key: `${prefix}_${envSuffix}`, secret: false, required: true, value }))
    ]
}

/** A field as the model stores it, or as a deploy reads it: the environment id a string or an ObjectId */
interface ResourceStoredValue {
    field: string
    value?: string
    overrides?: Array<{ environmentId: unknown; value?: string }>
}

/** A resource with the values of its fields, credentials decrypted */
export interface ResourceWithValues extends ResourceNaming {
    values?: ResourceStoredValue[]
    secrets?: ResourceStoredValue[]
}

/**
 * The variables a resource sets in one environment, by key: the value the environment overrides with,
 * the one of all otherwise, and the fixed ones of its variant. A field with neither is left out, as the
 * container would not get it. What a deploy ships, to the repository and to its snapshot alike.
 */
export const resourceEnvironmentValues = (resource: ResourceWithValues, environmentId: string): Record<string, string> => {
    const byField = new Map([...(resource.values ?? []), ...(resource.secrets ?? [])].map(stored => [stored.field, stored]))
    const data: Record<string, string> = {}
    for (const { key, field, value } of resourceEnvKeys(resource)) {
        const stored = field === undefined ? undefined : byField.get(field)
        const resolved = field === undefined ? value : stored?.overrides?.find(override => String(override.environmentId) === environmentId)?.value || stored?.value
        if (resolved) data[key] = resolved
    }
    return data
}
