import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DatabaseExistsError, DatabaseUserExistsError, UserLeftOnServerError } from "../client/MongoProvisioner"
import Environment from "../models/EnvironmentModel"
import MongoServer, { MongoServerProvider } from "../models/MongoServerModel"
import Project from "../models/ProjectModel"
import ProvisionedDatabase, { IProvisionedDatabase } from "../models/ProvisionedDatabaseModel"
import Resource, { RESOURCE_SECRET_PATHS } from "../models/ResourceModel"
import { withArgoCdInitialized } from "../testing/argoCdInitialized"
import { transformUpdate } from "../utils/encryptedFieldsPlugin"
import { encryptSecret, resetSecretEncryptionKeyCache, SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import BaseAuthorizedService from "./BaseAuthorizedService"
import ProvisionedDatabaseService, { generateDatabasePassword, withEnvironmentOverrides } from "./ProvisionedDatabaseService"

/**
 * The server is a stub: every MONGODB server of these tests builds it, so no test reaches a driver.
 * Its secrets are the ones a message of the server must never quote.
 */
const provisioner = vi.hoisted(() => ({
    resource: { type: "mongodb", variant: "connectionString", fields: ["connectionString", "database"] },
    reservedNames: ["admin", "local", "config"],
    secrets: ["mongodb://root:root-pw@db.internal/admin", "root-pw"],
    test: vi.fn(),
    ensureUser: vi.fn(),
    dropUser: vi.fn(),
    dropDatabase: vi.fn(),
    rollbackCreate: vi.fn(),
    resourceFields: vi.fn()
}))

vi.mock("../client/MongoProvisioner", async importOriginal => ({
    ...(await importOriginal<object>()),
    MongoDbProvisioner: class {
        constructor() {
            // The stub stands for every provisioner built
            return provisioner
        }
    }
}))

const projectId = new Types.ObjectId()
const serverId = new Types.ObjectId()
const resourceId = new Types.ObjectId()
const development = new Types.ObjectId()
const production = new Types.ObjectId()
const APP_URI = "mongodb://report_dev:app-pw@db.internal/report_dev?authSource=report_dev"

const server = { _id: serverId, projectId, name: "Shared cluster", provider: MongoServerProvider.MONGODB, connection: { connectionString: "mongodb://root:root-pw@db.internal/admin" } }

/** A mongodb resource reached by connection string, with a value of all and one override in production */
const resource = (changes: object = {}) => ({
    _id: resourceId,
    projectId,
    name: "report-steering",
    type: "mongodb",
    variant: "connectionString",
    values: [{ field: "database", value: "report", overrides: [{ environmentId: production, value: "report_prod" }] }],
    secrets: [{ field: "connectionString", value: "mongodb://shared", overrides: [{ environmentId: production, value: "mongodb://prod" }] }],
    ...changes
})

const database = (changes: Partial<IProvisionedDatabase> = {}) => {
    const document = new ProvisionedDatabase({ projectId, serverId, databaseName: "report_dev", username: "report_dev", password: "app-pw", ...changes })
    vi.spyOn(document, "save").mockResolvedValue(document)
    return document
}

let write: ReturnType<typeof vi.fn>
let remove: ReturnType<typeof vi.fn>

beforeEach(() => {
    for (const mock of [provisioner.test, provisioner.ensureUser, provisioner.dropUser, provisioner.dropDatabase, provisioner.rollbackCreate, provisioner.resourceFields])
        mock.mockReset().mockResolvedValue(undefined)
    provisioner.resourceFields.mockResolvedValue({ connectionString: APP_URI, database: "report_dev" })
    const base = BaseAuthorizedService.prototype as unknown as Record<string, () => Promise<void>>
    vi.spyOn(base, "ensureAccessToProject").mockResolvedValue(undefined)
    vi.spyOn(base, "ensureNotViewer").mockResolvedValue(undefined)
    vi.spyOn(base, "ensureWholeProject").mockResolvedValue(undefined)
    vi.spyOn(MongoServer, "findById").mockResolvedValue(server as never)
    vi.spyOn(Resource, "findById").mockResolvedValue(resource() as never)
    vi.spyOn(Environment, "findById").mockResolvedValue({ _id: development, projectId, name: "dev" } as never)
    vi.spyOn(ProvisionedDatabase, "findOne").mockResolvedValue(null)
    write = vi.spyOn(Resource, "findOneAndUpdate").mockResolvedValue({} as never) as unknown as ReturnType<typeof vi.fn>
    remove = vi.spyOn(ProvisionedDatabase, "deleteOne").mockResolvedValue({} as never) as unknown as ReturnType<typeof vi.fn>
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("generateDatabasePassword", () => {
    it("given two passwords, when they are generated, then each is 32 url-safe characters and they differ", () => {
        const [first, second] = [generateDatabasePassword(), generateDatabasePassword()]

        expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/)
        expect(first).not.toBe(second)
    })
})

describe("withEnvironmentOverrides", () => {
    it("given a resource, when the fields of an environment are set, then the credential goes to the secrets, the name to the values, and the other environments stay", () => {
        expect(withEnvironmentOverrides(resource() as never, String(development), { connectionString: APP_URI, database: "report_dev" })).toEqual({
            values: [
                {
                    field: "database",
                    value: "report",
                    overrides: [
                        { environmentId: String(production), value: "report_prod" },
                        { environmentId: String(development), value: "report_dev" }
                    ]
                }
            ],
            secrets: [
                {
                    field: "connectionString",
                    value: "mongodb://shared",
                    overrides: [
                        { environmentId: String(production), value: "mongodb://prod" },
                        { environmentId: String(development), value: APP_URI }
                    ]
                }
            ]
        })
    })

    it("given an environment that already has an override, when it is set, then the override is replaced, not doubled", () => {
        const { secrets } = withEnvironmentOverrides(resource() as never, String(production), { connectionString: APP_URI })

        expect(secrets[0].overrides).toEqual([{ environmentId: String(production), value: APP_URI }])
    })

    it("given a field with nothing but the override taken away, when it is removed, then the field is left unset", () => {
        const only = resource({ values: [], secrets: [{ field: "connectionString", overrides: [{ environmentId: development, value: APP_URI }] }] })

        expect(withEnvironmentOverrides(only as never, String(development), { connectionString: undefined, database: undefined })).toEqual({ values: [], secrets: [] })
    })

    it("given a field the variant does not have, when it is set, then it is refused", () => {
        expect(() => withEnvironmentOverrides(resource() as never, String(development), { host: "db" })).toThrow(expect.objectContaining({ code: "RESOURCE_VARIANT_NOT_SUPPORTED" }))
    })
})

describe("ProvisionedDatabaseService.link", () => {
    withArgoCdInitialized()

    const link = (document = database(), changes: object = {}) => {
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)
        return new ProvisionedDatabaseService().link(String(document._id), { resourceId: String(resourceId), environmentId: String(development), ...changes })
    }

    it("given a mongodb resource by connection string, when a database is linked, then its overrides there go through the encrypted $set and the link is saved", async () => {
        const document = database()

        await link(document)

        expect(provisioner.resourceFields).toHaveBeenCalledWith("report_dev", "report_dev", "app-pw")
        const [filter, update] = write.mock.calls[0]
        expect(filter._id).toBe(resourceId)
        expect(update.$set.secrets[0].overrides).toContainEqual({ environmentId: String(development), value: APP_URI })
        expect(update.$set.values[0].overrides).toContainEqual({ environmentId: String(development), value: "report_dev" })
        expect(String(document.link?.resourceId)).toBe(String(resourceId))
        expect(String(document.link?.environmentId)).toBe(String(development))
    })

    it("given a resource connecting by credentials, when a database is linked, then it is refused and nothing is written", async () => {
        vi.mocked(Resource.findById).mockResolvedValue(resource({ variant: "credentials" }) as never)

        await expect(link()).rejects.toMatchObject({ code: "RESOURCE_VARIANT_NOT_SUPPORTED", details: { variant: "connectionString" } })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a resource of another type, when a database is linked, then it is refused", async () => {
        vi.mocked(Resource.findById).mockResolvedValue(resource({ type: "redis" }) as never)

        await expect(link()).rejects.toMatchObject({ code: "RESOURCE_TYPE_NOT_SUPPORTED" })
    })

    it("given a resource of another project, when a database is linked, then it is not found", async () => {
        vi.mocked(Resource.findById).mockResolvedValue(resource({ projectId: new Types.ObjectId() }) as never)

        await expect(link()).rejects.toMatchObject({ statusCode: 404 })
        expect(write).not.toHaveBeenCalled()
    })

    it("given an environment of another project, when a database is linked, then it is refused", async () => {
        vi.mocked(Environment.findById).mockResolvedValue({ _id: development, projectId: new Types.ObjectId() } as never)

        await expect(link()).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_ENVIRONMENT_UNKNOWN" })
    })

    it("given ids that are not ids, when a database is linked, then it is refused before any read", async () => {
        await expect(link(database(), { resourceId: { $ne: null } })).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_LINK_INVALID" })
        expect(Resource.findById).not.toHaveBeenCalled()
    })

    it("given another database already feeding that environment of the resource, when a database is linked, then it is refused with its name", async () => {
        vi.mocked(ProvisionedDatabase.findOne).mockResolvedValue({ databaseName: "report_old" } as never)

        await expect(link()).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_LINK_TAKEN", statusCode: 409, details: { databaseName: "report_old" } })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a database feeding another environment, when it is linked to a new one, then it is refused until unlinked", async () => {
        await expect(link(database({ link: { resourceId, environmentId: production } as never }))).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_LINKED", statusCode: 409 })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a project whose Argo CD is not initialized, when a database is linked, then it is refused as writing a resource is", async () => {
        vi.mocked(Project.findById).mockResolvedValue({ argoCd: {} } as never)

        await expect(link()).rejects.toMatchObject({ code: "ARGOCD_REQUIRED_FOR_VARIABLES" })
        expect(write).not.toHaveBeenCalled()
    })

    it("given the resource write failing, when a database is linked, then the link is taken back", async () => {
        write.mockRejectedValue(new Error("write conflict"))
        const document = database()

        await expect(link(document)).rejects.toThrow("write conflict")
        expect(document.link).toBeUndefined()
    })
})

describe("ProvisionedDatabaseService.unlink", () => {
    it("given a linked database, when it is unlinked, then its overrides go from the resource and the link from the database", async () => {
        const linked = resource({
            values: [{ field: "database", value: "report", overrides: [{ environmentId: development, value: "report_dev" }] }],
            secrets: [{ field: "connectionString", value: "mongodb://shared", overrides: [{ environmentId: development, value: APP_URI }] }]
        })
        vi.mocked(Resource.findById).mockResolvedValue(linked as never)
        const document = database({ link: { resourceId, environmentId: development } as never })
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await new ProvisionedDatabaseService().unlink(String(document._id))

        expect(write.mock.calls[0][1]).toEqual({
            $set: { values: [{ field: "database", value: "report", overrides: [] }], secrets: [{ field: "connectionString", value: "mongodb://shared", overrides: [] }] }
        })
        expect(document.link).toBeUndefined()
        expect(provisioner.resourceFields).not.toHaveBeenCalled()
    })

    it("given a database that is not linked, when it is unlinked, then nothing is written", async () => {
        const document = database()
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await new ProvisionedDatabaseService().unlink(String(document._id))

        expect(write).not.toHaveBeenCalled()
    })
})

describe("ProvisionedDatabaseService.delete", () => {
    const remove_ = (mode: unknown, confirmName?: string, document = database()) => {
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)
        return new ProvisionedDatabaseService().delete(String(document._id), mode, confirmName)
    }

    it("given mode record, when it is removed, then the server is not touched and the record goes", async () => {
        await remove_("record")

        expect(provisioner.dropUser).not.toHaveBeenCalled()
        expect(provisioner.dropDatabase).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
    })

    it("given mode user, when it is removed, then its user is dropped and the data stays", async () => {
        await remove_("user")

        expect(provisioner.dropUser).toHaveBeenCalledWith("report_dev", "report_dev")
        expect(provisioner.dropDatabase).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
    })

    it("given mode drop with the name typed again, when it is removed, then the database is dropped as its user, then the user", async () => {
        await remove_("drop", "report_dev")

        expect(provisioner.dropDatabase).toHaveBeenCalledWith("report_dev", "report_dev", "app-pw")
        expect(provisioner.dropDatabase.mock.invocationCallOrder[0]).toBeLessThan(provisioner.dropUser.mock.invocationCallOrder[0])
        expect(remove).toHaveBeenCalled()
    })

    it.each([undefined, "report_prod"])("given mode drop with the confirmation %s, when it is removed, then it is refused and nothing is touched", async confirmName => {
        await expect(remove_("drop", confirmName)).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_CONFIRMATION_MISMATCH" })
        expect(provisioner.dropDatabase).not.toHaveBeenCalled()
        expect(remove).not.toHaveBeenCalled()
    })

    it("given an unknown mode, when it is removed, then it is refused", async () => {
        await expect(remove_("everything")).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_DELETE_MODE_INVALID" })
    })

    it("given a linked database, when it is removed, then it is refused until unlinked", async () => {
        await expect(remove_("record", undefined, database({ link: { resourceId, environmentId: development } as never }))).rejects.toMatchObject({
            code: "PROVISIONED_DATABASE_LINKED",
            statusCode: 409
        })
        expect(remove).not.toHaveBeenCalled()
    })

    it("given a server refusing quoting the credentials, when the user is dropped, then the refusal blanks them and the record stays", async () => {
        provisioner.dropUser.mockRejectedValue(new Error("auth failed for root:root-pw with app-pw on mongodb://root:root-pw@db.internal/admin"))

        const refusal = remove_("user")

        await expect(refusal).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_SERVER_FAILED", statusCode: 502 })
        const message = await refusal.catch(error => (error as Error).message)
        expect(message).not.toMatch(/root-pw|app-pw/)
        expect(remove).not.toHaveBeenCalled()
    })
})

describe("ProvisionedDatabaseService.create", () => {
    let create: ReturnType<typeof vi.fn>

    withArgoCdInitialized()

    beforeEach(() => {
        create = vi.spyOn(ProvisionedDatabase, "create").mockImplementation((async (fields: object) => database(fields as never)) as never) as unknown as ReturnType<typeof vi.fn>
    })

    it("given a name, when a database is created, then the record holds a generated password and the user of the same name is ensured with it", async () => {
        const created = await new ProvisionedDatabaseService().create(String(serverId), { databaseName: " report_dev " })

        const { password } = create.mock.calls[0][0]
        expect(create.mock.calls[0][0]).toMatchObject({ projectId, serverId, databaseName: "report_dev", username: "report_dev" })
        expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/)
        expect(provisioner.ensureUser).toHaveBeenCalledWith("report_dev", "report_dev", password)
        expect(created.toFrontendObject().password).toBe(SECRET_PLACEHOLDER)
        expect(JSON.stringify(created.toFrontendObject())).not.toContain(password)
    })

    it("given a link, when a database is created, then it feeds the resource there", async () => {
        const created = await new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev", link: { resourceId: String(resourceId), environmentId: String(development) } })

        expect(write).toHaveBeenCalled()
        expect(String(created.link?.environmentId)).toBe(String(development))
    })

    it("given a link to a resource by credentials, when a database is created, then it is refused before anything is created", async () => {
        vi.mocked(Resource.findById).mockResolvedValue(resource({ variant: "credentials" }) as never)

        await expect(
            new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev", link: { resourceId: String(resourceId), environmentId: String(development) } })
        ).rejects.toMatchObject({
            code: "RESOURCE_VARIANT_NOT_SUPPORTED"
        })
        expect(create).not.toHaveBeenCalled()
        expect(provisioner.ensureUser).not.toHaveBeenCalled()
    })

    it.each([
        ["a name with capitals", "Report", "PROVISIONED_DATABASE_NAME_INVALID"],
        ["a name with a dot", "report.dev", "PROVISIONED_DATABASE_NAME_INVALID"],
        ["no name", "", "PROVISIONED_DATABASE_NAME_INVALID"],
        ["the database of the users", "admin", "PROVISIONED_DATABASE_NAME_RESERVED"]
    ])("given %s, when a database is created, then it is refused and the server is not touched", async (_case, databaseName, code) => {
        await expect(new ProvisionedDatabaseService().create(String(serverId), { databaseName })).rejects.toMatchObject({ code })
        expect(provisioner.ensureUser).not.toHaveBeenCalled()
    })

    /** Its user would otherwise get a new password, while the record of the existing one keeps the old */
    it("given a database already on the server, when it is created again, then it is refused before the server is touched", async () => {
        create.mockRejectedValue({ code: 11000 })

        await expect(new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev" })).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_EXISTS", statusCode: 409 })
        expect(provisioner.ensureUser).not.toHaveBeenCalled()
        expect(provisioner.dropUser).not.toHaveBeenCalled()
    })

    /** It may be someone else's: it is neither updated nor dropped by the undo */
    it("given a user of that name already on the server, when a database is created, then it is refused, the record goes and the user is left alone", async () => {
        provisioner.ensureUser.mockRejectedValue(new DatabaseUserExistsError("report_dev"))

        await expect(new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev" })).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_USER_EXISTS", statusCode: 409 })
        expect(provisioner.dropUser).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
    })

    it("given a database of that name already on the server, when it is created, then it is refused, the record goes and no user is dropped", async () => {
        provisioner.ensureUser.mockRejectedValue(new DatabaseExistsError("report_dev"))

        await expect(new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev" })).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_EXISTS", statusCode: 409 })
        expect(provisioner.dropUser).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
    })

    /**
     * A failing ensureUser has undone its own work, and the user it may have refused is someone else's: nothing is
     * dropped here. What the server said is told by the rate-limited test of the server only, never by a create.
     */
    it("given the server refusing the user, when a database is created, then the record is removed, nothing is dropped, and the refusal says nothing of the server", async () => {
        provisioner.ensureUser.mockImplementation(async (_database: string, _username: string, password: string) => {
            throw new Error(`not authorized: root-pw / ${password}`)
        })

        const refusal = new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev" })

        await expect(refusal).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_SERVER_FAILED", statusCode: 502 })
        const message = await refusal.catch(error => (error as Error).message)
        expect(message).toBe("The server could not be reached or refused to create the user: run Test on the server to see why")
        expect(provisioner.dropUser).not.toHaveBeenCalled()
        expect(provisioner.rollbackCreate).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
    })

    it("given the link failing after the user is created, when a database is created, then the provisioner rolls its create back and the record goes", async () => {
        write.mockRejectedValue(new Error("write conflict"))

        await expect(
            new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev", link: { resourceId: String(resourceId), environmentId: String(development) } })
        ).rejects.toThrow("write conflict")
        expect(provisioner.rollbackCreate).toHaveBeenCalledWith("report_dev", "report_dev")
        expect(provisioner.dropUser).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
    })
})

