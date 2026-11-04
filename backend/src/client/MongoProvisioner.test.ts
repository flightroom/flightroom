import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    ATLAS_BASE_URL,
    ATLAS_PROPAGATION_DELAY_MS,
    ATLAS_PROPAGATION_TIMEOUT_MS,
    AtlasProvisioner,
    ClusterUnreachableError,
    DatabaseExistsError,
    DatabaseUserExistsError,
    DROP_ATTEMPTS,
    DROP_BACKOFF_MS,
    dropOwnUser,
    isUnknownOutcome,
    MongoDbProvisioner,
    parseMongoUri,
    UserLeftOnServerError,
    withAccount
} from "./MongoProvisioner"

/**
 * The driver is stubbed: no test opens a socket. Each client records the URI it was built with and the
 * database it was asked for, so a test reads what was sent where.
 */
const driver = vi.hoisted(() => ({
    uris: [] as string[],
    databases: [] as string[],
    connect: vi.fn(),
    close: vi.fn(),
    command: vi.fn(),
    dropDatabase: vi.fn(),
    listCollections: vi.fn()
}))

vi.mock("mongoose", () => ({
    default: {
        mongo: {
            MongoClient: class {
                constructor(uri: string) {
                    driver.uris.push(uri)
                }
                connect = driver.connect
                close = driver.close
                db = (name: string) => {
                    driver.databases.push(name)
                    return { command: driver.command, dropDatabase: driver.dropDatabase, listCollections: (...args: unknown[]) => ({ toArray: () => driver.listCollections(...args) }) }
                }
            }
        }
    }
}))

const ADMIN_URI = "mongodb://root:r%40ot-pw@db-0.internal:27017,db-1.internal:27017/admin?replicaSet=rs0&authSource=admin&tls=true"

const serverError = (code: number, message: string) => Object.assign(new Error(message), { code })

beforeEach(() => {
    driver.uris = []
    driver.databases = []
    driver.connect.mockReset().mockResolvedValue(undefined)
    driver.close.mockReset().mockResolvedValue(undefined)
    driver.command.mockReset().mockResolvedValue({ ok: 1 })
    driver.dropDatabase.mockReset().mockResolvedValue(true)
    driver.listCollections.mockReset().mockResolvedValue([])
})

describe("parseMongoUri", () => {
    it("given a single host, when it is parsed, then the scheme, the credentials, the host and the options come apart", () => {
        expect(parseMongoUri("mongodb://root:pw@db.internal:27017/admin?authSource=admin")).toEqual({
            scheme: "mongodb",
            credentials: "root:pw",
            hosts: "db.internal:27017",
            options: ["authSource=admin"]
        })
    })

    it("given several hosts, when it is parsed, then they stay together as written", () => {
        expect(parseMongoUri(ADMIN_URI).hosts).toBe("db-0.internal:27017,db-1.internal:27017")
    })

    it("given a mongodb+srv URI with no credentials and no path, when it is parsed, then it is read", () => {
        expect(parseMongoUri("mongodb+srv://cluster0.abcde.mongodb.net")).toEqual({ scheme: "mongodb+srv", hosts: "cluster0.abcde.mongodb.net", options: [] })
    })

    /** In `root:p/ss@db` the password would be read as a host and a path */
    it.each(["postgres://root:pw@db/orders", "mongodb://", "mongodb://root:p@ss@db/admin", "not a uri"])("given %s, when it is parsed, then it is refused without quoting it", uri => {
        expect(() => parseMongoUri(uri)).toThrow("The connection string is not a mongodb:// or mongodb+srv:// URI with percent-encoded credentials")
    })

    it.each(["mongodb://root:p/ss@db/admin", "mongodb://root:p?ss@db", "mongodb://root:pw@db/admin?appName=@cluster0@"])(
        "given %s, with an @ after the hosts, when it is parsed, then the refusal says to write it as %40",
        uri => {
            expect(() => parseMongoUri(uri)).toThrow("An @ in the path or the options of the connection string is not allowed: percent-encode it as %40 (appName=@...@ is the usual one)")
        }
    )
})

