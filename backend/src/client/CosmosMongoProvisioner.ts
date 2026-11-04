/*
 * Azure Cosmos DB for MongoDB (RU): the users are Mongo user definitions managed through Azure Resource
 * Manager, not through the driver. What follows was checked on the Microsoft documentation on 2026-11-04:
 *
 * - Role-based access control is the account capability `EnableMongoRoleBasedAccessControl`, set at creation
 *   (`az cosmosdb create --capabilities EnableMongoRoleBasedAccessControl`) or from the Features tab of the
 *   portal. GET databaseAccounts/{account} lists it in `properties.capabilities` as `{ "name": ... }`, and an
 *   account of the API for MongoDB has `kind: "MongoDB"`.
 *   https://learn.microsoft.com/azure/cosmos-db/mongodb/how-to-setup-role-based-access-control
 *   https://learn.microsoft.com/rest/api/cosmos-db-resource-provider/database-accounts/get
 * - A user definition is `PUT .../databaseAccounts/{account}/mongodbUserDefinitions/{dbName.userName}` with
 *   `{ properties: { userName, password, databaseName, customData, roles: [{ db, role }], mechanisms } }`, and
 *   `SCRAM-SHA-256` is the only mechanism supported. It answers 200, or 202 with Azure-AsyncOperation.
 *   https://learn.microsoft.com/rest/api/cosmos-db-resource-provider/mongo-db-resources/create-update-mongo-user-definition
 * - `readWrite` and `dbAdmin` are built-in roles that exist on every database; `dbAdmin` holds `dropDatabase`.
 *   https://learn.microsoft.com/azure/cosmos-db/mongodb/role-based-access-control
 * - A database is `PUT .../mongodbDatabases/{databaseName}` with `{ properties: { resource: { id }, options: {} } }`
 *   (no throughput of its own), 200 or 202 with Azure-AsyncOperation.
 *   https://learn.microsoft.com/rest/api/cosmos-db-resource-provider/mongo-db-resources/create-update-mongo-db-database
 * - An application connects to `<host>:10255` with `ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000`,
 *   `appname=@<appName>@`, `authSource=<its database>` and `authMechanism=SCRAM-SHA-256`.
 *   https://learn.microsoft.com/azure/cosmos-db/mongodb/how-to-setup-role-based-access-control
 * - A 202 is followed on its Azure-AsyncOperation URL (`status` Succeeded, Failed or Canceled, anything else is
 *   running; `error` when it failed), or on its Location when there is none, waiting Retry-After seconds.
 *   https://learn.microsoft.com/azure/azure-resource-manager/management/async-operations
 * - The service principal needs "DocumentDB Account Contributor" (5bd9cd88-fe45-4216-938b-f97437e15450):
 *   it holds Microsoft.DocumentDb/databaseAccounts/*. "Cosmos DB Operator" is not enough, it excludes
 *   mongodbUserDefinitions/write and /delete. Following an asynchronous operation needs the role at the
 *   resource group, not only on the account.
 *   https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/databases
 *
 * Chosen where the documentation does not settle it:
 * - api-version 2025-10-15, the stable version before the newest (2026-07-15): every call here is in both.
 * - The host is `<account>.mongo.cosmos.azure.com`, the public cloud's: no sovereign cloud.
 * - appName is `@<account>@`, as the portal writes it in the connection strings of an account.
 * - The user and the database are looked for before they are created, so that one already there is refused
 *   rather than updated by the PUT, which creates or updates. The two references above document no request
 *   header for these PUTs (no If-None-Match, no If-Match), so a create-only PUT cannot be asked for: a user
 *   definition or a database created by someone else between the GET and the PUT would be updated. The
 *   window is the few hundred milliseconds between the two calls; it is left as it is.
 */
import { DatabaseExistsError, DatabaseProvisioner, DatabaseUserExistsError, dropOwnUser, MONGO_RESERVED_NAMES, MONGODB_RESOURCE, reasonOf, rolesOn } from "./MongoProvisioner"

export const ARM_BASE_URL = "https://management.azure.com"
export const COSMOS_API_VERSION = "2025-10-15"
export const ENTRA_BASE_URL = "https://login.microsoftonline.com"
/** One call to Azure Resource Manager or to Entra ID */
const AZURE_TIMEOUT_MS = 15000
/** How long an asynchronous operation (a database, a user definition) may run before it counts as failed */
export const ASYNC_OPERATION_TIMEOUT_MS = 120000
const DEFAULT_RETRY_AFTER_S = 2
const MAX_RETRY_AFTER_S = 10
export const RBAC_CAPABILITY = "EnableMongoRoleBasedAccessControl"