/**
 * A resource as the database keeps it, for the tests of what happens when several writers meet: each write is
 * made only if updatedAt is still the one read, and moves it, as Mongoose timestamps do.
 */
const resourceStore = (initial: object) => {
    let current = { ...JSON.parse(JSON.stringify(initial)), updatedAt: new Date(1) }
    let clock = 1
    const writes: unknown[] = []
    vi.mocked(Resource.findById).mockImplementation((async () => JSON.parse(JSON.stringify(current), (key, value) => (key === "updatedAt" ? new Date(value) : value))) as never)
    vi.mocked(Resource.findOneAndUpdate).mockImplementation((async (filter: { updatedAt?: Date }, update: { $set: object }) => {
        // Let the other writers read before this one writes: the window a call to the server opens
        await new Promise(resolve => setTimeout(resolve, 0))
        if (filter.updatedAt?.getTime() !== current.updatedAt.getTime()) return null
        clock++
        current = { ...current, ...JSON.parse(JSON.stringify(update.$set)), updatedAt: new Date(clock) }
        writes.push(update)
        return current
    }) as never)
    return { state: () => current, writes }
}

describe("links made at the same time", () => {
    withArgoCdInitialized()

    it("given four databases linked at once to four environments of one resource, when they are written, then every override survives", async () => {
        const environments = [development, production, new Types.ObjectId(), new Types.ObjectId()]
        const store = resourceStore(resource({ values: [], secrets: [] }))
        vi.mocked(Environment.findById).mockImplementation((async (id: unknown) => ({ _id: id, projectId, name: String(id) })) as never)
        const databases = environments.map((_environment, index) => database({ databaseName: `report_${index}`, username: `report_${index}` }))
        vi.spyOn(ProvisionedDatabase, "findById").mockImplementation((async (id: unknown) => databases.find(candidate => String(candidate._id) === String(id))) as never)
        provisioner.resourceFields.mockImplementation(async (name: string) => ({ connectionString: `mongodb://${name}`, database: name }))

        await Promise.all(
            databases.map((document, index) => new ProvisionedDatabaseService().link(String(document._id), { resourceId: String(resourceId), environmentId: String(environments[index]) }))
        )

        const overrides = store.state().secrets.find((field: { field: string }) => field.field === "connectionString").overrides
        expect(overrides.map((override: { environmentId: string }) => override.environmentId).sort()).toEqual(environments.map(String).sort())
        expect(store.state().values[0].overrides).toHaveLength(4)
    })

    it("given a resource that never stops changing, when a link is written, then it gives up with a refusal rather than overwrite", async () => {
        vi.mocked(Resource.findOneAndUpdate).mockResolvedValue(null as never)
        const document = database()
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await expect(new ProvisionedDatabaseService().link(String(document._id), { resourceId: String(resourceId), environmentId: String(development) })).rejects.toMatchObject({
            code: "RESOURCE_CHANGED_MEANWHILE",
            statusCode: 409
        })
        expect(Resource.findOneAndUpdate).toHaveBeenCalledTimes(5)
        expect(document.link).toBeUndefined()
    })
})

