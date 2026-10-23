import { describe, expect, it } from "vitest"
import { DATABASE_SECRET_KEYS } from "../models/DatabaseModel"
import { STORAGE_SECRET_KEYS } from "../models/StorageModel"
import { RESERVED_ENV_KEYS, RESOURCE_CATALOG, resourceEnvKeys, resourceEnvPrefix, resourceSecretName } from "./ResourceCatalog"
import { SERVICE_VARIABLE_KEY } from "./ServiceStack"

const variants = Object.values(RESOURCE_CATALOG).flatMap(spec => spec.variants.map(variant => [spec.type, variant.id] as const))

describe("RESOURCE_CATALOG", () => {
    it.each(variants)("given %s %s with the longest name, when its variables are derived, then each is a valid key no other one of the variant repeats", (type, variant) => {
        const keys = resourceEnvKeys({ name: `a-${"b".repeat(61)}`, type, variant }).map(({ key }) => key)

        expect(keys.length).toBeGreaterThan(0)
        expect(keys.every(key => SERVICE_VARIABLE_KEY.test(key))).toBe(true)
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

describe("resourceSecretName", () => {
    it("given a resource, when its Kubernetes Secret is named, then it is its name with a suffix no map name can have", () => {
        expect(resourceSecretName({ name: "orders" })).toBe("orders.resource")
    })
})
