import mongoose from "mongoose"
import type { ResourceType } from "../types/ResourceCatalog"

/** How long the driver may look for a server before the operation counts as failed */
export const MONGO_TIMEOUT_MS = 5000
/** How long one call to the Atlas Admin API may take */
export const ATLAS_TIMEOUT_MS = 10000
export const ATLAS_BASE_URL = "https://cloud.mongodb.com"
/** The version of the Atlas Admin API the calls are written against: a newer one may change the bodies */
const ATLAS_ACCEPT = "application/vnd.atlas.2023-01-01+json"
/**
 * A new Atlas user takes some seconds to reach the nodes: an authentication failure is tried again this far apart,
 * for this long at most, which with the last try keeps a create well under a 60 second gateway timeout
 */
export const ATLAS_PROPAGATION_TIMEOUT_MS = 25000
export const ATLAS_PROPAGATION_DELAY_MS = 3000
/** How many times a user Flightroom created is dropped again before it is reported as left on the server, and the pause between tries */
export const DROP_ATTEMPTS = 3
export const DROP_BACKOFF_MS = 500

/** What a MONGODB server is reached with: the URI of an account allowed to create users, usually root with authSource=admin */
export interface MongoDbConnection {
    connectionString: string
}

/** An Atlas project reached through a service account (OAuth2 client credentials), and the cluster its databases live on */
export interface AtlasConnection {
    clientId: string
    clientSecret: string
    groupId: string
    clusterName: string
}

/**
 * Creates and removes the databases of a server, each with a user of its own. Nothing here is
 * specific to an engine for the callers: ProvisionedDatabaseService only learns from it which
 * resource the databases feed and the values to write there, so another engine is another
 * implementation of this, not a change to the service.
 */
export interface DatabaseProvisioner {
    /** The resource a database of this server feeds: its type, its variant and the fields written per environment */
    readonly resource: { type: ResourceType; variant: string; fields: readonly string[] }
    /** Names a database cannot take on this server: the engine keeps them for itself */
    readonly reservedNames: readonly string[]
    /** What no error message may ever quote: the credentials of the server */
    readonly secrets: readonly string[]
    /** Reaches the server with its credentials, changing nothing */
    test(): Promise<void>
    /**
     * Creates the user of a database. A user already there is refused with a DatabaseUserExistsError, never taken
     * over: it may belong to someone else, and a new password and new roles would lock them out or let us in. So
     * is a database already there, with a DatabaseExistsError. When it throws, it has undone its own partial work:
     * the caller has nothing to drop
     */
    ensureUser(database: string, username: string, password: string): Promise<void>
    /**
     * Undoes a create whose ensureUser resolved, when what came after it failed: the user, and whatever else that
     * call made for it (the database on Cosmos DB). Nothing that was there before is touched
     */
    rollbackCreate(database: string, username: string): Promise<void>
    /** Removes the user of a database; a user that is not there is not an error */
    dropUser(username: string, database: string): Promise<void>
    /** Drops the database and its data, connected as its own user */
    dropDatabase(database: string, username: string, password: string): Promise<void>
    /** The values of the resource fields an application of this database reads, by field name */
    resourceFields(database: string, username: string, password: string): Promise<Record<string, string>>
}

/** The refusal of a user that already exists on the server: told apart from every other failure, as nothing of it is ours to undo */
export class DatabaseUserExistsError extends Error {
    constructor(readonly username: string) {
        super(`A user named ${username} already exists on the server`)
        this.name = "DatabaseUserExistsError"
    }
}

/**
 * The refusal of a database that already exists on the server: its data is someone else's, and a new user with
 * readWrite and dbAdmin on it would reach it. Told apart as nothing of it is ours to undo.
 */
export class DatabaseExistsError extends Error {
    constructor(readonly database: string) {
        super(`A database named ${database} already exists on the server`)
        this.name = "DatabaseExistsError"
    }
}

/**
 * A user Flightroom created and could not remove again, after a few tries: it is still on the server, and the
 * caller must keep track of it rather than forget it.
 */
export class UserLeftOnServerError extends Error {
    constructor(
        readonly username: string,
        readonly reason: string
    ) {
        super(`The user ${username} was created on the server and could not be removed again (${reason}): it is still there`)
        this.name = "UserLeftOnServerError"
    }
}