describe("withAccount", () => {
    const account = { database: "orders_dev", username: "orders_dev", password: "pw/with:chars@", authSource: "orders_dev" }

    it("given an admin URI with several hosts and options, when an application account replaces its own, then hosts and options are kept and the database is the path", () => {
        expect(withAccount(ADMIN_URI, account)).toBe("mongodb://orders_dev:pw%2Fwith%3Achars%40@db-0.internal:27017,db-1.internal:27017/orders_dev?replicaSet=rs0&tls=true&authSource=orders_dev")
    })

    it("given an admin URI with its own mechanism, when an application account replaces its own, then the mechanism goes with the admin account", () => {
        expect(withAccount("mongodb://root:pw@db/admin?authMechanism=SCRAM-SHA-1&AUTHSOURCE=admin&w=majority", account)).toBe(
            "mongodb://orders_dev:pw%2Fwith%3Achars%40@db/orders_dev?w=majority&authSource=orders_dev"
        )
    })

    it("given admin-only options, when an application account replaces its own, then only the options of an application are kept", () => {
        const uri = "mongodb://root:pw@db/admin?proxyHost=proxy.internal&tlsCertificateKeyFile=/etc/admin.pem&tlsCAFile=/etc/ca.pem&readPreference=secondary&compressors=zstd"
        expect(withAccount(uri, account)).toBe("mongodb://orders_dev:pw%2Fwith%3Achars%40@db/orders_dev?readPreference=secondary&compressors=zstd&authSource=orders_dev")
    })

    it("given a mongodb+srv URI and extra options, when an account is added, then +srv stays and an option already written is not repeated", () => {
        expect(withAccount("mongodb+srv://cluster0.abcde.mongodb.net/?w=1", { ...account, authSource: "admin" }, ["retryWrites=true", "w=majority"])).toBe(
            "mongodb+srv://orders_dev:pw%2Fwith%3Achars%40@cluster0.abcde.mongodb.net/orders_dev?w=1&authSource=admin&retryWrites=true"
        )
    })
})

