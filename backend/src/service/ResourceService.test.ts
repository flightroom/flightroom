import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Environment from "../models/EnvironmentModel"
import Resource from "../models/ResourceModel"
import Service from "../models/ServiceModel"
import { ConfigMap, Secret } from "../models/VariableMapModel"
import { withNoMaintenanceAgents } from "../testing/noMaintenanceAgents"
import { RESOURCE_CATALOG } from "../types/ResourceCatalog"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import { parseApiDocument } from "./aiChange/apiSpecReader"
import ResourceService, { ensureAttachableResources, ensureValidApiSpec, normalizeResourceFields, resourceIdsInScope, withResourcesOutOfScope } from "./ResourceService"

withNoMaintenanceAgents()

const projectId = new Types.ObjectId().toString()
const development = new Types.ObjectId().toString()
const production = new Types.ObjectId().toString()
const environments = new Set([development, production])

const variantOf = (type: keyof typeof RESOURCE_CATALOG, id: string) => RESOURCE_CATALOG[type].variants.find(variant => variant.id === id)!
const databaseCredentials = variantOf("database", "credentials")
const databaseUrl = variantOf("database", "connectionString")
const apiKey = variantOf("api", "apiKey")
const azureOpenai = variantOf("ai", "azureOpenai")
const anthropic = variantOf("ai", "anthropic")
const smtpRelay = variantOf("smtp", "noAuth")

/** Every required field that is not a credential, with a value of all */
const requiredFields = { engine: { value: "POSTGRESQL" }, host: { value: "db.internal" }, port: { value: "5432" }, database: { value: "orders" }, username: { value: "orders" } }

afterEach(() => {
    vi.restoreAllMocks()
})

