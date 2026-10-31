import { describe, expect, it } from "vitest"
import { DATABASE_SECRET_KEYS } from "../models/DatabaseModel"
import { STORAGE_SECRET_KEYS } from "../models/StorageModel"
import { BACKEND_VARIABLE_KEY } from "./BackendStack"
import { RESERVED_ENV_KEYS, RESOURCE_CATALOG, resourceEnvironmentValues, resourceEnvKeys, resourceEnvPrefix, resourceSecretName, resourceVariant } from "./ResourceCatalog"

const variants = Object.values(RESOURCE_CATALOG).flatMap(spec => spec.variants.map(variant => [spec.type, variant.id] as const))

describe("RESOURCE_CATALOG", () => {
    it.each(variants)("given %s %s with the longest name, when its variables are derived, then each is a valid key no other one of the variant repeats", (type, variant) => {
        // A generic sets only the variables it defines: one of the longest name
        const keys = resourceEnvKeys({ name: `a-${"b".repeat(61)}`, type, variant, customFields: [{ name: "T".repeat(61), secret: true }] }).map(({ key }) => key)

        expect(keys.length).toBeGreaterThan(0)
        expect(keys.every(key => BACKEND_VARIABLE_KEY.test(key))).toBe(true)
        expect(new Set(keys).size).toBe(keys.length)
        expect(keys.some(key => RESERVED_ENV_KEYS.includes(key))).toBe(false)
    })

    it.each(variants)("given %s %s, when its fields are listed, then no name appears twice", (type, variant) => {
        const names = RESOURCE_CATALOG[type].variants.find(candidate => candidate.id === variant)?.fields.map(field => field.name) ?? []

        expect(new Set(names).size).toBe(names.length)
    })

    it("given the credentials of a storage or a database, when they are compared with the platform's, then they carry the same names", () => {
        const secretsOf = (type: "storage" | "database") => RESOURCE_CATALOG[type].variants.flatMap(variant => variant.fields.filter(field => field.secret).map(field => field.name))

        expect(secretsOf("storage").every(name => (STORAGE_SECRET_KEYS as readonly string[]).includes(name))).toBe(true)
        // A database on Azure SQL takes the Entra ID app of a storage on Azure, client secret included
        expect(secretsOf("database").every(name => ([...DATABASE_SECRET_KEYS, ...STORAGE_SECRET_KEYS] as readonly string[]).includes(name))).toBe(true)
    })
})

describe("resourceEnvPrefix", () => {
    it("given a name with dashes, when the prefix is derived, then it is the type's followed by the name in capitals with underscores", () => {
        expect(resourceEnvPrefix({ name: "orders-db", type: "database", variant: "credentials" })).toBe("DB_ORDERS_DB")
    })

    it.each([[null], [""], [undefined]])("given the prefix %j, when the prefix is derived, then the one of the type and name is used", envPrefix => {
        expect(resourceEnvPrefix({ name: "cache", type: "redis", variant: "credentials", envPrefix })).toBe("REDIS_CACHE")
    })

    it("given a prefix typed by hand, when the prefix is derived, then it replaces the derived one", () => {
        expect(resourceEnvPrefix({ name: "orders", type: "database", variant: "credentials", envPrefix: "POSTGRES" })).toBe("POSTGRES")
    })

    it("given an Application Insights resource, when its variables are derived, then they are named as the Azure Monitor SDKs read them, whatever its name", () => {
        expect(resourceEnvKeys({ name: "orders-telemetry", type: "applicationInsights", variant: "connectionString" })).toEqual([
            { key: "APPLICATIONINSIGHTS_CONNECTION_STRING", field: "connectionString", secret: true, required: true }
        ])
    })

    it("given an Application Insights resource with a prefix typed by hand, when the prefix is derived, then the typed one still wins", () => {
        expect(resourceEnvPrefix({ name: "telemetry", type: "applicationInsights", variant: "connectionString", envPrefix: "LEGACY_INSIGHTS" })).toBe("LEGACY_INSIGHTS")
    })
})

