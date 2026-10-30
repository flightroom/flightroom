import { FastifyRequest } from "fastify"
import { ObjectId, Schema } from "mongoose"
import DeploymentToCanaryUsers from "../../models/DeploymentsToCanaryUsersModel"
import { IEnvironment } from "../../models/EnvironmentModel"
import { CanaryDeploymentType, CanaryType, IFrontend } from "../../models/FrontendModel"
import Project from "../../models/ProjectModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { FrontendAdaptedToServe } from "./serveTypes"
import { buildFrontendAdaptedToServe, getFrontendUrl, getFrontendUrlCanary, getFrontendUrlStatic, isDocker } from "./serveUrls"

/** Query parameter forcing a specific version, to test a canary without waiting for the draw. */
const FORCE_VERSION_QUERY_PARAM = "mfeVersion"

/**
 * Query parameters carrying the identities a canary decision can be based on.
 *
 * They travel in the URL, not in a cookie: frontends are loaded with a cross site `import()`,
 * and module scripts are fetched with a fixed `same-origin` credentials mode, so no cookie of the
 * console domain is ever sent along with them (nor is any Set-Cookie of ours stored). The host page
 * is the only place holding this state, and the only way to hand it over is the URL.
 *
 * The host page sends every identity it holds and never learns which one we use, so the rollout
 * strategy, its percentage and even its existence stay on this side: switching a frontend from
 * one strategy to another takes no change at all on the host page.
 *
 * ON_SESSION buckets on the device id, which the SDK keeps in localStorage so that the version a
 * browser was given survives a restart. ON_USER looks the user id up in the enrolment list, and
 * RANDOM reads neither. The session id is still accepted, and still sent by the SDK for telemetry,
 * but no canary strategy is computed on it.
 */
const DEVICE_ID_QUERY_PARAM = "mfeDeviceId"
const USER_ID_QUERY_PARAM = "mfeUserId"

/** Number of buckets an identity is hashed into, one per percentage point. */
const CANARY_BUCKETS = 100

/**
 * FNV-1a: cheap, dependency free and stable across processes, which is what makes the decision
 * sticky without storing anything server side.
 * Bucketing by hash also keeps a rollout monotonic: raising the percentage only adds browsers to
 * the canary, it never moves someone who was already on it back to the stable version.
 */
const hashToBucket = (value: string): number => {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0) % CANARY_BUCKETS
}

/**
 * A canary changes which files we serve only when it rolls out a version of ours. One based on an
 * external url never reaches this service: the manifest hands that url straight to the host page,
 * and its version has no deployed folder here to be served from.
 *
 * It is also when the version must be drawn once and then pinned in the URL: the entrypoint is an ES
 * module whose chunks are imported with relative specifiers, so the browser resolves them against the
 * entrypoint final URL. Drawing again on every chunk would mix two versions in the same page.
 */
export const isVersionCanary = (frontend: IFrontend): boolean => {
    const canary = frontend.canary
    return Boolean(canary?.enabled && canary.version && canary.deploymentType === CanaryDeploymentType.BASED_ON_VERSION)
}

/**
 * The only versions a caller is ever allowed to ask for: anything else, even coming from one of
 * our own URLs, would let the request walk out of the deployed folders.
 */
const getServableVersions = (frontend: IFrontend): string[] => {
    const canaryVersion = isVersionCanary(frontend) ? frontend.canary?.version : undefined
    return canaryVersion ? [frontend.version, canaryVersion] : [frontend.version]
}

/** Decides which version of a frontend a request gets, from the canary of the frontend and what the query string carries */
export default class FrontendVersionResolver {
    /** @param request Fastify request being served, used to read the version override and the identities */
    constructor(private readonly request?: FastifyRequest) {}

    private getQueryParam(name: string): string | undefined {
        const query = this.request?.query as Record<string, string | undefined> | undefined
        const value = query?.[name]
        return typeof value === "string" && value.length > 0 ? value : undefined
    }

    /**
     * Version explicitly requested through the query string, ignored unless it is one of the versions
     * this deployment can serve.
     */
    private getForcedVersion(frontend: IFrontend): string | undefined {
        const forcedVersion = this.getQueryParam(FORCE_VERSION_QUERY_PARAM)
        return forcedVersion && getServableVersions(frontend).includes(forcedVersion) ? forcedVersion : undefined
    }

    /**
     * Draws the canary. Called from the two places where a version gets decided — the manifest and the
     * redirect of a versionless entrypoint — and nowhere else: every other file of the frontend
     * reads its version off the URL through getVersionToServe, so one page load runs one build.
     */
    async getFrontendVersion(deployedFrontend: IFrontend, deploymentId?: string | ObjectId | Schema.Types.ObjectId): Promise<string> {
        const forcedVersion = this.getForcedVersion(deployedFrontend)
        if (forcedVersion) {
            return forcedVersion
        }

        if (!isVersionCanary(deployedFrontend)) {
            return deployedFrontend.version
        }

        const isCanary = await this.isCanary(deployedFrontend, deploymentId)
        return isCanary && deployedFrontend.canary?.version ? deployedFrontend.canary.version : deployedFrontend.version
    }

