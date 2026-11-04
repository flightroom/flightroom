import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CosmosMongoProvisioner } from "../client/CosmosMongoProvisioner"
import { AtlasProvisioner, MongoDbProvisioner } from "../client/MongoProvisioner"
import { BusinessException } from "../errors/BusinessException"
import MongoServer, { MongoServerProvider } from "../models/MongoServerModel"
import ProvisionedDatabase from "../models/ProvisionedDatabaseModel"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import BaseAuthorizedService from "./BaseAuthorizedService"
import MongoServerService, { addressOf, normalizeMongoServerConnection, provisionerOf, toMongoServerConnection } from "./MongoServerService"

const ADMIN_URI = "mongodb://root:root-pw@db.internal:27017/admin?authSource=admin"
const atlas = { clientId: "mdb_sa_id", clientSecret: "mdb_sa_sk_secret", groupId: "5f1a2b3c4d5e6f7a8b9c0d1e", clusterName: "Cluster0" }

const cosmos = {
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "66666666-7777-8888-9999-000000000000",
    clientSecret: "entra-secret",
    subscriptionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    resourceGroup: "rg-data",
    accountName: "flightroom-mongo"
}
const storedCosmos = { provider: MongoServerProvider.COSMOS_MONGO_RU, connection: cosmos }

const storedMongo = { provider: MongoServerProvider.MONGODB, connection: { connectionString: ADMIN_URI } }
const storedAtlas = { provider: MongoServerProvider.ATLAS, connection: atlas }

const codeOf = (run: () => unknown): string | undefined => {
    try {
        run()
    } catch (error) {
        return (error as BusinessException).code
    }
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("normalizeMongoServerConnection", () => {
    it("given an admin URI, when it is normalized, then it is trimmed and kept whole", () => {
        expect(normalizeMongoServerConnection(MongoServerProvider.MONGODB, { connectionString: ` ${ADMIN_URI} `, clientId: "ignored" })).toEqual({ connectionString: ADMIN_URI })
    })

    /** The form submits every field, including the one it only ever received as bullets */
    it("given the placeholder came back for a MONGODB server, when it is updated, then the stored URI is kept", () => {
        expect(normalizeMongoServerConnection(MongoServerProvider.MONGODB, { connectionString: SECRET_PLACEHOLDER }, storedMongo)).toEqual({ connectionString: ADMIN_URI })
    })

    it("given the placeholder with nothing stored, when it is normalized, then the URI has to be typed", () => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.MONGODB, { connectionString: SECRET_PLACEHOLDER }))).toBe("MONGO_SERVER_SECRET_REQUIRED")
    })

    it("given a switch from Atlas to MONGODB, when the placeholder is submitted, then the secret of Atlas does not stand in for the URI", () => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.MONGODB, { connectionString: SECRET_PLACEHOLDER }, storedAtlas))).toBe("MONGO_SERVER_SECRET_REQUIRED")
    })

    it("given a URI that is not a MongoDB one, when it is normalized, then it is refused without quoting it", () => {
        let message = ""
        try {
            normalizeMongoServerConnection(MongoServerProvider.MONGODB, { connectionString: "postgres://root:root-pw@db/orders" })
        } catch (error) {
            message = (error as BusinessException).message
        }
        expect(message).toContain("not a mongodb://")
        expect(message).not.toContain("root-pw")
    })

    it("given a URI shaped like a ciphertext, when it is normalized, then it is refused", () => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.MONGODB, { connectionString: "enc:v1:abc" }))).toBe("MONGO_SERVER_CONNECTION_INVALID")
    })

    it("given no URI, when it is normalized, then it is required", () => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.MONGODB, {}))).toBe("MONGO_SERVER_CONNECTION_INVALID")
    })

    it("given an Atlas service account, when it is normalized, then only its four fields are kept", () => {
        expect(normalizeMongoServerConnection(MongoServerProvider.ATLAS, { ...atlas, connectionString: "ignored" })).toEqual(atlas)
    })

    it("given the placeholder for the same service account, Atlas project and cluster, when it is updated, then the stored secret is kept", () => {
        expect(normalizeMongoServerConnection(MongoServerProvider.ATLAS, { ...atlas, clientSecret: SECRET_PLACEHOLDER }, storedAtlas)).toMatchObject({
            clientSecret: "mdb_sa_sk_secret"
        })
    })

    /** Otherwise whoever may edit the server could point the stored secret at a project of their own */
    it.each([
        ["clientId", { clientId: "another-id" }],
        ["groupId", { groupId: "aaaaaaaaaaaaaaaaaaaaaaaa" }],
        ["clusterName", { clusterName: "Other" }]
    ])("given the %s changed, when the placeholder is submitted, then the secret has to be typed again", (_field, change) => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.ATLAS, { ...atlas, ...change, clientSecret: SECRET_PLACEHOLDER }, storedAtlas))).toBe("MONGO_SERVER_SECRET_REQUIRED")
    })

    it.each([
        ["a groupId that is not an Atlas id", { groupId: "my-project" }],
        ["a cluster name with spaces", { clusterName: "my cluster" }],
        ["no client id", { clientId: " " }],
        ["no secret", { clientSecret: "" }]
    ])("given %s, when it is normalized, then it is refused", (_case, change) => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.ATLAS, { ...atlas, ...change }))).toBe("MONGO_SERVER_CONNECTION_INVALID")
    })
})