describe("resourceEnvKeys", () => {
    it("given a database by credentials, when its variables are derived, then each field has one, the password marked secret", () => {
        expect(resourceEnvKeys({ name: "orders", type: "database", variant: "credentials" })).toEqual([
            { key: "DB_ORDERS_ENGINE", field: "engine", secret: false, required: true },
            { key: "DB_ORDERS_HOST", field: "host", secret: false, required: true },
            { key: "DB_ORDERS_PORT", field: "port", secret: false, required: true },
            { key: "DB_ORDERS_NAME", field: "database", secret: false, required: true },
            { key: "DB_ORDERS_SCHEMA", field: "schema", secret: false, required: false },
            { key: "DB_ORDERS_USER", field: "username", secret: false, required: true },
            { key: "DB_ORDERS_PASSWORD", field: "password", secret: true, required: true },
            { key: "DB_ORDERS_SSL", field: "ssl", secret: false, required: false }
        ])
    })

    it("given a Cosmos DB reached by its managed identity, when its variables are derived, then endpoint and database are required, the client id and the container optional, and the variant is the AUTH one", () => {
        expect(resourceEnvKeys({ name: "orders", type: "cosmosdb", variant: "azureManagedIdentity" })).toEqual([
            { key: "COSMOS_ORDERS_ENDPOINT", field: "endpoint", secret: false, required: true },
            { key: "COSMOS_ORDERS_DATABASE", field: "database", secret: false, required: true },
            { key: "COSMOS_ORDERS_CONTAINER", field: "containerName", secret: false, required: false },
            { key: "COSMOS_ORDERS_CLIENT_ID", field: "clientId", secret: false, required: false },
            { key: "COSMOS_ORDERS_AUTH", secret: false, required: true, value: "azureManagedIdentity" }
        ])
    })

    it("given a Cosmos DB by account key, when its variables are derived, then the key is the one credential", () => {
        expect(resourceEnvKeys({ name: "orders", type: "cosmosdb", variant: "accountKey" }).filter(({ secret }) => secret)).toEqual([
            { key: "COSMOS_ORDERS_KEY", field: "accountKey", secret: true, required: true }
        ])
    })

    it("given a SharePoint site reached by an Entra ID certificate, when its variables are derived, then the site is required, the library optional, the certificate the one credential and the variant the AUTH one", () => {
        expect(resourceEnvKeys({ name: "docs", type: "sharepoint", variant: "azureAadCertificate" })).toEqual([
            { key: "SHAREPOINT_DOCS_SITE_URL", field: "siteUrl", secret: false, required: true },
            { key: "SHAREPOINT_DOCS_LIBRARY", field: "library", secret: false, required: false },
            { key: "SHAREPOINT_DOCS_TENANT_ID", field: "tenantId", secret: false, required: true },
            { key: "SHAREPOINT_DOCS_CLIENT_ID", field: "clientId", secret: false, required: true },
            { key: "SHAREPOINT_DOCS_CERTIFICATE", field: "certificate", secret: true, required: true },
            { key: "SHAREPOINT_DOCS_AUTH", secret: false, required: true, value: "azureAadCertificate" }
        ])
    })

    it("given an Azure AI Speech resource reached by managed identity, when its variables are derived, then region and endpoint are required, language and client id optional and the variant the AUTH one", () => {
        expect(resourceEnvKeys({ name: "voice", type: "speech", variant: "azureManagedIdentity" })).toEqual([
            { key: "SPEECH_VOICE_REGION", field: "region", secret: false, required: true },
            { key: "SPEECH_VOICE_LANGUAGE", field: "language", secret: false, required: false },
            { key: "SPEECH_VOICE_ENDPOINT", field: "endpoint", secret: false, required: true },
            { key: "SPEECH_VOICE_CLIENT_ID", field: "clientId", secret: false, required: false },
            { key: "SPEECH_VOICE_AUTH", secret: false, required: true, value: "azureManagedIdentity" }
        ])
    })

    it("given an Azure Service Bus reached by connection string, when its variables are derived, then the connection string is the one credential, the entities optional and the variant the AUTH one", () => {
        expect(resourceEnvKeys({ name: "orders", type: "serviceBus", variant: "connectionString" })).toEqual([
            { key: "SERVICEBUS_ORDERS_CONNECTION_STRING", field: "connectionString", secret: true, required: true },
            { key: "SERVICEBUS_ORDERS_QUEUE", field: "queue", secret: false, required: false },
            { key: "SERVICEBUS_ORDERS_TOPIC", field: "topic", secret: false, required: false },
            { key: "SERVICEBUS_ORDERS_SUBSCRIPTION", field: "subscription", secret: false, required: false },
            { key: "SERVICEBUS_ORDERS_AUTH", secret: false, required: true, value: "connectionString" }
        ])
    })

    it("given a storage on AWS, when its variables are derived, then the provider is among them with its fixed value", () => {
        expect(resourceEnvKeys({ name: "media", type: "storage", variant: "aws" })).toContainEqual({ key: "STORAGE_MEDIA_PROVIDER", secret: false, required: true, value: "AWS" })
    })

    it("given an API by OAuth2 client credentials, when its variables are derived, then the address of its document is one of them and the variant is the AUTH one", () => {
        const env = resourceEnvKeys({ name: "payments", type: "api", variant: "oauth2ClientCredentials" })

        expect(env.map(({ key }) => key)).toEqual([
            "API_PAYMENTS_BASE_URL",
            "API_PAYMENTS_SPEC_URL",
            "API_PAYMENTS_TOKEN_URL",
            "API_PAYMENTS_CLIENT_ID",
            "API_PAYMENTS_CLIENT_SECRET",
            "API_PAYMENTS_SCOPE",
            "API_PAYMENTS_AUDIENCE",
            "API_PAYMENTS_AUTH"
        ])
        expect(env).toContainEqual({ key: "API_PAYMENTS_AUTH", secret: false, required: true, value: "oauth2ClientCredentials" })
    })

    it.each(RESOURCE_CATALOG.api.variants.map(variant => [variant.id]))(
        "given an API authenticating by %s, when its variables are derived, then its address, its document's and its AUTH are among them",
        variant => {
            const env = resourceEnvKeys({ name: "payments", type: "api", variant })

            expect(env.map(({ key }) => key)).toEqual(expect.arrayContaining(["API_PAYMENTS_BASE_URL", "API_PAYMENTS_SPEC_URL", "API_PAYMENTS_AUTH"]))
            expect(env).toContainEqual(expect.objectContaining({ key: "API_PAYMENTS_AUTH", value: variant }))
        }
    )

    it.each([
        ["an unknown type", "queue", "default"],
        ["a variant of another type", "redis", "aws"]
    ])("given %s, when its variables are derived, then there are none", (_case, type, variant) => {
        expect(resourceEnvKeys({ name: "orders", type, variant })).toEqual([])
    })
})

