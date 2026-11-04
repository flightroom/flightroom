import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MongoDbProvisioner } from "../client/MongoProvisioner"
import { testDatabaseConnection } from "../client/SqlDatabaseClient"
import { BusinessException } from "../errors/BusinessException"
import Database, { DatabaseConnection, DatabaseType, IDatabase } from "../models/DatabaseModel"
import ProvisionedDatabase from "../models/ProvisionedDatabaseModel"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import BaseAuthorizedService from "./BaseAuthorizedService"
import DatabaseService, { addressOf, normalizeConnection, toConnection } from "./DatabaseService"

// No SQL driver is loaded: a test says what the driver answers
vi.mock("../client/SqlDatabaseClient", () => ({ testDatabaseConnection: vi.fn() }))

const credentials = (password: string) => ({ authType: "credentials", host: " db.internal ", port: "5432", database: "orders", username: "app", password, ssl: true })

const stored: DatabaseConnection = { authType: "credentials", host: "db.internal", port: 5432, database: "orders", username: "app", password: "the-real-password", ssl: true }

const codeOf = (run: () => unknown): string | undefined => {
    try {
        run()
    } catch (error) {
        return (error as BusinessException).code
    }
}

describe("normalizeConnection", () => {
    it("given credentials, when they are normalized, then the address is trimmed and the port is a number", () => {
        expect(normalizeConnection(credentials("secret"))).toEqual({ authType: "credentials", host: "db.internal", port: 5432, database: "orders", username: "app", password: "secret", ssl: true })
    })

    /** The form submits every field, including the one it only ever received as bullets. */
    it("given the placeholder came back, when the database is updated, then the stored password is kept", () => {
        expect(normalizeConnection(credentials(SECRET_PLACEHOLDER), stored)).toMatchObject({ password: "the-real-password" })
    })

    it("given no database to take it from, when the placeholder is submitted, then the password has to be typed", () => {
        expect(codeOf(() => normalizeConnection(credentials(SECRET_PLACEHOLDER)))).toBe("DATABASE_SECRET_REQUIRED")
    })

    it("given a switch to a connection string, when the placeholder is submitted, then the stored password does not stand in for it", () => {
        expect(codeOf(() => normalizeConnection({ authType: "connectionString", connectionString: SECRET_PLACEHOLDER }, stored))).toBe("DATABASE_SECRET_REQUIRED")
    })

    /** Otherwise whoever may edit the database could send the stored password to a host of their own */
    it.each([
        ["host", { host: "attacker.example" }],
        ["port", { port: "6543" }],
        ["database", { database: "other" }],
        ["username", { username: "admin" }]
    ])("given the %s changed, when the placeholder is submitted, then the password has to be typed again", (_field, change) => {
        expect(codeOf(() => normalizeConnection({ ...credentials(SECRET_PLACEHOLDER), ...change }, stored))).toBe("DATABASE_SECRET_REQUIRED")
    })

    it("given the address changed, when a new password is typed, then it is accepted", () => {
        expect(normalizeConnection({ ...credentials("new-password"), host: "replica.internal" }, stored)).toMatchObject({ host: "replica.internal", password: "new-password" })
    })

    it("given a connection string kept as the placeholder, when it is normalized, then the stored one is kept", () => {
        const storedString: DatabaseConnection = { authType: "connectionString", connectionString: "postgres://app:pw@db/orders" }
        expect(normalizeConnection({ authType: "connectionString", connectionString: SECRET_PLACEHOLDER }, storedString)).toEqual(storedString)
    })

    it("given a connection string, when it is normalized, then the fields of the other kind are dropped", () => {
        expect(normalizeConnection({ authType: "connectionString", connectionString: "postgres://app:pw@db/orders", host: "ignored" })).toEqual({
            authType: "connectionString",
            connectionString: "postgres://app:pw@db/orders"
        })
    })

    it.each(["0", "65536", "abc", ""])("given the port %s, when it is normalized, then it is refused", port => {
        expect(codeOf(() => normalizeConnection({ ...credentials("secret"), port }))).toBe("DATABASE_PORT_INVALID")
    })

    it("given a password shaped like a ciphertext, when it is normalized, then it is refused", () => {
        expect(codeOf(() => normalizeConnection(credentials("enc:v1:abc")))).toBe("DATABASE_CONNECTION_INVALID")
    })

    it("given an unknown authType, when it is normalized, then it is refused", () => {
        expect(codeOf(() => normalizeConnection({ authType: "kerberos" }))).toBe("DATABASE_AUTH_TYPE_INVALID")
    })
})