/** The cluster does not answer the driver of the backend, which a create and a drop need: on Atlas, usually its IP Access List */
export class ClusterUnreachableError extends Error {
    constructor(
        readonly cluster: string,
        readonly reason: string
    ) {
        super(`The backend could not reach the cluster ${cluster} through the driver (${reason}): add the egress IP address of the Flightroom backend to the IP Access List of the Atlas project`)
        this.name = "ClusterUnreachableError"
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Drops a user this call created, a few times before giving up: a user Flightroom made is never left behind without a word */
export const dropOwnUser = async (username: string, drop: () => Promise<void>): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
        try {
            await drop()
            return
        } catch (error) {
            if (attempt >= DROP_ATTEMPTS) throw new UserLeftOnServerError(username, (error as Error).message)
            await sleep(DROP_BACKOFF_MS * attempt)
        }
    }
}

/** A connection string taken apart: only what is rewritten for an application is kept separate */
export interface MongoUri {
    scheme: "mongodb" | "mongodb+srv"
    /** `user:password`, percent-encoded as in the URI */
    credentials?: string
    /** One host or several, comma separated, with their ports */
    hosts: string
    /** The options, `key=value` each, as they were written */
    options: string[]
}

/**
 * Parsed by hand: `new URL` refuses the several hosts of a replica set. The credentials must be
 * percent-encoded, as the driver requires, so none of `@ / ? #` appears in them unescaped. An `@` after the
 * authority is refused: in `user:p/ss@host` or `user:p?ss@host` it would make the password a host and a path.
 */
