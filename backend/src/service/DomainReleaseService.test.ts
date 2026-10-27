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
import ArgoCdService from "./ArgoCdService"
import BaseAuthorizedService from "./BaseAuthorizedService"
import BuildStatusService from "./BuildStatusService"
import DeploymentService from "./DeploymentService"
import { advanceDomainReleases, CI_TIMEOUT_MS, DEGRADED_GRACE_MS, DomainReleaseService, REGISTRATION_GRACE_MS, ROLLOUT_TIMEOUT_MS, STALE_STEP_MS } from "./DomainReleaseService"
import DomainService from "./DomainService"
import { RolloutApplication, RolloutDTO } from "./gitops/rollout"

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
                    ref: "main",
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

        expect(build).toHaveBeenCalledWith(domainId, "1.4.0", undefined, undefined)
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
    let rollout: ReturnType<typeof vi.spyOn>
    const deploymentId = new Types.ObjectId()
    const deployedAt = new Date()

    /** An application of the domain as Argo CD tells it */
    const application = (member: { _id: Types.ObjectId; name: string; kind: "frontend" | "backend" }, state: RolloutApplication["state"]): RolloutApplication => ({
        _id: String(member._id),
        kind: member.kind,
        name: member.name,
        slug: member.name.toLowerCase(),
        state
    })
    /** What Argo CD tells of the deploy: tracked, with these applications */
    const argoCdTells = (...applications: RolloutApplication[]) =>
        rollout.mockResolvedValue({
            tracked: true,
            applications,
            done: applications.every(candidate => candidate.state === "healthy"),
            failed: applications.some(candidate => candidate.state === "failed")
        } satisfies RolloutDTO)
    /** A release deployed at `since`, its containers still starting */
    const rollingOut = (since = deployedAt, applications: RolloutApplication[] = []) =>
        release({ status: DomainReleaseStatus.ROLLING_OUT, deploymentId: deploymentId as never, rollout: { since, applications } })

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
        deploy = vi.spyOn(DeploymentService.prototype, "createMultiple").mockResolvedValue([{ _id: deploymentId, deployedAt }] as never)
        // A project deploying through no Argo CD: the deploy is over with its commit
        rollout = vi.spyOn(ArgoCdService.prototype, "rollout").mockResolvedValue({ tracked: false, applications: [], done: true, failed: false })
        vi.spyOn(BuildStatusService.prototype, "getByProjectId").mockResolvedValue({ frontends: [], backends: [], environments: [] } as never)
    })

    it("given every tagged member registered by the CI, when the tick runs, then the release sets the versions, deploys and is deployed", async () => {
        withReleases(release())
        registered([cart, search], [ordersApi])

        await advanceDomainReleases()

        expect(writesOf(updateOne).map(write => write.$set.status)).toEqual([
            undefined,
            DomainReleaseStatus.UPDATING_VERSIONS,
            DomainReleaseStatus.DEPLOYING,
            DomainReleaseStatus.ROLLING_OUT,
            DomainReleaseStatus.DEPLOYED
        ])
        expect(deploy).toHaveBeenCalledWith([String(environmentId)], String(domainId))
        expect(writesOf(updateOne).at(-2)!.$set).toMatchObject({ deploymentId })
        const deployed = writesOf(updateOne).at(-1)!
        expect(deployed.$unset).toEqual({ active: "", rollout: "" })
        expect(rollout).toHaveBeenCalledWith(projectId, deploymentId, domainId)
        // Acting as the user who started it
        expect((deploy.mock.contexts[0] as unknown as { user: unknown }).user).toEqual(user)
    })

    it("given Argo CD still replacing the pods once the deploy is committed, when the tick runs, then the release is rolling out, not deployed", async () => {
        withReleases(release())
        registered([cart, search], [ordersApi])
        argoCdTells(application(cart, "healthy"), application(ordersApi, "progressing"))

        await advanceDomainReleases()

        const statuses = writesOf(updateOne).map(write => write.$set.status)
        expect(statuses).not.toContain(DomainReleaseStatus.DEPLOYED)
        const last = writesOf(updateOne).at(-1)!
        expect(last.$set.rollout).toMatchObject({
            since: deployedAt,
            applications: [
                { name: "Cart", state: "healthy" },
                { name: "Orders API", state: "progressing" }
            ]
        })
        expect(updateOne.mock.calls.at(-1)![0]).toMatchObject({ status: DomainReleaseStatus.ROLLING_OUT })
    })

    it("given every application healthy, when the tick follows the rollout, then the release is deployed with what Argo CD told", async () => {
        withReleases(rollingOut())
        argoCdTells(application(cart, "healthy"), application(ordersApi, "healthy"))

        await advanceDomainReleases()

        const [deployed] = writesOf(updateOne)
        expect(deployed.$set).toMatchObject({ status: DomainReleaseStatus.DEPLOYED, rollout: { applications: [{ state: "healthy" }, { state: "healthy" }] } })
        expect(deployed.$unset).toEqual({ active: "" })
        expect(deploy).not.toHaveBeenCalled()
    })

    it("given Argo CD failing to apply the commit, when the tick follows the rollout, then the release fails naming the application", async () => {
        withReleases(rollingOut())
        argoCdTells(application(cart, "healthy"), application(ordersApi, "failed"))

        await advanceDomainReleases()

        const [failed] = writesOf(updateOne)
        expect(failed.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.ROLLING_OUT, errorCode: "DOMAIN_RELEASE_ROLLOUT_FAILED" })
        expect(failed.$set.errorMessage).toContain("Orders API")
        expect(failed.$set.errorMessage).not.toContain("Cart")
        expect(failed.$set.rollout).toMatchObject({ applications: [{ state: "healthy" }, { state: "failed" }] })
    })

    it("given an application turning degraded, when the tick follows the rollout, then the release gives it time to recover", async () => {
        withReleases(rollingOut())
        argoCdTells(application(ordersApi, "degraded"))

        await advanceDomainReleases()

        const [kept] = writesOf(updateOne)
        expect(kept.$set.status).toBeUndefined()
        expect((kept.$set.rollout as { applications: { degradedAt?: Date }[] }).applications[0].degradedAt).toBeInstanceOf(Date)
    })

    it("given an application degraded past the grace, when the tick follows the rollout, then the release fails naming it", async () => {
        const degradedAt = new Date(Date.now() - DEGRADED_GRACE_MS - 1000)
        withReleases(rollingOut(deployedAt, [{ ...application(ordersApi, "degraded"), degradedAt } as RolloutApplication]))
        argoCdTells(application(ordersApi, "degraded"))

        await advanceDomainReleases()

        const [failed] = writesOf(updateOne)
        expect(failed.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.ROLLING_OUT, errorCode: "DOMAIN_RELEASE_ROLLOUT_DEGRADED" })
        expect(failed.$set.errorMessage).toContain("Orders API")
    })

    it("given a member the release did not build that was broken already, when the tick follows the rollout, then it neither fails nor holds the release", async () => {
        const degradedAt = new Date(Date.now() - DEGRADED_GRACE_MS - 1000)
        withReleases(rollingOut(deployedAt, [{ ...application(legacy, "degraded"), degradedAt } as RolloutApplication]))
        argoCdTells(application(cart, "healthy"), application(ordersApi, "healthy"), application(legacy, "degraded"))

        await advanceDomainReleases()

        const [deployed] = writesOf(updateOne)
        expect(deployed.$set.status).toBe(DomainReleaseStatus.DEPLOYED)
    })

    it("given a member built and running while one not built is still being applied, when the tick follows the rollout, then the release waits for it", async () => {
        withReleases(rollingOut())
        argoCdTells(application(ordersApi, "healthy"), application(legacy, "syncing"))

        await advanceDomainReleases()

        const [kept] = writesOf(updateOne)
        expect(kept.$set.status).toBeUndefined()
    })

    it("given a member built going from degraded back to progressing, when the tick follows the rollout, then it keeps the time it broke", async () => {
        const degradedAt = new Date(Date.now() - 60_000)
        withReleases(rollingOut(deployedAt, [{ ...application(ordersApi, "degraded"), degradedAt } as RolloutApplication]))
        argoCdTells(application(ordersApi, "progressing"))

        await advanceDomainReleases()

        const [kept] = writesOf(updateOne)
        expect((kept.$set.rollout as { applications: { degradedAt?: Date }[] }).applications[0].degradedAt).toEqual(degradedAt)
    })

    it("given the pods still not ready after the timeout, when the tick follows the rollout, then the release fails naming those not running", async () => {
        withReleases(rollingOut(new Date(Date.now() - ROLLOUT_TIMEOUT_MS - 1000)))
        argoCdTells(application(cart, "healthy"), application(ordersApi, "progressing"))

        await advanceDomainReleases()

        const [failed] = writesOf(updateOne)
        expect(failed.$set).toMatchObject({ status: DomainReleaseStatus.FAILED, failedStep: DomainReleaseStatus.ROLLING_OUT, errorCode: "DOMAIN_RELEASE_ROLLOUT_TIMEOUT" })
        expect(failed.$set.errorMessage).toContain("Orders API")
        expect(failed.$set.errorMessage).not.toContain("Cart")
    })

    it("given Argo CD out of reach before the timeout, when the tick follows the rollout, then the release keeps rolling out and tells why", async () => {
        withReleases(rollingOut())
        rollout.mockRejectedValue(createBusinessException({ code: "ARGOCD_UNREACHABLE", message: "Argo CD cannot be reached", statusCode: 502 }))

        await advanceDomainReleases()

        const [kept] = writesOf(updateOne)
        expect(kept.$set.status).toBeUndefined()
        expect(kept.$set.rollout).toMatchObject({ since: deployedAt, error: "Argo CD cannot be reached" })
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
