import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ARM_BASE_URL, ASYNC_OPERATION_TIMEOUT_MS, COSMOS_API_VERSION, CosmosMongoProvisioner, ENTRA_BASE_URL } from "./CosmosMongoProvisioner"
import { DatabaseExistsError, DatabaseUserExistsError, DROP_ATTEMPTS, DROP_BACKOFF_MS } from "./MongoProvisioner"

/** Azure is stubbed through fetch: no test reaches Entra ID or Azure Resource Manager */
const connection = {
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "66666666-7777-8888-9999-000000000000",
    clientSecret: "entra-secret-value",
    subscriptionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    resourceGroup: "rg-data",
    accountName: "flightroom-mongo"
}
const account = `${ARM_BASE_URL}/subscriptions/${connection.subscriptionId}/resourceGroups/rg-data/providers/Microsoft.DocumentDB/databaseAccounts/flightroom-mongo`
const at = (path = "") => `${account}${path}?api-version=${COSMOS_API_VERSION}`
const OPERATION = `${ARM_BASE_URL}/subscriptions/${connection.subscriptionId}/providers/Microsoft.DocumentDB/locations/westeurope/operationsStatus/op-1?api-version=${COSMOS_API_VERSION}`

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers })
const mongoAccount = (capabilities = [{ name: "EnableMongoRoleBasedAccessControl" }], kind = "MongoDB") => json(200, { kind, properties: { capabilities } })
const notFound = () => json(404, { code: "NotFound", message: "Resource not found" })

let fetchMock: ReturnType<typeof vi.fn>

