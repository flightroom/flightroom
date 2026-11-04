import { randomBytes } from "node:crypto"
import { isValidObjectId, ObjectId, Schema } from "mongoose"
import { ClusterUnreachableError, DatabaseExistsError, DatabaseProvisioner, DatabaseUserExistsError, UserLeftOnServerError } from "../client/MongoProvisioner"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Environment from "../models/EnvironmentModel"
import MongoServer, { IMongoServer } from "../models/MongoServerModel"
import ProvisionedDatabase, { IProvisionedDatabase, PROVISIONED_DATABASE_NAME } from "../models/ProvisionedDatabaseModel"
import Resource, { IResource, IResourceValue, RESOURCE_WRITE_ATTEMPTS, unchangedSince } from "../models/ResourceModel"
import { PROVISIONED_DATABASE_DELETE_MODES, ProvisionedDatabaseCreateDTO, ProvisionedDatabaseDeleteMode, ProvisionedDatabaseLinkDTO } from "../types/MongoServerDTO"
import { resourceVariant } from "../types/ResourceCatalog"
import { runConnectionTest } from "../utils/connectionTest"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService from "./BaseAuthorizedService"
import MongoServerService, { provisionerOf } from "./MongoServerService"
import { ensureArgoCdInitialized } from "./VariableMapService"

/** 24 random bytes are 32 url-safe characters: nothing to escape in a URI, nothing a person types */
export const generateDatabasePassword = (): string => randomBytes(24).toString("base64url")

const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: number })?.code === 11000

export const USER_EXISTS = "PROVISIONED_DATABASE_USER_EXISTS"
export const DATABASE_EXISTS = "PROVISIONED_DATABASE_EXISTS"
export const USER_LEFT_ON_SERVER = "PROVISIONED_DATABASE_USER_LEFT_ON_SERVER"
export const CLUSTER_UNREACHABLE = "PROVISIONED_DATABASE_CLUSTER_UNREACHABLE"

/** What deleting an environment does with the databases feeding a resource there: unlink them, or remove them as a removal does */
export const ENVIRONMENT_RELEASE_CHOICES = ["unlink", ...PROVISIONED_DATABASE_DELETE_MODES] as const
export type EnvironmentReleaseChoice = (typeof ENVIRONMENT_RELEASE_CHOICES)[number]

/** A database linked in an environment, as a refusal names it to the user */
export interface LinkedDatabaseSummary {
    id: string
    databaseName: string
    server?: string
    resource?: string
}

/**
 * Runs an operation on the server. Its failure is a refusal saying what the server said, with every
 * credential blanked out as a connection test does: neither the admin URI nor a password may reach a message.
 * A user or a database already on the server is a refusal of its own: it is not ours, so nothing of it is undone.
 */
export const onServer = async <T>(operation: () => Promise<T>, secrets: readonly unknown[]): Promise<T> => {
    let result: T | undefined
    let existing: DatabaseUserExistsError | undefined
    let existingDatabase: DatabaseExistsError | undefined
    let leftOver: UserLeftOnServerError | undefined
    let unreachable = false
    const outcome = await runConnectionTest(async () => {
        try {
            result = await operation()
        } catch (error) {
            if (error instanceof DatabaseUserExistsError) existing = error
            if (error instanceof DatabaseExistsError) existingDatabase = error
            if (error instanceof UserLeftOnServerError) leftOver = error
            if (error instanceof ClusterUnreachableError) unreachable = true
            throw error
        }
    }, [...secrets])
    // The two that follow keep what the server said, blanked: they are what the user has to act on
    if (leftOver) {
        throw createBusinessException({ code: USER_LEFT_ON_SERVER, message: outcome.message ?? leftOver.message, statusCode: 502, details: { username: leftOver.username } })
    }
    if (unreachable) {
        throw createBusinessException({ code: CLUSTER_UNREACHABLE, message: outcome.message ?? "The cluster could not be reached", statusCode: 502 })
    }
    if (existingDatabase) {
        throw createBusinessException({
            code: DATABASE_EXISTS,
            message: `A database named ${existingDatabase.database} already exists on the server: Flightroom does not hand a database it did not create to a new user, choose another name`,
            statusCode: 409
        })
    }
    if (existing) {
        throw createBusinessException({
            code: USER_EXISTS,
            message: `A user named ${existing.username} already exists on the server: Flightroom does not take over a user it did not create, choose another name`,
            statusCode: 409
        })
    }
    if (!outcome.ok) {
        throw createBusinessException({ code: "PROVISIONED_DATABASE_SERVER_FAILED", message: outcome.message ?? "The server refused the operation", statusCode: 502 })
    }
    return result as T
}

