import mongoose, { Document, ObjectId, Schema } from "mongoose"
import type { CosmosMongoConnection } from "../client/CosmosMongoProvisioner"
import type { AtlasConnection } from "../client/MongoProvisioner"
import { encryptedFields } from "../utils/encryptedFieldsPlugin"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"

/** The engines a project can connect: the SQL ones, and MongoDB */
export enum DatabaseType {
    POSTGRESQL = "POSTGRESQL",
    MYSQL = "MYSQL",
    MARIADB = "MARIADB",
    SQLSERVER = "SQLSERVER",
    ORACLE = "ORACLE",
    MONGODB = "MONGODB"
}

/** The engines a SQL client is for: MongoDB never reaches one */
export type SqlDatabaseType = Exclude<DatabaseType, DatabaseType.MONGODB>
export const SQL_DATABASE_TYPES = Object.values(DatabaseType).filter((type): type is SqlDatabaseType => type !== DatabaseType.MONGODB)
export const isSqlDatabaseType = (type: unknown): type is SqlDatabaseType => SQL_DATABASE_TYPES.includes(type as SqlDatabaseType)

/** A SQL database: either the address and the account one field at a time, or the whole string the engine's driver takes */
export type SqlDatabaseConnection =
    | {
          authType: "credentials"
          host: string
          port: number
          database: string
          username: string
          password: string
          ssl: boolean
      }
    | {
          authType: "connectionString"
          connectionString: string
      }

/**
 * A MongoDB server: by the URI of an account allowed to create users (self-hosted), by a service account of an Atlas
 * project and the cluster, or by an Entra service principal on an Azure Cosmos DB for MongoDB (RU) account
 */
export type MongoDatabaseConnection =
    | { authType: "connectionString"; connectionString: string }
    | ({ authType: "atlasServiceAccount" } & AtlasConnection)
    | ({ authType: "azureServicePrincipal" } & CosmosMongoConnection)

export type DatabaseConnection = SqlDatabaseConnection | MongoDatabaseConnection

/** How each engine is reached: the authTypes its connection takes */
export const AUTH_TYPES_OF: Record<DatabaseType, DatabaseConnection["authType"][]> = {
    ...(Object.fromEntries(SQL_DATABASE_TYPES.map(type => [type, ["credentials", "connectionString"]])) as Record<SqlDatabaseType, DatabaseConnection["authType"][]>),
    [DatabaseType.MONGODB]: ["connectionString", "atlasServiceAccount", "azureServicePrincipal"]
}

/**
 * The keys of a connection that are a credential. A connection string is one as a whole: it usually
 * carries the password; so is the secret of an Atlas service account or of an Entra service principal.
 * Host, port, database, username and the ids of an account stay readable so the list can name the
 * database and the edit form comes back filled in.
 */
export const DATABASE_SECRET_KEYS = ["password", "connectionString", "clientSecret"] as const

export const DATABASE_SECRET_PATHS = DATABASE_SECRET_KEYS.map(key => `connection.${key}`)

export interface IDatabase extends Document<ObjectId> {
    projectId: ObjectId
    name: string
    type: DatabaseType
    connection: DatabaseConnection
    createdAt: Date
    updatedAt: Date
    toFrontendObject: () => Record<string, unknown>
}

// The connection is checked by DatabaseService: on an update a validator here would see the ciphertext
const databaseSchema = new Schema<IDatabase>(
    {
        projectId: {
            type: Schema.Types.ObjectId,
            ref: "Project",
            required: true,
            index: true
        },
        name: {
            type: String,
            required: true,
            trim: true
        },
        type: {
            type: String,
            enum: Object.values(DatabaseType),
            required: true
        },
        connection: {
            type: Schema.Types.Mixed,
            required: true
        }
    },
    {
        timestamps: true
    }
)

databaseSchema.plugin(encryptedFields, { model: "Database", paths: DATABASE_SECRET_PATHS })

/** The database as the console may see it: the credentials replaced by the placeholder, which submitted back means "keep it" */
databaseSchema.methods.toFrontendObject = function (): Record<string, unknown> {
    const object = this.toObject()
    delete object.__v

    for (const key of DATABASE_SECRET_KEYS) {
        if (object.connection?.[key]) {
            object.connection[key] = SECRET_PLACEHOLDER
        }
    }

    return object
}

const Database = mongoose.model<IDatabase>("Database", databaseSchema)
export default Database
