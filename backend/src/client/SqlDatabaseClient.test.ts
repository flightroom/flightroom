import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DatabaseType } from "../models/DatabaseModel"
import { databaseTargetOf, testDatabaseConnection } from "./SqlDatabaseClient"

/**
 * The four drivers are stubbed, so no test loads a real one or opens a socket. Loading mssql (tedious,
 * @azure/identity and their dependencies) took seconds under the full suite and ran past the 5 s timeout
 * of the first test that needed it. Each stub exports only `default`, as Node shows a CommonJS package to
 * import(): a named import of the client would find nothing here, as it would in production.
 */
const driver = vi.hoisted(() => ({
    pg: { options: undefined as unknown, connect: vi.fn(), query: vi.fn(), end: vi.fn() },
    mysql: { createConnection: vi.fn(), query: vi.fn(), end: vi.fn() },
    mssql: { options: undefined as unknown, connect: vi.fn(), query: vi.fn(), close: vi.fn() },
    oracle: { getConnection: vi.fn(), execute: vi.fn(), close: vi.fn(), connection: undefined as { callTimeout?: number } | undefined }
}))

vi.mock("pg", () => ({
    default: {
        Client: class {
            constructor(options: unknown) {
                driver.pg.options = options
            }
            connect = driver.pg.connect
            query = driver.pg.query
            end = driver.pg.end
        }
    }
}))

vi.mock("mysql2/promise", () => ({ default: { createConnection: driver.mysql.createConnection } }))

/** The parser is the driver's own: it lives in the base pool, which loads without tedious */
vi.mock("mssql", async () => {
    const { default: BasePool } = await vi.importActual<{ default: { parseConnectionString: (connectionString: string) => unknown } }>("mssql/lib/base/connection-pool.js")
    return {
        default: {
            ConnectionPool: class {
                static parseConnectionString = (connectionString: string) => BasePool.parseConnectionString(connectionString)
                constructor(options: unknown) {
                    driver.mssql.options = options
                }
                connect = driver.mssql.connect
                request = () => ({ query: driver.mssql.query })
                close = driver.mssql.close
            }
        }
    }
})

vi.mock("oracledb", () => ({ default: { getConnection: driver.oracle.getConnection } }))

beforeEach(() => {
    driver.pg.options = undefined
    driver.pg.connect.mockResolvedValue(undefined)
    driver.pg.query.mockResolvedValue({ rows: [{ "?column?": 1 }] })
    driver.pg.end.mockResolvedValue(undefined)

    driver.mysql.createConnection.mockResolvedValue({ query: driver.mysql.query, end: driver.mysql.end })
    driver.mysql.query.mockResolvedValue([[{ 1: 1 }], []])
    driver.mysql.end.mockResolvedValue(undefined)

    driver.mssql.options = undefined
    driver.mssql.connect.mockResolvedValue(undefined)
    driver.mssql.query.mockResolvedValue({ recordset: [{ "": 1 }] })
    driver.mssql.close.mockResolvedValue(undefined)

    driver.oracle.connection = undefined
    driver.oracle.getConnection.mockImplementation(async () => {
        driver.oracle.connection = { execute: driver.oracle.execute, close: driver.oracle.close } as { callTimeout?: number }
        return driver.oracle.connection
    })
    driver.oracle.execute.mockResolvedValue({ rows: [[1]] })
    driver.oracle.close.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.resetAllMocks()
    vi.useRealTimers()
})

const credentials = { authType: "credentials" as const, host: "db.internal", port: 5432, database: "orders", username: "app", password: "pw", ssl: false }
const fromString = (connectionString: string) => ({ authType: "connectionString" as const, connectionString })