/** A field of a resource as it is written back, its environments as strings: Mongoose casts them */
type PlainField = { field: string; value?: string; overrides: Array<{ environmentId: string; value: string }> }

const plain = (fields: IResourceValue[] = []): PlainField[] =>
    fields.map(({ field, value, overrides = [] }) => ({
        field,
        ...(value !== undefined && { value }),
        overrides: overrides.map(override => ({ environmentId: String(override.environmentId), value: override.value }))
    }))

/**
 * The fields of `resource` with the override of `environmentId` of each field in `fields` set to its
 * value, or taken away when the value is undefined. A field left with no value and no override is
 * dropped, as ResourceService stores an unset field. Which list a field goes to is the catalog's call.
 */
export const withEnvironmentOverrides = (resource: Pick<IResource, "type" | "variant" | "customFields" | "values" | "secrets">, environmentId: string, fields: Record<string, string | undefined>) => {
    const variant = resourceVariant(resource.type, resource.variant, resource.customFields)
    const values = plain(resource.values)
    const secrets = plain(resource.secrets)
    for (const [name, value] of Object.entries(fields)) {
        const spec = variant?.fields.find(candidate => candidate.name === name)
        if (!spec) throw createBusinessException({ code: "RESOURCE_VARIANT_NOT_SUPPORTED", message: `The variant ${resource.variant} of a ${resource.type} has no field ${name}` })
        const list = spec.secret ? secrets : values
        let entry = list.find(candidate => candidate.field === name)
        if (!entry) {
            if (value === undefined) continue
            entry = { field: name, overrides: [] }
            list.push(entry)
        }
        entry.overrides = entry.overrides.filter(override => override.environmentId !== environmentId)
        if (value !== undefined) entry.overrides.push({ environmentId, value })
    }
    const set = (list: PlainField[]) => list.filter(entry => entry.value !== undefined || entry.overrides.length > 0)
    return { values: set(values), secrets: set(secrets) }
}

/** Where a database is linked to, checked: a resource and an environment of its project */
interface LinkTarget {
    resourceId: ObjectId
    resourceName: string
    environmentId: string
}

/** What the server said when a create failed before its user existed is for the rate-limited test route only */
const SERVER_UNREACHABLE = "The server could not be reached or refused to create the user: run Test on the server to see why"

/** The databases created on the MongoDB servers of a project, each with a user of its own, and the resources they feed */
export class ProvisionedDatabaseService extends BaseAuthorizedService {
    private servers(): MongoServerService {
        return new MongoServerService(this.user)
    }

    async getByProjectId(projectId: string | Schema.Types.ObjectId, serverId?: string): Promise<IProvisionedDatabase[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        // Filtered by the project too: a server of another project lists nothing
        return ProvisionedDatabase.find({ projectId: projectIdObj, ...(serverId !== undefined && { serverId: toObjectId(serverId) }) }).sort({ databaseName: 1 })
    }

    async getByServerId(serverId: string): Promise<IProvisionedDatabase[]> {
        const server = await this.servers().getById(serverId)
        return ProvisionedDatabase.find({ serverId: server._id }).sort({ databaseName: 1 })
    }

    async getById(id: string | ObjectId): Promise<IProvisionedDatabase> {
        const database = await ProvisionedDatabase.findById(toObjectId(id))
        if (!database) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureAccessToProject(database.projectId)
        return database
    }

    private secretsOf(provisioner: DatabaseProvisioner, password: string): string[] {
        return [...provisioner.secrets, password]
    }

