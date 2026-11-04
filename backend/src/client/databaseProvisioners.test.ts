import { describe, expect, it } from "vitest"
import { CosmosMongoProvisioner } from "./CosmosMongoProvisioner"
import { provisionerOf } from "./databaseProvisioners"
import { AtlasProvisioner, MongoDbProvisioner } from "./MongoProvisioner"

const atlas = { clientId: "mdb_sa_id", clientSecret: "secret", groupId: "5f1a2b3c4d5e6f7a8b9c0d1e", clusterName: "Cluster0" }
const cosmos = { tenantId: "t", clientId: "c", clientSecret: "s", subscriptionId: "sub", resourceGroup: "rg", accountName: "acc" }

describe("provisionerOf", () => {
    it.each([
        ["an admin URI", { authType: "connectionString", connectionString: "mongodb://root:pw@db/admin" }, MongoDbProvisioner],
        ["an Atlas service account", { authType: "atlasServiceAccount", ...atlas }, AtlasProvisioner],
        ["an Entra service principal", { authType: "azureServicePrincipal", ...cosmos }, CosmosMongoProvisioner]
    ])("given a MongoDB reached by %s, when its provisioner is asked, then it is the one of that connection", (_case, connection, kind) => {
        expect(provisionerOf({ type: "MONGODB", connection: connection as never })).toBeInstanceOf(kind)
    })

    /** Creating databases is a capability of the connection: a SQL engine has none yet */
    it("given a SQL database, when its provisioner is asked, then there is none", () => {
        expect(provisionerOf({ type: "POSTGRESQL", connection: { authType: "connectionString", connectionString: "postgres://db/orders" } })).toBeUndefined()
    })

    it("given a MongoDB with a connection of another kind, when its provisioner is asked, then there is none", () => {
        expect(provisionerOf({ type: "MONGODB", connection: { authType: "credentials" } as never })).toBeUndefined()
    })
})
