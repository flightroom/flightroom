import { ObjectId, Schema } from "mongoose"
import { provisionerOf } from "../client/databaseProvisioners"
import { parseMongoUri } from "../client/MongoProvisioner"
import { testDatabaseConnection } from "../client/SqlDatabaseClient"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Database, { AUTH_TYPES_OF, DatabaseConnection, DatabaseType, IDatabase, isSqlDatabaseType, MongoDatabaseConnection, SqlDatabaseConnection } from "../models/DatabaseModel"
import ProvisionedDatabase from "../models/ProvisionedDatabaseModel"
import { DatabaseDTO } from "../types/DatabaseDTO"
import { ConnectionTestResultDTO, runConnectionTest } from "../utils/connectionTest"
import { toObjectId } from "../utils/mongooseUtils"
import { isEncryptedSecret, SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import BaseAuthorizedService from "./BaseAuthorizedService"

const WRITE_FORBIDDEN = { code: "DATABASE_WRITE_FORBIDDEN", message: "A viewer of the project cannot connect, edit, test or delete a database" }

/** The id Atlas gives a project, and the name it lets a cluster take */
const ATLAS_GROUP_ID = /^[a-f0-9]{24}$/i
const ATLAS_CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
/** The ids Azure gives a tenant, an application and a subscription, and the names it lets a resource group and a Cosmos DB account take */
const AZURE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AZURE_RESOURCE_GROUP = /^[-\w.()]{0,89}[-\w()]$/
const COSMOS_ACCOUNT_NAME = /^(?=.{3,50}$)[a-z0-9]+(-[a-z0-9]+)*$/

const invalid = (code: string, message: string) => createBusinessException({ code, message })

const required = (field: string, value: string): string => {
    if (!value) throw invalid("DATABASE_CONNECTION_INVALID", `${field} is required`)
    return value
}

/** The fields of a connection as typed, and its credentials kept or refused as the placeholder rule says */
const reader = (input: unknown) => {
    const connection = (input ?? {}) as Record<string, unknown>
    const text = (key: string) => (typeof connection[key] === "string" ? (connection[key] as string).trim() : "")
    const secret = (key: "password" | "connectionString" | "clientSecret", kept: string | undefined): string => {
        const value = connection[key]
        if (value === SECRET_PLACEHOLDER) {
            if (!kept) throw invalid("DATABASE_SECRET_REQUIRED", `Type the ${key} again: a stored one is kept only while the engine and the address stay the same`)
            return kept
        }
        // Stored as typed, it would read as a ciphertext and make every load of the database fail to decrypt
        if (isEncryptedSecret(value)) throw invalid("DATABASE_CONNECTION_INVALID", `${key} cannot start with "enc:v1:"`)
        return typeof value === "string" ? value : ""
    }
    return { connection, text, secret }
}

/**
 * A SQL connection as it is stored: only the fields of its kind, every one filled in. A credential that
 * comes back as the placeholder keeps the stored one, but only where it already went: with another
 * address it has to be typed again, or whoever may edit the database could send it to a host of their
 * own. `stored` is undefined on a create and when the engine changes.
 */
const normalizeSqlConnection = (input: unknown, stored?: DatabaseConnection): SqlDatabaseConnection => {
    const { connection, text, secret } = reader(input)

    if (connection.authType === "connectionString") {
        const kept = stored?.authType === "connectionString" ? stored.connectionString : undefined
        return { authType: "connectionString", connectionString: required("connectionString", secret("connectionString", kept).trim()) }
    }

    if (connection.authType === "credentials") {
        const port = Number(connection.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw invalid("DATABASE_PORT_INVALID", "port must be a number between 1 and 65535")
        }
        const host = required("host", text("host"))
        const database = required("database", text("database"))
        const username = required("username", text("username"))
        const kept = stored?.authType === "credentials" && stored.host === host && stored.port === port && stored.database === database && stored.username === username ? stored.password : undefined
        return { authType: "credentials", host, port, database, username, password: required("password", secret("password", kept)), ssl: connection.ssl === true }
    }

    throw invalid("DATABASE_AUTH_TYPE_INVALID", 'authType must be "credentials" or "connectionString"')
}

/**
 * A MongoDB connection as it is stored, by the same rule: the whole admin URI is the credential of a self-hosted
 * server, so it is kept as a whole; the secret of an Atlas service account is kept while the client id, the
 * project and the cluster stay the same, the one of an Entra service principal while the tenant, the client id,
 * the subscription, the resource group and the account do.
 */
const normalizeMongoConnection = (input: unknown, stored?: DatabaseConnection): MongoDatabaseConnection => {
    const { connection, text, secret } = reader(input)

    if (connection.authType === "connectionString") {
        const kept = stored?.authType === "connectionString" ? stored.connectionString : undefined
        const connectionString = required("connectionString", secret("connectionString", kept).trim())
        try {
            parseMongoUri(connectionString)
        } catch (error) {
            throw invalid("DATABASE_CONNECTION_INVALID", (error as Error).message)
        }
        return { authType: "connectionString", connectionString }
    }

    if (connection.authType === "atlasServiceAccount") {
        const clientId = required("clientId", text("clientId"))
        const groupId = required("groupId", text("groupId"))
        const clusterName = required("clusterName", text("clusterName"))
        if (!ATLAS_GROUP_ID.test(groupId)) throw invalid("DATABASE_CONNECTION_INVALID", "groupId must be the 24 character id of the Atlas project")
        if (!ATLAS_CLUSTER_NAME.test(clusterName)) throw invalid("DATABASE_CONNECTION_INVALID", "clusterName must be the name of an Atlas cluster: letters, digits and dashes")
        const atlas = stored?.authType === "atlasServiceAccount" ? stored : undefined
        // The client id too: the secret goes with the service account it was typed for
        const kept = atlas?.clientId === clientId && atlas.groupId === groupId && atlas.clusterName === clusterName ? atlas.clientSecret : undefined
        return { authType: "atlasServiceAccount", clientId, clientSecret: required("clientSecret", secret("clientSecret", kept).trim()), groupId, clusterName }
    }

    if (connection.authType === "azureServicePrincipal") {
        const tenantId = required("tenantId", text("tenantId"))
        const clientId = required("clientId", text("clientId"))
        const subscriptionId = required("subscriptionId", text("subscriptionId"))
        const resourceGroup = required("resourceGroup", text("resourceGroup"))
        const accountName = required("accountName", text("accountName"))
        for (const [field, value] of [
            ["tenantId", tenantId],
            ["clientId", clientId],
            ["subscriptionId", subscriptionId]
        ]) {
            if (!AZURE_GUID.test(value)) throw invalid("DATABASE_CONNECTION_INVALID", `${field} must be a GUID, as Azure shows it`)
        }
        if (!AZURE_RESOURCE_GROUP.test(resourceGroup)) throw invalid("DATABASE_CONNECTION_INVALID", "resourceGroup must be the name of an Azure resource group")
        if (!COSMOS_ACCOUNT_NAME.test(accountName)) throw invalid("DATABASE_CONNECTION_INVALID", "accountName must be the name of a Cosmos DB account: 3 to 50 lowercase letters, digits and dashes")
        const cosmos = stored?.authType === "azureServicePrincipal" ? stored : undefined
        const same =
            cosmos?.tenantId === tenantId && cosmos.clientId === clientId && cosmos.subscriptionId === subscriptionId && cosmos.resourceGroup === resourceGroup && cosmos.accountName === accountName
        const clientSecret = required("clientSecret", secret("clientSecret", same ? cosmos.clientSecret : undefined).trim())
        return { authType: "azureServicePrincipal", tenantId, clientId, clientSecret, subscriptionId, resourceGroup, accountName }
    }

    throw invalid("DATABASE_AUTH_TYPE_INVALID", `authType must be one of ${AUTH_TYPES_OF[DatabaseType.MONGODB].join(", ")}`)
}

/**
 * The connection as it is stored, by the authTypes of its engine. `stored` is undefined on a create and
 * when the engine changes. The engine defaults to a SQL one, whose connections all take the same fields.
 */
export const normalizeConnection = (input: unknown, stored?: DatabaseConnection, type: DatabaseType = DatabaseType.POSTGRESQL): DatabaseConnection =>
    type === DatabaseType.MONGODB ? normalizeMongoConnection(input, stored) : normalizeSqlConnection(input, stored)

/** The engine and the connection, picked by name: anything else in the body never reaches the database */
export const toConnection = (dto: Partial<DatabaseDTO> | undefined, stored?: IDatabase): { type: DatabaseType; connection: DatabaseConnection } => {
    const type = dto?.type
    if (!type || !Object.values(DatabaseType).includes(type)) {
        throw invalid("DATABASE_TYPE_INVALID", `type must be one of ${Object.values(DatabaseType).join(", ")}`)
    }
    return { type, connection: normalizeConnection(dto.connection, stored?.type === type ? stored.connection : undefined, type) }
}

/**
 * Where a database is, credentials aside: the engine, the way it is reached and its address (the host, or the
 * hosts of a MongoDB URI, an Atlas project and cluster, a Cosmos DB account). The databases created on it live
 * there, so it does not change while it has some.
 */
export const addressOf = (database: { type: DatabaseType | string; connection: DatabaseConnection }): string => {
    const { type, connection } = database
    switch (connection.authType) {
        case "credentials":
            return `${type}:credentials:${connection.host.toLowerCase()}:${connection.port}/${connection.database}`
        case "atlasServiceAccount":
            return `${type}:atlas:${connection.groupId.toLowerCase()}/${connection.clusterName}`
        case "azureServicePrincipal":
            return `${type}:cosmos:${connection.subscriptionId.toLowerCase()}/${connection.resourceGroup.toLowerCase()}/${connection.accountName}`
        default: {
            if (type !== DatabaseType.MONGODB) return `${type}:connectionString`
            const { scheme, hosts } = parseMongoUri(connection.connectionString)
            return `${type}:${scheme}://${hosts.toLowerCase()}`
        }
    }
}

const toDocument = (dto: DatabaseDTO, stored?: IDatabase) => {
    const name = typeof dto?.name === "string" ? dto.name.trim() : ""
    if (!name) throw invalid("DATABASE_NAME_REQUIRED", "name is required")
    return { name, ...toConnection(dto, stored) }
}

const inUse = (database: IDatabase, databases: number, what: string) =>
    createBusinessException({
        code: "DATABASE_IN_USE",
        message: `"${database.name}" has ${databases} databases created on it: ${what}`,
        statusCode: 409,
        details: { databases }
    })

export class DatabaseService extends BaseAuthorizedService {
    async getByProjectId(projectId: string | Schema.Types.ObjectId): Promise<IDatabase[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        return Database.find({ projectId: projectIdObj }).sort({ name: 1 })
    }

    async getById(databaseId: string | ObjectId): Promise<IDatabase> {
        const database = await Database.findById(toObjectId(databaseId))
        if (!database) {
            throw new EntityNotFoundError(String(databaseId))
        }
        await this.ensureAccessToProject(database.projectId)
        return database
    }

    /** Whoever writes the databases of a project: not a viewer, and not a member confined to some domains, as they are the whole project's */
    async ensureWritable(projectId: string | ObjectId | Schema.Types.ObjectId): Promise<void> {
        await this.ensureNotViewer(projectId, WRITE_FORBIDDEN)
        await this.ensureWholeProject(projectId)
    }

    async create(projectId: string, dto: DatabaseDTO): Promise<IDatabase> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        // The databases are shared by the whole project, not owned by one of its domains
        await this.ensureWritable(projectIdObj)
        return Database.create({ ...toDocument(dto), projectId: projectIdObj })
    }

    /**
     * Rotating the credentials at the same address is an update like any other. Another engine or another
     * address is refused while databases were created on it: their users and their data are where it was.
     */
    async update(databaseId: string, dto: DatabaseDTO): Promise<IDatabase> {
        const database = await this.getById(databaseId)
        await this.ensureWritable(database.projectId)
        const next = toDocument(dto, database)
        if (addressOf(next) !== addressOf(database)) {
            const databases = await ProvisionedDatabase.countDocuments({ databaseId: database._id })
            if (databases > 0) throw inUse(database, databases, "its engine and its address stay as they are until they are removed")
        }
        database.set(next)
        return database.save()
    }

    /** Refused while databases were created on it: their users would be left on a server nobody manages them from */
    async delete(databaseId: string | ObjectId): Promise<void> {
        const database = await this.getById(databaseId)
        await this.ensureWritable(database.projectId)
        const databases = await ProvisionedDatabase.countDocuments({ databaseId: database._id })
        if (databases > 0) throw inUse(database, databases, "remove them first")
        await Database.deleteOne({ _id: database._id })
    }

    /**
     * Connects with what the form holds, without saving it. On an edit the form still carries the
     * placeholder for the credentials it never received: the database they are taken from is named in
     * `scope`, and the rule is the one of an update. A MongoDB is tested by its provisioner, which reaches
     * it as a create of a database would; a SQL engine by its driver.
     */
    async testConnection(dto: DatabaseDTO, scope: { projectId: string } | { databaseId: string }): Promise<ConnectionTestResultDTO> {
        const stored = "databaseId" in scope ? await this.getById(scope.databaseId) : undefined
        const projectId = stored?.projectId ?? toObjectId((scope as { projectId: string }).projectId)
        if (!stored) await this.ensureAccessToProject(projectId)
        // Connects with the stored credentials of a database of the project, as an update would
        await this.ensureWritable(projectId)

        const { type, connection } = toConnection(dto, stored)
        if (isSqlDatabaseType(type)) {
            const sql = connection as SqlDatabaseConnection
            const secrets = sql.authType === "credentials" ? [sql.password] : [sql.connectionString]
            return runConnectionTest(() => testDatabaseConnection(type, sql), secrets)
        }
        const provisioner = provisionerOf({ type, connection })
        if (!provisioner) throw invalid("DATABASE_AUTH_TYPE_INVALID", `A ${type} database cannot be reached by ${connection.authType}`)
        return runConnectionTest(() => provisioner.test(), [...provisioner.secrets])
    }
}

export default DatabaseService