const allowAccess = () => vi.spyOn(ResourceService.prototype as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue(undefined)

describe("normalizeResourceFields", () => {
    it("given the required fields and a password, when they are normalised, then the password goes to the credentials and the rest to the values", () => {
        expect(normalizeResourceFields({ ...requiredFields, password: { value: "hunter2" } }, databaseCredentials, environments)).toEqual({
            values: [
                { field: "engine", value: "POSTGRESQL", overrides: [] },
                { field: "host", value: "db.internal", overrides: [] },
                { field: "port", value: "5432", overrides: [] },
                { field: "database", value: "orders", overrides: [] },
                { field: "username", value: "orders", overrides: [] }
            ],
            secrets: [{ field: "password", value: "hunter2", overrides: [] }]
        })
    })

    it("given blank values and blank overrides, when they are normalised, then those fields are left unset", () => {
        const { values, secrets } = normalizeResourceFields(
            { ...requiredFields, password: { value: "", overrides: [{ environmentId: production, value: "" }] }, ssl: { value: "" } },
            databaseCredentials,
            environments
        )

        expect(secrets).toEqual([])
        expect(values.map(value => value.field)).not.toContain("ssl")
    })

    it("given a required field with no value of all but one in every environment, when they are normalised, then it is accepted", () => {
        const host = {
            overrides: [
                { environmentId: development, value: "dev.internal" },
                { environmentId: production, value: "prod.internal" }
            ]
        }

        expect(normalizeResourceFields({ ...requiredFields, host }, databaseCredentials, environments).values).toContainEqual({ field: "host", ...host })
    })

    it("given a required field set in one environment only, when they are normalised, then it is refused", () => {
        const fields = { ...requiredFields, host: { overrides: [{ environmentId: development, value: "dev.internal" }] } }

        expect(() => normalizeResourceFields(fields, databaseCredentials, environments)).toThrow(expect.objectContaining({ code: "RESOURCE_VALUE_REQUIRED" }))
    })

    it("given a required credential left unset, when they are normalised, then it is accepted to be typed later", () => {
        expect(normalizeResourceFields(requiredFields, databaseCredentials, environments).secrets).toEqual([])
    })

    it.each([
        ["a field the variant does not have", { connectionString: { value: "postgres://" } }, "RESOURCE_FIELD_UNKNOWN"],
        ["fields that are not an object", [], "RESOURCE_FIELDS_INVALID"],
        ["a port out of range", { port: { value: "70000" } }, "RESOURCE_VALUE_INVALID"],
        ["a port that is not a number", { port: { value: "5432a" } }, "RESOURCE_VALUE_INVALID"],
        ["a boolean that is not one", { ssl: { value: "yes" } }, "RESOURCE_VALUE_INVALID"],
        ["an engine the catalog does not list", { engine: { value: "MONGODB" } }, "RESOURCE_VALUE_INVALID"],
        ["a value that is not text", { host: { value: 5432 } }, "RESOURCE_VALUE_INVALID"],
        ["a value too long", { host: { value: "x".repeat(32 * 1024 + 1) } }, "RESOURCE_VALUE_INVALID"],
        ["a credential that looks like a ciphertext", { password: { value: "enc:v1:a:b:c" } }, "RESOURCE_VALUE_INVALID"],
        ["an override for an environment of another project", { host: { value: "db", overrides: [{ environmentId: new Types.ObjectId().toString(), value: "x" }] } }, "RESOURCE_ENVIRONMENT_UNKNOWN"],
        [
            "two overrides for one environment",
            {
                host: {
                    value: "db",
                    overrides: [
                        { environmentId: production, value: "a" },
                        { environmentId: production, value: "b" }
                    ]
                }
            },
            "RESOURCE_ENVIRONMENT_DUPLICATED"
        ],
        ["the placeholder for a credential with nothing stored", { password: { value: SECRET_PLACEHOLDER } }, "RESOURCE_SECRET_VALUE_REQUIRED"],
        ["an override that is not an object", { host: { value: "db", overrides: ["db.prod"] } }, "RESOURCE_FIELDS_INVALID"],
        ["an override that is null", { host: { value: "db", overrides: [null] } }, "RESOURCE_FIELDS_INVALID"],
        [
            "the placeholder of a credential for an environment of another project",
            { password: { overrides: [{ environmentId: new Types.ObjectId().toString(), value: SECRET_PLACEHOLDER }] } },
            "RESOURCE_ENVIRONMENT_UNKNOWN"
        ],
        [
            "an invalid value for an environment of another project",
            { port: { value: "5432", overrides: [{ environmentId: new Types.ObjectId().toString(), value: "x" }] } },
            "RESOURCE_ENVIRONMENT_UNKNOWN"
        ]
    ])("given %s, when they are normalised, then they are refused", (_case, fields, code) => {
        const sent = Array.isArray(fields) ? fields : { ...requiredFields, ...fields }

        expect(() => normalizeResourceFields(sent, databaseCredentials, environments)).toThrow(expect.objectContaining({ code }))
    })

    describe("of an API", () => {
        const apiFields = { baseUrl: { value: "https://payments.example.com/v1" }, in: { value: "header" }, name: { value: "X-API-Key" } }

        it("given the addresses of the API and of its document, when they are normalised, then they are kept as plain values", () => {
            const { values } = normalizeResourceFields({ ...apiFields, specUrl: { value: "http://payments.internal/openapi.json" } }, apiKey, environments)

            expect(values).toContainEqual({ field: "baseUrl", value: "https://payments.example.com/v1", overrides: [] })
            expect(values).toContainEqual({ field: "specUrl", value: "http://payments.internal/openapi.json", overrides: [] })
        })

        it.each([
            ["a relative base URL", { baseUrl: { value: "/v1" } }],
            ["a base URL of another scheme", { baseUrl: { value: "ftp://payments.example.com" } }],
            ["a spec URL that is not one", { specUrl: { value: "openapi.json" } }],
            ["a base URL overridden with something that is not one", { baseUrl: { value: "https://payments.example.com", overrides: [{ environmentId: production, value: "payments" }] } }],
            ["a key sent in neither the header nor the query", { in: { value: "cookie" } }],
            ["a base URL carrying a user and a password", { baseUrl: { value: "https://user:pw@payments.example.com/v1" } }],
            ["a spec URL carrying a user", { specUrl: { value: "https://token@payments.example.com/openapi.json" } }]
        ])("given %s, when they are normalised, then they are refused", (_case, fields) => {
            expect(() => normalizeResourceFields({ ...apiFields, ...fields }, apiKey, environments)).toThrow(expect.objectContaining({ code: "RESOURCE_VALUE_INVALID" }))
        })

        it("given no base URL, when they are normalised, then it is refused as required", () => {
            expect(() => normalizeResourceFields({ in: { value: "header" }, name: { value: "X-API-Key" } }, apiKey, environments)).toThrow(expect.objectContaining({ code: "RESOURCE_VALUE_REQUIRED" }))
        })
    })

    describe("of an LLM provider", () => {
        const azureFields = { endpoint: { value: "https://acme.openai.azure.com" }, deployment: { value: "gpt-orders" }, apiVersion: { value: "2026-06-01" }, apiKey: { value: "sk-azure" } }

        it("given Azure OpenAI, when its fields are normalised, then the key goes to the credentials and the rest to the values", () => {
            const { values, secrets } = normalizeResourceFields(azureFields, azureOpenai, environments)

            expect(values.map(value => value.field)).toEqual(["endpoint", "deployment", "apiVersion"])
            expect(secrets).toEqual([{ field: "apiKey", value: "sk-azure", overrides: [] }])
        })

        it.each([
            ["an endpoint that is not a URL", azureOpenai, { ...azureFields, endpoint: { value: "acme.openai.azure.com" } }, "RESOURCE_VALUE_INVALID"],
            ["a base URL that is not one", anthropic, { model: { value: "claude-opus-5-5" }, baseUrl: { value: "proxy" } }, "RESOURCE_VALUE_INVALID"],
            ["no model", anthropic, { apiKey: { value: "sk-ant" } }, "RESOURCE_VALUE_REQUIRED"],
            ["no API version", azureOpenai, { ...azureFields, apiVersion: { value: "" } }, "RESOURCE_VALUE_REQUIRED"]
        ])("given %s, when its fields are normalised, then they are refused", (_case, variant, fields, code) => {
            expect(() => normalizeResourceFields(fields, variant, environments)).toThrow(expect.objectContaining({ code }))
        })

        it("given Claude with no key yet, when its fields are normalised, then it is accepted to be typed later", () => {
            expect(normalizeResourceFields({ model: { value: "claude-opus-5-5" } }, anthropic, environments).secrets).toEqual([])
        })
    })

    describe("of an SMTP server", () => {
        const relay = { host: { value: "smtp.internal" }, port: { value: "587" }, security: { value: "starttls" }, from: { value: "orders@shop.example.com" } }

        it("given a relay with a sender, when its fields are normalised, then they are kept as plain values", () => {
            expect(normalizeResourceFields({ ...relay, fromName: { value: "Shop" } }, smtpRelay, environments)).toEqual({
                values: [
                    { field: "host", value: "smtp.internal", overrides: [] },
                    { field: "port", value: "587", overrides: [] },
                    { field: "security", value: "starttls", overrides: [] },
                    { field: "from", value: "orders@shop.example.com", overrides: [] },
                    { field: "fromName", value: "Shop", overrides: [] }
                ],
                secrets: []
            })
        })

        it.each([
            ["a sender that is no address", { from: { value: "orders" } }, "RESOURCE_VALUE_INVALID"],
            ["a sender with a space", { from: { value: "orders @shop.example.com" } }, "RESOURCE_VALUE_INVALID"],
            ["a security the server does not take", { security: { value: "ssl" } }, "RESOURCE_VALUE_INVALID"],
            ["a port out of range", { port: { value: "0" } }, "RESOURCE_VALUE_INVALID"],
            ["an account on a relay without authentication", { username: { value: "orders" } }, "RESOURCE_FIELD_UNKNOWN"],
            ["no sender", { from: { value: "" } }, "RESOURCE_VALUE_REQUIRED"]
        ])("given %s, when its fields are normalised, then they are refused", (_case, fields, code) => {
            expect(() => normalizeResourceFields({ ...relay, ...fields }, smtpRelay, environments)).toThrow(expect.objectContaining({ code }))
        })
    })

    describe("over what is stored", () => {
        const stored = {
            values: [
                { field: "engine", value: "POSTGRESQL", overrides: [] },
                { field: "host", value: "db.internal", overrides: [{ environmentId: new Types.ObjectId(production), value: "db.prod.internal" }] },
                { field: "port", value: "5432", overrides: [] },
                { field: "database", value: "orders", overrides: [] },
                { field: "username", value: "orders", overrides: [] }
            ],
            secrets: [{ field: "password", value: "stored-password", overrides: [{ environmentId: new Types.ObjectId(production), value: "stored-prod-password" }] }]
        } as never

        it("given the credential sent back as the placeholder, when they are normalised, then the stored values are kept and a retyped one replaces its own", () => {
            const { secrets } = normalizeResourceFields(
                {
                    password: {
                        value: SECRET_PLACEHOLDER,
                        overrides: [
                            { environmentId: production, value: SECRET_PLACEHOLDER },
                            { environmentId: development, value: "new-dev-password" }
                        ]
                    }
                },
                databaseCredentials,
                environments,
                stored
            )

            expect(secrets).toEqual([
                {
                    field: "password",
                    value: "stored-password",
                    overrides: [
                        { environmentId: production, value: "stored-prod-password" },
                        { environmentId: development, value: "new-dev-password" }
                    ]
                }
            ])
        })

        it("given one field sent, when they are normalised, then it is replaced with its overrides and the others are kept", () => {
            const { values, secrets } = normalizeResourceFields({ username: { value: "billing" } }, databaseCredentials, environments, stored)

            expect(values).toContainEqual({ field: "username", value: "billing", overrides: [] })
            expect(values).toContainEqual({ field: "port", value: "5432", overrides: [] })
            expect(secrets).toEqual([{ field: "password", value: "stored-password", overrides: [{ environmentId: production, value: "stored-prod-password" }] }])
        })

        describe("with a connection field changed", () => {
            const keepPassword = { value: SECRET_PLACEHOLDER, overrides: [{ environmentId: production, value: SECRET_PLACEHOLDER }] }

            it.each([
                ["the credential sent back as the placeholder", { host: { value: "evil.example.com" }, password: keepPassword }],
                ["the credential left out", { host: { value: "evil.example.com" } }],
                [
                    "only the override of production retyped",
                    { host: { value: "evil.example.com" }, password: { value: SECRET_PLACEHOLDER, overrides: [{ environmentId: production, value: "typed" }] } }
                ]
            ])("given %s, when they are normalised, then it is refused naming what to type again", (_case, fields) => {
                expect(() => normalizeResourceFields(fields, databaseCredentials, environments, stored)).toThrow(
                    expect.objectContaining({ code: "RESOURCE_SECRET_REENTRY_REQUIRED", details: { secrets: ["password"], connections: ["host"] } })
                )
            })

            it("given the credential typed again everywhere it is set, when they are normalised, then the new values are taken", () => {
                const { secrets } = normalizeResourceFields(
                    { port: { value: "6543" }, password: { value: "new-password", overrides: [{ environmentId: production, value: "new-prod-password" }] } },
                    databaseCredentials,
                    environments,
                    stored
                )

                expect(secrets).toEqual([{ field: "password", value: "new-password", overrides: [{ environmentId: production, value: "new-prod-password" }] }])
            })

            it("given a change of variant, when the credential it shares is kept, then it is refused", () => {
                const anthropicStored = { values: [{ field: "model", value: "claude-opus-5-5", overrides: [] }], secrets: [{ field: "apiKey", value: "sk-stored", overrides: [] }] } as never

                expect(() => normalizeResourceFields({ model: { value: "gpt-5" } }, variantOf("ai", "openai"), environments, anthropicStored, { variantChanged: true })).toThrow(
                    expect.objectContaining({ code: "RESOURCE_SECRET_REENTRY_REQUIRED", details: { secrets: ["apiKey"], connections: ["variant"] } })
                )
            })

            describe("in one environment only", () => {
                const hostIn = (environment: string, value: string) => ({
                    value: "db.internal",
                    overrides: [
                        { environmentId: production, value: "db.prod.internal" },
                        { environmentId: environment, value }
                    ].slice(environment === production ? 1 : 0)
                })

                it("given the override of production changed, when its credential there is kept, then it is refused", () => {
                    expect(() => normalizeResourceFields({ host: hostIn(production, "evil.example.com"), password: keepPassword }, databaseCredentials, environments, stored)).toThrow(
                        expect.objectContaining({ code: "RESOURCE_SECRET_REENTRY_REQUIRED" })
                    )
                })

                it("given the override of production changed, when only its credential there is typed again, then the value of all is kept", () => {
                    const { secrets } = normalizeResourceFields(
                        { host: hostIn(production, "db2.prod.internal"), password: { value: SECRET_PLACEHOLDER, overrides: [{ environmentId: production, value: "new-prod-password" }] } },
                        databaseCredentials,
                        environments,
                        stored
                    )

                    expect(secrets).toEqual([{ field: "password", value: "stored-password", overrides: [{ environmentId: production, value: "new-prod-password" }] }])
                })

                it("given an override added in development, which takes the credential of all, when that one is kept, then it is refused", () => {
                    expect(() => normalizeResourceFields({ host: hostIn(development, "evil.example.com"), password: keepPassword }, databaseCredentials, environments, stored)).toThrow(
                        expect.objectContaining({ code: "RESOURCE_SECRET_REENTRY_REQUIRED", details: { secrets: ["password"], connections: ["host"] } })
                    )
                })
            })
        })

        it("given another variant, when they are normalised, then the fields it shares are kept and the others are dropped", () => {
            const { values, secrets } = normalizeResourceFields({ connectionString: { value: "postgres://orders" } }, databaseUrl, environments, stored)

            expect(values).toEqual([{ field: "engine", value: "POSTGRESQL", overrides: [] }])
            expect(secrets).toEqual([{ field: "connectionString", value: "postgres://orders", overrides: [] }])
        })
    })
})

describe("ResourceService.create", () => {
    let create: ReturnType<typeof vi.fn>

    beforeEach(() => {
        allowAccess()
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: development }, { _id: production }] as never)
        create = vi.spyOn(Resource, "create").mockImplementation((async (document: unknown) => document) as never) as unknown as ReturnType<typeof vi.fn>
    })

    const createResource = (dto: object) => new ResourceService().create({ name: "orders", type: "database", variant: "credentials", fields: requiredFields, ...dto } as never, projectId)

    it("given a database, when it is created, then it is written for the project with its name lowercase and its credentials apart", async () => {
        await createResource({ name: " Orders ", fields: { ...requiredFields, password: { value: "hunter2" } } })

        expect(create.mock.calls[0][0]).toMatchObject({
            name: "orders",
            type: "database",
            variant: "credentials",
            projectId: expect.anything(),
            secrets: [{ field: "password", value: "hunter2", overrides: [] }]
        })
    })

    it("given no variant, when it is created, then the refusal says one is needed and which", async () => {
        await expect(createResource({ variant: undefined })).rejects.toMatchObject({ message: "A database needs a variant: one of credentials, connectionString" })
    })

    it("given a prefix in lowercase, when it is created, then it is written in capitals", async () => {
        await createResource({ envPrefix: " postgres " })

        expect(create.mock.calls[0][0]).toMatchObject({ envPrefix: "POSTGRES" })
    })

    it.each([
        ["a type the catalog does not have", { type: "queue" }, "RESOURCE_TYPE_INVALID"],
        ["a variant of another type", { variant: "aws" }, "RESOURCE_VARIANT_INVALID"],
        ["no variant", { variant: undefined }, "RESOURCE_VARIANT_INVALID"],
        ["a variant that is not text", { variant: 3 }, "RESOURCE_VARIANT_INVALID"],
        ["an invalid name", { name: "orders_db" }, "RESOURCE_NAME_INVALID"],
        ["an invalid prefix", { envPrefix: "1DB" }, "RESOURCE_ENV_PREFIX_INVALID"],
        ["a description too long", { description: "x".repeat(2001) }, "RESOURCE_DESCRIPTION_INVALID"]
    ])("given %s, when it is created, then it is refused and nothing is written", async (_case, dto, code) => {
        await expect(createResource(dto)).rejects.toMatchObject({ code })
        expect(create).not.toHaveBeenCalled()
    })

    it("given a prefix that makes it set HTTP_PORT, when a redis is created, then it is refused as the chart sets that one", async () => {
        const refusal = createResource({ type: "redis", envPrefix: "HTTP", fields: { host: { value: "cache" }, port: { value: "6379" } } })

        await expect(refusal).rejects.toMatchObject({ code: "RESOURCE_ENV_PREFIX_INVALID", message: expect.stringContaining("HTTP_PORT") })
        expect(create).not.toHaveBeenCalled()
    })

    it("given a name already taken, when it is created, then the unique index error is refused as RESOURCE_NAME_TAKEN", async () => {
        create.mockRejectedValue({ code: 11000 })

        await expect(createResource({})).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN", statusCode: 409 })
    })

    it("given a domain-scoped member, when a resource is created, then it is forbidden", async () => {
        vi.spyOn(ResourceService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([new Types.ObjectId().toString()])

        await expect(createResource({})).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        expect(create).not.toHaveBeenCalled()
    })
})

