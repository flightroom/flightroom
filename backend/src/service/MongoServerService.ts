import { ObjectId, Schema } from "mongoose"
import { CosmosMongoConnection, CosmosMongoProvisioner } from "../client/CosmosMongoProvisioner"
import { AtlasConnection, AtlasProvisioner, DatabaseProvisioner, MongoDbConnection, MongoDbProvisioner, parseMongoUri } from "../client/MongoProvisioner"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import MongoServer, { IMongoServer, MongoServerConnection, MongoServerProvider } from "../models/MongoServerModel"
import ProvisionedDatabase from "../models/ProvisionedDatabaseModel"
import { MongoServerDTO } from "../types/MongoServerDTO"
import { ConnectionTestResultDTO, runConnectionTest } from "../utils/connectionTest"
import { toObjectId } from "../utils/mongooseUtils"
import { isEncryptedSecret, SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import BaseAuthorizedService from "./BaseAuthorizedService"

const WRITE_FORBIDDEN = { code: "MONGO_SERVER_WRITE_FORBIDDEN", message: "A viewer of the project cannot register, edit, test or delete a MongoDB server" }

/** The id Atlas gives a project, and the name it lets a cluster take */
const ATLAS_GROUP_ID = /^[a-f0-9]{24}$/i
const ATLAS_CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
/** The ids Azure gives a tenant, an application and a subscription, and the names it lets a resource group and a Cosmos DB account take */
const AZURE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AZURE_RESOURCE_GROUP = /^[-\w.()]{0,89}[-\w()]$/
const COSMOS_ACCOUNT_NAME = /^(?=.{3,50}$)[a-z0-9]+(-[a-z0-9]+)*$/

const invalid = (code: string, message: string) => createBusinessException({ code, message })

const required = (field: string, value: string): string => {
    if (!value) throw invalid("MONGO_SERVER_CONNECTION_INVALID", `${field} is required`)
    return value
}

/** The provisioner of a server: what creates its databases, through the driver or through Atlas */
export const provisionerOf = (server: { provider: MongoServerProvider; connection: MongoServerConnection }): DatabaseProvisioner => {
    if (server.provider === MongoServerProvider.ATLAS) return new AtlasProvisioner(server.connection as AtlasConnection)
    if (server.provider === MongoServerProvider.COSMOS_MONGO_RU) return new CosmosMongoProvisioner(server.connection as CosmosMongoConnection)
    return new MongoDbProvisioner(server.connection as MongoDbConnection)
}

/**
 * Where a server is, credentials aside: the scheme and the hosts of the admin URI, the Atlas project and
 * cluster, the Cosmos DB account. Its databases live there, so it does not change while it has some.
 */
export const addressOf = (server: { provider: MongoServerProvider; connection: MongoServerConnection }): string => {
    if (server.provider === MongoServerProvider.ATLAS) {
        const { groupId, clusterName } = server.connection as AtlasConnection
        return `ATLAS:${groupId.toLowerCase()}/${clusterName}`
    }
    if (server.provider === MongoServerProvider.COSMOS_MONGO_RU) {
        const { subscriptionId, resourceGroup, accountName } = server.connection as CosmosMongoConnection
        return `COSMOS_MONGO_RU:${subscriptionId.toLowerCase()}/${resourceGroup.toLowerCase()}/${accountName}`
    }
    const { scheme, hosts } = parseMongoUri((server.connection as MongoDbConnection).connectionString)
    return `MONGODB:${scheme}://${hosts.toLowerCase()}`
}

/**
 * The connection as it is stored: only the fields of the provider, every one filled in. A credential
 * that comes back as the placeholder keeps the stored one only where it already went, as in
 * DatabaseService: the whole admin URI is the credential of a MONGODB server, so it is kept as a whole;
 * the secret of an Atlas service account is kept while the client id, the project and the cluster stay the same,
 * the one of an Entra service principal while the tenant, the client id, the subscription, the resource group and
 * the account do.
 * `stored` is undefined on a create.
 */
export const normalizeMongoServerConnection = (provider: MongoServerProvider, input: unknown, stored?: Pick<IMongoServer, "provider" | "connection">): MongoServerConnection => {
    const connection = (input ?? {}) as Record<string, unknown>
    const text = (key: string) => (typeof connection[key] === "string" ? (connection[key] as string).trim() : "")
    const secret = (key: "connectionString" | "clientSecret", kept: string | undefined): string => {
        const value = connection[key]
        if (value === SECRET_PLACEHOLDER) {
            if (!kept) throw invalid("MONGO_SERVER_SECRET_REQUIRED", `Type the ${key} again: a stored one is kept only while the provider and the address stay the same`)
            return kept
        }
        // Stored as typed, it would read as a ciphertext and make every load of the server fail to decrypt
        if (isEncryptedSecret(value)) throw invalid("MONGO_SERVER_CONNECTION_INVALID", `${key} cannot start with "enc:v1:"`)
        return typeof value === "string" ? value.trim() : ""
    }

    if (provider === MongoServerProvider.MONGODB) {
        const kept = stored?.provider === MongoServerProvider.MONGODB ? (stored.connection as MongoDbConnection).connectionString : undefined
        const connectionString = required("connectionString", secret("connectionString", kept))
        try {
            parseMongoUri(connectionString)
        } catch (error) {
            throw invalid("MONGO_SERVER_CONNECTION_INVALID", (error as Error).message)
        }
        return { connectionString }
    }

    if (provider === MongoServerProvider.COSMOS_MONGO_RU) {
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
            if (!AZURE_GUID.test(value)) throw invalid("MONGO_SERVER_CONNECTION_INVALID", `${field} must be a GUID, as Azure shows it`)
        }
        if (!AZURE_RESOURCE_GROUP.test(resourceGroup)) throw invalid("MONGO_SERVER_CONNECTION_INVALID", "resourceGroup must be the name of an Azure resource group")
        if (!COSMOS_ACCOUNT_NAME.test(accountName))
            throw invalid("MONGO_SERVER_CONNECTION_INVALID", "accountName must be the name of a Cosmos DB account: 3 to 50 lowercase letters, digits and dashes")
        const cosmos = stored?.provider === MongoServerProvider.COSMOS_MONGO_RU ? (stored.connection as CosmosMongoConnection) : undefined
        const same =
            cosmos?.tenantId === tenantId && cosmos.clientId === clientId && cosmos.subscriptionId === subscriptionId && cosmos.resourceGroup === resourceGroup && cosmos.accountName === accountName
        return { tenantId, clientId, clientSecret: required("clientSecret", secret("clientSecret", same ? cosmos.clientSecret : undefined)), subscriptionId, resourceGroup, accountName }
    }

    const clientId = required("clientId", text("clientId"))
    const groupId = required("groupId", text("groupId"))
    const clusterName = required("clusterName", text("clusterName"))
    if (!ATLAS_GROUP_ID.test(groupId)) throw invalid("MONGO_SERVER_CONNECTION_INVALID", "groupId must be the 24 character id of the Atlas project")
    if (!ATLAS_CLUSTER_NAME.test(clusterName)) throw invalid("MONGO_SERVER_CONNECTION_INVALID", "clusterName must be the name of an Atlas cluster: letters, digits and dashes")
    const atlas = stored?.provider === MongoServerProvider.ATLAS ? (stored.connection as AtlasConnection) : undefined
    // The client id too: the secret goes with the service account it was typed for
    const kept = atlas?.clientId === clientId && atlas.groupId === groupId && atlas.clusterName === clusterName ? atlas.clientSecret : undefined
    return { clientId, clientSecret: required("clientSecret", secret("clientSecret", kept)), groupId, clusterName }
}