    /** The resource and the environment, of the project of the database and of the kind its server feeds, that no other database feeds */
    private async linkTarget(projectId: ObjectId, provisioner: DatabaseProvisioner, dto: ProvisionedDatabaseLinkDTO | undefined, self?: ObjectId): Promise<LinkTarget> {
        const { resourceId, environmentId } = dto ?? {}
        // A string: a nested object would otherwise pass for an id, and reach a query as an operator
        if (typeof resourceId !== "string" || typeof environmentId !== "string" || !isValidObjectId(resourceId) || !isValidObjectId(environmentId)) {
            throw createBusinessException({ code: "PROVISIONED_DATABASE_LINK_INVALID", message: "A link needs the resourceId and the environmentId" })
        }
        const resource = await Resource.findById(toObjectId(resourceId))
        if (!resource || String(resource.projectId) !== String(projectId)) {
            throw new EntityNotFoundError(resourceId)
        }
        const { type, variant } = provisioner.resource
        if (resource.type !== type) {
            throw createBusinessException({ code: "RESOURCE_TYPE_NOT_SUPPORTED", message: `"${resource.name}" is a ${resource.type}: a database of this server feeds a ${type} resource` })
        }
        // The variant is not switched for the user: it would drop the values the resource has in the other environments
        if (resource.variant !== variant) {
            throw createBusinessException({
                code: "RESOURCE_VARIANT_NOT_SUPPORTED",
                message: `"${resource.name}" connects by ${resource.variant}: switch it to ${variant} to feed it a database`,
                details: { variant }
            })
        }
        const environment = await Environment.findById(toObjectId(environmentId))
        if (!environment || String(environment.projectId) !== String(projectId)) {
            throw createBusinessException({ code: "PROVISIONED_DATABASE_ENVIRONMENT_UNKNOWN", message: `${environmentId} is not an environment of the project` })
        }
        const taken = await ProvisionedDatabase.findOne({ "link.resourceId": resource._id, "link.environmentId": environment._id, ...(self && { _id: { $ne: self } }) })
        if (taken) {
            throw createBusinessException({
                code: "PROVISIONED_DATABASE_LINK_TAKEN",
                message: `${taken.databaseName} already feeds "${resource.name}" in ${environment.name}: unlink it first`,
                statusCode: 409,
                details: { databaseName: taken.databaseName }
            })
        }
        return { resourceId: resource._id, resourceName: resource.name, environmentId: String(environment._id) }
    }

    /**
     * Writes the overrides with a $set of the whole lists, as ResourceService updates a resource: that is the
     * path the encryptedFields plugin encrypts the credentials on. The lists are rebuilt from a read made right
     * before the write, and the write is made only if the resource is still as read (unchangedSince): links to
     * other environments made at the same time, and edits from the console, are never overwritten. A resource
     * gone in the meantime is nothing to unlink from, and a refusal to link to.
     */
    private async writeOverrides(resourceId: unknown, environmentId: string, fields: Record<string, string | undefined>, { missingOk = false } = {}): Promise<void> {
        for (let attempt = 0; attempt < RESOURCE_WRITE_ATTEMPTS; attempt++) {
            const resource = await Resource.findById(resourceId)
            if (!resource) {
                if (missingOk) return
                throw new EntityNotFoundError(String(resourceId))
            }
            const written = await Resource.findOneAndUpdate(
                unchangedSince(resource),
                { $set: withEnvironmentOverrides(resource, environmentId, fields) },
                { returnDocument: "after", runValidators: true }
            )
            if (written) return
        }
        throw createBusinessException({ code: "RESOURCE_CHANGED_MEANWHILE", message: "The resource kept changing while it was written: try again", statusCode: 409 })
    }

