import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { log } = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("..", () => ({ fastify: { log } }))

import { createBusinessException } from "../errors/BusinessException"
import Backend from "../models/BackendModel"
import BuiltBackend from "../models/BuiltBackendModel"
import BuiltFrontend from "../models/BuiltFrontendModel"
import DomainRelease, { DomainReleaseStatus, IDomainRelease } from "../models/DomainReleaseModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import User, { UserStatus } from "../models/UserModel"
import { BuildStatus } from "../types/BuildStatusDTO"
import BaseAuthorizedService from "./BaseAuthorizedService"
import BuildStatusService from "./BuildStatusService"
import DeploymentService from "./DeploymentService"
import { advanceDomainReleases, CI_TIMEOUT_MS, DomainReleaseService, REGISTRATION_GRACE_MS, STALE_STEP_MS } from "./DomainReleaseService"
import DomainService from "./DomainService"

const projectId = new Types.ObjectId()
const domainId = new Types.ObjectId()
const environmentId = new Types.ObjectId()
const user = { _id: new Types.ObjectId(), email: "ada@example.com", status: UserStatus.ACTIVE }
const domain = { _id: domainId, projectId, slug: "payments", name: "Payments" }

const cart = { kind: "frontend" as const, _id: new Types.ObjectId(), name: "Cart" }
const search = { kind: "frontend" as const, _id: new Types.ObjectId(), name: "Search" }
const ordersApi = { kind: "backend" as const, _id: new Types.ObjectId(), name: "Orders API" }
const legacy = { kind: "backend" as const, _id: new Types.ObjectId(), name: "Legacy" }

type Gates = { ensureAccessToProject: () => Promise<void>; getDomainScope: () => Promise<undefined>; ensureNotViewer: () => Promise<void> }

/** The user who started the release still reaches the whole project, not as a viewer */
const allowEverything = () => {
    const gates = BaseAuthorizedService.prototype as unknown as Gates
    vi.spyOn(gates, "ensureAccessToProject").mockResolvedValue(undefined)
    vi.spyOn(gates, "getDomainScope").mockResolvedValue(undefined)
    return vi.spyOn(gates, "ensureNotViewer").mockResolvedValue(undefined)
}

/** The updates written to the release, in order */
type ReleaseWrite = { $set: Record<string, unknown>; $unset?: Record<string, unknown> }
const writesOf = (updateOne: ReturnType<typeof vi.spyOn>): ReleaseWrite[] => updateOne.mock.calls.map((call: unknown[]) => call[1] as ReleaseWrite)

afterEach(() => {
    vi.restoreAllMocks()
})