describe("the ai type", () => {
    it("given Claude, when its variables are derived, then the key is secret, the model required and the provider fixed", () => {
        expect(resourceEnvKeys({ name: "assistant", type: "ai", variant: "anthropic" })).toEqual([
            { key: "AI_ASSISTANT_API_KEY", field: "apiKey", secret: true, required: true },
            { key: "AI_ASSISTANT_MODEL", field: "model", secret: false, required: true },
            { key: "AI_ASSISTANT_BASE_URL", field: "baseUrl", secret: false, required: false },
            { key: "AI_ASSISTANT_PROVIDER", secret: false, required: true, value: "anthropic" }
        ])
    })

    it("given Claude, when the console fills in a new one, then the model it proposes is the catalog's", () => {
        expect(RESOURCE_CATALOG.ai.variants.find(variant => variant.id === "anthropic")?.fields.find(field => field.name === "model")?.default).toBe("claude-opus-5-5")
    })

    it.each(RESOURCE_CATALOG.ai.variants.map(variant => [variant.id]))("given the provider %s, when its variables are derived, then the provider is fixed to it and the key is a secret", variant => {
        const env = resourceEnvKeys({ name: "assistant", type: "ai", variant })

        expect(env).toContainEqual({ key: "AI_ASSISTANT_PROVIDER", secret: false, required: true, value: variant })
        expect(env).toContainEqual({ key: "AI_ASSISTANT_API_KEY", field: "apiKey", secret: true, required: true })
    })

    it("given Azure OpenAI, when its variables are derived, then endpoint, deployment and API version are required", () => {
        const required = resourceEnvKeys({ name: "assistant", type: "ai", variant: "azureOpenai" }).filter(({ required, field }) => required && field)

        expect(required.map(({ key }) => key)).toEqual(["AI_ASSISTANT_ENDPOINT", "AI_ASSISTANT_DEPLOYMENT", "AI_ASSISTANT_API_VERSION", "AI_ASSISTANT_API_KEY"])
    })
})