describe("toConnection", () => {
    const database = { type: DatabaseType.POSTGRESQL, connection: stored } as unknown as IDatabase

    it("given the same engine, when the placeholder is submitted, then the stored password is kept", () => {
        expect(toConnection({ type: DatabaseType.POSTGRESQL, connection: credentials(SECRET_PLACEHOLDER) as never }, database).connection).toMatchObject({ password: "the-real-password" })
    })

    it("given another engine, when the placeholder is submitted, then the password has to be typed again", () => {
        expect(codeOf(() => toConnection({ type: DatabaseType.MYSQL, connection: credentials(SECRET_PLACEHOLDER) as never }, database))).toBe("DATABASE_SECRET_REQUIRED")
    })

    it("given an unknown engine, when it is read, then it is refused", () => {
        expect(codeOf(() => toConnection({ type: "REDIS" as DatabaseType, connection: credentials("secret") as never }))).toBe("DATABASE_TYPE_INVALID")
    })
})

const ADMIN_URI = "mongodb://root:root-pw@db.internal:27017/admin?authSource=admin"
const atlas = { authType: "atlasServiceAccount", clientId: "mdb_sa_id", clientSecret: "mdb_sa_sk_secret", groupId: "5f1a2b3c4d5e6f7a8b9c0d1e", clusterName: "Cluster0" }
const cosmos = {
    authType: "azureServicePrincipal",
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "66666666-7777-8888-9999-000000000000",
    clientSecret: "entra-secret",
    subscriptionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    resourceGroup: "rg-data",
    accountName: "flightroom-mongo"
}
const mongo = (connection: Record<string, unknown>) => normalizeConnection(connection, undefined, DatabaseType.MONGODB)
const mongoOver = (connection: Record<string, unknown>, stored: Record<string, unknown>) => normalizeConnection(connection, stored as never, DatabaseType.MONGODB)

