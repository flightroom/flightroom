import type { DatabaseConnection, DatabaseType } from "../models/DatabaseModel"
import { CosmosMongoConnection, CosmosMongoProvisioner } from "./CosmosMongoProvisioner"
import { AtlasConnection, AtlasProvisioner, DatabaseProvisioner, MongoDbProvisioner } from "./MongoProvisioner"

/**
 * What creates databases and their users on a connected database, when its engine and its connection allow it:
 * today MongoDB, by its admin URI, an Atlas service account or an Entra service principal on Cosmos DB. Undefined
 * for every other one: a SQL engine gets a provisioner here, and ProvisionedDatabaseService needs nothing else.
 */
export const provisionerOf = (database: { type: DatabaseType | string; connection: DatabaseConnection }): DatabaseProvisioner | undefined => {
    if (database.type !== "MONGODB") return undefined
    const { connection } = database
    switch (connection.authType) {
        case "connectionString":
            return new MongoDbProvisioner({ connectionString: connection.connectionString })
        case "atlasServiceAccount":
            return new AtlasProvisioner(connection as AtlasConnection)
        case "azureServicePrincipal":
            return new CosmosMongoProvisioner(connection as CosmosMongoConnection)
        default:
            return undefined
    }
}
