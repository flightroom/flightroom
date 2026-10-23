import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { transformDocument } from "../utils/encryptedFieldsPlugin"
import { decryptSecret, encryptSecret, isEncryptedSecret, resetSecretEncryptionKeyCache, SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import Resource, { RESOURCE_SECRET_PATHS } from "./ResourceModel"

const projectId = new Types.ObjectId()

describe("Resource model", () => {
    it("given a name with capitals and spaces, when it is built, then it is stored trimmed and lowercase, with no values", async () => {
        const resource = new Resource({ projectId, name: "  Orders-Database ", type: "database", variant: "credentials" })

        expect(resource.name).toBe("orders-database")
        expect(resource.values).toEqual([])
        expect(resource.secrets).toEqual([])
        await expect(resource.validate()).resolves.toBeUndefined()
    })

    it.each([["-orders"], ["orders_db"], ["x".repeat(64)]])("given the name %j, when it is validated, then it is refused", async name => {
        await expect(new Resource({ projectId, name, type: "database", variant: "credentials" }).validate()).rejects.toMatchObject({ errors: { name: expect.anything() } })
    })

    it("given a type the catalog does not have, when it is validated, then it is refused", async () => {
        await expect(new Resource({ projectId, name: "orders", type: "queue", variant: "default" }).validate()).rejects.toMatchObject({ errors: { type: expect.anything() } })
    })

    it.each([["db"], ["1DB"], ["DB-ORDERS"]])("given the prefix %j, when it is validated, then it is refused", async envPrefix => {
        await expect(new Resource({ projectId, name: "orders", type: "database", variant: "credentials", envPrefix }).validate()).rejects.toMatchObject({
            errors: { envPrefix: expect.anything() }
        })
    })

    it("given a resource of a catalog type, when it is built, then it carries no custom fields", () => {
        expect(new Resource({ projectId, name: "orders", type: "database", variant: "credentials" }).toObject()).not.toHaveProperty("customFields")
    })

    it.each([["token"], ["API-KEY"], [""]])("given a generic defining the variable %j, when it is validated, then it is refused", async name => {
        await expect(new Resource({ projectId, name: "billing", type: "generic", variant: "custom", customFields: [{ name }] }).validate()).rejects.toMatchObject({
            errors: { "customFields.0.name": expect.anything() }
        })
    })

    it("given a generic, when it is serialised, then the variables it sets are those it defines", () => {
        const generic = new Resource({ projectId, name: "billing", type: "generic", variant: "custom", customFields: [{ name: "TOKEN", secret: true }] })

        const json = JSON.parse(JSON.stringify(generic))

        expect(json.customFields).toEqual([{ name: "TOKEN", secret: true }])
        expect(json.env).toEqual([{ key: "RES_BILLING_TOKEN", field: "TOKEN", secret: true, required: false }])
    })

    it("declares the name unique inside its project", () => {
        expect(Resource.schema.indexes()).toContainEqual([{ name: 1, projectId: 1 }, expect.objectContaining({ unique: true })])
    })
})

describe("serialisation", () => {
    const environmentId = new Types.ObjectId()

    const resource = () =>
        new Resource({
            projectId,
            name: "orders",
            type: "database",
            variant: "credentials",
            values: [
                { field: "host", value: "db.internal", overrides: [{ environmentId, value: "db.prod.internal" }] },
                { field: "port", overrides: [{ environmentId, value: "5433" }] }
            ],
            secrets: [{ field: "password", value: "hunter2", overrides: [{ environmentId, value: "prod-password" }] }]
        })

    it("given values and credentials, when it is serialised, then they come out as one map of fields with every credential as the placeholder", () => {
        const json = JSON.parse(JSON.stringify(resource()))

        expect(json.fields).toEqual({
            host: { value: "db.internal", overrides: [{ environmentId: String(environmentId), value: "db.prod.internal" }] },
            port: { overrides: [{ environmentId: String(environmentId), value: "5433" }] },
            password: { value: SECRET_PLACEHOLDER, overrides: [{ environmentId: String(environmentId), value: SECRET_PLACEHOLDER }] }
        })
        expect(json).not.toHaveProperty("values")
        expect(json).not.toHaveProperty("secrets")
        expect(JSON.stringify(json)).not.toContain("hunter2")
        expect(JSON.stringify(json)).not.toContain("prod-password")
    })

    it("given a credential set only in one environment, when it is serialised, then it has no value of all and the document keeps it", () => {
        const document = resource()
        document.secrets = [{ field: "password", overrides: [{ environmentId, value: "prod-password" }] }] as never

        const json = JSON.parse(JSON.stringify(document))

        expect(json.fields.password).toEqual({ overrides: [{ environmentId: String(environmentId), value: SECRET_PLACEHOLDER }] })
        expect(document.secrets[0].overrides[0].value).toBe("prod-password")
    })

    it("given an api with a document, when it is serialised, then only whether there is one and its size come out", () => {
        const api = new Resource({ projectId, name: "payments", type: "api", variant: "none", apiSpec: '{"openapi":"3.1.0"}', apiSpecBytes: 19 })

        const json = JSON.parse(JSON.stringify(api))

        expect(json.apiSpec).toEqual({ present: true, bytes: 19 })
        expect(json).not.toHaveProperty("apiSpecBytes")
        expect(JSON.parse(JSON.stringify(resource())).apiSpec).toEqual({ present: false, bytes: 0 })
    })

    it("declares the API document out of every read that does not ask for it", () => {
        expect(Resource.schema.path("apiSpec").options.select).toBe(false)
    })

    it("given a resource, when it is serialised, then the variables it sets come with it", () => {
        const json = JSON.parse(JSON.stringify(resource()))

        expect(json.env).toContainEqual({ key: "DB_ORDERS_PASSWORD", field: "password", secret: true, required: true })
        expect(json.env).toHaveLength(8)
    })
})

describe("Resource model with a key configured", () => {
    const originalKey = process.env.SECRETS_ENCRYPTION_KEY

    beforeEach(() => {
        process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
        resetSecretEncryptionKeyCache()
    })

    afterEach(() => {
        if (originalKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY
        else process.env.SECRETS_ENCRYPTION_KEY = originalKey
        resetSecretEncryptionKeyCache()
    })

    it("given a credential with an override, when it is encrypted and decrypted, then both go through it and the plain values do not", () => {
        const options = { model: "Resource", paths: RESOURCE_SECRET_PATHS }
        const resource = new Resource({
            projectId,
            name: "orders",
            type: "database",
            variant: "credentials",
            values: [{ field: "host", value: "db.internal" }],
            secrets: [{ field: "password", value: "dev-password", overrides: [{ environmentId: new Types.ObjectId(), value: "prod-password" }] }]
        })

        transformDocument(resource, options, encryptSecret)

        expect(isEncryptedSecret(resource.secrets[0].value)).toBe(true)
        expect(isEncryptedSecret(resource.secrets[0].overrides[0].value)).toBe(true)
        expect(resource.values[0].value).toBe("db.internal")

        transformDocument(resource, options, decryptSecret)

        expect(resource.secrets[0].value).toBe("dev-password")
        expect(resource.secrets[0].overrides[0].value).toBe("prod-password")
    })
})