/** An account of Azure Cosmos DB for MongoDB (RU) and the Entra service principal that manages it */
export interface CosmosMongoConnection {
    tenantId: string
    clientId: string
    clientSecret: string
    subscriptionId: string
    resourceGroup: string
    accountName: string
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** How long to wait before asking again: the Retry-After Azure gave, bounded */
const retryDelayMs = (header: string | null): number => {
    const seconds = Number(header ?? DEFAULT_RETRY_AFTER_S)
    return Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S) * 1000
}

/**
 * Whether the operation a status answer is about has ended; throws when it ended badly. A Location answers
 * 202 while it runs and 200 or 204 once done; an Azure-AsyncOperation answers 200 with the status in the body.
 */
const hasEnded = async (response: Response, byOperation: boolean, what: string): Promise<boolean> => {
    if (!byOperation) return response.status !== 202
    const { status = "", error } = (await response.json()) as { status?: string; error?: { message?: string; code?: string } }
    const state = status.toLowerCase()
    if (!["succeeded", "failed", "canceled"].includes(state)) return false
    if (state !== "succeeded") throw new Error(`Azure could not ${what}: ${error?.message ?? error?.code ?? status}`)
    return true
}

export class CosmosMongoProvisioner implements DatabaseProvisioner {
    readonly resource = MONGODB_RESOURCE
    readonly reservedNames = MONGO_RESERVED_NAMES
    readonly secrets: string[]
    /** One token for every call of this provisioner: it lives for an hour, a request lasts seconds */
    private token?: Promise<string>
    /** The databases ensureUser made on this instance: a rollback drops those, and never one that was already there */
    private readonly created = new Set<string>()

    constructor(private readonly connection: CosmosMongoConnection) {
        this.secrets = [connection.clientSecret]
    }