describe("DomainReleaseService.start", () => {
    let build: ReturnType<typeof vi.spyOn>
    let updateOne: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        allowEverything()
        vi.spyOn(DomainService.prototype, "getById").mockResolvedValue(domain as never)
        vi.spyOn(Environment, "exists").mockResolvedValue({ _id: environmentId } as never)
        vi.spyOn(DomainRelease, "exists").mockResolvedValue(null)
        vi.spyOn(Frontend, "find").mockResolvedValue([cart] as never)
        vi.spyOn(Backend, "find").mockResolvedValue([ordersApi, legacy] as never)
        vi.spyOn(DomainRelease, "create").mockImplementation((async (doc: Record<string, unknown>) => ({ _id: new Types.ObjectId(), ...doc })) as never)
        vi.spyOn(DomainRelease, "findById").mockResolvedValue({ status: DomainReleaseStatus.WAITING_CI } as never)
        updateOne = vi.spyOn(DomainRelease, "updateOne").mockResolvedValue({ modifiedCount: 1 } as never)
        build = vi.spyOn(DomainService.prototype, "build").mockResolvedValue({
            version: "1.4.0",
            ref: "main",
            repositories: [
                {
                    id: "c/1",
                    repository: "shop",
                    status: "tagged",
                    members: [
                        { kind: "frontend", _id: String(cart._id), name: "Cart" },
                        { kind: "backend", _id: String(ordersApi._id), name: "Orders API" }
                    ]
                }
            ]
        })
    })

    const start = () => new DomainReleaseService(user as never).start(String(domainId), "1.4.0", undefined, String(environmentId))

    it("given a domain with no release running, when a build and deploy starts, then the domain is built and the release waits for the CI of the tagged members", async () => {
        await start()

        expect(build).toHaveBeenCalledWith(domainId, "1.4.0", undefined)
        expect(DomainRelease.create).toHaveBeenCalledWith(expect.objectContaining({ version: "1.4.0", ref: "main", startedBy: user._id, active: true, status: DomainReleaseStatus.BUILDING }))
        const [waiting] = writesOf(updateOne)
        expect(waiting.$set.status).toBe(DomainReleaseStatus.WAITING_CI)
        expect((waiting.$set.members as { name: string; tagged: boolean }[]).map(({ name, tagged }) => [name, tagged])).toEqual([
            ["Cart", true],
            ["Orders API", true],
            ["Legacy", false]
        ])
    })

    it("given a release of the domain still running, when another starts, then it is refused with a conflict and nothing is built", async () => {
        vi.spyOn(DomainRelease, "exists").mockResolvedValue({ _id: new Types.ObjectId() } as never)

        await expect(start()).rejects.toMatchObject({ code: "DOMAIN_RELEASE_RUNNING", statusCode: 409 })
        expect(DomainRelease.create).not.toHaveBeenCalled()
        expect(build).not.toHaveBeenCalled()
    })

    /** Two starts at once: both pass the check, the partial unique index refuses the second */
    it("given the unique index refusing the release, when it starts, then it is a conflict and nothing is built", async () => {
        vi.spyOn(DomainRelease, "create").mockRejectedValue(Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }) as never)

        await expect(start()).rejects.toMatchObject({ code: "DOMAIN_RELEASE_RUNNING", statusCode: 409 })
        expect(build).not.toHaveBeenCalled()
    })

    it("given a build whose check fails, when the release starts, then the refusal goes back as the build gives it and the release fails with each repository", async () => {
        const repositories = [{ id: "c/1", repository: "shop", status: "failed", reason: "TAG_EXISTS", members: [] }]
        build.mockRejectedValue(createBusinessException({ code: "DOMAIN_BUILD_CHECK_FAILED", message: "No repository was tagged", statusCode: 409, details: { repositories } }))

        await expect(start()).rejects.toMatchObject({ code: "DOMAIN_BUILD_CHECK_FAILED", statusCode: 409 })
        const [failed] = writesOf(updateOne)
        expect(failed.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.BUILDING, errorCode: "DOMAIN_BUILD_CHECK_FAILED", repositories })
        expect(failed.$unset).toEqual({ active: "" })
    })

    it("given an environment of another project, when the release starts, then it is not found and nothing is built", async () => {
        vi.spyOn(Environment, "exists").mockResolvedValue(null)

        await expect(start()).rejects.toMatchObject({ code: "DOMAIN_RELEASE_ENVIRONMENT_NOT_FOUND", statusCode: 404 })
        expect(build).not.toHaveBeenCalled()
    })

    it("given a viewer of the project, when the release starts, then it is refused before anything is written", async () => {
        allowEverything().mockRejectedValue(createBusinessException({ code: "DOMAIN_BUILD_FORBIDDEN", message: "A viewer cannot create a version of a domain", statusCode: 403 }))

        await expect(start()).rejects.toMatchObject({ code: "DOMAIN_BUILD_FORBIDDEN", statusCode: 403 })
        expect(DomainRelease.create).not.toHaveBeenCalled()
    })
})

