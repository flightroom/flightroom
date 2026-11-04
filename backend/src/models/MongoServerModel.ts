import mongoose, { Document, ObjectId, Schema } from "mongoose"
import type { CosmosMongoConnection } from "../client/CosmosMongoProvisioner"
import type { AtlasConnection, MongoDbConnection } from "../client/MongoProvisioner"
import { encryptedFields } from "../utils/encryptedFieldsPlugin"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"

/**
 * Where the databases of a server are created: a server of one's own through the driver, an Atlas project
 * through its Admin API, or an account of Azure Cosmos DB for MongoDB (RU) through Azure Resource Manager
 */
export enum MongoServerProvider {
    MONGODB = "MONGODB",
    ATLAS = "ATLAS",
    COSMOS_MONGO_RU = "COSMOS_MONGO_RU"
}

export type MongoServerConnection = MongoDbConnection | AtlasConnection | CosmosMongoConnection

/** The keys of a connection that are a credential: the admin URI as a whole (it carries the password), the secret of the Atlas service account or of the Entra service principal */
export const MONGO_SERVER_SECRET_KEYS = ["connectionString", "clientSecret"] as const

export const MONGO_SERVER_SECRET_PATHS = MONGO_SERVER_SECRET_KEYS.map(key => `connection.${key}`)

/**
 * A MongoDB server a project creates databases on, with credentials allowed to create users. It
 * belongs to the whole project, as a connected database does: the databases created on it
 * (ProvisionedDatabase) feed the resources of the project.
 */
export interface IMongoServer extends Document<ObjectId> {
    projectId: ObjectId
    name: string
    provider: MongoServerProvider
    connection: MongoServerConnection
    createdAt: Date
    updatedAt: Date
    toFrontendObject: () => Record<string, unknown>
}

// The connection is checked by MongoServerService: on an update a validator here would see the ciphertext
const mongoServerSchema = new Schema<IMongoServer>(
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
        provider: {
            type: String,
            enum: Object.values(MongoServerProvider),
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

mongoServerSchema.plugin(encryptedFields, { model: "MongoServer", paths: MONGO_SERVER_SECRET_PATHS })

/** The server as the console may see it: the credentials replaced by the placeholder, which submitted back means "keep it" */
mongoServerSchema.methods.toFrontendObject = function (): Record<string, unknown> {
    const object = this.toObject()
    delete object.__v

    for (const key of MONGO_SERVER_SECRET_KEYS) {
        if (object.connection?.[key]) {
            object.connection[key] = SECRET_PLACEHOLDER
        }
    }

    return object
}

const MongoServer = mongoose.model<IMongoServer>("MongoServer", mongoServerSchema)
export default MongoServer
