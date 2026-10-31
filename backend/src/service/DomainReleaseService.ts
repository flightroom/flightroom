import { isValidObjectId, ObjectId, Types } from "mongoose"
import { fastify } from ".."
import { BusinessException, createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Backend from "../models/BackendModel"
import BuiltBackend from "../models/BuiltBackendModel"
import BuiltFrontend from "../models/BuiltFrontendModel"
import DomainRelease, { DomainReleaseStatus, DomainReleaseStep, IDomainRelease, IDomainReleaseMember, IDomainReleaseRollout, IDomainReleaseRolloutApplication } from "../models/DomainReleaseModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import User, { UserStatus } from "../models/UserModel"
import { BuildStatus } from "../types/BuildStatusDTO"
import { DomainBuildRepository } from "../types/DomainDTO"
import { toObjectId } from "../utils/mongooseUtils"
import ArgoCdService from "./ArgoCdService"
import BaseAuthorizedService, { AuthorizedPrincipal } from "./BaseAuthorizedService"
import BuildStatusService from "./BuildStatusService"
import DeploymentService from "./DeploymentService"
import DomainService, { buildBranchOf, ensureBuildTarget } from "./DomainService"
import { RolloutApplication, RolloutDTO } from "./gitops/rollout"

/** How long the CI of the tagged repositories is given to register the version: a release still waiting then fails */
export const CI_TIMEOUT_MS = 60 * 60 * 1000

/**
 * The other steps run in one go, inside the request that tags or inside one tick: one that has not moved for
 * this long was cut short by a restart, and is failed rather than run twice (a deploy may have gone through).
 */
export const STALE_STEP_MS = 15 * 60 * 1000

/**
 * How long after the last run of the tag ended its version may still be registered: a registration made by a
 * workflow the tag's run starts when it ends comes after it. Past this, the CI is over and will not register it.
 */
export const REGISTRATION_GRACE_MS = 2 * 60 * 1000

/**
 * How long Argo CD and Kubernetes are given to run what the release deployed: past it the release fails, naming
 * what does not run yet. Longer than the 10 minutes Kubernetes gives a rollout before calling it degraded.
 */
export const ROLLOUT_TIMEOUT_MS = 20 * 60 * 1000

/** How long an application may stay degraded before the release takes it for broken: a pod restarting may recover */
export const DEGRADED_GRACE_MS = 2 * 60 * 1000

const ENDED = [BuildStatus.SUCCESS, BuildStatus.FAILED, BuildStatus.CANCELED]

const ACTIVE_STATUSES = [DomainReleaseStatus.BUILDING, DomainReleaseStatus.WAITING_CI, DomainReleaseStatus.UPDATING_VERSIONS, DomainReleaseStatus.DEPLOYING, DomainReleaseStatus.ROLLING_OUT]

const FORBIDDEN = { code: "DOMAIN_BUILD_FORBIDDEN", message: "A viewer cannot create a version of a domain" }

const releaseNotRunning = () => createBusinessException({ code: "DOMAIN_RELEASE_NOT_RUNNING", message: "This build and deploy is over already", statusCode: 409 })

const releaseRunning = () => createBusinessException({ code: "DOMAIN_RELEASE_RUNNING", message: "A build and deploy of this domain is already running", statusCode: 409 })

/** The code and the words a failed release keeps: a business exception's own, anything else as a failed step */
const errorOf = (error: unknown): { errorCode: string; errorMessage: string } =>
    error instanceof BusinessException
        ? { errorCode: error.code, errorMessage: error.message }
        : { errorCode: "DOMAIN_RELEASE_STEP_FAILED", errorMessage: error instanceof Error ? error.message : String(error) }

/**
 * Ends the release as failed in `step`, unless it is over already. `repositories` replaces what the build told, when
 * given, and `rollout` what Argo CD told.
 */
const failRelease = async (release: Pick<IDomainRelease, "_id">, step: DomainReleaseStep, error: unknown, repositories?: unknown, rollout?: IDomainReleaseRollout) => {
    await DomainRelease.updateOne(
        { _id: release._id, status: { $in: ACTIVE_STATUSES } },
        {
            $set: {
                status: DomainReleaseStatus.FAILED,
                failedStep: step,
                ...errorOf(error),
                finishedAt: new Date(),
                ...(Array.isArray(repositories) && { repositories }),
                ...(rollout && { rollout })
            },
            $unset: { active: "" }
        }
    )
}

const namesOf = (members: Pick<IDomainReleaseMember, "name">[]) => members.map(member => member.name).join(", ")

export class DomainReleaseService extends BaseAuthorizedService {
    /**
     * Starts a build and deploy of the domain to `environmentId`: the build runs now, as {@link DomainService.build}
     * does it, with the same checks and the same refusal; the release tick takes the other steps. One release per
     * domain at a time: a second one is refused while the first is not over.
     */
    async start(id: string | ObjectId, version: unknown, ref: unknown, environmentId: unknown, refs?: unknown): Promise<IDomainRelease | null> {
        ensureBuildTarget(version, ref, refs)
        if (typeof environmentId !== "string" || !isValidObjectId(environmentId)) {
            throw createBusinessException({ code: "DOMAIN_RELEASE_ENVIRONMENT_INVALID", message: "The environment to deploy to is required" })
        }
        const domain = await new DomainService(this.user).getById(id)
        if (!domain) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureNotViewer(domain.projectId, FORBIDDEN)
        // An environment of another project is refused as missing: the deploy never reaches across projects
        if (!(await Environment.exists({ _id: toObjectId(environmentId), projectId: domain.projectId }))) {
            throw createBusinessException({ code: "DOMAIN_RELEASE_ENVIRONMENT_NOT_FOUND", message: `There is no environment ${environmentId} in this project`, statusCode: 404 })
        }
        if (await DomainRelease.exists({ domainId: domain._id, active: true })) {
            throw releaseRunning()
        }

        const inDomain = { projectId: domain.projectId, domainId: domain._id }
        const [frontends, backends] = await Promise.all([Frontend.find(inDomain, { name: 1 }), Backend.find(inDomain, { name: 1 })])
        let release: IDomainRelease
        try {
            release = await DomainRelease.create({
                projectId: domain.projectId,
                domainId: domain._id,
                version,
                ref: buildBranchOf(ref),
                environmentId: toObjectId(environmentId),
                startedBy: this.getUser()!._id,
                status: DomainReleaseStatus.BUILDING,
                active: true,
                members: [
                    ...frontends.map(member => ({ kind: "frontend" as const, _id: member._id, name: member.name })),
                    ...backends.map(member => ({ kind: "backend" as const, _id: member._id, name: member.name }))
                ]
            })
        } catch (error) {
            // Two releases started together both passed the check above: the partial unique index decides
            if ((error as { code?: number })?.code === 11000) throw releaseRunning()
            throw error
        }

        let repositories: DomainBuildRepository[]
        try {
            repositories = (await new DomainService(this.user).build(domain._id, version, ref, refs)).repositories
        } catch (error) {
            // The refusal of the check goes back as the build gives it: the dialog lists it repository by repository
            await failRelease(release, DomainReleaseStatus.BUILDING, error, (error as BusinessException).details?.repositories)
            throw error
        }

        const tagged = new Set(repositories.filter(repository => repository.status === "tagged").flatMap(repository => repository.members.map(member => member._id)))
        const members = release.members.map(member => ({ kind: member.kind, _id: member._id, name: member.name, tagged: tagged.has(String(member._id)), built: false }))
        const untagged = repositories.filter(repository => repository.status === "failed")
        if (untagged.length > 0) {
            // The CI of a repository left untagged never registers the version: waiting for it would only time out
            await DomainRelease.updateOne({ _id: release._id }, { $set: { members, repositories } })
            await failRelease(
                release,
                DomainReleaseStatus.BUILDING,
                createBusinessException({
                    code: "DOMAIN_RELEASE_TAG_FAILED",
                    message: `The tag failed for ${untagged.map(repository => repository.repository).join(", ")}: the other repositories stay tagged`
                })
            )
        } else {
            await DomainRelease.updateOne({ _id: release._id, status: DomainReleaseStatus.BUILDING }, { $set: { members, repositories, status: DomainReleaseStatus.WAITING_CI } })
        }
        return DomainRelease.findById(release._id)
    }

    /** The last release of the domain, over or not: null when it never had one */
    async getLatest(id: string | ObjectId): Promise<IDomainRelease | null> {
        const domain = await new DomainService(this.user).getById(id)
        if (!domain) {
            throw new EntityNotFoundError(String(id))
        }
        return DomainRelease.findOne({ domainId: domain._id }).sort({ createdAt: -1 })
    }

    /**
     * Stops the release where it stands: it fails as canceled in the step it was taking, and the tick no longer
     * moves it on. What is done stays done: the tags pushed and the CI runs they started, a deploy already committed.
     */
    async cancel(id: string | ObjectId, releaseId: unknown): Promise<IDomainRelease | null> {
        const domain = await new DomainService(this.user).getById(id)
        if (!domain) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureNotViewer(domain.projectId, FORBIDDEN)
        const release = typeof releaseId === "string" && isValidObjectId(releaseId) ? await DomainRelease.findOne({ _id: toObjectId(releaseId), domainId: domain._id }) : null
        if (!release) {
            throw new EntityNotFoundError(String(releaseId))
        }
        if (!ACTIVE_STATUSES.includes(release.status)) {
            throw releaseNotRunning()
        }
        await failRelease(release, release.status as DomainReleaseStep, createBusinessException({ code: "DOMAIN_RELEASE_CANCELED", message: "The release was stopped from the console" }))
        return DomainRelease.findById(release._id)
    }

    /**
     * Takes the release as far as it can go now, acting as the user who started it with the rights they have
     * now: waits for the CI, then sets the versions, then deploys. Each move to the next step is claimed in the
     * database, so of two ticks reading the same release only one goes on.
     */
    async advance(release: IDomainRelease): Promise<void> {
        let step = release.status as DomainReleaseStep
        try {
            if (step === DomainReleaseStatus.ROLLING_OUT) {
                await this.followRollout(release, new Date(release.rollout?.since ?? release.updatedAt))
                return
            }
            if (step !== DomainReleaseStatus.WAITING_CI) {
                if (Date.now() - new Date(release.updatedAt).getTime() > STALE_STEP_MS) {
                    throw createBusinessException({ code: "DOMAIN_RELEASE_INTERRUPTED", message: "The release stopped in the middle of a step, most likely on a restart of the console" })
                }
                return
            }
            await this.ensureAccessToProject(release.projectId)
            await this.ensureInDomainScope(release.projectId, release.domainId)
            await this.ensureNotViewer(release.projectId, FORBIDDEN)

            const waiting = await this.waitingFor(release)
            if (waiting.length > 0) {
                if (Date.now() - new Date(release.createdAt).getTime() > CI_TIMEOUT_MS) {
                    throw createBusinessException({
                        code: "DOMAIN_RELEASE_CI_TIMEOUT",
                        message: `The CI did not register version ${release.version} of ${namesOf(waiting)} within ${CI_TIMEOUT_MS / 60_000} minutes`
                    })
                }
                const { failed, unregistered } = await this.endedInCi(release, waiting)
                if (failed.length > 0) {
                    throw createBusinessException({ code: "DOMAIN_RELEASE_CI_FAILED", message: `The CI of tag ${release.version} failed for ${namesOf(failed)}` })
                }
                if (unregistered.length > 0) {
                    throw createBusinessException({
                        code: "DOMAIN_RELEASE_CI_NOT_REGISTERED",
                        message: `The CI of tag ${release.version} ended without registering the version for ${namesOf(unregistered)}`
                    })
                }
                return
            }

            if (!(await this.claim(release, DomainReleaseStatus.WAITING_CI, DomainReleaseStatus.UPDATING_VERSIONS))) return
            step = DomainReleaseStatus.UPDATING_VERSIONS
            await this.updateVersions(release)

            if (!(await this.claim(release, DomainReleaseStatus.UPDATING_VERSIONS, DomainReleaseStatus.DEPLOYING))) return
            step = DomainReleaseStatus.DEPLOYING
            // As the deploy button of the domain: only its frontends and backends move
            const [deployment] = await new DeploymentService(this.user).createMultiple([String(release.environmentId)], String(release.domainId))
            // Committed: the containers of the new version are still to start, Argo CD tells when they run
            step = DomainReleaseStatus.ROLLING_OUT
            const since = deployment?.deployedAt ?? new Date()
            await DomainRelease.updateOne(
                { _id: release._id, status: DomainReleaseStatus.DEPLOYING },
                { $set: { status: DomainReleaseStatus.ROLLING_OUT, deploymentId: deployment?._id, rollout: { since, applications: [] } } }
            )
            await this.followRollout({ ...release, deploymentId: deployment?._id, rollout: undefined }, since)
        } catch (error) {
            await failRelease(release, step, error)
        }
    }

    /**
     * Reads from Argo CD where the deploy of the release stands, and ends the release once the members it built run
     * the new version and the others are applied. It fails when Argo CD could not apply the commit, when a member it
     * built stays broken past the grace, or when the rollout is not over in time. A member the release did not build
     * that was broken already does not fail it. Argo CD out of reach is tried again at the next tick.
     */
    private async followRollout(release: Pick<IDomainRelease, "_id" | "projectId" | "domainId" | "version" | "members" | "deploymentId" | "rollout">, since: Date): Promise<void> {
        const current = { _id: release._id, status: DomainReleaseStatus.ROLLING_OUT }
        const deployed = { status: DomainReleaseStatus.DEPLOYED, finishedAt: new Date() }
        if (!release.deploymentId) {
            await DomainRelease.updateOne(current, { $set: deployed, $unset: { active: "", rollout: "" } })
            return
        }
        const late = Date.now() - since.getTime() > ROLLOUT_TIMEOUT_MS
        let rollout: RolloutDTO
        try {
            rollout = await new ArgoCdService(this.user).rollout(release.projectId, release.deploymentId, release.domainId)
        } catch (error) {
            if (late) throw error
            await DomainRelease.updateOne(current, { $set: { rollout: { since, applications: release.rollout?.applications ?? [], checkedAt: new Date(), error: errorOf(error).errorMessage } } })
            return
        }
        if (!rollout.tracked) {
            await DomainRelease.updateOne(current, { $set: deployed, $unset: { active: "", rollout: "" } })
            return
        }

        const now = new Date()
        const before = new Map((release.rollout?.applications ?? []).map(application => [application._id, application]))
        // Kept until it is healthy again: a crash loop goes from progressing to degraded and back
        const applications: IDomainReleaseRolloutApplication[] = rollout.applications.map(application => {
            const degradedAt = application.state === "healthy" ? undefined : (before.get(application._id)?.degradedAt ?? (application.state === "degraded" ? now : undefined))
            return degradedAt ? { ...application, degradedAt } : application
        })
        const snapshot: IDomainReleaseRollout = { since, applications, checkedAt: now }
        const fail = (code: string, message: string, names: RolloutApplication[]) =>
            failRelease(release, DomainReleaseStatus.ROLLING_OUT, createBusinessException({ code, message: `${message}: ${namesOf(names)}` }), undefined, snapshot)

        const built = new Set(release.members.filter(member => member.tagged).map(member => String(member._id)))
        const failed = applications.filter(application => application.state === "failed")
        if (failed.length > 0) return fail("DOMAIN_RELEASE_ROLLOUT_FAILED", `Argo CD could not apply version ${release.version}`, failed)
        const broken = applications.filter(application => built.has(application._id) && application.degradedAt && now.getTime() - new Date(application.degradedAt).getTime() > DEGRADED_GRACE_MS)
        if (broken.length > 0) return fail("DOMAIN_RELEASE_ROLLOUT_DEGRADED", `Version ${release.version} does not run, its pods are broken`, broken)
        // A member built must run the new version; the others need only be applied, broken as they may have been already
        const pending = applications.filter(application => (built.has(application._id) ? application.state !== "healthy" : ["waiting", "syncing", "progressing"].includes(application.state)))
        if (pending.length === 0) {
            await DomainRelease.updateOne(current, { $set: { ...deployed, rollout: snapshot }, $unset: { active: "" } })
            return
        }
        if (late) return fail("DOMAIN_RELEASE_ROLLOUT_TIMEOUT", `Version ${release.version} does not run yet after ${ROLLOUT_TIMEOUT_MS / 60_000} minutes`, pending)
        await DomainRelease.updateOne(current, { $set: { rollout: snapshot } })
    }

    /** Moves the release from `from` to `to`: false when another tick did it first, or it was failed meanwhile */
    private async claim(release: IDomainRelease, from: DomainReleaseStatus, to: DomainReleaseStatus): Promise<boolean> {
        const result = await DomainRelease.updateOne({ _id: release._id, status: from }, { $set: { status: to } })
        return result.modifiedCount > 0
    }

    /** The tagged members whose version the CI has not registered yet; those registered since the last tick are marked built */
    private async waitingFor(release: IDomainRelease): Promise<IDomainReleaseMember[]> {
        const pending = release.members.filter(member => member.tagged && !member.built)
        if (pending.length === 0) return []
        const idsOf = (kind: IDomainReleaseMember["kind"]) => pending.filter(member => member.kind === kind).map(member => member._id)
        const [frontends, backends] = await Promise.all([
            BuiltFrontend.find({ frontendId: { $in: idsOf("frontend") }, version: release.version }, { frontendId: 1 }),
            BuiltBackend.find({ backendId: { $in: idsOf("backend") }, version: release.version }, { backendId: 1 })
        ])
        const built = new Set([...frontends.map(entry => String(entry.frontendId)), ...backends.map(entry => String(entry.backendId))])
        if (built.size > 0) {
            const members = release.members.map(member => ({ ...member, built: member.built || built.has(String(member._id)) }))
            await DomainRelease.updateOne({ _id: release._id }, { $set: { members } })
        }
        return pending.filter(member => !built.has(String(member._id)))
    }

    /**
     * The members whose runs of the tag are all over, as the build status of the project shows them: `failed`
     * when they all failed or were canceled, `unregistered` when one succeeded but the version is still missing
     * {@link REGISTRATION_GRACE_MS} after the last one ended. A tag can start more than one workflow, and only
     * when none of them can still register the version is the wait over. Nothing when the providers cannot be
     * read: the timeout still ends the wait.
     */
    private async endedInCi(release: IDomainRelease, waiting: IDomainReleaseMember[]): Promise<{ failed: IDomainReleaseMember[]; unregistered: IDomainReleaseMember[] }> {
        const failed: IDomainReleaseMember[] = []
        const unregistered: IDomainReleaseMember[] = []
        try {
            const snapshot = await new BuildStatusService(this.user).getByProjectId(release.projectId)
            for (const member of waiting) {
                const row =
                    member.kind === "frontend"
                        ? snapshot.frontends.find(candidate => candidate.frontendId === String(member._id))
                        : snapshot.backends.find(candidate => candidate.backendId === String(member._id))
                const runs = row?.builds.filter(run => run.ref === release.version) ?? []
                if (runs.length === 0 || !runs.every(run => ENDED.includes(run.status))) continue
                if (runs.every(run => run.status !== BuildStatus.SUCCESS)) {
                    failed.push(member)
                    continue
                }
                // Without the end of every run there is no telling the grace is over: the timeout decides
                const endedAt = runs.map(run => (run.finishedAt ? new Date(run.finishedAt).getTime() : Number.NaN))
                if (endedAt.every(Number.isFinite) && Date.now() - Math.max(...endedAt) > REGISTRATION_GRACE_MS) {
                    unregistered.push(member)
                }
            }
        } catch (error) {
            fastify.log.warn({ err: error, releaseId: String(release._id) }, "Unable to read the build status of a domain release")
        }
        return { failed, unregistered }
    }

    /**
     * Sets the version of the release on every member it built, a BUNDLE frontend as a DOCKER one and a backend:
     * the release decides the version, unlike a CI registration that moves it only to a newer one. A member
     * taken out of the domain since is left alone, the deploy of the domain no longer ships it.
     */
    private async updateVersions(release: IDomainRelease) {
        const idsOf = (kind: IDomainReleaseMember["kind"]) => release.members.filter(member => member.kind === kind && member.tagged).map(member => member._id)
        const inDomain = { projectId: release.projectId, domainId: release.domainId }
        // A container runs it in the environment of the release, in place of the version it had there
        // An aggregation pipeline is not cast by mongoose: an ObjectId, or the entry of the environment would never match
        const environmentId = new Types.ObjectId(String(release.environmentId))
        const inEnvironment = [
            {
                $set: {
                    version: release.version,
                    environmentVersions: {
                        $concatArrays: [
                            { $filter: { input: { $ifNull: ["$environmentVersions", []] }, cond: { $ne: ["$$this.environmentId", environmentId] } } },
                            [{ environmentId, version: release.version }]
                        ]
                    }
                }
            }
        ]
        await Frontend.updateMany({ _id: { $in: idsOf("frontend") }, ...inDomain, kind: { $ne: FrontendKind.DOCKER } }, { $set: { version: release.version } })
        await Frontend.updateMany({ _id: { $in: idsOf("frontend") }, ...inDomain, kind: FrontendKind.DOCKER }, inEnvironment, { updatePipeline: true })
        await Backend.updateMany({ _id: { $in: idsOf("backend") }, ...inDomain }, inEnvironment, { updatePipeline: true })
    }
}

/**
 * Moves on every release that is not over, each as the user who started it. Run by the release tick of every
 * instance of the backend: the steps are claimed in the database, never taken twice.
 */
export const advanceDomainReleases = async (): Promise<void> => {
    const releases = await DomainRelease.find({ status: { $in: ACTIVE_STATUSES } }).lean<IDomainRelease[]>()
    for (const release of releases) {
        const user = await User.findById(release.startedBy)
        if (!user || user.status === UserStatus.DISABLED) {
            await failRelease(
                release,
                release.status as DomainReleaseStep,
                createBusinessException({ code: "DOMAIN_RELEASE_USER_UNAVAILABLE", message: "The user who started the release can no longer act in the console" })
            )
            continue
        }
        await new DomainReleaseService({ ...user.toObject() } as AuthorizedPrincipal).advance(release)
    }
}

export default DomainReleaseService