const MONGO_URI = /^(mongodb(?:\+srv)?):\/\/(?:([^/?#@]*)@)?([^/?#@]+)(?:\/([^?#@]*))?(?:\?([^#@]*))?$/

/** Its error never quotes the string: it carries the password */
export const parseMongoUri = (uri: string): MongoUri => {
    const match = MONGO_URI.exec(uri.trim())
    if (!match) {
        // What follows the user, the password and the hosts: an @ there is the mistake usually made
        const scheme = /^mongodb(\+srv)?:\/\//.exec(uri.trim())
        const afterHosts = scheme
            ? uri
                  .trim()
                  .slice(scheme[0].length)
                  .replace(/^[^/?#]*/, "")
            : ""
        if (afterHosts.includes("@")) {
            throw new Error("An @ in the path or the options of the connection string is not allowed: percent-encode it as %40 (appName=@...@ is the usual one)")
        }
        throw new Error("The connection string is not a mongodb:// or mongodb+srv:// URI with percent-encoded credentials")
    }
    const [, scheme, credentials, hosts, , query] = match
    return { scheme: scheme as MongoUri["scheme"], ...(credentials !== undefined && { credentials }), hosts, options: query ? query.split("&").filter(Boolean) : [] }
}

/**
 * The options of the admin URI an application gets too: how to reach the hosts and how to behave there. Anything
 * else stays with the admin account: how it authenticates (auth*), its certificates (tlsCertificateKeyFile*,
 * tlsCAFile) and its proxy (proxy*), which are files and hosts of the backend, not of the application.
 */
const APPLICATION_OPTIONS = new Set(
    [
        "replicaSet",
        "tls",
        "ssl",
        "directConnection",
        "readPreference",
        "readPreferenceTags",
        "retryWrites",
        "retryReads",
        "w",
        "wtimeoutMS",
        "journal",
        "appName",
        "compressors",
        "maxPoolSize",
        "minPoolSize",
        "maxIdleTimeMS",
        "connectTimeoutMS",
        "socketTimeoutMS",
        "serverSelectionTimeoutMS",
        "loadBalanced",
        "srvServiceName",
        "srvMaxHosts",
        // How the application trusts the certificate of the same server the admin URI reaches
        "tlsAllowInvalidCertificates",
        "tlsAllowInvalidHostnames",
        "tlsInsecure"
    ].map(option => option.toLowerCase())
)

/**
 * The URI an application connects with: the hosts, the scheme and the application options of `uri`
 * (replicaSet, tls...), with the account and the database given in place of the ones it had.
 */
export const withAccount = (uri: string, account: { database: string; username: string; password: string; authSource: string }, extraOptions: string[] = []): string => {
    const { scheme, hosts, options } = parseMongoUri(uri)
    const kept = options.filter(option => APPLICATION_OPTIONS.has(option.split("=")[0].toLowerCase()))
    const names = new Set(kept.map(option => option.split("=")[0].toLowerCase()))
    const query = [...kept, `authSource=${encodeURIComponent(account.authSource)}`, ...extraOptions.filter(option => !names.has(option.split("=")[0].toLowerCase()))]
    return `${scheme}://${encodeURIComponent(account.username)}:${encodeURIComponent(account.password)}@${hosts}/${encodeURIComponent(account.database)}?${query.join("&")}`
}

/** The password inside a URI, as written and decoded: a driver may quote either */
const passwordsOf = (uri: string): string[] => {
    try {
        const password = parseMongoUri(uri).credentials?.split(":").slice(1).join(":")
        return password ? [password, decodeURIComponent(password)] : []
    } catch {
        return []
    }
}

const withClient = async <T>(uri: string, run: (client: InstanceType<typeof mongoose.mongo.MongoClient>) => Promise<T>): Promise<T> => {
    const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: MONGO_TIMEOUT_MS, connectTimeoutMS: MONGO_TIMEOUT_MS })
    try {
        await client.connect()
        return await run(client)
    } finally {
        await client.close().catch(() => undefined)
    }
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown })?.code

/**
 * Whether a write may have been applied although it failed: no answer at all (a network error, a timeout, no
 * server selected), or an answer that does not say (a time limit hit, a write concern not met, a server going
 * down or stepping down). A refusal with any other code of the server was not applied.
 */
const UNKNOWN_OUTCOME_CODES = [50, 64, 91, 189, 11600, 11602]
export const isUnknownOutcome = (error: unknown): boolean => {
    const code = codeOf(error)
    return typeof code !== "number" || UNKNOWN_OUTCOME_CODES.includes(code) || (error as { name?: string })?.name === "MongoWriteConcernError"
}

/**
 * What a user Atlas has not finished rolling out gets: a failure to authenticate (the server's 18, Atlas's 8000, or the
 * words of either), or a refusal of its roles not there yet (13, Unauthorized)
 */
const isNotRolledOutYet = (error: unknown): boolean => [13, 18, 8000].includes(codeOf(error) as number) || /authentication failed|bad auth/i.test((error as { message?: string })?.message ?? "")

/** The server's own codes: a createUser of a user already there, a dropUser of one that is not */
const USER_ALREADY_EXISTS = 51003
const USER_NOT_FOUND = 11

/** What the databases of a MongoDB server feed: a mongodb resource reached by its connection string */
export const MONGODB_RESOURCE = { type: "mongodb" as const, variant: "connectionString", fields: ["connectionString", "database"] }

/** Where MongoDB keeps its users, its replication log and the metadata of a sharded cluster */
export const MONGO_RESERVED_NAMES = ["admin", "local", "config"]

/** readWrite for the application, dbAdmin for its indexes and for dropping the database: nothing outside it */
export const rolesOn = (database: string) => [
    { role: "readWrite", db: database },
    { role: "dbAdmin", db: database }
]

/** A self-hosted server: the users are created through the driver, with the admin URI */
export class MongoDbProvisioner implements DatabaseProvisioner {
    readonly resource = MONGODB_RESOURCE
    readonly reservedNames = MONGO_RESERVED_NAMES
    readonly secrets: string[]

    constructor(private readonly connection: MongoDbConnection) {
        this.secrets = [connection.connectionString, ...passwordsOf(connection.connectionString)]
    }

    async test(): Promise<void> {
        await withClient(this.connection.connectionString, client => client.db("admin").command({ ping: 1 }))
    }

    async ensureUser(database: string, username: string, password: string): Promise<void> {
        await withClient(this.connection.connectionString, async client => {
            // A database is listed once it holds something: one that does not is nobody's data yet
            // authorizedDatabases false: an account that may not list every database fails here, rather than seeing none
            const listed = (await client.db("admin").command({ listDatabases: 1, nameOnly: true, authorizedDatabases: false, filter: { name: database } })) as { databases?: unknown[] }
            if (listed.databases?.length) throw new DatabaseExistsError(database)
            // Proven absent before the create: only then may a create of unknown outcome be undone by dropping that name
            const info = (await client.db(database).command({ usersInfo: username })) as { users?: unknown[] }
            if (info.users?.length) throw new DatabaseUserExistsError(username)
            try {
                await client.db(database).command({ createUser: username, pwd: password, roles: rolesOn(database) })
            } catch (error) {
                if (codeOf(error) === USER_ALREADY_EXISTS) throw new DatabaseUserExistsError(username)
                // It was not there (usersInfo said so) and may be now: it is ours to drop before anything else is said
                if (isUnknownOutcome(error)) await dropOwnUser(username, () => this.dropUser(username, database))
                throw error
            }
        })
    }

    async rollbackCreate(database: string, username: string): Promise<void> {
        await dropOwnUser(username, () => this.dropUser(username, database))
    }

    async dropUser(username: string, database: string): Promise<void> {
        await withClient(this.connection.connectionString, async client => {
            try {
                await client.db(database).command({ dropUser: username })
            } catch (error) {
                if (codeOf(error) !== USER_NOT_FOUND) throw error
            }
        })
    }

    async dropDatabase(database: string, username: string, password: string): Promise<void> {
        await withClient(this.connectionString(database, username, password), client => client.db(database).dropDatabase())
    }

    /** The user is defined in its own database, so that is where it authenticates */
    connectionString(database: string, username: string, password: string): string {
        return withAccount(this.connection.connectionString, { database, username, password, authSource: database })
    }

    async resourceFields(database: string, username: string, password: string): Promise<Record<string, string>> {
        return { connectionString: this.connectionString(database, username, password), database }
    }
}

/** The reason a cloud API gave, from the JSON it answers errors with: Atlas, Azure Resource Manager and the OAuth2 token endpoints */
export const reasonOf = async (response: Response): Promise<string> => {
    const body = (await response.json().catch(() => undefined)) as
        | { detail?: string; error_description?: string; errorCode?: string; reason?: string; error?: { message?: string; code?: string } | string }
        | undefined
    const azure = typeof body?.error === "object" ? (body.error.message ?? body.error.code) : undefined
    return `${response.status} ${body?.detail ?? body?.error_description ?? azure ?? body?.errorCode ?? body?.reason ?? response.statusText}`.trim()
}

/** Atlas: the users are created through the Admin API, the database is dropped through the driver as its own user */
export class AtlasProvisioner implements DatabaseProvisioner {
    readonly resource = MONGODB_RESOURCE
    readonly reservedNames = MONGO_RESERVED_NAMES
    readonly secrets: string[]
    /** One token for every call of this provisioner: it lives for an hour, a request lasts seconds */
    private token?: Promise<string>

    constructor(private readonly connection: AtlasConnection) {
        this.secrets = [connection.clientSecret]
    }

    private accessToken(): Promise<string> {
        this.token ??= (async () => {
            const basic = Buffer.from(`${this.connection.clientId}:${this.connection.clientSecret}`).toString("base64")
            const response = await fetch(`${ATLAS_BASE_URL}/api/oauth/token`, {
                method: "POST",
                headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                body: "grant_type=client_credentials",
                signal: AbortSignal.timeout(ATLAS_TIMEOUT_MS)
            })
            if (!response.ok) throw new Error(`Atlas refused the service account: ${await reasonOf(response)}`)
            const { access_token: token } = (await response.json()) as { access_token?: string }
            if (!token) throw new Error("Atlas answered without an access token")
            return token
        })()
        return this.token
    }

    /** A call of the Admin API; the statuses in `accepted` are an answer, not an error */
    private async call(method: string, path: string, body?: unknown, accepted: number[] = []): Promise<Response> {
        const response = await fetch(`${ATLAS_BASE_URL}/api/atlas/v2/groups/${encodeURIComponent(this.connection.groupId)}${path}`, {
            method,
            headers: { Authorization: `Bearer ${await this.accessToken()}`, Accept: ATLAS_ACCEPT, ...(body !== undefined && { "Content-Type": "application/json" }) },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(ATLAS_TIMEOUT_MS)
        })
        if (!response.ok && !accepted.includes(response.status)) {
            throw Object.assign(new Error(`Atlas answered ${method} ${path.split("/")[1]}: ${await reasonOf(response)}`), { status: response.status })
        }
        return response
    }

    private userPath(username: string): string {
        return `/databaseUsers/admin/${encodeURIComponent(username)}`
    }

    async test(): Promise<void> {
        await this.call("GET", `/clusters/${encodeURIComponent(this.connection.clusterName)}`)
    }

    /**
     * Atlas keeps every user in admin; the roles and the scope keep it to its database on its cluster. The Admin API
     * cannot tell whether the database already exists (it lists databases per node of a cluster only), so the new user
     * itself looks, once Atlas has rolled it out: a database with collections is someone else's, and the user goes
     * again. A check that cannot be made fails the create the same way, as the user cannot be trusted with it. The
     * look goes through the driver: the backend needs to reach the cluster, which the test of the server does not try.
     */
    async ensureUser(database: string, username: string, password: string): Promise<void> {
        const roles = rolesOn(database).map(({ role, db }) => ({ roleName: role, databaseName: db }))
        const scopes = [{ name: this.connection.clusterName, type: "CLUSTER" }]
        // Proven absent before the create (a refusal of the service account fails here too): only then may a create of
        // unknown outcome be undone by deleting that name, which could otherwise be an application's user
        const existing = await this.call("GET", this.userPath(username), undefined, [404])
        if (existing.status !== 404) throw new DatabaseUserExistsError(username)
        let created: Response
        try {
            created = await this.call("POST", "/databaseUsers", { databaseName: "admin", username, password, roles, scopes }, [409])
        } catch (error) {
            // No answer, or an error of Atlas itself: the user may have been created, and was not there (the GET said so)
            const status = (error as { status?: number }).status
            if (status === undefined || status >= 500) await dropOwnUser(username, () => this.dropUser(username))
            throw error
        }
        // Atlas keeps one list of users for the whole project: the name may be taken by an application that is not ours
        if (created.status === 409) throw new DatabaseUserExistsError(username)
        let collections: unknown[]
        try {
            collections = await this.collectionsAs(database, username, password)
        } catch (error) {
            await dropOwnUser(username, () => this.dropUser(username))
            if (error instanceof ClusterUnreachableError) throw error
            throw new Error(`Could not check that ${database} is new as its user: ${(error as Error).message}`)
        }
        if (collections.length > 0) {
            await dropOwnUser(username, () => this.dropUser(username))
            throw new DatabaseExistsError(database)
        }
    }

    /**
     * The collections of the database as its new user sees them. Only what a user Atlas has not rolled out yet gets (an
     * authentication failure, its roles refused) is tried again, for ATLAS_PROPAGATION_TIMEOUT_MS at most; anything else (a host not
     * found, a refused connection, no server selected, TLS) fails at once as the cluster being out of reach.
     */
    private async collectionsAs(database: string, username: string, password: string): Promise<unknown[]> {
        const uri = await this.connectionString(database, username, password)
        const deadline = Date.now() + ATLAS_PROPAGATION_TIMEOUT_MS
        for (;;) {
            try {
                return await withClient(uri, client => client.db(database).listCollections({}, { nameOnly: true }).toArray())
            } catch (error) {
                if (!isNotRolledOutYet(error)) throw new ClusterUnreachableError(this.connection.clusterName, (error as Error).message)
                if (Date.now() + ATLAS_PROPAGATION_DELAY_MS > deadline) throw error
                await sleep(ATLAS_PROPAGATION_DELAY_MS)
            }
        }
    }

    async rollbackCreate(_database: string, username: string): Promise<void> {
        await dropOwnUser(username, () => this.dropUser(username))
    }

    async dropUser(username: string): Promise<void> {
        await this.call("DELETE", this.userPath(username), undefined, [404])
    }

    // On Atlas no account reaches the data through the driver but those created here: the database's own does
    async dropDatabase(database: string, username: string, password: string): Promise<void> {
        await withClient(await this.connectionString(database, username, password), client => client.db(database).dropDatabase())
    }

    async connectionString(database: string, username: string, password: string): Promise<string> {
        const cluster = (await (await this.call("GET", `/clusters/${encodeURIComponent(this.connection.clusterName)}`)).json()) as { connectionStrings?: { standardSrv?: string } }
        const srv = cluster.connectionStrings?.standardSrv
        if (!srv) throw new Error(`Atlas gave no connection string for the cluster ${this.connection.clusterName}: is it still being created?`)
        return withAccount(srv, { database, username, password, authSource: "admin" }, ["retryWrites=true", "w=majority"])
    }

    async resourceFields(database: string, username: string, password: string): Promise<Record<string, string>> {
        return { connectionString: await this.connectionString(database, username, password), database }
    }
}