/** The provider and the connection, picked by name: anything else in the body never reaches the database */
export const toMongoServerConnection = (dto: Partial<MongoServerDTO> | undefined, stored?: Pick<IMongoServer, "provider" | "connection">) => {
    const provider = dto?.provider
    if (!provider || !Object.values(MongoServerProvider).includes(provider)) {
        throw invalid("MONGO_SERVER_PROVIDER_INVALID", `provider must be one of ${Object.values(MongoServerProvider).join(", ")}`)
    }
    return { provider, connection: normalizeMongoServerConnection(provider, dto.connection, stored) }
}

const toDocument = (dto: MongoServerDTO, stored?: IMongoServer) => {
    const name = typeof dto?.name === "string" ? dto.name.trim() : ""
    if (!name) throw invalid("MONGO_SERVER_NAME_REQUIRED", "name is required")
    return { name, ...toMongoServerConnection(dto, stored) }
}

export class MongoServerService extends BaseAuthorizedService {
    async getByProjectId(projectId: string | Schema.Types.ObjectId): Promise<IMongoServer[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        return MongoServer.find({ projectId: projectIdObj }).sort({ name: 1 })
    }

    async getById(serverId: string | ObjectId): Promise<IMongoServer> {
        const server = await MongoServer.findById(toObjectId(serverId))
        if (!server) {
            throw new EntityNotFoundError(String(serverId))
        }
        await this.ensureAccessToProject(server.projectId)
        return server
    }