describe("MongoDbProvisioner", () => {
    const provisioner = () => new MongoDbProvisioner({ connectionString: ADMIN_URI })

    it("given an admin URI, when the provisioner is built, then its secrets are the URI and its password as written and decoded", () => {
        expect(provisioner().secrets).toEqual([ADMIN_URI, "r%40ot-pw", "r@ot-pw"])
    })

    it("given an admin URI without credentials, when the provisioner is built, then the URI is the only secret", () => {
        expect(new MongoDbProvisioner({ connectionString: "mongodb://db.internal" }).secrets).toEqual(["mongodb://db.internal"])
    })

    it("given a server that answers, when it is tested, then admin is pinged and the client closed", async () => {
        await provisioner().test()

        expect(driver.uris).toEqual([ADMIN_URI])
        expect(driver.databases).toEqual(["admin"])
        expect(driver.command).toHaveBeenCalledWith({ ping: 1 })
        expect(driver.close).toHaveBeenCalled()
    })

    it("given a server that does not answer, when it is tested, then the failure comes back and the client is closed all the same", async () => {
        driver.connect.mockRejectedValue(new Error("Server selection timed out"))
        driver.close.mockRejectedValue(new Error("not connected"))

        await expect(provisioner().test()).rejects.toThrow("Server selection timed out")
        expect(driver.close).toHaveBeenCalled()
    })

    it("given a new user, when it is ensured, then it is created in its own database with readWrite and dbAdmin there", async () => {
        await provisioner().ensureUser("orders_dev", "orders_dev", "secret")

        expect(driver.databases).toEqual(["admin", "orders_dev"])
        expect(driver.command).toHaveBeenNthCalledWith(1, { listDatabases: 1, nameOnly: true, authorizedDatabases: false, filter: { name: "orders_dev" } })
        expect(driver.command).toHaveBeenCalledWith({
            createUser: "orders_dev",
            pwd: "secret",
            roles: [
                { role: "readWrite", db: "orders_dev" },
                { role: "dbAdmin", db: "orders_dev" }
            ]
        })
    })

    /** Its data is someone else's: a user with readWrite and dbAdmin on it would reach it */
    it("given a database already there, when a user is ensured, then it is refused before any user is created", async () => {
        driver.command.mockResolvedValueOnce({ databases: [{ name: "orders_dev" }] })

        await expect(provisioner().ensureUser("orders_dev", "orders_dev", "secret")).rejects.toBeInstanceOf(DatabaseExistsError)
        expect(driver.command).toHaveBeenCalledTimes(1)
    })

    /** It may be someone else's: a new password and new roles would lock them out, or let us into what is theirs */
    it("given a user already there, when it is ensured, then it is refused and never updated", async () => {
        driver.command.mockResolvedValueOnce({ databases: [] }).mockRejectedValueOnce(serverError(51003, "User already exists"))

        await expect(provisioner().ensureUser("orders_dev", "orders_dev", "secret")).rejects.toBeInstanceOf(DatabaseUserExistsError)
        expect(driver.command).toHaveBeenCalledTimes(2)
    })

    /** A createUser that got no answer may have created it: it was not there (no 51003), so it is ours to drop */
    it("given a createUser that timed out, when a user is ensured, then the user is dropped before the failure comes back", async () => {
        driver.command
            .mockResolvedValueOnce({ databases: [] })
            .mockRejectedValueOnce(Object.assign(new Error("connection timed out"), { name: "MongoNetworkTimeoutError" }))
            .mockResolvedValueOnce({ ok: 1 })

        await expect(provisioner().ensureUser("orders_dev", "orders_dev", "secret")).rejects.toThrow("connection timed out")
        expect(driver.command).toHaveBeenLastCalledWith({ dropUser: "orders_dev" })
    })

    it("given any other refusal, when a user is ensured, then it is not taken for an existing user", async () => {
        driver.command.mockResolvedValueOnce({ databases: [] }).mockRejectedValueOnce(serverError(13, "not authorized on orders_dev"))

        await expect(provisioner().ensureUser("orders_dev", "orders_dev", "secret")).rejects.toThrow("not authorized")
        expect(driver.command).toHaveBeenCalledTimes(2)
    })

    it("given a create to undo, when it is rolled back, then its user is dropped", async () => {
        await provisioner().rollbackCreate("orders_dev", "orders_dev")

        expect(driver.command).toHaveBeenCalledWith({ dropUser: "orders_dev" })
    })

    it("given a user, when it is dropped, then it is dropped in its database", async () => {
        await provisioner().dropUser("orders_dev", "orders_dev")

        expect(driver.databases).toEqual(["orders_dev"])
        expect(driver.command).toHaveBeenCalledWith({ dropUser: "orders_dev" })
    })

    it("given a user that is not there, when it is dropped, then it is not an error", async () => {
        driver.command.mockRejectedValue(serverError(11, "UserNotFound"))

        await expect(provisioner().dropUser("orders_dev", "orders_dev")).resolves.toBeUndefined()
    })

    it("given a refusal other than a missing user, when a user is dropped, then it comes back", async () => {
        driver.command.mockRejectedValue(serverError(13, "not authorized"))

        await expect(provisioner().dropUser("orders_dev", "orders_dev")).rejects.toThrow("not authorized")
    })

    it("given a database, when it is dropped, then the driver connects as its own user and drops it", async () => {
        await provisioner().dropDatabase("orders_dev", "orders_dev", "secret")

        expect(driver.uris).toEqual(["mongodb://orders_dev:secret@db-0.internal:27017,db-1.internal:27017/orders_dev?replicaSet=rs0&tls=true&authSource=orders_dev"])
        expect(driver.dropDatabase).toHaveBeenCalled()
    })

    it("given a database, when the fields of its resource are asked, then they are its URI and its name", async () => {
        expect(await provisioner().resourceFields("orders_dev", "orders_dev", "secret")).toEqual({
            connectionString: "mongodb://orders_dev:secret@db-0.internal:27017,db-1.internal:27017/orders_dev?replicaSet=rs0&tls=true&authSource=orders_dev",
            database: "orders_dev"
        })
    })
})