describe("the overrides as they are written", () => {
    beforeEach(() => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"))
        resetSecretEncryptionKeyCache()
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        resetSecretEncryptionKeyCache()
    })

    /** The $set of whole lists is what the plugin encrypts on findOneAndUpdate: no credential may go through in the clear */
    it("given the $set a link writes, when the plugin of the resource transforms it, then every credential is a ciphertext and the plain values stay readable", () => {
        const update = { $set: withEnvironmentOverrides(resource() as never, String(development), { connectionString: APP_URI, database: "report_dev" }) }

        transformUpdate(update, { model: "Resource", paths: RESOURCE_SECRET_PATHS }, encryptSecret)

        const [connectionString] = update.$set.secrets
        expect(connectionString.value).toMatch(/^enc:v1:/)
        for (const override of connectionString.overrides) expect(override.value).toMatch(/^enc:v1:/)
        expect(JSON.stringify(update)).not.toContain(APP_URI)
        expect(update.$set.values[0].overrides).toContainEqual({ environmentId: String(development), value: "report_dev" })
    })
})

describe("a user left on the server", () => {
    withArgoCdInitialized()

    let create: ReturnType<typeof vi.fn>
    let created: IProvisionedDatabase

    beforeEach(() => {
        create = vi.spyOn(ProvisionedDatabase, "create").mockImplementation((async (fields: object) => {
            created = database(fields as never)
            return created
        }) as never) as unknown as ReturnType<typeof vi.fn>
    })

    /** A user Flightroom made is never forgotten: its record stays, marked, and the refusal names it */
    it("given ensureUser leaving its user behind, when a database is created, then the record is kept marked and the refusal names the user", async () => {
        provisioner.ensureUser.mockRejectedValue(new UserLeftOnServerError("report_dev", "Atlas answered DELETE databaseUsers: 500"))

        await expect(new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev" })).rejects.toMatchObject({
            code: "PROVISIONED_DATABASE_USER_LEFT_ON_SERVER",
            statusCode: 502,
            details: { username: "report_dev" }
        })
        expect(create).toHaveBeenCalled()
        expect(remove).not.toHaveBeenCalled()
        expect(created.status).toBe("cleanupRequired")
        expect(created.cleanupReason).toContain("could not be removed again")
        expect(created.toFrontendObject()).toMatchObject({ status: "cleanupRequired" })
    })

    it("given the rollback of a failed link failing too, when a database is created, then the record is kept marked, unlinked, naming the user", async () => {
        write.mockRejectedValue(new Error("write conflict"))
        provisioner.rollbackCreate.mockRejectedValue(new UserLeftOnServerError("report_dev", "not reachable"))

        const refusal = new ProvisionedDatabaseService().create(String(serverId), { databaseName: "report_dev", link: { resourceId: String(resourceId), environmentId: String(development) } })

        await expect(refusal).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_USER_LEFT_ON_SERVER", message: expect.stringContaining("write conflict") })
        await expect(refusal).rejects.toThrow("The user report_dev was created on the server and could not be removed again")
        expect(remove).not.toHaveBeenCalled()
        expect(created.status).toBe("cleanupRequired")
        expect(created.link).toBeUndefined()
    })

    it("given a database left for clean-up, when it is linked, then it is refused", async () => {
        const document = database({ status: "cleanupRequired" })
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await expect(new ProvisionedDatabaseService().link(String(document._id), { resourceId: String(resourceId), environmentId: String(development) })).rejects.toMatchObject({
            code: "PROVISIONED_DATABASE_CLEANUP_REQUIRED",
            statusCode: 409
        })
        expect(write).not.toHaveBeenCalled()
    })

    /** Its database may be someone else's, as a failed check found it: only the user is ours */
    it("given a database left for clean-up, when it is dropped, then it is refused, and removing its user goes through", async () => {
        const document = database({ status: "cleanupRequired" })
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await expect(new ProvisionedDatabaseService().delete(String(document._id), "drop", "report_dev")).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_CLEANUP_REQUIRED" })
        expect(provisioner.dropDatabase).not.toHaveBeenCalled()

        await new ProvisionedDatabaseService().delete(String(document._id), "user")

        expect(provisioner.dropUser).toHaveBeenCalledWith("report_dev", "report_dev")
        expect(remove).toHaveBeenCalled()
    })
})