describe("advanceDomainReleases", () => {
    let updateOne: ReturnType<typeof vi.spyOn>
    let deploy: ReturnType<typeof vi.spyOn>
    let updateFrontends: ReturnType<typeof vi.spyOn>
    let updateBackends: ReturnType<typeof vi.spyOn>
    const deploymentId = new Types.ObjectId()

    const release = (overrides: Partial<IDomainRelease> = {}) =>
        ({
            _id: new Types.ObjectId(),
            projectId,
            domainId,
            version: "1.4.0",
            ref: "main",
            environmentId,
            startedBy: user._id,
            status: DomainReleaseStatus.WAITING_CI,
            members: [
                { ...cart, tagged: true, built: false },
                { ...search, tagged: true, built: false },
                { ...ordersApi, tagged: true, built: false },
                { ...legacy, tagged: false, built: false }
            ],
            repositories: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            ...overrides
        }) as unknown as IDomainRelease

    const withReleases = (...releases: IDomainRelease[]) => vi.spyOn(DomainRelease, "find").mockReturnValue({ lean: async () => releases } as never)

    /** What the CI registered for the version of the release */
    const registered = (frontends: { _id: Types.ObjectId }[], backends: { _id: Types.ObjectId }[]) => {
        vi.spyOn(BuiltFrontend, "find").mockResolvedValue(frontends.map(member => ({ frontendId: member._id })) as never)
        vi.spyOn(BuiltBackend, "find").mockResolvedValue(backends.map(member => ({ backendId: member._id })) as never)
    }

    beforeEach(() => {
        allowEverything()
        vi.spyOn(User, "findById").mockResolvedValue({ status: UserStatus.ACTIVE, toObject: () => user } as never)
        updateOne = vi.spyOn(DomainRelease, "updateOne").mockResolvedValue({ modifiedCount: 1 } as never)
        updateFrontends = vi.spyOn(Frontend, "updateMany").mockResolvedValue({} as never)
        updateBackends = vi.spyOn(Backend, "updateMany").mockResolvedValue({} as never)
        deploy = vi.spyOn(DeploymentService.prototype, "createMultiple").mockResolvedValue([{ _id: deploymentId }] as never)
        vi.spyOn(BuildStatusService.prototype, "getByProjectId").mockResolvedValue({ frontends: [], backends: [], environments: [] } as never)
    })

    it("given every tagged member registered by the CI, when the tick runs, then the release sets the versions, deploys and is deployed", async () => {
        withReleases(release())
        registered([cart, search], [ordersApi])

        await advanceDomainReleases()

        expect(writesOf(updateOne).map(write => write.$set.status)).toEqual([undefined, DomainReleaseStatus.UPDATING_VERSIONS, DomainReleaseStatus.DEPLOYING, DomainReleaseStatus.DEPLOYED])
        expect(deploy).toHaveBeenCalledWith([String(environmentId)], String(domainId))
        const deployed = writesOf(updateOne).at(-1)!
        expect(deployed.$set).toMatchObject({ deploymentId })
        expect(deployed.$unset).toEqual({ active: "" })
        // Acting as the user who started it
        expect((deploy.mock.contexts[0] as unknown as { user: unknown }).user).toEqual(user)
    })

    /** The release decides the version: a CI registration would move it only to a newer one */
    it("given members holding any version, when the versions are set, then every built frontend, BUNDLE or DOCKER, and backend gets the tag unconditionally", async () => {
        withReleases(release())
        registered([cart, search], [ordersApi])

        await advanceDomainReleases()

        expect(updateFrontends).toHaveBeenCalledWith({ _id: { $in: [cart._id, search._id] }, projectId, domainId }, { $set: { version: "1.4.0" } })
        // The member without a repository keeps its version
        expect(updateBackends).toHaveBeenCalledWith({ _id: { $in: [ordersApi._id] }, projectId, domainId }, { $set: { version: "1.4.0" } })
        expect(updateFrontends.mock.invocationCallOrder[0]).toBeLessThan(deploy.mock.invocationCallOrder[0])
    })

    it("given a member the CI has not registered yet, when the tick runs, then the release keeps waiting and nothing is deployed", async () => {
        withReleases(release())
        registered([cart], [ordersApi])

        await advanceDomainReleases()

        const [marked] = writesOf(updateOne)
        expect((marked.$set.members as { name: string; built: boolean }[]).filter(member => member.built).map(member => member.name)).toEqual(["Cart", "Orders API"])
        expect(writesOf(updateOne)).toHaveLength(1)
        expect(updateFrontends).not.toHaveBeenCalled()
        expect(deploy).not.toHaveBeenCalled()
    })

    it("given the CI still missing a version after the timeout, when the tick runs, then the release fails naming it and nothing is deployed", async () => {
        withReleases(release({ createdAt: new Date(Date.now() - CI_TIMEOUT_MS - 1000) }))
        registered([cart], [ordersApi])

        await advanceDomainReleases()

        const failed = writesOf(updateOne).at(-1)!
        expect(failed.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.WAITING_CI, errorCode: "DOMAIN_RELEASE_CI_TIMEOUT" })
        expect(failed.$set.errorMessage).toContain("Search")
        expect(failed.$unset).toEqual({ active: "" })
        expect(updateFrontends).not.toHaveBeenCalled()
        expect(deploy).not.toHaveBeenCalled()
    })

    it("given every run of the tag failed for a member, when the tick runs, then the release fails without waiting for the timeout", async () => {
        withReleases(release())
        registered([cart], [ordersApi])
        vi.spyOn(BuildStatusService.prototype, "getByProjectId").mockResolvedValue({
            frontends: [
                {
                    frontendId: String(search._id),
                    builds: [
                        { id: "2", status: BuildStatus.FAILED, ref: "1.4.0" },
                        { id: "1", status: BuildStatus.SUCCESS, ref: "1.3.0" }
                    ]
                }
            ],
            backends: [],
            environments: []
        } as never)

        await advanceDomainReleases()

        expect(writesOf(updateOne).at(-1)!.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, errorCode: "DOMAIN_RELEASE_CI_FAILED" })
        expect(deploy).not.toHaveBeenCalled()
    })

    /** A tag can start more than one workflow: one still running may yet register the version */
    it("given a failed run of the tag next to one still running, when the tick runs, then the release keeps waiting", async () => {
        withReleases(release())
        registered([cart], [ordersApi])
        vi.spyOn(BuildStatusService.prototype, "getByProjectId").mockResolvedValue({
            frontends: [
                {
                    frontendId: String(search._id),
                    builds: [
                        { id: "3", status: BuildStatus.RUNNING, ref: "1.4.0" },
                        { id: "2", status: BuildStatus.FAILED, ref: "1.4.0" }
                    ]
                }
            ],
            backends: [],
            environments: []
        } as never)

        await advanceDomainReleases()

        expect(writesOf(updateOne).every(write => write.$set.status !== DomainReleaseStatus.FAILED)).toBe(true)
    })

    /** The run went green but never called the console: waiting longer would only reach the timeout */
    it("given every run of the tag ended with one successful but the version unregistered past the grace, when the tick runs, then the release fails without waiting for the timeout", async () => {
        withReleases(release())
        registered([cart], [ordersApi])
        const ended = new Date(Date.now() - REGISTRATION_GRACE_MS - 1000).toISOString()
        vi.spyOn(BuildStatusService.prototype, "getByProjectId").mockResolvedValue({
            frontends: [
                {
                    frontendId: String(search._id),
                    builds: [
                        { id: "3", status: BuildStatus.SUCCESS, ref: "1.4.0", finishedAt: ended },
                        { id: "2", status: BuildStatus.FAILED, ref: "1.4.0", finishedAt: ended }
                    ]
                }
            ],
            backends: [],
            environments: []
        } as never)

        await advanceDomainReleases()

        const failed = writesOf(updateOne).at(-1)!
        expect(failed.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.WAITING_CI, errorCode: "DOMAIN_RELEASE_CI_NOT_REGISTERED" })
        expect(failed.$set.errorMessage).toContain("Search")
        expect(deploy).not.toHaveBeenCalled()
    })

    /** A workflow the run starts when it ends may register the version a little later */
    it("given a successful run of the tag that ended within the grace, or with no end told, when the tick runs, then the release keeps waiting", async () => {
        withReleases(release())
        registered([cart], [])
        vi.spyOn(BuildStatusService.prototype, "getByProjectId").mockResolvedValue({
            frontends: [{ frontendId: String(search._id), builds: [{ id: "3", status: BuildStatus.SUCCESS, ref: "1.4.0", finishedAt: new Date().toISOString() }] }],
            backends: [{ backendId: String(ordersApi._id), builds: [{ id: "4", status: BuildStatus.SUCCESS, ref: "1.4.0" }] }],
            environments: []
        } as never)

        await advanceDomainReleases()

        expect(writesOf(updateOne).every(write => write.$set.status !== DomainReleaseStatus.FAILED)).toBe(true)
    })

    it("given a release another tick moved on first, when this tick claims it, then it neither sets the versions nor deploys", async () => {
        withReleases(release())
        registered([cart, search], [ordersApi])
        updateOne.mockImplementation((async (filter: { status?: unknown }) => ({ modifiedCount: filter.status === DomainReleaseStatus.WAITING_CI ? 0 : 1 })) as never)

        await advanceDomainReleases()

        expect(updateFrontends).not.toHaveBeenCalled()
        expect(deploy).not.toHaveBeenCalled()
    })

    it("given a deploy that fails, when the tick runs, then the release fails in the deploy step with the error", async () => {
        withReleases(release())
        registered([cart, search], [ordersApi])
        deploy.mockRejectedValue(createBusinessException({ code: "GITOPS_PUSH_FAILED", message: "The GitOps repository refused the push" }))

        await advanceDomainReleases()

        expect(writesOf(updateOne).at(-1)!.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.DEPLOYING, errorCode: "GITOPS_PUSH_FAILED" })
    })

    it("given a user who lost the right to release, when the tick runs, then the release fails and nothing is deployed", async () => {
        allowEverything().mockRejectedValue(createBusinessException({ code: "DOMAIN_BUILD_FORBIDDEN", message: "A viewer cannot create a version of a domain", statusCode: 403 }))
        withReleases(release())
        registered([cart, search], [ordersApi])

        await advanceDomainReleases()

        expect(writesOf(updateOne).at(-1)!.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, errorCode: "DOMAIN_BUILD_FORBIDDEN" })
        expect(deploy).not.toHaveBeenCalled()
    })

    it("given a release stuck deploying since before a restart, when the tick runs, then it fails as interrupted rather than deploying twice", async () => {
        withReleases(release({ status: DomainReleaseStatus.DEPLOYING, updatedAt: new Date(Date.now() - STALE_STEP_MS - 1000) }))

        await advanceDomainReleases()

        expect(writesOf(updateOne).at(-1)!.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.DEPLOYING, errorCode: "DOMAIN_RELEASE_INTERRUPTED" })
        expect(deploy).not.toHaveBeenCalled()
    })

    it("given a release deploying in another tick right now, when this tick runs, then it is left alone", async () => {
        withReleases(release({ status: DomainReleaseStatus.DEPLOYING }))

        await advanceDomainReleases()

        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given the user who started the release is gone, when the tick runs, then the release fails", async () => {
        vi.spyOn(User, "findById").mockResolvedValue(null)
        withReleases(release())

        await advanceDomainReleases()

        expect(writesOf(updateOne).at(-1)!.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, errorCode: "DOMAIN_RELEASE_USER_UNAVAILABLE" })
    })
})