describe("ResourceService.update", () => {
    const resourceId = new Types.ObjectId()
    const configMapId = new Types.ObjectId()
    const resource = {
        _id: resourceId,
        projectId,
        name: "orders",
        type: "database",
        variant: "credentials",
        values: Object.entries(requiredFields).map(([field, { value }]) => ({ field, value, overrides: [] })),
        secrets: [{ field: "password", value: "stored-password", overrides: [] }]
    }
    let write: ReturnType<typeof vi.fn>
    let services: ReturnType<typeof vi.fn>

    beforeEach(() => {
        allowAccess()
        vi.spyOn(Resource, "findById").mockResolvedValue(resource as never)
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: development }, { _id: production }] as never)
        services = vi.spyOn(Service, "find").mockResolvedValue([] as never) as unknown as ReturnType<typeof vi.fn>
        write = vi.spyOn(Resource, "findByIdAndUpdate").mockResolvedValue(resource as never) as unknown as ReturnType<typeof vi.fn>
    })

    const update = (changes: object) => new ResourceService().update(String(resourceId), changes)

    it("given another type, when it is updated, then it is refused and nothing is written", async () => {
        await expect(update({ type: "storage" })).rejects.toMatchObject({ code: "RESOURCE_TYPE_IMMUTABLE" })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a description only, when it is updated, then neither the environments nor the services are read", async () => {
        await update({ description: "Main Postgres", type: "database" })

        expect(Environment.find).not.toHaveBeenCalled()
        expect(services).not.toHaveBeenCalled()
        expect(write.mock.calls[0][1]).toEqual({ $set: { description: "Main Postgres" } })
    })

    it("given update operators and fields that are not of a resource in the body, when it is updated, then none of them is written", async () => {
        await update({ description: "Main", projectId: new Types.ObjectId().toString(), $set: { projectId: new Types.ObjectId().toString() }, values: [{ field: "password", value: "in-the-clear" }] })

        expect(write.mock.calls[0][1]).toEqual({ $set: { description: "Main" } })
    })

    it("given the password sent back as the placeholder, when it is updated, then the stored one is written again", async () => {
        await update({ fields: { password: { value: SECRET_PLACEHOLDER } } })

        expect(write.mock.calls[0][1].$set.secrets).toEqual([{ field: "password", value: "stored-password", overrides: [] }])
    })

    it("given a new host with the password sent back as the placeholder, when it is updated, then it is refused and nothing is written", async () => {
        await expect(update({ fields: { host: { value: "evil.example.com" }, password: { value: SECRET_PLACEHOLDER } } })).rejects.toMatchObject({
            code: "RESOURCE_SECRET_REENTRY_REQUIRED",
            details: { secrets: ["password"], connections: ["host"] }
        })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a new host with the password typed again, when it is updated, then both are written", async () => {
        await update({ fields: { host: { value: "db2.internal" }, password: { value: "new-password" } } })

        expect(write.mock.calls[0][1].$set.secrets).toEqual([{ field: "password", value: "new-password", overrides: [] }])
        expect(write.mock.calls[0][1].$set.values).toContainEqual({ field: "host", value: "db2.internal", overrides: [] })
    })

    it("given another variant keeping a credential of the same name, when it is updated without it, then it is refused", async () => {
        vi.mocked(Resource.findById).mockResolvedValue({
            ...resource,
            name: "assistant",
            type: "ai",
            variant: "anthropic",
            values: [{ field: "model", value: "claude-opus-5-5", overrides: [] }],
            secrets: [{ field: "apiKey", value: "sk-stored", overrides: [] }]
        } as never)

        await expect(update({ variant: "openai", fields: { model: { value: "gpt-5" } } })).rejects.toMatchObject({ code: "RESOURCE_SECRET_REENTRY_REQUIRED", details: { connections: ["variant"] } })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a blank prefix, when it is updated, then it goes back to the derived one", async () => {
        await update({ envPrefix: "" })

        expect(write.mock.calls[0][1]).toEqual({ $set: { envPrefix: null } })
    })

    it("given a rename to variables a config map of an attaching service sets, when it is updated, then it is refused and nothing is written", async () => {
        services.mockResolvedValue([{ name: "Billing API", configMapIds: [configMapId], secretIds: [], resourceIds: [resourceId] }])
        vi.spyOn(ConfigMap, "find").mockResolvedValue([{ _id: configMapId, name: "billing", entries: [{ key: "DB_BILLING_HOST" }] }] as never)
        vi.spyOn(Secret, "find").mockResolvedValue([] as never)
        vi.spyOn(Resource, "find").mockResolvedValue([resource] as never)

        await expect(update({ name: "billing" })).rejects.toMatchObject({ code: "SERVICE_VARIABLE_KEY_DUPLICATED", details: { key: "DB_BILLING_HOST", service: "Billing API" } })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a rename no other variable of the attaching services clashes with, when it is updated, then it is written", async () => {
        services.mockResolvedValue([{ name: "Billing API", configMapIds: [configMapId], secretIds: [], resourceIds: [resourceId] }])
        vi.spyOn(ConfigMap, "find").mockResolvedValue([{ _id: configMapId, name: "billing", entries: [{ key: "DB_ORDERS_HOST" }] }] as never)
        vi.spyOn(Secret, "find").mockResolvedValue([] as never)
        vi.spyOn(Resource, "find").mockResolvedValue([resource] as never)

        await update({ name: "billing" })

        expect(write.mock.calls[0][1]).toEqual({ $set: { name: "billing" } })
    })

    it("given a name already taken, when it is renamed, then the unique index error is refused as RESOURCE_NAME_TAKEN", async () => {
        write.mockRejectedValue({ code: 11000 })

        await expect(update({ name: "billing" })).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" })
    })
})