describe("databaseTargetOf", () => {
    it("given credentials, when they are read, then they are the target as they are", async () => {
        expect(await databaseTargetOf(DatabaseType.POSTGRESQL, credentials)).toEqual({ host: "db.internal", port: 5432, database: "orders", user: "app", password: "pw", ssl: false })
    })

    /** pg would read those files from the server's disk while building its client */
    it("given a Postgres URL naming certificate files, when it is read, then only the address, the account and SSL are kept", async () => {
        const target = await databaseTargetOf(DatabaseType.POSTGRESQL, fromString("postgres://app:p%40ss@db.internal:6543/orders?sslmode=require&sslcert=/dev/zero&sslkey=/etc/passwd"))

        expect(target).toEqual({ host: "db.internal", port: 6543, database: "orders", user: "app", password: "p@ss", ssl: true })
    })

    /** mysql2 would copy socketPath into its options and connect to a socket of the server */
    it("given a MySQL URL with a socket path, when it is read, then the parameter is not kept", async () => {
        expect(await databaseTargetOf(DatabaseType.MARIADB, fromString("mysql://app:pw@db.internal/orders?socketPath=/var/run/mysqld/mysqld.sock"))).toEqual({
            host: "db.internal",
            port: 3306,
            database: "orders",
            user: "app",
            password: "pw",
            ssl: false
        })
    })

    it.each([
        ["postgresql://app:pw@db.internal/orders", DatabaseType.POSTGRESQL, 5432],
        ["mariadb://app:pw@db.internal/orders", DatabaseType.MYSQL, 3306],
        ["oracle://app:pw@db.internal/ORCLPDB1", DatabaseType.ORACLE, 1521]
    ])("given %s without a port, when it is read, then the engine's default port is the target's", async (connectionString, type, port) => {
        expect(await databaseTargetOf(type, fromString(connectionString))).toMatchObject({ host: "db.internal", port, ssl: false })
    })

    it.each([
        ["sslmode=verify-full", "postgres://app:pw@db.internal/orders?sslmode=verify-full", DatabaseType.POSTGRESQL, true],
        ["sslmode=disable", "postgres://app:pw@db.internal/orders?sslmode=disable", DatabaseType.POSTGRESQL, false],
        ["ssl=true", "mysql://app:pw@db.internal/orders?ssl=true", DatabaseType.MYSQL, true],
        ["ssl=false", "mysql://app:pw@db.internal/orders?ssl=false", DatabaseType.MYSQL, false]
    ])("given a URL with %s, when it is read, then SSL is asked for accordingly", async (_case, connectionString, type, ssl) => {
        expect(await databaseTargetOf(type, fromString(connectionString))).toMatchObject({ ssl })
    })

    it("given a URL with an IPv6 host and an encoded database, when it is read, then the brackets are dropped and the name decoded", async () => {
        expect(await databaseTargetOf(DatabaseType.POSTGRESQL, fromString("postgres://app:pw@[::1]:5433/my%20db"))).toMatchObject({ host: "::1", port: 5433, database: "my db" })
    })

    it("given a SQL Server connection string, when it is read, then the driver's parser reads it", async () => {
        expect(await databaseTargetOf(DatabaseType.SQLSERVER, fromString("Server=tcp:db.internal,1444;Database=orders;User Id=app;Password={p;w};Encrypt=true"))).toEqual({
            host: "db.internal",
            port: 1444,
            database: "orders",
            user: "app",
            password: "p;w",
            ssl: true
        })
    })

    it("given a SQL Server connection string with no port, database or encryption, when it is read, then the default port is used and TLS is not asked for", async () => {
        expect(await databaseTargetOf(DatabaseType.SQLSERVER, fromString("Server=db.internal;User Id=app;Password=pw;Encrypt=false"))).toEqual({
            host: "db.internal",
            port: 1433,
            database: "",
            user: "app",
            password: "pw",
            ssl: false
        })
    })

    it("given an Oracle URL over TLS, when it is read, then the target asks for TLS", async () => {
        expect(await databaseTargetOf(DatabaseType.ORACLE, fromString("tcps://app:pw@db.internal:2484/ORCLPDB1"))).toMatchObject({ port: 2484, database: "ORCLPDB1", ssl: true })
    })

    it.each([
        ["a Unix socket as host", DatabaseType.POSTGRESQL, { ...credentials, host: "/var/run/postgresql" }],
        ["a host only in the query", DatabaseType.POSTGRESQL, fromString("postgres://app:pw@/orders?host=/tmp")],
        ["no password, which pg would take from the server", DatabaseType.POSTGRESQL, fromString("postgres://app@db.internal/orders")],
        ["no database, which pg would take from the server", DatabaseType.POSTGRESQL, fromString("postgres://app:pw@db.internal")],
        ["an Oracle descriptor as service", DatabaseType.ORACLE, { ...credentials, database: "x(DESCRIPTION=(ADDRESS=(HOST=evil)))" }],
        ["no Oracle service", DatabaseType.ORACLE, { ...credentials, database: "" }],
        ["a URL of another engine", DatabaseType.POSTGRESQL, fromString("mysql://app:pw@db.internal/orders")],
        ["something that is not a URL", DatabaseType.MYSQL, fromString("host=db.internal user=app password=pw")],
        ["a SQL Server string with no server", DatabaseType.SQLSERVER, fromString("Database=orders;User Id=app;Password=pw")],
        ["a SQL Server string with no account", DatabaseType.SQLSERVER, fromString("Server=db.internal;Database=orders")],
        ["port 0", DatabaseType.MYSQL, { ...credentials, port: 0 }],
        ["port 65536", DatabaseType.MYSQL, { ...credentials, port: 65536 }],
        ["a fractional port", DatabaseType.MYSQL, { ...credentials, port: 3306.5 }]
    ])("given %s, when it is read, then it is refused", async (_case, type, connection) => {
        await expect(databaseTargetOf(type, connection as never)).rejects.toThrow()
    })

    it.each([
        ["a host that is not one", { ...credentials, host: "db.internal/evil" }, "The host is not a host name or an IP address"],
        ["a port out of range", { ...credentials, port: 70000 }, "The port is not a number between 1 and 65535"],
        ["no user", { ...credentials, username: "" }, "The connection string has no user or password"],
        ["no database", { ...credentials, database: "" }, "The connection string names no database"]
    ])("given %s, when it is read, then the message says what is wrong", async (_case, connection, message) => {
        await expect(databaseTargetOf(DatabaseType.POSTGRESQL, connection)).rejects.toThrow(message)
    })

    it.each([
        ["is not a URL", fromString("not a url"), "The connection string is not a URL starting with mysql://"],
        ["has another scheme", fromString("postgres://app:pw@db.internal/orders"), "The connection string of this engine starts with mysql:// or mariadb://"]
    ])("given a MySQL connection string that %s, when it is read, then the message names the schemes it takes", async (_case, connection, message) => {
        await expect(databaseTargetOf(DatabaseType.MYSQL, connection)).rejects.toThrow(message)
    })

    it("given a connection string that cannot be read, when it is refused, then the message does not quote it", async () => {
        const error = await databaseTargetOf(DatabaseType.POSTGRESQL, fromString("mysql://app:s3cret@db.internal/orders")).catch((error: Error) => error)

        expect((error as Error).message).not.toContain("s3cret")
    })
})