/** Answers the token, then each call in turn */
const answer = (...responses: Response[]) => {
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "arm-token", expires_in: 3599 }))
    for (const response of responses) fetchMock.mockResolvedValueOnce(response)
}
const call = (index: number) => {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit]
    const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body
    return { url, method: init.method, headers: init.headers as Record<string, string>, body }
}
const urls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`)

const provisioner = () => new CosmosMongoProvisioner(connection)

beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe("CosmosMongoProvisioner.test", () => {
    it("given a service principal, when the account is read, then the token is asked of its tenant for Azure Resource Manager and the call carries it", async () => {
        answer(mongoAccount())

        await provisioner().test()

        expect(call(0)).toMatchObject({ url: `${ENTRA_BASE_URL}/${connection.tenantId}/oauth2/v2.0/token`, method: "POST" })
        const form = new URLSearchParams(call(0).body as string)
        expect(Object.fromEntries(form)).toEqual({
            grant_type: "client_credentials",
            client_id: connection.clientId,
            client_secret: "entra-secret-value",
            scope: "https://management.azure.com/.default"
        })
        expect(call(1)).toMatchObject({ url: at(), method: "GET", headers: { Authorization: "Bearer arm-token" } })
    })

    it("given an account without role-based access control, when it is tested, then the refusal says which capability to turn on", async () => {
        answer(mongoAccount([{ name: "EnableServerless" }]))

        await expect(provisioner().test()).rejects.toThrow("flightroom-mongo does not have role-based access control: turn on EnableMongoRoleBasedAccessControl")
    })

    it("given an account of the API for NoSQL, when it is tested, then it is refused as not a MongoDB one", async () => {
        answer(mongoAccount(undefined, "GlobalDocumentDB"))

        await expect(provisioner().test()).rejects.toThrow("is not an account of Azure Cosmos DB for MongoDB (RU)")
    })

    it("given a service principal Entra ID refuses, when a call is made, then the refusal says why and never quotes the secret", async () => {
        fetchMock.mockResolvedValueOnce(json(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }))

        const refusal = provisioner().test()

        await expect(refusal).rejects.toThrow("Entra ID refused the service principal: 401 AADSTS7000215: Invalid client secret provided.")
        await expect(refusal).rejects.not.toThrow("entra-secret-value")
    })

    it("given a token answer with no token, when a call is made, then it is refused", async () => {
        fetchMock.mockResolvedValueOnce(json(200, {}))

        await expect(provisioner().test()).rejects.toThrow("Entra ID answered without an access token")
    })

    it("given a principal without the role, when the account is read, then the error of Azure names the call", async () => {
        answer(json(403, { error: { code: "AuthorizationFailed", message: "The client does not have authorization to perform action" } }))

        await expect(provisioner().test()).rejects.toThrow("Azure answered GET databaseAccounts: 403 The client does not have authorization to perform action")
    })
})

describe("CosmosMongoProvisioner.ensureUser", () => {
    const userUrl = at("/mongodbUserDefinitions/report_dev.report_dev")
    const databaseUrl = at("/mongodbDatabases/report_dev")

    it("given a database and a user that are not there, when the user is ensured, then the database is created first and the user is granted readWrite and dbAdmin on it", async () => {
        answer(mongoAccount(), notFound(), notFound(), json(200, {}), json(200, {}))

        await provisioner().ensureUser("report_dev", "report_dev", "app-password")

        expect(urls()).toEqual([`POST ${ENTRA_BASE_URL}/${connection.tenantId}/oauth2/v2.0/token`, `GET ${at()}`, `GET ${userUrl}`, `GET ${databaseUrl}`, `PUT ${databaseUrl}`, `PUT ${userUrl}`])
        expect(call(4).body).toEqual({ properties: { resource: { id: "report_dev" }, options: {} } })
        expect(call(5).body).toEqual({
            properties: {
                userName: "report_dev",
                password: "app-password",
                databaseName: "report_dev",
                mechanisms: "SCRAM-SHA-256",
                roles: [
                    { db: "report_dev", role: "readWrite" },
                    { db: "report_dev", role: "dbAdmin" }
                ]
            }
        })
    })

    /** Its data is someone else's: a user with readWrite and dbAdmin on it would reach it */
    it("given a database already there, when the user is ensured, then it is refused before anything is written", async () => {
        answer(mongoAccount(), notFound(), json(200, { name: "report_dev" }))

        await expect(provisioner().ensureUser("report_dev", "report_dev", "app-password")).rejects.toBeInstanceOf(DatabaseExistsError)
        expect(urls().some(url => url.startsWith("PUT") || url.startsWith("DELETE"))).toBe(false)
    })

    /** The PUT creates or updates: it would hand someone else's user a new password */
    it("given a user definition already there, when the user is ensured, then it is refused before anything is written", async () => {
        answer(mongoAccount(), json(200, { name: "report_dev.report_dev" }))

        await expect(provisioner().ensureUser("report_dev", "report_dev", "app-password")).rejects.toBeInstanceOf(DatabaseUserExistsError)
        expect(urls().some(url => url.startsWith("PUT"))).toBe(false)
    })

    it("given an account without role-based access control, when a user is ensured, then it is refused before anything is written", async () => {
        answer(mongoAccount([]))

        await expect(provisioner().ensureUser("report_dev", "report_dev", "app-password")).rejects.toThrow("EnableMongoRoleBasedAccessControl")
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("given Azure running the creations asynchronously, when the user is ensured, then each operation is followed until it succeeds", async () => {
        const accepted = () => empty(202, { "Azure-AsyncOperation": OPERATION, "Retry-After": "0" })
        answer(
            mongoAccount(),
            notFound(),
            notFound(),
            accepted(),
            json(200, { status: "InProgress" }, { "Retry-After": "0" }),
            json(200, { status: "Succeeded" }),
            accepted(),
            json(200, { status: "Succeeded" })
        )

        await provisioner().ensureUser("report_dev", "report_dev", "app-password")

        expect(urls().filter(url => url === `GET ${OPERATION}`)).toHaveLength(3)
        expect(call(5)).toMatchObject({ headers: { Authorization: "Bearer arm-token" } })
    })

    /** A user PUT that timed out may still create the definition: it is deleted too, then the database made for it */
    it("given the user definition failing after its database was made for it, when the user is ensured, then the definition and the empty database are removed and the failure comes back", async () => {
        answer(mongoAccount(), notFound(), notFound(), json(200, {}), json(400, { error: { message: "Invalid password" } }), notFound(), empty(200))

        await expect(provisioner().ensureUser("report_dev", "report_dev", "app-password")).rejects.toThrow("Azure answered PUT mongodbUserDefinitions: 400 Invalid password")
        expect(urls().slice(-2)).toEqual([`DELETE ${userUrl}`, `DELETE ${databaseUrl}`])
    })

    /** A user definition Flightroom may have made is never forgotten: the error names it, and the empty database still goes */
    it("given the user definition failing and its removal failing too, when the user is ensured, then the error names the user left there", async () => {
        vi.useFakeTimers()
        answer(mongoAccount(), notFound(), notFound(), json(200, {}), json(400, { error: { message: "Invalid password" } }), json(500, {}), json(500, {}), json(500, {}), empty(200))

        const ensuring = provisioner().ensureUser("report_dev", "report_dev", "app-password")
        const failure = expect(ensuring).rejects.toMatchObject({ name: "UserLeftOnServerError", username: "report_dev" })
        await vi.advanceTimersByTimeAsync(DROP_BACKOFF_MS * DROP_ATTEMPTS * DROP_ATTEMPTS)
        await failure

        expect(urls().filter(url => url === `DELETE ${userUrl}`)).toHaveLength(DROP_ATTEMPTS)
        expect(urls().at(-1)).toBe(`DELETE ${databaseUrl}`)
    })

    /** A database whose PUT failed is not known to be ours: it is never dropped */
    it("given the database PUT failing, when the user is ensured, then no user definition is sent and nothing is deleted", async () => {
        answer(mongoAccount(), notFound(), notFound(), json(500, { error: { message: "Internal error" } }))

        await expect(provisioner().ensureUser("report_dev", "report_dev", "app-password")).rejects.toThrow("Azure answered PUT mongodbDatabases: 500 Internal error")
        expect(urls().filter(url => !url.startsWith("GET") && !url.startsWith("POST"))).toEqual([`PUT ${databaseUrl}`])
    })

    it("given a create this provisioner made, when it is rolled back, then the user definition goes, then the database it made", async () => {
        answer(mongoAccount(), notFound(), notFound(), json(200, {}), json(200, {}), empty(200), empty(200))
        const cosmos = provisioner()

        await cosmos.ensureUser("report_dev", "report_dev", "app-password")
        await cosmos.rollbackCreate("report_dev", "report_dev")

        expect(urls().slice(-2)).toEqual([`DELETE ${userUrl}`, `DELETE ${databaseUrl}`])
    })

    it("given the empty database failing to go, when a create is rolled back or a user definition fails, then the user part decides the outcome", async () => {
        answer(mongoAccount(), notFound(), notFound(), json(200, {}), json(200, {}), empty(200), json(500, {}))
        const cosmos = provisioner()
        await cosmos.ensureUser("report_dev", "report_dev", "app-password")

        await expect(cosmos.rollbackCreate("report_dev", "report_dev")).resolves.toBeUndefined()

        answer(mongoAccount(), notFound(), notFound(), json(200, {}), json(400, { error: { message: "Invalid password" } }), empty(200), json(500, {}))
        await expect(provisioner().ensureUser("report_dev", "report_dev", "app-password")).rejects.toThrow("400 Invalid password")
    })

    it("given a create another call made, when it is rolled back, then only the user definition goes", async () => {
        answer(empty(200))

        await provisioner().rollbackCreate("report_dev", "report_dev")

        expect(urls().slice(1)).toEqual([`DELETE ${userUrl}`])
    })
})

describe("CosmosMongoProvisioner asynchronous operations", () => {
    it("given an operation that fails, when it is followed, then the reason Azure gave comes back", async () => {
        answer(empty(202, { "Azure-AsyncOperation": OPERATION, "Retry-After": "0" }), json(200, { status: "Failed", error: { code: "BadRequest", message: "Database is being deleted" } }))

        await expect(provisioner().dropDatabase("report_dev")).rejects.toThrow("Azure could not DELETE mongodbDatabases: Database is being deleted")
    })

    it("given an operation behind a Location only, when it is followed, then it is asked again until it answers 200", async () => {
        const location = `${ARM_BASE_URL}/subscriptions/${connection.subscriptionId}/providers/Microsoft.DocumentDB/locations/westeurope/operationResults/op-2`
        answer(empty(202, { Location: location, "Retry-After": "0" }), empty(202, { "Retry-After": "0" }), empty(204))

        await provisioner().dropUser("report_dev", "report_dev")

        expect(urls().filter(url => url === `GET ${location}`)).toHaveLength(2)
    })

    it("given a 202 with nothing to follow, when it is answered, then it counts as done", async () => {
        answer(empty(202))

        await expect(provisioner().dropDatabase("report_dev")).resolves.toBeUndefined()
    })

    /** The bearer token goes nowhere but to Azure Resource Manager */
    it("given an operation pointing outside Azure Resource Manager, when it is answered, then it is not followed", async () => {
        answer(empty(202, { "Azure-AsyncOperation": "https://attacker.example/operations/1" }))

        await expect(provisioner().dropDatabase("report_dev")).rejects.toThrow("with an operation outside Azure Resource Manager")
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("given the status of an operation that cannot be read, when it is followed, then the failure says so", async () => {
        answer(empty(202, { "Azure-AsyncOperation": OPERATION, "Retry-After": "not-a-number" }), json(403, { error: { message: "No access to the resource group" } }))
        vi.useFakeTimers()

        const dropping = provisioner().dropDatabase("report_dev")
        const failure = expect(dropping).rejects.toThrow("Azure answered the status of DELETE mongodbDatabases: 403 No access to the resource group")
        await vi.advanceTimersByTimeAsync(2000)
        await failure
    })

    it("given an operation that never ends, when it is followed, then it gives up after its timeout", async () => {
        vi.useFakeTimers()
        answer(empty(202, { "Azure-AsyncOperation": OPERATION, "Retry-After": "10" }))
        fetchMock.mockImplementation(async () => json(200, { status: "InProgress" }, { "Retry-After": "10" }))

        const dropping = provisioner().dropDatabase("report_dev")
        const failure = expect(dropping).rejects.toThrow(`Azure did not finish DELETE mongodbDatabases within ${ASYNC_OPERATION_TIMEOUT_MS / 1000} seconds`)
        await vi.advanceTimersByTimeAsync(ASYNC_OPERATION_TIMEOUT_MS + 20000)
        await failure
    })
})

describe("CosmosMongoProvisioner removals and connection string", () => {
    it("given a user, when it is dropped, then its user definition is deleted, and a 404 is not an error", async () => {
        answer(notFound())

        await expect(provisioner().dropUser("report_dev", "report_dev")).resolves.toBeUndefined()
        expect(call(1)).toMatchObject({ url: at("/mongodbUserDefinitions/report_dev.report_dev"), method: "DELETE" })
    })

    it("given a database, when it is dropped, then it is deleted through Azure Resource Manager", async () => {
        answer(empty(200))

        await provisioner().dropDatabase("report_dev")

        expect(call(1)).toMatchObject({ url: at("/mongodbDatabases/report_dev"), method: "DELETE" })
    })

    it("given a database, when the fields of its resource are asked, then the URI is the account's on 10255, its own database as authSource and SCRAM-SHA-256", async () => {
        expect(await provisioner().resourceFields("report_dev", "report_dev", "p/w")).toEqual({
            connectionString:
                "mongodb://report_dev:p%2Fw@flightroom-mongo.mongo.cosmos.azure.com:10255/report_dev?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@flightroom-mongo@&authSource=report_dev&authMechanism=SCRAM-SHA-256",
            database: "report_dev"
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("given a service principal, when the provisioner is built, then its secret is what no message may quote", () => {
        expect(provisioner().secrets).toEqual(["entra-secret-value"])
        expect(provisioner().reservedNames).toEqual(["admin", "local", "config"])
    })
})