describe("a removal that stopped half way", () => {
    withArgoCdInitialized()

    it.each(["data", "user"] as const)("given a database whose %s is already gone, when it is linked, then it is refused and nothing is written", async removedFromServer => {
        const document = database({ removedFromServer })
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await expect(new ProvisionedDatabaseService().link(String(document._id), { resourceId: String(resourceId), environmentId: String(development) })).rejects.toMatchObject({
            code: "PROVISIONED_DATABASE_PARTLY_REMOVED",
            statusCode: 409,
            details: { removedFromServer }
        })
        expect(write).not.toHaveBeenCalled()
    })

    /** The data is dropped as its user on MongoDB and Atlas: once the user is gone that cannot be done again */
    it("given a drop whose user removal failed, when it is tried again, then the data is not dropped twice and the user goes", async () => {
        const document = database()
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)
        provisioner.dropUser.mockRejectedValueOnce(new Error("timed out"))

        await expect(new ProvisionedDatabaseService().delete(String(document._id), "drop", "report_dev")).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_SERVER_FAILED" })
        expect(document.removedFromServer).toBe("data")
        expect(remove).not.toHaveBeenCalled()

        await new ProvisionedDatabaseService().delete(String(document._id), "drop", "report_dev")

        expect(provisioner.dropDatabase).toHaveBeenCalledTimes(1)
        expect(provisioner.dropUser).toHaveBeenCalledTimes(2)
        expect(document.removedFromServer).toBe("user")
        expect(remove).toHaveBeenCalled()
    })

    it("given a database whose user is already gone, when its data is to be dropped, then it is refused rather than tried without it", async () => {
        const document = database({ removedFromServer: "user" })
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await expect(new ProvisionedDatabaseService().delete(String(document._id), "drop", "report_dev")).rejects.toMatchObject({ code: "PROVISIONED_DATABASE_USER_ALREADY_REMOVED" })
        expect(provisioner.dropDatabase).not.toHaveBeenCalled()
    })

    it("given a database whose user is already gone, when it is removed with user, then nothing is asked of the server again", async () => {
        const document = database({ removedFromServer: "user" })
        vi.spyOn(ProvisionedDatabase, "findById").mockResolvedValue(document as never)

        await new ProvisionedDatabaseService().delete(String(document._id), "user")

        expect(provisioner.dropUser).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
    })
})