    /**
     * Decide whether this request belongs to the canary, according to how the canary is configured.
     *
     * The three strategies answer two different questions. RANDOM and ON_SESSION split traffic by
     * percentage and differ only in stickiness — a draw per request against a draw per browser, held
     * by hashing an identity the host page sends. ON_USER does not split anything: the percentage is
     * ignored and only the users enrolled on the deployment see the canary.
     *
     * The host page sends every identity it holds and is never told which one is used, so switching a
     * frontend from one strategy to another takes no change at all on its side.
     */
    private async isCanary(frontend: IFrontend, deploymentId?: string | ObjectId | Schema.Types.ObjectId): Promise<boolean> {
        switch (frontend.canary?.type) {
            // Nothing is remembered, so a reload draws again: the point is to exercise both versions on
            // the same browser, not to keep anyone on one of them.
            case CanaryType.RANDOM:
                return Math.random() * CANARY_BUCKETS < (frontend.canary?.percentage || 0)
            // The device id lives in the localStorage of the host page, so it outlives the browser and
            // this machine keeps the version it was given across restarts.
            case CanaryType.ON_SESSION:
                return this.isIdInCanaryBucket(frontend, this.getQueryParam(DEVICE_ID_QUERY_PARAM))
            case CanaryType.ON_USER:
                return this.isUserInCanary(frontend, deploymentId)
            default:
                return false
        }
    }

    /**
     * Bucket the identity the host page sent us. Without it the decision cannot be sticky, so it falls
     * back to a plain draw: consistent within the page load, since the version gets pinned in the URL
     * right after, but drawn again on the next one.
     */
    private isIdInCanaryBucket(frontend: IFrontend, id?: string): boolean {
        const percentage = frontend.canary?.percentage || 0
        if (!id) {
            return Math.random() * CANARY_BUCKETS < percentage
        }
        return hashToBucket(`${id}:${frontend._id.toString()}`) < percentage
    }

    /**
     * ON_USER is an explicit enrolment, not a split: a user sees the canary only when the deployment
     * carries a row enabling them, and everybody else — including every anonymous visitor, who has no
     * `mfeUserId` to look up — gets the stable version. The percentage plays no part here.
     *
     * Enrolment is stored per deployment and leaves frontendId unset, so a row covers every canary
     * frontend of that deployment. A row scoped to one frontend is still honoured and wins
     * over the deployment wide one, which is what sorting by frontendId descending gives us: an
     * ObjectId sorts after null in Mongo.
     */
    private async isUserInCanary(frontend: IFrontend, deploymentId?: string | ObjectId | Schema.Types.ObjectId): Promise<boolean> {
        const userId = this.getQueryParam(USER_ID_QUERY_PARAM)
        if (!userId || !deploymentId) {
            return false
        }
        const enrolment = await DeploymentToCanaryUsers.findOne({
            deploymentId: toObjectId(deploymentId),
            userId,
            $or: [{ frontendId: frontend._id }, { frontendId: null }, { frontendId: { $exists: false } }]
        }).sort({ frontendId: -1 })
        return Boolean(enrolment?.enabled)
    }

    /**
     * The version the bytes of one file must come from — read from the URL, never drawn.
     *
     * A frontend is many files, and they all have to come from the same build. The draw therefore
     * happens exactly once, on the entrypoint, and its result is pinned into the URL as a
     * `_v/<version>/` segment that every other file of that frontend inherits, because chunks are
     * imported with relative specifiers and the browser resolves them against the entrypoint URL.
     *
     * So a file arriving here without a version has not come through a resolved entrypoint: it is a
     * host holding a raw url, or a classic script that computed its chunk base before the redirect.
     * Drawing again for it is exactly the wrong answer — with a RANDOM canary every asset would flip
     * its own coin and one page would end up running two builds at once. The deployed version is the
     * only coherent thing to serve, and `mfeVersion` stays available to ask for the other one.
     */
    getVersionToServe(frontend: IFrontend, versionFromUrl?: string): string {
        if (versionFromUrl && getServableVersions(frontend).includes(versionFromUrl)) {
            return versionFromUrl
        }
        return this.getForcedVersion(frontend) ?? frontend.version
    }

    /**
     * Turn a deployed frontend into what the host page needs to load it.
     *
     * The canary is resolved right here, so the url handed out already points at the chosen version and
     * the host page has nothing to decide, nothing to store about the rollout and no way to tell one
     * strategy from another.
     */
    async adaptFrontendToServe(
        frontend: IFrontend,
        environment: Pick<IEnvironment, "_id" | "slug" | "projectId" | "subdomain" | "isProduction">,
        deploymentId?: string | ObjectId | Schema.Types.ObjectId
    ): Promise<FrontendAdaptedToServe> {
        const environmentSlug = environment.slug
        // Its own container serves it at the URL of that environment, and nothing of ours draws a canary for it.
        // A DOCKER is never a remote, so this is a lookup of that one frontend: one query for the domain, not one per remote
        if (isDocker(frontend)) {
            const project = frontend.exposurePath ? await Project.findById(environment.projectId, { exposure: 1 }) : null
            return buildFrontendAdaptedToServe(frontend, getFrontendUrl(frontend, environment, project?.exposure))
        }
        if (!frontend.canary?.enabled) {
            return buildFrontendAdaptedToServe(frontend, getFrontendUrlStatic(frontend, environmentSlug))
        }

        // A canary rolling out a version of ours does not change the url, only which version it is
        // pinned to. Resolving it through getFrontendVersion keeps this a single draw and honours
        // the version override as well.
        if (isVersionCanary(frontend)) {
            const servedVersion = await this.getFrontendVersion(frontend, deploymentId)
            return buildFrontendAdaptedToServe(frontend, getFrontendUrlStatic(frontend, environmentSlug, servedVersion), servedVersion)
        }

        // A canary pointing at an external url has no version of ours to pin: the url is the decision
        const isCanary = await this.isCanary(frontend, deploymentId)
        return buildFrontendAdaptedToServe(frontend, isCanary ? getFrontendUrlCanary(frontend) : getFrontendUrlStatic(frontend, environmentSlug))
    }
}