describe("the smtp type", () => {
    it("given a server with an account, when its variables are derived, then the password is the only secret and no provider is fixed", () => {
        expect(resourceEnvKeys({ name: "mail", type: "smtp", variant: "credentials" })).toEqual([
            { key: "SMTP_MAIL_HOST", field: "host", secret: false, required: true },
            { key: "SMTP_MAIL_PORT", field: "port", secret: false, required: true },
            { key: "SMTP_MAIL_SECURITY", field: "security", secret: false, required: true },
            { key: "SMTP_MAIL_USERNAME", field: "username", secret: false, required: true },
            { key: "SMTP_MAIL_PASSWORD", field: "password", secret: true, required: true },
            { key: "SMTP_MAIL_FROM", field: "from", secret: false, required: true },
            { key: "SMTP_MAIL_FROM_NAME", field: "fromName", secret: false, required: false }
        ])
    })

    it("given a relay without authentication, when its variables are derived, then they are those of a server with an account but the account", () => {
        const keys = (variant: string) => resourceEnvKeys({ name: "mail", type: "smtp", variant }).map(({ key }) => key)

        expect(keys("noAuth")).toEqual(keys("credentials").filter(key => !["SMTP_MAIL_USERNAME", "SMTP_MAIL_PASSWORD"].includes(key)))
    })

    it("given a new server, when the console fills it in, then it proposes port 587 with STARTTLS", () => {
        const fields = RESOURCE_CATALOG.smtp.variants[0].fields

        expect(fields.find(field => field.name === "port")?.default).toBe("587")
        expect(fields.find(field => field.name === "security")).toMatchObject({ options: ["none", "starttls", "tls"], default: "starttls" })
    })
})

describe("the mongodb type", () => {
    it("given a connection string, when its variables are derived, then the URI is a secret and the database optional", () => {
        expect(resourceEnvKeys({ name: "orders", type: "mongodb", variant: "connectionString" })).toEqual([
            { key: "MONGO_ORDERS_URL", field: "connectionString", secret: true, required: true },
            { key: "MONGO_ORDERS_NAME", field: "database", secret: false, required: false }
        ])
    })

    it("given host and credentials, when its variables are derived, then the password is the only secret and the options are optional", () => {
        expect(resourceEnvKeys({ name: "orders", type: "mongodb", variant: "credentials" })).toEqual([
            { key: "MONGO_ORDERS_HOST", field: "host", secret: false, required: true },
            { key: "MONGO_ORDERS_PORT", field: "port", secret: false, required: true },
            { key: "MONGO_ORDERS_NAME", field: "database", secret: false, required: true },
            { key: "MONGO_ORDERS_USER", field: "username", secret: false, required: true },
            { key: "MONGO_ORDERS_PASSWORD", field: "password", secret: true, required: true },
            { key: "MONGO_ORDERS_AUTH_SOURCE", field: "authSource", secret: false, required: false },
            { key: "MONGO_ORDERS_REPLICA_SET", field: "replicaSet", secret: false, required: false },
            { key: "MONGO_ORDERS_TLS", field: "tls", secret: false, required: false }
        ])
    })

    it("given the catalog, when a database engine is picked, then MongoDB is not one: it is a type of its own, its connection string first", () => {
        expect(RESOURCE_CATALOG.database.variants[0].fields.find(field => field.name === "engine")?.options).not.toContain("MONGODB")
        expect(RESOURCE_CATALOG.mongodb.variants.map(variant => variant.id)).toEqual(["connectionString", "credentials"])
    })
})