const target = (overrides: Partial<typeof credentials> = {}) => ({ ...credentials, ...overrides })

describe("testDatabaseConnection on PostgreSQL", () => {
    it("given a reachable server, when the connection is tested, then the target and a connect timeout reach the client, SELECT 1 runs and the client ends", async () => {
        await testDatabaseConnection(DatabaseType.POSTGRESQL, target({ ssl: true }))

        expect(driver.pg.options).toEqual({ host: "db.internal", port: 5432, database: "orders", user: "app", password: "pw", ssl: true, connectionTimeoutMillis: 5000 })
        expect(driver.pg.query).toHaveBeenCalledWith("SELECT 1")
        expect(driver.pg.end).toHaveBeenCalledTimes(1)
    })

    it("given a server refusing the login, when the connection is tested, then the driver's error comes back and the client still ends", async () => {
        const loginFailed = new Error('password authentication failed for user "app"')
        driver.pg.connect.mockRejectedValue(loginFailed)

        await expect(testDatabaseConnection(DatabaseType.POSTGRESQL, target())).rejects.toBe(loginFailed)
        expect(driver.pg.query).not.toHaveBeenCalled()
        expect(driver.pg.end).toHaveBeenCalledTimes(1)
    })

    it("given a client that fails to end, when the connection worked, then the test still passes", async () => {
        driver.pg.end.mockRejectedValue(new Error("Connection terminated"))

        await expect(testDatabaseConnection(DatabaseType.POSTGRESQL, target())).resolves.toBeUndefined()
    })
})

describe("testDatabaseConnection on MySQL and MariaDB", () => {
    it.each([DatabaseType.MYSQL, DatabaseType.MARIADB])("given %s without SSL, when the connection is tested, then the MySQL driver connects without TLS nor local files", async type => {
        await testDatabaseConnection(type, target({ port: 3306 }))

        expect(driver.mysql.createConnection).toHaveBeenCalledWith({
            host: "db.internal",
            port: 3306,
            database: "orders",
            user: "app",
            password: "pw",
            ssl: undefined,
            connectTimeout: 5000,
            flags: ["-LOCAL_FILES"]
        })
        expect(driver.mysql.query).toHaveBeenCalledWith("SELECT 1")
        expect(driver.mysql.end).toHaveBeenCalledTimes(1)
    })

    it("given SSL, when the connection is tested, then the server certificate is verified", async () => {
        await testDatabaseConnection(DatabaseType.MYSQL, target({ ssl: true }))

        expect(driver.mysql.createConnection).toHaveBeenCalledWith(expect.objectContaining({ ssl: { rejectUnauthorized: true } }))
    })

    it("given a query that fails, when the connection is tested, then the driver's error comes back and the connection still ends", async () => {
        const denied = new Error("Access denied for user 'app'@'%' to database 'orders'")
        driver.mysql.query.mockRejectedValue(denied)
        driver.mysql.end.mockRejectedValue(new Error("already closed"))

        await expect(testDatabaseConnection(DatabaseType.MYSQL, target())).rejects.toBe(denied)
        expect(driver.mysql.end).toHaveBeenCalledTimes(1)
    })

    it("given an unreachable server, when the connection is tested, then the driver's error comes back", async () => {
        const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:3306"), { code: "ECONNREFUSED" })
        driver.mysql.createConnection.mockRejectedValue(refused)

        await expect(testDatabaseConnection(DatabaseType.MYSQL, target())).rejects.toBe(refused)
        expect(driver.mysql.end).not.toHaveBeenCalled()
    })
})