    /** Whoever writes the servers of a project: not a viewer, and not a member confined to some domains, as the servers are the whole project's */
    async ensureWritable(projectId: string | ObjectId | Schema.Types.ObjectId): Promise<void> {
        await this.ensureNotViewer(projectId, WRITE_FORBIDDEN)
        await this.ensureWholeProject(projectId)
    }

    async create(projectId: string, dto: MongoServerDTO): Promise<IMongoServer> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        await this.ensureWritable(projectIdObj)
        return MongoServer.create({ ...toDocument(dto), projectId: projectIdObj })
    }

    /**
     * Rotating the credentials at the same address is an update like any other. Another provider or another
     * address is refused while the server has databases: their users and their data are where the server was.
     */
    async update(serverId: string, dto: MongoServerDTO): Promise<IMongoServer> {
        const server = await this.getById(serverId)
        await this.ensureWritable(server.projectId)
        const next = toDocument(dto, server)
        if (addressOf(next) !== addressOf(server)) {
            const databases = await ProvisionedDatabase.countDocuments({ serverId: server._id })
            if (databases > 0) {
                throw createBusinessException({
                    code: "MONGO_SERVER_IN_USE",
                    message: `"${server.name}" has ${databases} databases created on it: its provider and its address stay as they are until they are removed`,
                    statusCode: 409,
                    details: { databases }
                })
            }
        }
        server.set(next)
        return server.save()
    }

    /** Refused while it has databases: their users would be left on a server nobody manages them from */
    async delete(serverId: string | ObjectId): Promise<void> {
        const server = await this.getById(serverId)
        await this.ensureWritable(server.projectId)
        const databases = await ProvisionedDatabase.countDocuments({ serverId: server._id })
        if (databases > 0) {
            throw createBusinessException({
                code: "MONGO_SERVER_IN_USE",
                message: `"${server.name}" has ${databases} databases created on it: remove them first`,
                statusCode: 409,
                details: { databases }
            })
        }
        await MongoServer.deleteOne({ _id: server._id })
    }

    /**
     * Connects with what the form holds, without saving it. On an edit the form still carries the
     * placeholder for the credentials it never received: the server they are taken from is named in
     * `scope`, and the rule is the one of an update.
     */
    async testConnection(dto: MongoServerDTO, scope: { projectId: string } | { serverId: string }): Promise<ConnectionTestResultDTO> {
        const stored = "serverId" in scope ? await this.getById(scope.serverId) : undefined
        const projectId = stored?.projectId ?? toObjectId((scope as { projectId: string }).projectId)
        if (!stored) await this.ensureAccessToProject(projectId)
        // Connects with the stored credentials of a server of the project, as an update would
        await this.ensureWritable(projectId)

        const provisioner = provisionerOf(toMongoServerConnection(dto, stored))
        return runConnectionTest(() => provisioner.test(), [...provisioner.secrets])
    }
}

export default MongoServerService