describe("AtlasProvisioner", () => {
    const connection = { clientId: "mdb_sa_id", clientSecret: "mdb_sa_sk_secret", groupId: "5f1a2b3c4d5e6f7a8b9c0d1e", clusterName: "Cluster0" }
    const api = `${ATLAS_BASE_URL}/api/atlas/v2/groups/${connection.groupId}`
    let fetchMock: ReturnType<typeof vi.fn>

    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
    /** Answers the token, then each call in turn */
    const answer = (...responses: Response[]) => {
        fetchMock.mockResolvedValueOnce(json(200, { access_token: "atlas-token", expires_in: 3600 }))
        for (const response of responses) fetchMock.mockResolvedValueOnce(response)
    }
    const call = (index: number) => {
        const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit]
        return {
            url,
            method: init.method,
            headers: init.headers as Record<string, string>,
            body: init.body === undefined ? undefined : typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body
        }
    }

    beforeEach(() => {
        fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("given a service account, when a call is made, then the token is asked with client credentials and the call carries it with the versioned Accept", async () => {
        answer(json(200, { name: "Cluster0" }))

        await new AtlasProvisioner(connection).test()

        expect(call(0)).toMatchObject({
            url: `${ATLAS_BASE_URL}/api/oauth/token`,
            method: "POST",
            body: "grant_type=client_credentials",
            headers: { Authorization: `Basic ${Buffer.from("mdb_sa_id:mdb_sa_sk_secret").toString("base64")}` }
        })
        expect(call(1)).toMatchObject({ url: `${api}/clusters/Cluster0`, method: "GET", headers: { Authorization: "Bearer atlas-token", Accept: "application/vnd.atlas.2023-01-01+json" } })
    })

    it("given two calls of one provisioner, when they are made, then the token is asked once", async () => {
        answer(json(200, {}), json(200, {}))
        const provisioner = new AtlasProvisioner(connection)

        await provisioner.test()
        await provisioner.test()

        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it("given a service account Atlas refuses, when a call is made, then the refusal says why", async () => {
        fetchMock.mockResolvedValueOnce(json(401, { error_description: "invalid client" }))

        await expect(new AtlasProvisioner(connection).test()).rejects.toThrow("Atlas refused the service account: 401 invalid client")
    })

    it("given a token answer with no token, when a call is made, then it is refused", async () => {
        fetchMock.mockResolvedValueOnce(json(200, {}))

        await expect(new AtlasProvisioner(connection).test()).rejects.toThrow("Atlas answered without an access token")
    })

    it("given a cluster Atlas does not know, when the server is tested, then the error names the call and the reason, not the user", async () => {
        answer(json(404, { detail: "No cluster named Cluster0 exists in group" }))

        await expect(new AtlasProvisioner(connection).test()).rejects.toThrow("Atlas answered GET clusters: 404 No cluster named Cluster0 exists in group")
    })

    it("given an error with no JSON body, when a call fails, then its status text is the reason", async () => {
        answer(new Response("gateway down", { status: 502, statusText: "Bad Gateway" }))

        await expect(new AtlasProvisioner(connection).test()).rejects.toThrow("Atlas answered GET clusters: 502 Bad Gateway")
    })

    const cluster = () => json(200, { connectionStrings: { standardSrv: "mongodb+srv://cluster0.abcde.mongodb.net" } })

    it("given a new user, when it is ensured, then it is created in admin, scoped to the cluster, with roles on its database only", async () => {
        answer(json(201, {}), cluster())

        await new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")

        expect(call(1)).toMatchObject({
            url: `${api}/databaseUsers`,
            method: "POST",
            body: {
                databaseName: "admin",
                username: "orders_dev",
                password: "secret",
                roles: [
                    { roleName: "readWrite", databaseName: "orders_dev" },
                    { roleName: "dbAdmin", databaseName: "orders_dev" }
                ],
                scopes: [{ name: "Cluster0", type: "CLUSTER" }]
            }
        })
    })

    it("given a new user, when it is ensured, then it looks at the database as that user and finds it new", async () => {
        answer(json(201, {}), cluster())

        await new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")

        expect(driver.uris).toEqual(["mongodb+srv://orders_dev:secret@cluster0.abcde.mongodb.net/orders_dev?authSource=admin&retryWrites=true&w=majority"])
        expect(driver.listCollections).toHaveBeenCalledWith({}, { nameOnly: true })
    })

    /** Its data is someone else's: the user just made would reach it, so it goes again */
    it("given a database with collections already on the cluster, when a user is ensured, then the user is deleted and the database refused", async () => {
        answer(json(201, {}), cluster(), new Response(null, { status: 204 }))
        driver.listCollections.mockResolvedValue([{ name: "reports" }])

        await expect(new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")).rejects.toBeInstanceOf(DatabaseExistsError)
        expect(call(3)).toMatchObject({ url: `${api}/databaseUsers/admin/orders_dev`, method: "DELETE" })
    })

    it("given a user Atlas has not rolled out yet, when it is ensured, then the check is tried again until it gets through", async () => {
        vi.useFakeTimers()
        answer(json(201, {}), cluster())
        driver.listCollections.mockRejectedValueOnce(serverError(18, "Authentication failed")).mockResolvedValue([])

        const ensuring = new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")
        await vi.advanceTimersByTimeAsync(ATLAS_PROPAGATION_DELAY_MS)
        await ensuring
        vi.useRealTimers()

        expect(driver.listCollections).toHaveBeenCalledTimes(2)
    })

    it("given a user that never authenticates, when a user is ensured, then it is tried for the propagation time only, then deleted, and the create fails", async () => {
        vi.useFakeTimers()
        answer(json(201, {}), cluster(), new Response(null, { status: 204 }))
        driver.listCollections.mockRejectedValue(serverError(18, "Authentication failed"))

        const ensuring = new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")
        const failure = expect(ensuring).rejects.toThrow("Could not check that orders_dev is new as its user: Authentication failed")
        await vi.advanceTimersByTimeAsync(ATLAS_PROPAGATION_TIMEOUT_MS)
        await failure
        vi.useRealTimers()

        expect(driver.listCollections).toHaveBeenCalledTimes(Math.floor(ATLAS_PROPAGATION_TIMEOUT_MS / ATLAS_PROPAGATION_DELAY_MS) + 1)
        expect(call(3)).toMatchObject({ url: `${api}/databaseUsers/admin/orders_dev`, method: "DELETE" })
    })

    /** Only a user not rolled out yet is waited for: a cluster out of reach says so at once, and where to look */
    it.each([
        ["a host not found", Object.assign(new Error("getaddrinfo ENOTFOUND cluster0-shard-00-00.abcde.mongodb.net"), { name: "MongoServerSelectionError" })],
        ["a refused connection", Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:27017"), { name: "MongoNetworkError" })],
        ["a TLS failure", Object.assign(new Error("SSL routines:ssl3_read_bytes:tlsv1 alert internal error"), { name: "MongoNetworkError" })]
    ])("given %s, when the new user looks at its database, then it fails at once pointing at the IP Access List and the user is deleted", async (_case, failure) => {
        answer(json(201, {}), cluster(), new Response(null, { status: 204 }))
        driver.connect.mockRejectedValue(failure)

        const refusal = new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")

        await expect(refusal).rejects.toBeInstanceOf(ClusterUnreachableError)
        await expect(refusal).rejects.toThrow("add the egress IP address of the Flightroom backend to the IP Access List of the Atlas project")
        expect(driver.connect).toHaveBeenCalledTimes(1)
        expect(call(3)).toMatchObject({ url: `${api}/databaseUsers/admin/orders_dev`, method: "DELETE" })
    })

    it("given the user that cannot be trusted with its database failing to go too, when it is dropped again and again, then the error names the user left on Atlas", async () => {
        vi.useFakeTimers()
        answer(json(201, {}), cluster(), json(500, {}), json(500, {}), json(500, {}))
        driver.listCollections.mockResolvedValue([{ name: "reports" }])

        const ensuring = new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")
        const failure = expect(ensuring).rejects.toMatchObject({ name: "UserLeftOnServerError", username: "orders_dev" })
        await vi.advanceTimersByTimeAsync(DROP_BACKOFF_MS * DROP_ATTEMPTS * DROP_ATTEMPTS)
        await failure
        vi.useRealTimers()

        expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === "DELETE")).toHaveLength(DROP_ATTEMPTS)
    })

    /** A POST that got no answer may have created it: it was not there (no 409), so it is ours to drop */
    it.each([
        ["no answer", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))],
        ["an error of Atlas", () => fetchMock.mockResolvedValueOnce(json(503, { detail: "Service Unavailable" }))]
    ])("given a create of the user that got %s, when it is ensured, then the user is dropped before the failure comes back", async (_case, arrange) => {
        fetchMock.mockResolvedValueOnce(json(200, { access_token: "atlas-token" }))
        arrange()
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))

        await expect(new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")).rejects.toThrow()
        expect(call(2)).toMatchObject({ url: `${api}/databaseUsers/admin/orders_dev`, method: "DELETE" })
    })

    it("given a create Atlas refused outright, when it is ensured, then nothing is dropped: nothing was made", async () => {
        answer(json(400, { detail: "Invalid password" }))

        await expect(new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")).rejects.toThrow("400 Invalid password")
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("given a create to undo, when it is rolled back, then its user is deleted", async () => {
        answer(new Response(null, { status: 204 }))

        await new AtlasProvisioner(connection).rollbackCreate("orders_dev", "orders_dev")

        expect(call(1)).toMatchObject({ url: `${api}/databaseUsers/admin/orders_dev`, method: "DELETE" })
    })

    it("given a user already there, when it is ensured, then it is refused and never patched", async () => {
        answer(json(409, { errorCode: "USER_ALREADY_EXISTS" }))

        await expect(new AtlasProvisioner(connection).ensureUser("orders_dev", "orders_dev", "secret")).rejects.toMatchObject({ name: "DatabaseUserExistsError", username: "orders_dev" })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("given a user, when it is dropped, then it is deleted from admin", async () => {
        answer(new Response(null, { status: 204 }))

        await new AtlasProvisioner(connection).dropUser("orders_dev")

        expect(call(1)).toMatchObject({ url: `${api}/databaseUsers/admin/orders_dev`, method: "DELETE" })
    })

    it("given a user that is not there, when it is dropped, then the 404 is not an error", async () => {
        answer(json(404, { errorCode: "USERNAME_NOT_FOUND" }))

        await expect(new AtlasProvisioner(connection).dropUser("orders_dev")).resolves.toBeUndefined()
    })

    it("given a cluster, when the fields of a resource are asked, then the URI is its SRV address with the account, the database and authSource=admin", async () => {
        answer(json(200, { connectionStrings: { standardSrv: "mongodb+srv://cluster0.abcde.mongodb.net" } }))

        expect(await new AtlasProvisioner(connection).resourceFields("orders_dev", "orders_dev", "secret")).toEqual({
            connectionString: "mongodb+srv://orders_dev:secret@cluster0.abcde.mongodb.net/orders_dev?authSource=admin&retryWrites=true&w=majority",
            database: "orders_dev"
        })
    })

    it("given a cluster still being created, when its URI is asked, then the refusal says so", async () => {
        answer(json(200, { connectionStrings: {} }))

        await expect(new AtlasProvisioner(connection).connectionString("orders_dev", "orders_dev", "secret")).rejects.toThrow("Atlas gave no connection string for the cluster Cluster0")
    })

    it("given a database, when it is dropped, then the driver connects to the cluster as its own user and drops it", async () => {
        answer(json(200, { connectionStrings: { standardSrv: "mongodb+srv://cluster0.abcde.mongodb.net" } }))

        await new AtlasProvisioner(connection).dropDatabase("orders_dev", "orders_dev", "secret")

        expect(driver.uris).toEqual(["mongodb+srv://orders_dev:secret@cluster0.abcde.mongodb.net/orders_dev?authSource=admin&retryWrites=true&w=majority"])
        expect(driver.databases).toEqual(["orders_dev"])
        expect(driver.dropDatabase).toHaveBeenCalled()
    })

    it("given a service account, when the provisioner is built, then its secret is what no message may quote", () => {
        expect(new AtlasProvisioner(connection).secrets).toEqual(["mdb_sa_sk_secret"])
    })
})

describe("dropOwnUser", () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it("given a drop that fails once, when it is tried, then it is tried again and gets through", async () => {
        vi.useFakeTimers()
        const drop = vi.fn().mockRejectedValueOnce(new Error("timed out")).mockResolvedValue(undefined)

        const dropping = dropOwnUser("orders_dev", drop)
        await vi.advanceTimersByTimeAsync(DROP_BACKOFF_MS)
        await dropping

        expect(drop).toHaveBeenCalledTimes(2)
    })

    /** A user Flightroom made is never forgotten: the caller is told it is still there */
    it("given a drop that keeps failing, when it is tried, then the error names the user left on the server", async () => {
        vi.useFakeTimers()
        const drop = vi.fn().mockRejectedValue(new Error("not reachable"))

        const dropping = dropOwnUser("orders_dev", drop)
        const failure = expect(dropping).rejects.toBeInstanceOf(UserLeftOnServerError)
        await vi.advanceTimersByTimeAsync(DROP_BACKOFF_MS * DROP_ATTEMPTS * DROP_ATTEMPTS)
        await failure

        await expect(dropping).rejects.toThrow("The user orders_dev was created on the server and could not be removed again (not reachable): it is still there")
        expect(drop).toHaveBeenCalledTimes(DROP_ATTEMPTS)
    })
})

describe("isUnknownOutcome", () => {
    it.each([
        ["a network error", Object.assign(new Error("closed"), { name: "MongoNetworkError" })],
        ["a time limit", Object.assign(new Error("operation exceeded time limit"), { code: 50 })],
        ["a write concern not met", Object.assign(new Error("waiting for replication timed out"), { code: 64 })],
        ["a write concern error", Object.assign(new Error("wc"), { name: "MongoWriteConcernError", code: 100 })]
    ])("given %s, when it is read, then the write may have been applied", (_case, error) => {
        expect(isUnknownOutcome(error)).toBe(true)
    })

    it("given a refusal of the server, when it is read, then nothing was applied", () => {
        expect(isUnknownOutcome(Object.assign(new Error("not authorized"), { code: 13 }))).toBe(false)
    })
})