describe("normalizeConnection of a MongoDB", () => {
    it("given an admin URI, when it is normalized, then it is trimmed and kept whole", () => {
        expect(mongo({ authType: "connectionString", connectionString: ` ${ADMIN_URI} `, clientId: "ignored" })).toEqual({ authType: "connectionString", connectionString: ADMIN_URI })
    })

    it("given the placeholder for an admin URI, when it is updated, then the stored URI is kept", () => {
        expect(mongoOver({ authType: "connectionString", connectionString: SECRET_PLACEHOLDER }, { authType: "connectionString", connectionString: ADMIN_URI })).toMatchObject({
            connectionString: ADMIN_URI
        })
    })

    it("given a switch from Atlas to an admin URI, when the placeholder is submitted, then the secret of Atlas does not stand in for it", () => {
        expect(codeOf(() => mongoOver({ authType: "connectionString", connectionString: SECRET_PLACEHOLDER }, atlas))).toBe("DATABASE_SECRET_REQUIRED")
    })

    it("given a URI that is not a MongoDB one, when it is normalized, then it is refused without quoting it", () => {
        let message = ""
        try {
            mongo({ authType: "connectionString", connectionString: "postgres://root:root-pw@db/orders" })
        } catch (error) {
            message = (error as BusinessException).message
        }
        expect(message).toContain("not a mongodb://")
        expect(message).not.toContain("root-pw")
    })

    it("given an Atlas service account, when it is normalized, then only its fields are kept", () => {
        expect(mongo({ ...atlas, connectionString: "ignored" })).toEqual(atlas)
    })

    it("given the placeholder for the same service account, project and cluster, when it is updated, then the stored secret is kept", () => {
        expect(mongoOver({ ...atlas, clientSecret: SECRET_PLACEHOLDER }, atlas)).toMatchObject({ clientSecret: "mdb_sa_sk_secret" })
    })

    /** Otherwise whoever may edit the database could point the stored secret at an account of their own */
    it.each([
        ["clientId", { clientId: "another-id" }],
        ["groupId", { groupId: "aaaaaaaaaaaaaaaaaaaaaaaa" }],
        ["clusterName", { clusterName: "Other" }]
    ])("given the %s of Atlas changed, when the placeholder is submitted, then the secret has to be typed again", (_field, change) => {
        expect(codeOf(() => mongoOver({ ...atlas, ...change, clientSecret: SECRET_PLACEHOLDER }, atlas))).toBe("DATABASE_SECRET_REQUIRED")
    })

    it("given an Entra service principal, when it is normalized, then only its fields are kept and the same account keeps its secret", () => {
        expect(mongo({ ...cosmos, groupId: "ignored" })).toEqual(cosmos)
        expect(mongoOver({ ...cosmos, clientSecret: SECRET_PLACEHOLDER }, cosmos)).toMatchObject({ clientSecret: "entra-secret" })
    })

    it.each([
        ["tenantId", { tenantId: "99999999-2222-3333-4444-555555555555" }],
        ["clientId", { clientId: "99999999-7777-8888-9999-000000000000" }],
        ["subscriptionId", { subscriptionId: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee" }],
        ["resourceGroup", { resourceGroup: "rg-other" }],
        ["accountName", { accountName: "other-account" }]
    ])("given the %s of Cosmos DB changed, when the placeholder is submitted, then the secret has to be typed again", (_field, change) => {
        expect(codeOf(() => mongoOver({ ...cosmos, ...change, clientSecret: SECRET_PLACEHOLDER }, cosmos))).toBe("DATABASE_SECRET_REQUIRED")
    })

    it.each([
        ["a groupId that is not an Atlas id", { ...atlas, groupId: "my-project" }],
        ["a cluster name with spaces", { ...atlas, clusterName: "my cluster" }],
        ["a tenant that is not a GUID", { ...cosmos, tenantId: "contoso.onmicrosoft.com" }],
        ["an account name with capitals", { ...cosmos, accountName: "Flightroom" }],
        ["a resource group ending with a dot", { ...cosmos, resourceGroup: "rg." }],
        ["no secret", { ...atlas, clientSecret: "" }]
    ])("given %s, when it is normalized, then it is refused", (_case, connection) => {
        expect(codeOf(() => mongo(connection))).toBe("DATABASE_CONNECTION_INVALID")
    })

    /** A MongoDB is reached by URI, Atlas or Azure: never by the fields of a SQL server */
    it("given the credentials of a SQL server, when a MongoDB is normalized, then they are refused", () => {
        expect(codeOf(() => mongo(credentials("secret")))).toBe("DATABASE_AUTH_TYPE_INVALID")
    })

    it("given an Atlas service account, when a SQL database is normalized, then it is refused", () => {
        expect(codeOf(() => normalizeConnection(atlas, undefined, DatabaseType.POSTGRESQL))).toBe("DATABASE_AUTH_TYPE_INVALID")
    })
})

describe("addressOf", () => {
    const of = (connection: Record<string, unknown>, type = DatabaseType.MONGODB) => addressOf({ type, connection: connection as never })

    it("given the same hosts with other credentials, when the addresses are compared, then they are the same", () => {
        expect(of({ authType: "connectionString", connectionString: "mongodb://admin:new@DB.internal:27017/admin" })).toBe(of({ authType: "connectionString", connectionString: ADMIN_URI }))
    })

    it.each([
        ["another host", { authType: "connectionString", connectionString: "mongodb://root:root-pw@db2.internal:27017/admin" }],
        ["+srv in place of the hosts", { authType: "connectionString", connectionString: "mongodb+srv://root:root-pw@db.internal:27017/admin" }],
        ["Atlas", atlas]
    ])("given %s, when the addresses are compared, then they differ", (_case, other) => {
        expect(of(other)).not.toBe(of({ authType: "connectionString", connectionString: ADMIN_URI }))
    })

    it("given an Atlas project, a Cosmos DB account and a SQL server, when their address is read, then it names them without the secret", () => {
        expect(of(atlas)).toBe("MONGODB:atlas:5f1a2b3c4d5e6f7a8b9c0d1e/Cluster0")
        expect(of(cosmos)).toBe("MONGODB:cosmos:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/rg-data/flightroom-mongo")
        expect(of(stored, DatabaseType.POSTGRESQL)).toBe("POSTGRESQL:credentials:db.internal:5432/orders")
    })
})

describe("DatabaseService", () => {
    const projectId = new Types.ObjectId()
    const databaseId = new Types.ObjectId()
    const mongoDatabase = (changes: object = {}) => ({
        _id: databaseId,
        projectId,
        name: "Shared cluster",
        type: DatabaseType.MONGODB,
        connection: { authType: "connectionString", connectionString: ADMIN_URI },
        set: vi.fn(),
        save: vi.fn().mockResolvedValue({}),
        ...changes
    })

    beforeEach(() => {
        const base = BaseAuthorizedService.prototype as unknown as Record<string, () => Promise<void>>
        vi.spyOn(base, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(base, "ensureNotViewer").mockResolvedValue(undefined)
        vi.spyOn(base, "ensureWholeProject").mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("given a database with databases created on it, when it is deleted, then it is refused and nothing is removed", async () => {
        vi.spyOn(Database, "findById").mockResolvedValue(mongoDatabase() as never)
        vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(2 as never)
        const remove = vi.spyOn(Database, "deleteOne")

        await expect(new DatabaseService().delete(String(databaseId))).rejects.toMatchObject({ code: "DATABASE_IN_USE", statusCode: 409 })
        expect(remove).not.toHaveBeenCalled()
    })

    it("given a database with databases created on it, when its admin password is rotated at the same address, then it is saved", async () => {
        const database = mongoDatabase()
        vi.spyOn(Database, "findById").mockResolvedValue(database as never)
        const count = vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(3 as never)

        await new DatabaseService().update(String(databaseId), {
            name: "Shared cluster",
            type: DatabaseType.MONGODB,
            connection: { authType: "connectionString", connectionString: "mongodb://root:rotated@db.internal:27017/admin" }
        })

        expect(database.save).toHaveBeenCalled()
        expect(count).not.toHaveBeenCalled()
    })

    it.each([
        ["another host", { type: DatabaseType.MONGODB, connection: { authType: "connectionString", connectionString: "mongodb://root:pw@elsewhere.internal/admin" } }],
        ["another kind of connection", { type: DatabaseType.MONGODB, connection: atlas }],
        ["another engine", { type: DatabaseType.POSTGRESQL, connection: credentials("secret") }]
    ])("given a database with databases created on it, when it is moved to %s, then it is refused and nothing is saved", async (_case, change) => {
        const database = mongoDatabase()
        vi.spyOn(Database, "findById").mockResolvedValue(database as never)
        vi.spyOn(ProvisionedDatabase, "countDocuments").mockResolvedValue(3 as never)

        await expect(new DatabaseService().update(String(databaseId), { name: "Shared cluster", ...change } as never)).rejects.toMatchObject({ code: "DATABASE_IN_USE", statusCode: 409 })
        expect(database.save).not.toHaveBeenCalled()
    })

    /** A MongoDB never reaches a SQL driver: its provisioner tests it */
    it("given a MongoDB whose test fails quoting its password, when it is tested with the placeholder, then its provisioner is used and the password is blanked", async () => {
        vi.spyOn(Database, "findById").mockResolvedValue(mongoDatabase() as never)
        const test = vi.spyOn(MongoDbProvisioner.prototype, "test").mockRejectedValue(new Error("Authentication failed for root:root-pw"))

        const result = await new DatabaseService().testConnection(
            { name: "x", type: DatabaseType.MONGODB, connection: { authType: "connectionString", connectionString: SECRET_PLACEHOLDER } },
            { databaseId: String(databaseId) }
        )

        expect(test).toHaveBeenCalled()
        expect(testDatabaseConnection).not.toHaveBeenCalled()
        expect(result).toEqual({ ok: false, message: "Authentication failed for root:•••" })
    })

    it("given a SQL database, when it is tested, then its driver is used", async () => {
        vi.mocked(testDatabaseConnection).mockResolvedValue(undefined)

        expect(await new DatabaseService().testConnection({ name: "x", type: DatabaseType.POSTGRESQL, connection: credentials("secret") as never }, { projectId: String(projectId) })).toEqual({
            ok: true
        })
        expect(testDatabaseConnection).toHaveBeenCalledWith(DatabaseType.POSTGRESQL, expect.objectContaining({ authType: "credentials" }))
    })
})