describe("ensureValidApiSpec", () => {
    it.each([
        ["an OpenAPI document in JSON", JSON.stringify({ openapi: "3.1.0", info: { title: "Payments" }, paths: {} })],
        ["a Swagger document in YAML", "swagger: '2.0'\ninfo:\n  title: Payments\npaths: {}\n"]
    ])("given %s, when it is checked, then it is accepted", (_case, spec) => {
        expect(() => ensureValidApiSpec(spec)).not.toThrow()
    })

    it.each([
        ["an OpenAPI version written as a number in YAML", "openapi: 3.1\ninfo:\n  title: Payments\npaths: {}\n"],
        ["a Swagger version written as a number in YAML", "swagger: 2.0\npaths: {}\n"],
        ["an OpenAPI version written as a number in JSON", JSON.stringify({ openapi: 3.1, paths: {} })]
    ])("given %s, when it is checked, then it is accepted as read_api_spec reads it", (_case, spec) => {
        expect(() => ensureValidApiSpec(spec)).not.toThrow()
        expect(() => parseApiDocument(spec)).not.toThrow()
    })

    it("given a YAML mapping of 40 000 keys, when it is checked, then it is parsed in well under 2 seconds", () => {
        const spec = `openapi: 3.0.0\npaths:\n${Array.from({ length: 40_000 }, (_, index) => `  /p${index}: {}`).join("\n")}\n`
        expect(Buffer.byteLength(spec)).toBeGreaterThan(400 * 1024)
        expect(Buffer.byteLength(spec)).toBeLessThan(1024 * 1024)

        const started = performance.now()
        ensureValidApiSpec(spec)

        expect(performance.now() - started).toBeLessThan(2000)
    })

    it("given YAML past 1 MiB, when it is checked, then it is refused without being parsed, while JSON that size is read", () => {
        const yaml = `openapi: 3.0.0\ninfo:\n  description: ${"x".repeat(1024 * 1024)}\n`

        expect(() => ensureValidApiSpec(yaml)).toThrow(expect.objectContaining({ code: "RESOURCE_API_SPEC_INVALID", message: expect.stringContaining("1 MiB") }))
        expect(() => ensureValidApiSpec(JSON.stringify({ openapi: "3.0.0", info: { description: "x".repeat(1024 * 1024) } }))).not.toThrow()
    })

    it.each([
        ["text that is neither JSON nor YAML", "openapi: [3.1"],
        ["a document with no openapi nor swagger at its root", JSON.stringify({ info: { openapi: "3.1.0" } })],
        ["a list", "- openapi: 3.1.0"],
        ["a document past 5 MiB", `{"openapi":"3.1.0","x":"${"x".repeat(5 * 1024 * 1024)}"}`]
    ])("given %s, when it is checked, then it is refused", (_case, spec) => {
        expect(() => ensureValidApiSpec(spec)).toThrow(expect.objectContaining({ code: "RESOURCE_API_SPEC_INVALID" }))
    })
})