    private accessToken(): Promise<string> {
        this.token ??= (async () => {
            const response = await fetch(`${ENTRA_BASE_URL}/${encodeURIComponent(this.connection.tenantId)}/oauth2/v2.0/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                body: new URLSearchParams({
                    grant_type: "client_credentials",
                    client_id: this.connection.clientId,
                    client_secret: this.connection.clientSecret,
                    scope: `${ARM_BASE_URL}/.default`
                }).toString(),
                signal: AbortSignal.timeout(AZURE_TIMEOUT_MS)
            })
            if (!response.ok) throw new Error(`Entra ID refused the service principal: ${await reasonOf(response)}`)
            const { access_token: token } = (await response.json()) as { access_token?: string }
            if (!token) throw new Error("Entra ID answered without an access token")
            return token
        })()
        return this.token
    }

    private async request(method: string, url: string, body?: unknown): Promise<Response> {
        return fetch(url, {
            method,
            headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: "application/json", ...(body !== undefined && { "Content-Type": "application/json" }) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(AZURE_TIMEOUT_MS)
        })
    }

    private accountUrl(path = ""): string {
        const { subscriptionId, resourceGroup, accountName } = this.connection
        const account = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.DocumentDB/databaseAccounts/${encodeURIComponent(accountName)}`
        return `${ARM_BASE_URL}${account}${path}?api-version=${COSMOS_API_VERSION}`
    }

    /**
     * A call on the account, waited for when Azure runs it asynchronously; the statuses in `accepted` are an
     * answer, not an error. The message names the kind of resource, never its id or the body sent.
     */
    private async call(method: string, path: string, body?: unknown, accepted: number[] = []): Promise<Response> {
        const response = await this.request(method, this.accountUrl(path), body)
        const what = `${method} ${path.split("/")[1] || "databaseAccounts"}`
        if (!response.ok && !accepted.includes(response.status)) throw new Error(`Azure answered ${what}: ${await reasonOf(response)}`)
        if (response.status === 201 || response.status === 202) await this.waitFor(response, what)
        return response
    }

    /**
     * Follows an operation Azure runs asynchronously until it ends. The bearer token goes only to Azure
     * Resource Manager: a URL of a header pointing anywhere else is not followed.
     */
    private async waitFor(accepted: Response, what: string): Promise<void> {
        const operation = accepted.headers.get("azure-asyncoperation")
        const url = operation ?? accepted.headers.get("location")
        if (!url) return
        if (!url.startsWith(`${ARM_BASE_URL}/`)) throw new Error(`Azure answered ${what} with an operation outside Azure Resource Manager`)
        const deadline = Date.now() + ASYNC_OPERATION_TIMEOUT_MS
        let retryAfter = accepted.headers.get("retry-after")
        for (;;) {
            if (Date.now() > deadline) throw new Error(`Azure did not finish ${what} within ${ASYNC_OPERATION_TIMEOUT_MS / 1000} seconds`)
            await sleep(retryDelayMs(retryAfter))
            const response = await this.request("GET", url)
            if (!response.ok) throw new Error(`Azure answered the status of ${what}: ${await reasonOf(response)}`)
            if (await hasEnded(response, Boolean(operation), what)) return
            retryAfter = response.headers.get("retry-after")
        }
    }

    /** A user definition is named `<database>.<user>` */
    private userPath(database: string, username: string): string {
        return `/mongodbUserDefinitions/${encodeURIComponent(database + "." + username)}`
    }

    /** The account answers, is one of the API for MongoDB, and has role-based access control on: without it there are no users to create */
    async test(): Promise<void> {
        const account = (await (await this.call("GET", "")).json()) as { kind?: string; properties?: { capabilities?: Array<{ name?: string }> } }
        if (account.kind !== "MongoDB") throw new Error(`${this.connection.accountName} is not an account of Azure Cosmos DB for MongoDB (RU)`)
        if (!account.properties?.capabilities?.some(capability => capability.name === RBAC_CAPABILITY)) {
            throw new Error(`${this.connection.accountName} does not have role-based access control: turn on ${RBAC_CAPABILITY} (Features in the Azure portal)`)
        }
    }

    /** The database is created first, as a user definition is granted roles on an existing one; neither may be there already */
    async ensureUser(database: string, username: string, password: string): Promise<void> {
        await this.test()
        const existing = await this.call("GET", this.userPath(database, username), undefined, [404])
        if (existing.status !== 404) throw new DatabaseUserExistsError(username)
        const found = await this.call("GET", `/mongodbDatabases/${encodeURIComponent(database)}`, undefined, [404])
        if (found.status !== 404) throw new DatabaseExistsError(database)
        const roles = rolesOn(database).map(({ role, db }) => ({ db, role }))
        let databaseCreated = false
        let userSent = false
        try {
            await this.call("PUT", `/mongodbDatabases/${encodeURIComponent(database)}`, { properties: { resource: { id: database }, options: {} } })
            // Only once its PUT, and the operation behind it, succeeded: a database whose PUT failed is not known to be ours
            databaseCreated = true
            this.created.add(database)
            userSent = true
            await this.call("PUT", this.userPath(database, username), { properties: { userName: username, password, databaseName: database, mechanisms: "SCRAM-SHA-256", roles } })
        } catch (error) {
            try {
                // A user PUT that failed or timed out may still create the definition: it is ours, and never left behind without a word
                if (userSent) await dropOwnUser(username, () => this.dropUser(username, database))
            } finally {
                // The empty database this call made goes with it
                if (databaseCreated) {
                    await this.dropDatabase(database).catch(() => undefined)
                    this.created.delete(database)
                }
            }
            throw error
        }
    }

    async rollbackCreate(database: string, username: string): Promise<void> {
        await dropOwnUser(username, () => this.dropUser(username, database))
        if (this.created.has(database)) {
            await this.dropDatabase(database).catch(() => undefined)
            this.created.delete(database)
        }
    }

    async dropUser(username: string, database: string): Promise<void> {
        await this.call("DELETE", this.userPath(database, username), undefined, [404])
    }

    /** Through Azure Resource Manager, as the database was created: no account of the driver is needed */
    async dropDatabase(database: string): Promise<void> {
        await this.call("DELETE", `/mongodbDatabases/${encodeURIComponent(database)}`, undefined, [404])
    }

    /** Written out rather than through withAccount: the `@` of its appName is one parseMongoUri refuses in a typed URI */
    connectionString(database: string, username: string, password: string): string {
        const { accountName } = this.connection
        const account = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`
        const options = `ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@${accountName}@&authSource=${encodeURIComponent(database)}&authMechanism=SCRAM-SHA-256`
        return `mongodb://${account}@${accountName}.mongo.cosmos.azure.com:10255/${encodeURIComponent(database)}?${options}`
    }

    async resourceFields(database: string, username: string, password: string): Promise<Record<string, string>> {
        return { connectionString: this.connectionString(database, username, password), database }
    }
}