describe("normalizeMongoServerConnection of a Cosmos DB account", () => {
    it("given a service principal and an account, when it is normalized, then only its six fields are kept", () => {
        expect(normalizeMongoServerConnection(MongoServerProvider.COSMOS_MONGO_RU, { ...cosmos, groupId: "ignored" })).toEqual(cosmos)
    })

    it("given the placeholder for the same tenant, subscription, group and account, when it is updated, then the stored secret is kept", () => {
        expect(normalizeMongoServerConnection(MongoServerProvider.COSMOS_MONGO_RU, { ...cosmos, clientSecret: SECRET_PLACEHOLDER }, storedCosmos)).toMatchObject({ clientSecret: "entra-secret" })
    })

    it.each([
        ["tenantId", { tenantId: "99999999-2222-3333-4444-555555555555" }],
        ["clientId", { clientId: "99999999-7777-8888-9999-000000000000" }],
        ["subscriptionId", { subscriptionId: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee" }],
        ["resourceGroup", { resourceGroup: "rg-other" }],
        ["accountName", { accountName: "other-account" }]
    ])("given the %s changed, when the placeholder is submitted, then the secret has to be typed again", (_field, change) => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.COSMOS_MONGO_RU, { ...cosmos, ...change, clientSecret: SECRET_PLACEHOLDER }, storedCosmos))).toBe(
            "MONGO_SERVER_SECRET_REQUIRED"
        )
    })

    it.each([
        ["a tenant that is not a GUID", { tenantId: "contoso.onmicrosoft.com" }],
        ["a subscription that is not a GUID", { subscriptionId: "prod" }],
        ["an account name with capitals", { accountName: "Flightroom" }],
        ["an account name too short", { accountName: "ab" }],
        ["a resource group ending with a dot", { resourceGroup: "rg." }]
    ])("given %s, when it is normalized, then it is refused", (_case, change) => {
        expect(codeOf(() => normalizeMongoServerConnection(MongoServerProvider.COSMOS_MONGO_RU, { ...cosmos, ...change }))).toBe("MONGO_SERVER_CONNECTION_INVALID")
    })
})

describe("addressOf", () => {
    it("given the same hosts with other credentials, when the addresses are compared, then they are the same", () => {
        expect(addressOf({ provider: MongoServerProvider.MONGODB, connection: { connectionString: "mongodb://admin:new@DB.internal:27017/admin" } })).toBe(addressOf(storedMongo))
    })

    it.each([
        ["another host", { provider: MongoServerProvider.MONGODB, connection: { connectionString: "mongodb://root:root-pw@db2.internal:27017/admin" } }],
        ["+srv in place of the hosts", { provider: MongoServerProvider.MONGODB, connection: { connectionString: "mongodb+srv://root:root-pw@db.internal:27017/admin" } }],
        ["another provider", storedAtlas]
    ])("given %s, when the addresses are compared, then they differ", (_case, other) => {
        expect(addressOf(other as never)).not.toBe(addressOf(storedMongo))
    })

    it("given an Atlas project and a Cosmos DB account, when their address is read, then it names them without the secret", () => {
        expect(addressOf(storedAtlas)).toBe("ATLAS:5f1a2b3c4d5e6f7a8b9c0d1e/Cluster0")
        expect(addressOf(storedCosmos)).toBe("COSMOS_MONGO_RU:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/rg-data/flightroom-mongo")
    })
})

describe("toMongoServerConnection", () => {
    it("given an unknown provider, when it is read, then it is refused", () => {
        expect(codeOf(() => toMongoServerConnection({ provider: "COSMOS" as MongoServerProvider, connection: { connectionString: ADMIN_URI } }))).toBe("MONGO_SERVER_PROVIDER_INVALID")
    })

    it.each([
        [MongoServerProvider.MONGODB, { connectionString: ADMIN_URI }, MongoDbProvisioner],
        [MongoServerProvider.ATLAS, atlas, AtlasProvisioner],
        [MongoServerProvider.COSMOS_MONGO_RU, cosmos, CosmosMongoProvisioner]
    ])("given a %s server, when its provisioner is built, then it is the one of its provider", (provider, connection, kind) => {
        expect(provisionerOf(toMongoServerConnection({ provider, connection }))).toBeInstanceOf(kind)
    })
})