describe("the API document of a resource", () => {
    const resourceId = new Types.ObjectId()
    const spec = JSON.stringify({ openapi: "3.1.0", info: { title: "Pagamenti è" }, paths: {} })
    const api = { _id: resourceId, projectId, name: "payments", type: "api", variant: "none", values: [{ field: "baseUrl", value: "https://payments.example.com", overrides: [] }], secrets: [] }
    const apiFields = { baseUrl: { value: "https://payments.example.com" } }

    beforeEach(() => {
        allowAccess()
        vi.spyOn(Environment, "find").mockResolvedValue([{ _id: development }] as never)
        vi.spyOn(Service, "find").mockResolvedValue([] as never)
    })

    it("given a document, when an api is created, then it is written with its size in bytes", async () => {
        const create = vi.spyOn(Resource, "create").mockImplementation((async (document: unknown) => document) as never)

        await new ResourceService().create({ name: "payments", type: "api", variant: "none", fields: apiFields, apiSpec: spec }, projectId)

        expect(create.mock.calls[0][0]).toMatchObject({ apiSpec: spec, apiSpecBytes: Buffer.byteLength(spec, "utf8") })
    })

    it("given a document, when a resource of another type is created, then it is refused and nothing is written", async () => {
        const create = vi.spyOn(Resource, "create")

        await expect(new ResourceService().create({ name: "orders", type: "database", variant: "credentials", fields: requiredFields, apiSpec: spec }, projectId)).rejects.toMatchObject({
            code: "RESOURCE_API_SPEC_INVALID"
        })
        expect(create).not.toHaveBeenCalled()
    })

    it("given null, when an api is updated, then its document and its size are removed", async () => {
        vi.spyOn(Resource, "findById").mockResolvedValue(api as never)
        const write = vi.spyOn(Resource, "findByIdAndUpdate").mockResolvedValue(api as never)

        await new ResourceService().update(String(resourceId), { apiSpec: null })

        expect(write.mock.calls[0][1]).toEqual({ $set: {}, $unset: { apiSpec: "", apiSpecBytes: "" } })
    })

    it("given a new document, when an api is updated, then it replaces the stored one with its size", async () => {
        vi.spyOn(Resource, "findById").mockResolvedValue(api as never)
        const write = vi.spyOn(Resource, "findByIdAndUpdate").mockResolvedValue(api as never)

        await new ResourceService().update(String(resourceId), { apiSpec: spec })

        expect(write.mock.calls[0][1]).toEqual({ $set: { apiSpec: spec, apiSpecBytes: Buffer.byteLength(spec, "utf8") } })
    })

    it("given an api with a document, when it is asked for, then it is read apart and returned as typed", async () => {
        const read = vi
            .spyOn(Resource, "findById")
            .mockResolvedValueOnce(api as never)
            .mockResolvedValueOnce({ ...api, apiSpec: spec } as never)

        expect(await new ResourceService().getApiSpec(String(resourceId))).toBe(spec)
        expect(read).toHaveBeenLastCalledWith(resourceId, "+apiSpec")
    })

    it("given an api with no document, when it is asked for, then it is not found", async () => {
        vi.spyOn(Resource, "findById").mockResolvedValue(api as never)

        await expect(new ResourceService().getApiSpec(String(resourceId))).rejects.toMatchObject({ statusCode: 404 })
    })
})