describe("testDatabaseConnection on SQL Server", () => {
    it("given TLS, when the connection is tested, then the pool encrypts, verifies the certificate and times out like the others", async () => {
        await testDatabaseConnection(DatabaseType.SQLSERVER, target({ port: 1433, ssl: true }))

        expect(driver.mssql.options).toEqual({
            server: "db.internal",
            port: 1433,
            database: "orders",
            user: "app",
            password: "pw",
            connectionTimeout: 5000,
            requestTimeout: 5000,
            options: { encrypt: true, trustServerCertificate: false }
        })
        expect(driver.mssql.query).toHaveBeenCalledWith("SELECT 1")
        expect(driver.mssql.close).toHaveBeenCalledTimes(1)
    })

    it("given no database, when the connection is tested, then the pool gets none and the login's default database is used", async () => {
        await testDatabaseConnection(DatabaseType.SQLSERVER, fromString("Server=db.internal;User Id=app;Password=pw"))

        expect(driver.mssql.options).toMatchObject({ server: "db.internal", port: 1433, database: undefined, options: { encrypt: false, trustServerCertificate: false } })
    })

    it("given a login that fails, when the connection is tested, then the driver's error comes back and the pool is closed even when closing fails", async () => {
        const loginFailed = Object.assign(new Error("Login failed for user 'app'."), { code: "ELOGIN" })
        driver.mssql.connect.mockRejectedValue(loginFailed)
        driver.mssql.close.mockRejectedValue(new Error("not connected"))

        await expect(testDatabaseConnection(DatabaseType.SQLSERVER, target())).rejects.toBe(loginFailed)
        expect(driver.mssql.query).not.toHaveBeenCalled()
        expect(driver.mssql.close).toHaveBeenCalledTimes(1)
    })
})

describe("testDatabaseConnection on Oracle", () => {
    it("given a reachable server, when the connection is tested, then the connect string names host, port and service, the query is bounded and the connection closed", async () => {
        await testDatabaseConnection(DatabaseType.ORACLE, target({ port: 1521, database: "ORCLPDB1" }))

        expect(driver.oracle.getConnection).toHaveBeenCalledWith({ user: "app", password: "pw", connectString: "db.internal:1521/ORCLPDB1", connectTimeout: 5 })
        expect(driver.oracle.connection?.callTimeout).toBe(5000)
        expect(driver.oracle.execute).toHaveBeenCalledWith("SELECT 1 FROM DUAL")
        expect(driver.oracle.close).toHaveBeenCalledTimes(1)
    })

    it("given TLS and an IPv6 host, when the connection is tested, then the connect string asks for tcps and brackets the address", async () => {
        await testDatabaseConnection(DatabaseType.ORACLE, target({ host: "fd00::1", port: 2484, database: "ORCLPDB1", ssl: true }))

        expect(driver.oracle.getConnection).toHaveBeenCalledWith(expect.objectContaining({ connectString: "tcps://[fd00::1]:2484/ORCLPDB1" }))
    })

    it("given a query that fails, when the connection is tested, then the driver's error comes back and the connection is closed even when closing fails", async () => {
        const invalid = new Error("ORA-01017: invalid credential or not authorized; logon denied")
        driver.oracle.execute.mockRejectedValue(invalid)
        driver.oracle.close.mockRejectedValue(new Error("NJS-003: invalid or closed connection"))

        await expect(testDatabaseConnection(DatabaseType.ORACLE, target({ database: "ORCLPDB1" }))).rejects.toBe(invalid)
        expect(driver.oracle.close).toHaveBeenCalledTimes(1)
    })
})

describe("testDatabaseConnection", () => {
    it("given a target that is refused, when the connection is tested, then no driver is asked to connect", async () => {
        await expect(testDatabaseConnection(DatabaseType.POSTGRESQL, target({ host: "/var/run/postgresql" }))).rejects.toThrow("The host is not a host name or an IP address")

        expect(driver.pg.connect).not.toHaveBeenCalled()
    })

    it("given a driver that never answers, when the connection is tested, then it fails after three connect timeouts", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const connecting = new Promise<void>(resolve => driver.pg.connect.mockImplementation(() => (resolve(), new Promise(() => undefined))))

        const testing = testDatabaseConnection(DatabaseType.POSTGRESQL, target())
        const outcome = expect(testing).rejects.toThrow("The connection test timed out after 15 seconds")
        await connecting
        await vi.advanceTimersByTimeAsync(14_999)
        expect(driver.pg.query).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)

        await outcome
    })
})