describe("MongoServerService", () => {
    const projectId = new Types.ObjectId()
    const serverId = new Types.ObjectId()

    beforeEach(() => {
        const base = BaseAuthorizedService.prototype as unknown as Record<string, () => Promise<void>>
        vi.spyOn(base, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(base, "ensureNotViewer").mockResolvedValue(undefined)
        vi.spyOn(base, "ensureWholeProject").mockResolvedValue(undefined)
        vi.spyOn(MongoServer, "findById").mockResolvedValue({ _id: serverId, projectId, name: "Shared cluster", ...storedMongo } as never)
    })

    it("given a server with databases created on it, when it is deleted, then it is refused and nothing is removed", async () => {
        vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(2 as never)
        const remove = vi.spyOn(MongoServer, "deleteOne")

        await expect(new MongoServerService().delete(String(serverId))).rejects.toMatchObject({ code: "MONGO_SERVER_IN_USE", statusCode: 409 })
        expect(remove).not.toHaveBeenCalled()
    })

    it("given a server with no database, when it is deleted, then it is gone", async () => {
        vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(0 as never)
        const remove = vi.spyOn(MongoServer, "deleteOne").mockResolvedValue({} as never)

        await new MongoServerService().delete(String(serverId))

        expect(remove).toHaveBeenCalledWith({ _id: serverId })
    })

    it("given a server with databases, when its admin password is rotated at the same address, then it is saved", async () => {
        const save = vi.fn().mockResolvedValue({})
        vi.mocked(MongoServer.findById).mockResolvedValue({ _id: serverId, projectId, name: "Shared cluster", ...storedMongo, set: vi.fn(), save } as never)
        const count = vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(3 as never)

        await new MongoServerService().update(String(serverId), {
            name: "Shared cluster",
            provider: MongoServerProvider.MONGODB,
            connection: { connectionString: "mongodb://root:rotated@db.internal:27017/admin" }
        })

        expect(save).toHaveBeenCalled()
        expect(count).not.toHaveBeenCalled()
    })

    it.each([
        ["another host", { provider: MongoServerProvider.MONGODB, connection: { connectionString: "mongodb://root:root-pw@elsewhere.internal/admin" } }],
        ["another provider", { provider: MongoServerProvider.ATLAS, connection: atlas }]
    ])("given a server with databases, when it is moved to %s, then it is refused and nothing is saved", async (_case, change) => {
        const save = vi.fn()
        vi.mocked(MongoServer.findById).mockResolvedValue({ _id: serverId, projectId, name: "Shared cluster", ...storedMongo, set: vi.fn(), save } as never)
        vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(3 as never)

        await expect(new MongoServerService().update(String(serverId), { name: "Shared cluster", ...change } as never)).rejects.toMatchObject({ code: "MONGO_SERVER_IN_USE", statusCode: 409 })
        expect(save).not.toHaveBeenCalled()
    })

    it("given a server with no database, when it is moved to another host, then it is saved", async () => {
        const save = vi.fn().mockResolvedValue({})
        vi.mocked(MongoServer.findById).mockResolvedValue({ _id: serverId, projectId, name: "Shared cluster", ...storedMongo, set: vi.fn(), save } as never)
        vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(0 as never)

        await new MongoServerService().update(String(serverId), {
            name: "Shared cluster",
            provider: MongoServerProvider.MONGODB,
            connection: { connectionString: "mongodb://root:pw@elsewhere.internal/admin" }
        })

        expect(save).toHaveBeenCalled()
    })

    it("given a saved server whose test fails quoting its password, when it is tested with the placeholder, then the stored URI is used and the password is blanked", async () => {
        const test = vi.spyOn(MongoDbProvisioner.prototype, "test").mockRejectedValue(new Error("Authentication failed for root:root-pw"))

        const result = await new MongoServerService().testConnection(
            { name: "x", provider: MongoServerProvider.MONGODB, connection: { connectionString: SECRET_PLACEHOLDER } },
            { serverId: String(serverId) }
        )

        expect(test).toHaveBeenCalled()
        expect(result).toEqual({ ok: false, message: "Authentication failed for root:•••" })
    })

    it("given a domain-scoped member, when a server is created, then it is forbidden and nothing is written", async () => {
        vi.mocked((BaseAuthorizedService.prototype as unknown as Record<string, () => Promise<void>>).ensureWholeProject).mockRejectedValue(
            Object.assign(new Error("forbidden"), { code: "DOMAIN_SCOPE_FORBIDDEN" })
        )
        const create = vi.spyOn(MongoServer, "create")

        await expect(new MongoServerService().create(String(projectId), { name: "x", ...storedMongo })).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        expect(create).not.toHaveBeenCalled()
    })
})

describe("MongoServer.toFrontendObject", () => {
    it.each([
        ["MONGODB", storedMongo, "connectionString"],
        ["ATLAS", storedAtlas, "clientSecret"]
    ])("given a %s server, when it is sent to the console, then its credential is the placeholder and the rest stays readable", (_provider, stored, key) => {
        const connection = new MongoServer({ projectId: new Types.ObjectId(), name: "Shared", ...stored }).toFrontendObject().connection as Record<string, unknown>

        expect(connection[key]).toBe(SECRET_PLACEHOLDER)
        if (stored === storedAtlas) expect(connection).toMatchObject({ clientId: "mdb_sa_id", groupId: atlas.groupId, clusterName: "Cluster0" })
    })
})