describe("ResourceService.delete", () => {
    const resourceId = new Types.ObjectId()

    beforeEach(() => {
        allowAccess()
        vi.spyOn(Resource, "findById").mockResolvedValue({ _id: resourceId, projectId, name: "orders", type: "database", variant: "credentials" } as never)
    })

    it("given a resource a service attaches, when it is deleted, then it is refused with the service named", async () => {
        vi.spyOn(Service, "find").mockResolvedValue([{ name: "Orders API" }] as never)
        const remove = vi.spyOn(Resource, "findByIdAndDelete")

        await expect(new ResourceService().delete(String(resourceId))).rejects.toMatchObject({ code: "RESOURCE_IN_USE", statusCode: 409, details: { services: ["Orders API"] } })
        expect(remove).not.toHaveBeenCalled()
    })

    it("given a resource no service attaches, when it is deleted, then it is gone", async () => {
        vi.spyOn(Service, "find").mockResolvedValue([] as never)
        const remove = vi.spyOn(Resource, "findByIdAndDelete").mockResolvedValue(null)

        await new ResourceService().delete(String(resourceId))

        expect(remove).toHaveBeenCalledWith(resourceId)
    })
})

describe("domain scope", () => {
    const ownDomain = new Types.ObjectId()
    const otherDomain = new Types.ObjectId()
    const own = new Types.ObjectId()
    const shared = new Types.ObjectId()

    beforeEach(() => {
        vi.spyOn(Service, "find").mockResolvedValue([
            { domainId: ownDomain, resourceIds: [own, shared] },
            { domainId: otherDomain, resourceIds: [shared] }
        ] as never)
    })

    it("given a resource shared with a service of another domain, when the resources in scope are listed, then only the one of the domain is", async () => {
        expect(await resourceIdsInScope(projectId as never, [String(ownDomain)])).toEqual(new Set([String(own)]))
    })

    it("given a resource of another domain, when a domain-scoped member attaches it, then it is forbidden", async () => {
        await expect(ensureAttachableResources([String(ownDomain)], projectId as never, { resourceIds: [String(shared)] })).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
    })

    it("given a resource the service already attaches, when a domain-scoped member saves it, then nothing is read", async () => {
        await ensureAttachableResources([String(ownDomain)], projectId as never, { resourceIds: [String(shared)] }, { resourceIds: [shared] })

        expect(Service.find).not.toHaveBeenCalled()
    })

    it("given a service attaching a resource the member cannot see, when they save it without, then it stays attached after theirs", async () => {
        const saved = await withResourcesOutOfScope([String(ownDomain)], projectId as never, { name: "Orders", resourceIds: [] as unknown[] }, { resourceIds: [own, shared] })

        // The one they see they may take away; the one shared with another domain stays
        expect(saved).toEqual({ name: "Orders", resourceIds: [shared] })
    })

    it("given no list of resources, or a member of the whole project, when the service is saved, then the list is left as sent and nothing is read", async () => {
        const dto = { resourceIds: [String(own)] }

        const withoutList: { name: string; resourceIds?: unknown[] } = { name: "Orders" }

        expect(await withResourcesOutOfScope([String(ownDomain)], projectId as never, withoutList, { resourceIds: [shared] })).toEqual({ name: "Orders" })
        expect(await withResourcesOutOfScope(undefined, projectId as never, dto, { resourceIds: [shared] })).toBe(dto)
        expect(Service.find).not.toHaveBeenCalled()
    })

    it("given a member of the whole project, when resources are attached, then nothing is read", async () => {
        await ensureAttachableResources(undefined, projectId as never, { resourceIds: [String(shared)] })

        expect(Service.find).not.toHaveBeenCalled()
    })

    it("given a domain-scoped member, when a resource shared with another domain is read, then it is forbidden", async () => {
        allowAccess()
        vi.spyOn(ResourceService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(ownDomain)])
        vi.spyOn(Resource, "findById").mockResolvedValue({ _id: shared, projectId, name: "orders" } as never)

        await expect(new ResourceService().getById(String(shared))).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
    })
})