describe("the serviceAccount type", () => {
    it("given a Google key, when its variables are derived, then the provider is told to the client", () => {
        expect(resourceEnvKeys({ name: "crm", type: "serviceAccount", variant: "jsonKey" })).toEqual([
            { key: "SA_CRM_JSON", field: "jsonKey", secret: true, required: true },
            { key: "SA_CRM_PROVIDER", secret: false, required: true, value: "google" }
        ])
    })

    it("given a Microsoft Entra ID app, when its variables are derived, then the tenant replaces the token URL and the secret is the only credential", () => {
        expect(resourceEnvKeys({ name: "crm", type: "serviceAccount", variant: "microsoft" })).toEqual([
            { key: "SA_CRM_TENANT_ID", field: "tenantId", secret: false, required: true },
            { key: "SA_CRM_CLIENT_ID", field: "clientId", secret: false, required: true },
            { key: "SA_CRM_CLIENT_SECRET", field: "clientSecret", secret: true, required: true },
            { key: "SA_CRM_SCOPE", field: "scope", secret: false, required: false },
            { key: "SA_CRM_PROVIDER", secret: false, required: true, value: "microsoft" }
        ])
    })

    it("given the catalog, when the variants are listed, then the ids saved before the providers are still there", () => {
        expect(RESOURCE_CATALOG.serviceAccount.variants.map(variant => variant.id)).toEqual(["jsonKey", "microsoft", "clientCredentials"])
    })
})

describe("the bigquery type", () => {
    it("given a service account key, when its variables are derived, then the key is the only secret and the variant is told to the client", () => {
        expect(resourceEnvKeys({ name: "analytics", type: "bigquery", variant: "serviceAccountKey" })).toEqual([
            { key: "BQ_ANALYTICS_PROJECT_ID", field: "projectId", secret: false, required: true },
            { key: "BQ_ANALYTICS_DATASET", field: "dataset", secret: false, required: false },
            { key: "BQ_ANALYTICS_LOCATION", field: "location", secret: false, required: false },
            { key: "BQ_ANALYTICS_CREDENTIALS_JSON", field: "jsonKey", secret: true, required: true },
            { key: "BQ_ANALYTICS_AUTH", secret: false, required: true, value: "serviceAccountKey" }
        ])
    })

    it("given the identity of the pod, when its variables are derived, then there is no credential", () => {
        expect(resourceEnvKeys({ name: "analytics", type: "bigquery", variant: "applicationDefault" })).toEqual([
            { key: "BQ_ANALYTICS_PROJECT_ID", field: "projectId", secret: false, required: true },
            { key: "BQ_ANALYTICS_DATASET", field: "dataset", secret: false, required: false },
            { key: "BQ_ANALYTICS_LOCATION", field: "location", secret: false, required: false },
            { key: "BQ_ANALYTICS_AUTH", secret: false, required: true, value: "applicationDefault" }
        ])
    })
})

describe("the generic type", () => {
    const customFields = [
        { name: "BASE_URL", secret: false },
        { name: "TOKEN", secret: true }
    ]

    it("given the variables it defines, when they are derived, then each is <prefix>_<name>, optional, secret as defined", () => {
        expect(resourceEnvKeys({ name: "billing", type: "generic", variant: "custom", customFields })).toEqual([
            { key: "RES_BILLING_BASE_URL", field: "BASE_URL", secret: false, required: false },
            { key: "RES_BILLING_TOKEN", field: "TOKEN", secret: true, required: false }
        ])
    })

    it("given none defined, when its variables are derived, then there are none", () => {
        expect(resourceEnvKeys({ name: "billing", type: "generic", variant: "custom" })).toEqual([])
    })

    it("given custom fields on another type, when its variant is read, then they are ignored", () => {
        expect(resourceVariant("redis", "connectionString", customFields)).toBe(RESOURCE_CATALOG.redis.variants[1])
    })

    it("given stored values, when the variables of an environment are derived, then the override wins and a credential is read as any other", () => {
        const resource = {
            name: "billing",
            type: "generic",
            variant: "custom",
            customFields,
            values: [{ field: "BASE_URL", value: "https://billing.example.com", overrides: [{ environmentId: "dev", value: "https://dev.billing.example.com" }] }],
            secrets: [{ field: "TOKEN", value: "s3cr3t" }]
        }

        expect(resourceEnvironmentValues(resource, "dev")).toEqual({ RES_BILLING_BASE_URL: "https://dev.billing.example.com", RES_BILLING_TOKEN: "s3cr3t" })
    })
})

describe("resourceSecretName", () => {
    it("given a resource, when its Kubernetes Secret is named, then it is its name with a suffix no map name can have", () => {
        expect(resourceSecretName({ name: "orders" })).toBe("orders.resource")
    })
})