    /**
     * The link is saved before the resource is written: the unique index on it refuses a second database
     * for the same environment of a resource that got past the check at the same time.
     */
    private async writeLink(database: IProvisionedDatabase, provisioner: DatabaseProvisioner, target: LinkTarget): Promise<void> {
        const fields = await onServer(() => provisioner.resourceFields(database.databaseName, database.username, database.password), this.secretsOf(provisioner, database.password))
        database.link = { resourceId: target.resourceId, environmentId: toObjectId(target.environmentId) as unknown as ObjectId }
        try {
            await database.save()
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                throw createBusinessException({ code: "PROVISIONED_DATABASE_LINK_TAKEN", message: `Another database already feeds "${target.resourceName}" in this environment`, statusCode: 409 })
            }
            throw error
        }
        try {
            await this.writeOverrides(target.resourceId, target.environmentId, fields)
        } catch (error) {
            database.link = undefined
            await database.save().catch(() => undefined)
            throw error
        }
    }

    private async provisionerFor(database: IProvisionedDatabase): Promise<{ server: IMongoServer; provisioner: DatabaseProvisioner }> {
        const server = await this.servers().getById(database.serverId)
        return { server, provisioner: provisionerOf(server) }
    }

    /**
     * Creates a database and its user on the server, and links it when asked. The record is written
     * first: its unique index refuses a database already there before anything is done on the server.
     * A user already on the server is refused (PROVISIONED_DATABASE_USER_EXISTS), never taken over, and so is a
     * database already there where the provider can tell (PROVISIONED_DATABASE_EXISTS; not on Atlas).
     * Whatever fails after that is undone: the record, and what the provisioner made once ensureUser
     * resolved (rollbackCreate). When ensureUser itself fails the provisioner has undone its own work, and
     * nothing is dropped here: a user it refused is someone else's. That failure is told without what the
     * server said, which only the rate-limited test of the server shows.
     */
    async create(serverId: string, dto: ProvisionedDatabaseCreateDTO): Promise<IProvisionedDatabase> {
        // See createOnServer for what a failure leaves behind
        const servers = this.servers()
        const server = await servers.getById(serverId)
        await servers.ensureWritable(server.projectId)
        const provisioner = provisionerOf(server)

        const databaseName = typeof dto?.databaseName === "string" ? dto.databaseName.trim() : ""
        if (!PROVISIONED_DATABASE_NAME.test(databaseName)) {
            throw createBusinessException({
                code: "PROVISIONED_DATABASE_NAME_INVALID",
                message: `"${databaseName}" is not a valid name: at most 63 lowercase letters, digits, dashes or underscores, starting with a letter or digit`
            })
        }
        if (provisioner.reservedNames.includes(databaseName)) {
            throw createBusinessException({ code: "PROVISIONED_DATABASE_NAME_RESERVED", message: `"${databaseName}" is kept by the server for itself: choose another name` })
        }
        let target: LinkTarget | undefined
        if (dto?.link !== undefined && dto.link !== null) {
            await ensureArgoCdInitialized(server.projectId as unknown as Schema.Types.ObjectId)
            target = await this.linkTarget(server.projectId, provisioner, dto.link)
        }

        const password = generateDatabasePassword()
        let database: IProvisionedDatabase
        try {
            database = await ProvisionedDatabase.create({ projectId: server.projectId, serverId: server._id, databaseName, username: databaseName, password })
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                throw createBusinessException({ code: DATABASE_EXISTS, message: `${databaseName} already exists on "${server.name}"`, statusCode: 409 })
            }
            throw error
        }

        const secrets = this.secretsOf(provisioner, password)
        let userCreated = false
        try {
            await onServer(() => provisioner.ensureUser(databaseName, databaseName, password), secrets).catch(error => {
                if ((error as { code?: string }).code !== "PROVISIONED_DATABASE_SERVER_FAILED") throw error
                throw createBusinessException({ code: "PROVISIONED_DATABASE_SERVER_FAILED", message: SERVER_UNREACHABLE, statusCode: 502 })
            })
            userCreated = true
            if (target) await this.writeLink(database, provisioner, target)
        } catch (error) {
            let leftOver = (error as { code?: string }).code === USER_LEFT_ON_SERVER ? (error as Error) : undefined
            if (userCreated) {
                await onServer(() => provisioner.rollbackCreate(databaseName, databaseName), secrets).catch(rollbackFailure => {
                    leftOver = rollbackFailure as Error
                })
            }
            if (leftOver) throw await this.keepForCleanup(database, error as Error, leftOver)
            // A failed ensureUser has undone its own work; a record of nothing is not worth keeping
            await ProvisionedDatabase.deleteOne({ _id: database._id }).catch(() => undefined)
            throw error
        }
        return database
    }

    /**
     * A user Flightroom created that could not be removed again is never forgotten: its record stays, unlinked and
     * marked, until it is removed with `user` (which tries the drop again) or `record`. The refusal names the user.
     */
    private async keepForCleanup(database: IProvisionedDatabase, failure: Error, leftOver: Error): Promise<Error> {
        database.link = undefined
        database.status = "cleanupRequired"
        database.cleanupReason = leftOver.message
        await database.save().catch(() => undefined)
        const cause = failure === leftOver ? "" : `${failure.message}. `
        return createBusinessException({
            code: USER_LEFT_ON_SERVER,
            message: `${cause}The user ${database.username} was created on the server and could not be removed again: it is still there, and the database stays listed until it is removed with "user" or "record"`,
            statusCode: 502,
            details: { username: database.username, databaseId: String(database._id) }
        })
    }

    private refuseCleanupRequired(database: IProvisionedDatabase, what: string): void {
        if (database.status !== "cleanupRequired") return
        throw createBusinessException({
            code: "PROVISIONED_DATABASE_CLEANUP_REQUIRED",
            message: `The user ${database.username} of ${database.databaseName} was left on the server by a failed create: ${what}. Remove it with "user" or "record"`,
            statusCode: 409,
            details: { username: database.username }
        })
    }

    /** Feeds a resource, in one environment, with the database: its connection fields there are overwritten */
    async link(id: string, dto: ProvisionedDatabaseLinkDTO): Promise<IProvisionedDatabase> {
        const database = await this.getById(id)
        const servers = this.servers()
        await servers.ensureWritable(database.projectId)
        // Writing a resource needs Argo CD, as ResourceService.update does
        await ensureArgoCdInitialized(database.projectId as unknown as Schema.Types.ObjectId)
        this.refuseCleanupRequired(database, "it cannot be linked")
        const link = database.link
        if (link?.resourceId && (String(link.resourceId) !== dto?.resourceId || String(link.environmentId) !== dto?.environmentId)) {
            throw createBusinessException({ code: "PROVISIONED_DATABASE_LINKED", message: `${database.databaseName} already feeds another resource or environment: unlink it first`, statusCode: 409 })
        }
        const { provisioner } = await this.provisionerFor(database)
        await this.writeLink(database, provisioner, await this.linkTarget(database.projectId, provisioner, dto, database._id))
        return database
    }

    /**
     * Takes away the overrides the link wrote; the resource falls back on its value of all there. Allowed
     * without Argo CD, as deleting a resource is: otherwise neither the database nor the resource could go.
     */
    async unlink(id: string): Promise<IProvisionedDatabase> {
        const database = await this.getById(id)
        await this.servers().ensureWritable(database.projectId)
        const link = database.link
        if (!link?.resourceId) return database
        const { provisioner } = await this.provisionerFor(database)
        await this.writeOverrides(link.resourceId, String(link.environmentId), Object.fromEntries(provisioner.resource.fields.map(field => [field, undefined])), { missingOk: true })
        database.link = undefined
        return database.save()
    }

    /**
     * Removes the database from Flightroom and, by `mode`, its user (`user`) or its user and its data
     * (`drop`, with the name typed again in `confirmName`). Refused while it feeds a resource: unlinking
     * first is what tells the resource to stop pointing at it.
     */
    async delete(id: string, mode: unknown, confirmName?: unknown): Promise<void> {
        const database = await this.getById(id)
        await this.servers().ensureWritable(database.projectId)
        if (!PROVISIONED_DATABASE_DELETE_MODES.includes(mode as ProvisionedDatabaseDeleteMode)) {
            throw createBusinessException({ code: "PROVISIONED_DATABASE_DELETE_MODE_INVALID", message: `mode must be one of ${PROVISIONED_DATABASE_DELETE_MODES.join(", ")}` })
        }
        if (database.link?.resourceId) {
            throw createBusinessException({ code: "PROVISIONED_DATABASE_LINKED", message: `${database.databaseName} feeds a resource: unlink it first`, statusCode: 409 })
        }
        // Its database may be someone else's (it is what a failed check found): only its user is ours to remove
        if (mode === "drop") this.refuseCleanupRequired(database, "its data is not known to be ours to drop")
        if (mode === "drop" && confirmName !== database.databaseName) {
            throw createBusinessException({ code: "PROVISIONED_DATABASE_CONFIRMATION_MISMATCH", message: `Type ${database.databaseName} to confirm that its data is deleted` })
        }
        if (mode !== "record") await this.removeFromServer(database, mode as "user" | "drop")
        await ProvisionedDatabase.deleteOne({ _id: database._id })
    }

    /**
     * What a removal does on the server: the user, and with `drop` the data first. The record and the link stay.
     * Each step is noted on the record once done (removedFromServer), so that a retry after a failure skips it: the
     * data cannot be dropped again once its user, which drops it on MongoDB and Atlas, is gone.
     */
    async removeFromServer(database: IProvisionedDatabase, mode: "user" | "drop"): Promise<void> {
        await this.servers().ensureWritable(database.projectId)
        if (mode === "drop" && database.removedFromServer === "user") {
            throw createBusinessException({
                code: "PROVISIONED_DATABASE_USER_ALREADY_REMOVED",
                message: `The user of ${database.databaseName} is already gone, and with it the way to drop its data: drop it by hand, then remove it with "record"`,
                statusCode: 409
            })
        }
        const { provisioner } = await this.provisionerFor(database)
        const secrets = this.secretsOf(provisioner, database.password)
        if (mode === "drop" && !database.removedFromServer) {
            await onServer(() => provisioner.dropDatabase(database.databaseName, database.username, database.password), secrets)
            database.removedFromServer = "data"
            await database.save()
        }
        if (database.removedFromServer !== "user") {
            await onServer(() => provisioner.dropUser(database.username, database.databaseName), secrets)
            database.removedFromServer = "user"
            await database.save()
        }
    }

    /** The databases feeding a resource in these environments, by name. Who may see the environments is the caller's check */
    async linkedTo(environmentIds: Array<string | ObjectId>): Promise<IProvisionedDatabase[]> {
        const databases = await ProvisionedDatabase.find({ "link.environmentId": { $in: environmentIds.map(id => toObjectId(id)) } })
        return databases.sort((first, second) => first.databaseName.localeCompare(second.databaseName))
    }

    /** The databases with the names of their server and of the resource they feed, for a refusal the console shows as it is */
    async summaryOf(databases: IProvisionedDatabase[]): Promise<LinkedDatabaseSummary[]> {
        const servers = await MongoServer.find({ _id: { $in: databases.map(database => database.serverId) } }, { name: 1 })
        const resources = await Resource.find({ _id: { $in: databases.flatMap(database => (database.link?.resourceId ? [database.link.resourceId] : [])) } }, { name: 1 })
        const nameIn = (documents: Array<{ _id: unknown; name: string }>, id: unknown) => documents.find(document => String(document._id) === String(id))?.name
        return databases.map(database => ({
            id: String(database._id),
            databaseName: database.databaseName,
            server: nameIn(servers, database.serverId),
            resource: nameIn(resources, database.link?.resourceId)
        }))
    }

    /**
     * Lets go of the databases an environment about to be deleted links, one at a time, as `choice` says. What
     * reaches the server comes first (the user, the data), then the unlink, then the record: a database whose
     * operation on the server failed is still linked, so deleting the environment again asks about it again.
     * The first failure stops it, naming the databases already done: the caller deletes the environment only
     * once every one of them is through. A drop is confirmed by the caller, for all of them at once.
     */
    async releaseEnvironment(databases: IProvisionedDatabase[], choice: EnvironmentReleaseChoice): Promise<void> {
        const done: string[] = []
        for (const database of databases) {
            try {
                if (choice === "user" || choice === "drop") await this.removeFromServer(database, choice)
                await this.unlink(String(database._id))
                if (choice !== "unlink") await this.delete(String(database._id), "record")
            } catch (error) {
                const failure = error as { message?: string; code?: string; statusCode?: number }
                throw createBusinessException({
                    code: "ENVIRONMENT_PROVISIONED_DATABASES_FAILED",
                    message: `${database.databaseName}: ${failure.message}. Done before it: ${done.join(", ") || "none"}. The environment was not deleted`,
                    statusCode: failure.statusCode ?? 500,
                    details: { done, failed: database.databaseName, reason: failure.message, code: failure.code }
                })
            }
            done.push(database.databaseName)
        }
    }
}

export default ProvisionedDatabaseService
