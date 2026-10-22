import axios from "axios"
import { FastifyReply, FastifyRequest } from "fastify"
import fs from "fs"
import { ObjectId, Schema } from "mongoose"
import path from "path"
import Stream from "stream"
import { fastify } from ".."
import AzureStorageClient from "../client/AzureStorageAccount"
import GoogleStorageClient from "../client/GoogleStorageAccount"
import S3BucketClient from "../client/S3Buckets"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { EnvironmentNotFoundError } from "../errors/EnvironmentNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import Deployment, { IDeployment } from "../models/DeploymentModel"
import DeploymentToCanaryUsers from "../models/DeploymentsToCanaryUsersModel"
import Environment, { IEnvironment } from "../models/EnvironmentModel"
import Frontend, { CanaryDeploymentType, CanaryType, FrontendKind, FrontendType, HostedOn, IFrontend } from "../models/FrontendModel"
import { IGlobalVariable } from "../models/GlobalVariableModel"
import Project, { IProject } from "../models/ProjectModel"
import { IStorage, StorageType } from "../models/StorageModel"
import { effectiveSubdomain, exposedOrigin } from "../types/Exposure"
import { FrontendCompiler, FrontendFramework, FrontendStackSource, parseCompiler, parseFramework } from "../types/FrontendStack"
import { getBackendUrl } from "../utils/backendUrl"
import { toObjectId } from "../utils/mongooseUtils"
import DeploymentService from "./DeploymentService"
import FederationConfigService, { federationName, IntegrationInstructions } from "./FederationConfigService"

interface GetRemotesRequestDTO {
    frontendId: string | ObjectId
    deploymentId?: string | ObjectId
    environmentId?: string | ObjectId
}

export interface GetRemotesResponseDTO {
    filteredFrontends: IFrontend[]
    environment: IEnvironment
    frontend: IFrontend
    deployment: IDeployment
}

export interface GetFrontendAdaptedDataDTO extends GetRemotesResponseDTO {
    microfrotnedUrls: FrontendAdaptedToServe[]
}

export interface FrontendAdaptedToServe {
    url: string
    slug: string
    continuousDeployment?: boolean
    version: string
    name: string
    nameToIntegrate: string
}

export interface GetAllDataDTO {
    globalVariables?: IGlobalVariable[]
    /** Under its old name: the host applications read it through the client SDK */
    microfrontends?: FrontendAdaptedToServe[]
}

export interface StreamWithHeader {
    stream: Stream
    headers: Record<string, string>
}

/**
 * Asks the caller to retry on a URL carrying the resolved version, instead of returning content.
 * See getFrontendByDeployment for why the entrypoint of a canary frontend needs it.
 */
export interface RedirectToVersion {
    redirectToVersion: string
    headers: Record<string, string>
}

export type ServeFileResult = StreamWithHeader | RedirectToVersion

export const isRedirectToVersion = (result: ServeFileResult): result is RedirectToVersion => "redirectToVersion" in result

//NOTE: Here we need speed so please do not use any third party service

const HEADERS_NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "cross-origin-resource-policy": "cross-origin"
}

const HEADERS_CACHE = {
    "Cross-Origin-Resource-Policy": "cross-origin"
}

/** Path segment marking the version inside a frontend file URL, ex. `/_v/1.4.0/assets/index.js`. */
export const VERSION_PATH_SEGMENT = "_v"

/** Response header telling the caller which version has actually been served. */
const VERSION_HEADER = "x-mfe-version"

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
 * Client SDK the generated configs delegate the resolution of a remote to.
 *
 * The bundler config never carries a url of ours: it carries a bare specifier that the host bundler
 * resolves against its own node_modules, so the url is asked for at import time and comes from the
 * manifest, already pinned to the version this browser must get. That is what keeps the canary
 * decision on this side: a config with a static url would freeze one version into the host bundle.
 */

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

interface CodeIntegrationRequestDTO extends GetRemotesRequestDTO {
    /** Framework override, defaulting to the stack stored on the frontend */
    framework?: string
    /** Bundler override, defaulting to the stack stored on the frontend */
    compiler?: string
}

interface CodeIntegrationResponseDTO extends IntegrationInstructions {
    /** The stack the instructions were generated for, so the screen can say which one it picked */
    stack: {
        framework?: FrontendFramework
        compiler?: FrontendCompiler
        source?: FrontendStackSource
    }
}

export default class ServeService {
    /**
     * @param request Fastify request being served, used to read the version override
     * @param reply Fastify reply being served, used to expose the version actually served
     */
    constructor(
        private readonly request?: FastifyRequest,
        private readonly reply?: FastifyReply
    ) {}

    /**
     * A canary changes which files we serve only when it rolls out a version of ours. One based on an
     * external url never reaches this service: the manifest hands that url straight to the host page,
     * and its version has no deployed folder here to be served from.
     */
    private isVersionCanary(frontend: IFrontend): boolean {
        const canary = frontend.canary
        return Boolean(canary?.enabled && canary.version && canary.deploymentType === CanaryDeploymentType.BASED_ON_VERSION)
    }

    /**
     * The only versions a caller is ever allowed to ask for: anything else, even coming from one of
     * our own URLs, would let the request walk out of the deployed folders.
     */
    private getServableVersions(frontend: IFrontend): string[] {
        const canaryVersion = this.isVersionCanary(frontend) ? frontend.canary?.version : undefined
        return canaryVersion ? [frontend.version, canaryVersion] : [frontend.version]
    }

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
        return forcedVersion && this.getServableVersions(frontend).includes(forcedVersion) ? forcedVersion : undefined
    }

    async getRemotes({ frontendId, environmentId, deploymentId }: GetRemotesRequestDTO): Promise<GetRemotesResponseDTO> {
        let deployment: IDeployment | null = null
        if (deploymentId) {
            deployment = await new DeploymentService().getById(deploymentId)
        } else if (environmentId) {
            deployment = await new DeploymentService().getLastByEnvironmentIdNoAccessCheck(environmentId)
        }
        if (!deployment) {
            throw new EntityNotFoundError(deploymentId?.toString() || "")
        }
        const frontend = deployment.frontends?.find(mfe => mfe._id.toString() === frontendId?.toString())
        if (!frontend) {
            throw new EntityNotFoundError(frontendId?.toString())
        }

        const environment = await Environment.findById(deployment.environmentId)
        if (!environment) {
            throw new EnvironmentNotFoundError(deployment.environmentId?.toString())
        }

        const filteredFrontends = deployment.frontends?.filter(mfe => mfe.parentIds?.some(parentId => parentId.toString() === frontendId?.toString())) || []

        return {
            filteredFrontends,
            environment,
            frontend,
            deployment
        }
    }

    async getFrontendAdaptedData({ frontendId, environmentId, deploymentId }: GetRemotesRequestDTO): Promise<GetFrontendAdaptedDataDTO> {
        const data = await this.getRemotes({ frontendId, environmentId, deploymentId })
        const childs = await Promise.all(data.filteredFrontends.map(child => this.adaptFrontendToServe(child, data.environment, data.deployment._id)))

        return {
            ...data,
            microfrotnedUrls: childs
        }
    }

    /**
     * The integration instructions of a frontend, generated for the stack it is actually
     * built with. `framework` and `compiler` only override what is stored on it, so the screen
     * can still show another stack on request.
     */
    async getCodeIntegration({ framework, compiler, frontendId, deploymentId }: CodeIntegrationRequestDTO): Promise<CodeIntegrationResponseDTO> {
        const allData = await this.getRemotes({ frontendId, deploymentId })

        const childs = await Promise.all(allData.filteredFrontends.map(child => this.adaptFrontendToServe(child, allData.environment, allData.deployment._id)))

        const stored = allData.frontend.stack
        const stack = {
            framework: parseFramework(framework) || stored?.framework,
            compiler: parseCompiler(compiler) || stored?.compiler,
            source: stored?.source
        }

        const instructions = new FederationConfigService().getInstructions({
            framework: stack.framework,
            compiler: stack.compiler,
            frontendSlug: allData.frontend.slug,
            exposeSelf: allData.frontend.type === FrontendType.HOST,
            remotes: childs.map((child, index) => ({ name: child.nameToIntegrate || `mfe${index + 1}`, slug: child.slug })),
            projectId: allData.frontend.projectId.toString(),
            backendUrl: getBackendUrl()
        })

        return { ...instructions, stack }
    }

    /**
     * Get all frontends by environment ID
     * @param environmentId The ID of the environment
     * @returns Promise with array of Frontend objects
     */
    async getAllByEnvironmentId(environmentId: string | Schema.Types.ObjectId): Promise<GetAllDataDTO> {
        const deployment = await Deployment.findOne({ environmentId: toObjectId(environmentId), active: true })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        const environment = await Environment.findById(environmentId)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentId.toString())
        }

        // A DOCKER is never a remote, so no host loads it from the manifest
        const frontendsAdapted = deployment.frontends
            ? await Promise.all(deployment.frontends.filter(frontend => !isDocker(frontend)).map(frontend => this.adaptFrontendToServe(frontend, environment, deployment._id)))
            : undefined

        return {
            globalVariables: deployment.variables,
            microfrontends: frontendsAdapted
        }
    }

    /**
     * Find an environment by project ID and slug, ignoring case.
     * Collation strength 2 makes "dev", "Dev" and "DEV" resolve to the same environment,
     * so the URLs used to serve the frontends do not have to match the stored casing.
     * @param projectId The ID of the project
     * @param environmentSlug The slug of the environment
     * @returns Promise with Environment object or null if not found
     */
    private findEnvironmentByProjectIdAndSlug(projectId: string | ObjectId | Schema.Types.ObjectId, environmentSlug: string): Promise<IEnvironment | null> {
        return Environment.findOne({ slug: environmentSlug, projectId: toObjectId(projectId) }).collation({ locale: "en", strength: 2 })
    }

    /**
     * Get all frontends by project ID and environment slug
     * @param projectId The ID of the project
     * @param environmentSlug The slug of the environment
     * @returns Promise with array of Frontend objects
     */
    async getAllByProjectIdAndEnvironmentSlug(projectId: string, environmentSlug: string): Promise<GetAllDataDTO> {
        const environment = await this.findEnvironmentByProjectIdAndSlug(projectId, environmentSlug)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentSlug)
        }
        return this.getAllByEnvironmentId(environment._id)
    }

    /**
     * Resolve the environment a request belongs to from the domain it comes from.
     *
     * This is what lets the "auto" URLs work: the host page only knows its own project, the environment
     * is a deployment detail it should not have to configure, so it is derived from the domains
     * registered on the environment itself.
     * @param referer The referer (or host) of the request
     * @param projectId The ID of the project
     * @returns Promise with the Environment the referer belongs to
     */
    private async getEnvironmentByRefererAndProjectIdOrFail(referer: string, projectId: string | Schema.Types.ObjectId): Promise<IEnvironment> {
        const environment = await this.getEnvironmentFomRefererAndProjectId(referer, projectId)
        if (!environment) {
            throw EnvironmentNotFoundError.fromDomain(referer, projectId.toString())
        }
        return environment
    }

    /**
     * Same payload as getAllByProjectIdAndEnvironmentSlug, with the environment resolved from the referer.
     * @param projectId The ID of the project
     * @param referer The referer (or host) of the request
     * @returns Promise with array of Frontend objects
     */
    async getAllByProjectIdAndReferer(projectId: string, referer: string): Promise<GetAllDataDTO> {
        const environment = await this.getEnvironmentByRefererAndProjectIdOrFail(referer, projectId)
        return this.getAllByEnvironmentId(environment._id)
    }

    /**
     * Get frontend by frontend ID
     * @param mfeId The ID of the frontend
     * @param referer The referer of the request
     * @returns Promise with Frontend object or null if not found
     */
    async getFrontendConfigurationByFrontendId(mfeId: string, referer: string): Promise<FrontendAdaptedToServe> {
        const frontend = await Frontend.findById(mfeId)
        if (!frontend) {
            throw new EntityNotFoundError(mfeId)
        }
        const environment = await this.getEnvironmentByRefererAndProjectIdOrFail(referer, frontend.projectId)
        const deployment = await Deployment.findOne({ environmentId: environment._id, active: true }).sort({ createdAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        const deployedMFE = deployment.frontends?.find(mfe => mfe._id.toString() === mfeId)
        if (!deployedMFE) {
            throw new EntityNotFoundError(mfeId)
        }
        return await this.adaptFrontendToServe(deployedMFE, environment, deployment._id)
    }

    /**
     * Get frontend by project ID and environment slug
     * @param projectId The ID of the project
     * @param environmentSlug The slug of the environment
     * @param mfeSlug The slug of the frontend
     * @returns Promise with Frontend object or null if not found
     */
    async getFrontendConfigurationByProjectIdEnvironmentSlugAndMfeSlug(projectId: string, environmentSlug: string, mfeSlug: string): Promise<FrontendAdaptedToServe> {
        const environment = await this.findEnvironmentByProjectIdAndSlug(projectId, environmentSlug)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentSlug)
        }
        return this.getFrontendConfigurationByEnvironmentAndMfeSlug(environment, mfeSlug)
    }

    /**
     * Same payload as getFrontendConfigurationByProjectIdEnvironmentSlugAndMfeSlug, with the
     * environment resolved from the referer.
     * @param projectId The ID of the project
     * @param mfeSlug The slug of the frontend
     * @param referer The referer (or host) of the request
     * @returns Promise with Frontend object
     */
    async getFrontendConfigurationByProjectIdRefererAndMfeSlug(projectId: string, mfeSlug: string, referer: string): Promise<FrontendAdaptedToServe> {
        const environment = await this.getEnvironmentByRefererAndProjectIdOrFail(referer, projectId)
        return this.getFrontendConfigurationByEnvironmentAndMfeSlug(environment, mfeSlug)
    }

    /**
     * Everything the two lookups above have in common, once the environment has been resolved: how the
     * environment was found must not change what is served.
     */
    private async getFrontendConfigurationByEnvironmentAndMfeSlug(environment: IEnvironment, mfeSlug: string): Promise<FrontendAdaptedToServe> {
        const deployment = await Deployment.findOne({ environmentId: environment._id, active: true }).sort({ createdAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        const deployedMFE = deployment.frontends?.find(mfe => mfe.slug === mfeSlug)
        if (!deployedMFE) {
            throw new EntityNotFoundError(mfeSlug)
        }
        return await this.adaptFrontendToServe(deployedMFE, environment, deployment._id)
    }

    async getFrontendConfigurationByEnvironmentIdAndMfeSlug(environmentId: string, mfeSlug: string): Promise<FrontendAdaptedToServe> {
        const deployment = await Deployment.findOne({ environmentId: toObjectId(environmentId), active: true })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        const deployedMFE = deployment.frontends?.find(mfe => mfe.slug === mfeSlug)
        if (!deployedMFE) {
            throw new EntityNotFoundError(mfeSlug)
        }
        const environment = await Environment.findById(environmentId)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentId.toString())
        }
        return await this.adaptFrontendToServe(deployedMFE, environment, deployment._id)
    }

    /**
     * Get global variables by environment ID
     * @param environmentId The ID of the environment
     * @returns Promise with global variables object
     */
    async getGlobalVariablesByEnvironmentId(environmentId: string): Promise<{ key: string; value: string }[]> {
        const deployment = await Deployment.findOne({ environmentId: toObjectId(environmentId), active: true })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        return deployment.variables?.map(v => ({ key: v.key, value: v.value })) || []
    }

    async getGlobalVariablesByEnvironmentIdFile(environmentId: string): Promise<string> {
        return this.renderGlobalVariablesFile(await this.getGlobalVariablesByEnvironmentId(environmentId))
    }

    /**
     * The JS flavour of the global variables, shared by every URL exposing them as a file so that they
     * all hand the host page the very same global.
     */
    private renderGlobalVariablesFile(variables: { key: string; value: string }[]): string {
        const fileData = `window.globalConfig = {
  ${variables.map(v => `"${v.key}": "${v.value}"`).join(",\n  ")}
}`
        return fileData
    }

    /**
     * Get global variables by project ID and environment slug
     * @param projectId The ID of the project
     * @param environmentSlug The slug of the environment
     * @returns Promise with global variables object
     */
    async getGlobalVariablesByProjectIdAndEnvironmentSlug(projectId: string, environmentSlug: string): Promise<IGlobalVariable[]> {
        const environment = await this.findEnvironmentByProjectIdAndSlug(projectId, environmentSlug)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentSlug)
        }
        return this.getGlobalVariablesByEnvironment(environment)
    }

    /**
     * Same payload as getGlobalVariablesByProjectIdAndEnvironmentSlug, with the environment resolved
     * from the referer.
     * @param projectId The ID of the project
     * @param referer The referer (or host) of the request
     * @returns Promise with global variables object
     */
    async getGlobalVariablesByProjectIdAndReferer(projectId: string, referer: string): Promise<IGlobalVariable[]> {
        const environment = await this.getEnvironmentByRefererAndProjectIdOrFail(referer, projectId)
        return this.getGlobalVariablesByEnvironment(environment)
    }

    /**
     * The JS file flavour of getGlobalVariablesByProjectIdAndReferer, for the host pages loading the
     * global variables with a plain script tag.
     * @param projectId The ID of the project
     * @param referer The referer (or host) of the request
     * @returns Promise with the content of the global variables file
     */
    async getGlobalVariablesByProjectIdAndRefererFile(projectId: string, referer: string): Promise<string> {
        return this.renderGlobalVariablesFile(await this.getGlobalVariablesByProjectIdAndReferer(projectId, referer))
    }

    private async getGlobalVariablesByEnvironment(environment: IEnvironment): Promise<IGlobalVariable[]> {
        const deployment = await Deployment.findOne({ environmentId: environment._id, active: true }).sort({ createdAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        return deployment.variables || []
    }

    /**
     * Get frontend by environment slug, project ID, and frontend slug
     * @param environmentSlug The slug of the environment
     * @param projectId The ID of the project
     * @param frontendSlug The slug of the frontend
     * @returns Promise with Frontend object or null if not found
     */
    async getByEnvironmentSlugAndProjectIdAndFrontendSlug(environmentSlug: string, projectId: string, frontendSlug: string, filePath: string, version?: string): Promise<ServeFileResult> {
        const projectIdObj = toObjectId(projectId)
        const environment = await this.findEnvironmentByProjectIdAndSlug(projectIdObj, environmentSlug)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentSlug)
        }

        const project = await Project.findOne({ _id: projectIdObj })
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }

        const deployment = await Deployment.findOne({ environmentId: environment._id }).sort({ deployedAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        return this.getFrontendByDeployment(project, deployment, frontendSlug, filePath, version)
    }

    async getFrontendFilesByProjectIdAndFrontendSlug(projectId: string, frontendSlug: string, filePath: string, referer: string, version?: string): Promise<ServeFileResult> {
        const project = await Project.findById(projectId)
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }

        const environment = await this.getEnvironmentByRefererAndProjectIdOrFail(referer, projectId)

        const deployment = await Deployment.findOne({ environmentId: environment._id }).sort({ createdAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        return this.getFrontendByDeployment(project, deployment, frontendSlug, filePath, version)
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

        if (!this.isVersionCanary(deployedFrontend)) {
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
    private getVersionToServe(frontend: IFrontend, versionFromUrl?: string): string {
        if (versionFromUrl && this.getServableVersions(frontend).includes(versionFromUrl)) {
            return versionFromUrl
        }
        return this.getForcedVersion(frontend) ?? frontend.version
    }

    /**
     * True when the version must be drawn once and then pinned in the URL: the entrypoint is an ES
     * module whose chunks are imported with relative specifiers, so the browser resolves them against
     * the entrypoint final URL. Drawing again on every chunk would mix two versions in the same page.
     */
    private needsVersionInUrl(frontend: IFrontend): boolean {
        return this.isVersionCanary(frontend)
    }

    /**
     * Turn a deployed frontend into what the host page needs to load it.
     *
     * The canary is resolved right here, so the url handed out already points at the chosen version and
     * the host page has nothing to decide, nothing to store about the rollout and no way to tell one
     * strategy from another.
     */
    private async adaptFrontendToServe(
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
        if (this.isVersionCanary(frontend)) {
            const servedVersion = await this.getFrontendVersion(frontend, deploymentId)
            return buildFrontendAdaptedToServe(frontend, getFrontendUrlStatic(frontend, environmentSlug, servedVersion), servedVersion)
        }

        // A canary pointing at an external url has no version of ours to pin: the url is the decision
        const isCanary = await this.isCanary(frontend, deploymentId)
        return buildFrontendAdaptedToServe(frontend, isCanary ? getFrontendUrlCanary(frontend) : getFrontendUrlStatic(frontend, environmentSlug))
    }

    /**
     * Serve a single file of a frontend.
     * @param version Version to serve, taken from the URL. When missing and the frontend needs a
     * pinned version, the caller is redirected to the same file under the drawn version.
     */
    async getFrontendByDeployment(project: IProject, deployment: IDeployment, frontendSlug: string, filePath: string, version?: string): Promise<ServeFileResult> {
        const frontend = deployment.frontends?.find(mfe => mfe.slug === frontendSlug)
        // A DOCKER has no files here: its own container serves them
        if (!frontend || isDocker(frontend)) {
            throw new EntityNotFoundError(frontendSlug)
        }

        //Adesso tiro fuori il MFE
        const mfeEntryPoint = frontend.host.entryPoint || "index.js"
        const isEntryPoint = filePath.includes(mfeEntryPoint)

        if (!version && isEntryPoint && this.needsVersionInUrl(frontend)) {
            return {
                headers: HEADERS_NO_CACHE,
                redirectToVersion: await this.getFrontendVersion(frontend, deployment._id)
            }
        }

        const versionToServe = this.getVersionToServe(frontend, version)
        const headers = { ...(isEntryPoint ? HEADERS_NO_CACHE : HEADERS_CACHE), [VERSION_HEADER]: versionToServe }

        switch (frontend.host.type) {
            case HostedOn.CUSTOM_SOURCE: {
                const storage = this.getStorage(frontend, deployment)
                if (!storage) {
                    throw new Error("Storage not found for frontend " + frontend.slug)
                }
                return {
                    headers,
                    stream: await this.getFrontendStreamStorage(project, frontendSlug, versionToServe, filePath, storage)
                }
            }
            case HostedOn.CUSTOM_URL:
                if (!frontend.host.url) {
                    throw new Error("Frontend url is not defined from frontend " + frontend.slug)
                }
                return {
                    headers,
                    stream: await this.getFrontendStreamCustomUrl(project, frontendSlug, versionToServe, filePath, frontend.host.url)
                }
            case HostedOn.MFE_ORCHESTRATOR_HUB:
                return {
                    headers,
                    stream: await this.getFrontendStreamLocal(project, frontendSlug, versionToServe, filePath)
                }
        }
    }

    getStorage(frontend: IFrontend, deployment: IDeployment): IStorage | undefined {
        if (!frontend.host) return undefined
        if (frontend.host.type === HostedOn.CUSTOM_SOURCE && frontend.host.storageId) {
            const storageId = frontend.host.storageId.toString()
            return deployment.storages?.find(s => storageId === s._id.toString())
        }
        return undefined
    }

    async getFrontendFilesByFrontendId(mfeId: string, filePath: string, referer: string, version?: string): Promise<ServeFileResult> {
        const frontend = await Frontend.findById(mfeId)
        if (!frontend) {
            throw new EntityNotFoundError(mfeId)
        }
        const environment = await this.getEnvironmentByRefererAndProjectIdOrFail(referer, frontend.projectId)
        const project = await Project.findById(environment.projectId)
        if (!project) {
            throw new ProjectNotFoundError(environment.projectId.toString())
        }

        const deployment = await Deployment.findOne({ environmentId: environment._id }).sort({ createdAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        const deployedMFE = deployment.frontends?.find(mfe => mfe._id.toString() === mfeId)
        if (!deployedMFE) {
            throw new EntityNotFoundError(mfeId)
        }

        return this.getFrontendByDeployment(project, deployment, deployedMFE.slug, filePath, version)
    }

    getFrontendStreamLocal(project: IProject, frontendSlug: string, version: string, filePath: string): Stream {
        const basePath = path.join(fastify.config.MICROFRONTEND_HOST_FOLDER, project.slug + "-" + project._id.toString(), frontendSlug, version)
        if (!fs.existsSync(basePath)) {
            throw new Error("Frontend file not found in path " + basePath)
        }

        const finalPath = path.join(basePath, filePath)

        if (!fs.existsSync(finalPath)) {
            throw new Error("File not found for path: " + finalPath)
        }

        return fs.createReadStream(finalPath)
    }

    async getFrontendStreamCustomUrl(project: IProject, frontendSlug: string, version: string, filePath: string, baseUrl: string): Promise<Stream> {
        let finalPath = path.join(baseUrl, filePath)

        finalPath = finalPath.replace("$version", version)
        finalPath = finalPath.replace("$microfrontendSlug", frontendSlug)
        finalPath = finalPath.replace("$projectId", project._id.toString())
        finalPath = finalPath.replace("$projectSlug", project.slug)

        const response = await axios.get(finalPath, { responseType: "stream" })
        return response.data
    }

    async getFrontendStreamStorage(project: IProject, frontendSlug: string, version: string, filePath: string, storage: IStorage): Promise<Stream> {
        const storagePath = storage.path || ""
        const basePathInStorage = path.join(storagePath, `${project.slug}-${project._id.toString()}`, frontendSlug, version)
        let finalPath = path.join(basePathInStorage, filePath)
        if (finalPath.startsWith("/")) {
            finalPath = finalPath.substring(1)
        }

        switch (storage.type) {
            case StorageType.AZURE: {
                const client = new AzureStorageClient(storage.authConfig)
                return (await client.downloadFileStream(finalPath)) as unknown as Stream
            }
            case StorageType.AWS: {
                const client = new S3BucketClient(storage.authConfig)
                return (await client.downloadFileStream(finalPath)) as unknown as Stream
            }
            case StorageType.GOOGLE: {
                const client = new GoogleStorageClient(storage.authConfig)
                return client.downloadFileStream(finalPath) as unknown as Stream
            }
        }
    }

    getEnvironmentFomRefererAndProjectId(referer: string, projectId: string | Schema.Types.ObjectId) {
        return Environment.findOne({
            projectId: toObjectId(projectId),
            $or: refererMatchCandidates(referer).map(candidate => ({ domains: { $regex: new RegExp(escapeRegExp(candidate), "i") } }))
        })
    }
}

/**
 * The forms of the calling domain a registered domain can be matched against.
 *
 * The referer is a full url when the browser sends one and a bare host when getReferer falls back to
 * the Host header, so parsing has to tolerate both: `new URL("example.com")` throws, which used to
 * surface as a 500 on every "auto" url requested without a referer (a plain curl, a preload, a
 * browser under a no-referrer policy).
 */
const refererMatchCandidates = (referer: string): string[] => {
    const parsed = parseUrlOrNull(referer) ?? parseUrlOrNull(`https://${referer}`)
    const candidates = [referer, parsed?.origin, parsed?.host, parsed?.hostname]
    return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))]
}

const parseUrlOrNull = (value: string): URL | null => {
    try {
        return new URL(value)
    } catch {
        return null
    }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * @param pinnedVersion When set, the version is written into the path of the url.
 *
 * Pinning it here, instead of leaving the entrypoint redirect to do it, is what keeps the host page
 * independent from its bundler. A classic script (webpack `publicPath: 'auto'`) derives the base of
 * its chunks from `document.currentScript.src`, which is the url *before* any redirect: it would ask
 * for its chunks without the version and could end up mixing two of them. An url that already
 * carries the version has no redirect to follow, so both an ES module and a classic script resolve
 * their chunks on the same version.
 */
const getFrontendUrlStatic = (frontend: IFrontend, environmentSlug?: string, pinnedVersion?: string): string => {
    if (!frontend.host) {
        throw new Error("Frontend host is not defined from frontend " + frontend.slug)
    }
    if (frontend.host.type === HostedOn.MFE_ORCHESTRATOR_HUB || frontend.host.type === HostedOn.CUSTOM_SOURCE) {
        const backendUrl = getBackendUrl()
        const versionPath = pinnedVersion ? `${VERSION_PATH_SEGMENT}/${pinnedVersion}/` : ""
        const entryPoint = frontend.host.entryPoint || "index.js"
        if (environmentSlug) {
            // The environment is already resolved here, so it goes into the url: an "auto" url would make the
            // browser resolve it again from the referer of the file request, which fails for any host page whose
            // domain is not registered on the environment even when it asked for that environment explicitly.
            return `${backendUrl}/serve/mfe/files/${frontend.projectId}/${environmentSlug}/${frontend.slug}/${versionPath}${entryPoint}`
        } else {
            return `${backendUrl}/serve/mfe/files/${frontend._id}/${versionPath}${entryPoint}`
        }
    } else if (frontend.host.type === HostedOn.CUSTOM_URL) {
        if (!frontend.host.url) {
            throw new Error("Frontend URL is not defined")
        }
        // `$version` is how a custom url carries the version, and it has to honour the resolved one:
        // substituting the deployed version here would hand out the stable bundle while the manifest
        // reports the canary version next to it, and the canary would never actually roll out.
        return frontend.host.url.replace("$version", pinnedVersion ?? frontend.version)
    } else {
        throw new Error("Frontend host type is not defined")
    }
}

/** Snapshots taken before `kind` existed hold none: those are all FRONTENDs */
const isDocker = (frontend: Pick<IFrontend, "kind">): boolean => frontend.kind === FrontendKind.DOCKER

/**
 * Where the container of a DOCKER answers in the environment: its exposure path on the host of the environment,
 * there is nothing of ours to point at, without a trailing slash as the URL always had. Empty when it is not exposed or the project is exposed on no domain: the
 * DOCKER is a host asking for its own configuration, which must not fail for want of an address nobody loads it from.
 */
const getFrontendUrl = (frontend: IFrontend, environment: Pick<IEnvironment, "slug" | "subdomain" | "isProduction">, exposure?: IProject["exposure"]): string =>
    exposure?.domain && frontend.exposurePath ? `${exposedOrigin(exposure, effectiveSubdomain(environment))}${frontend.exposurePath.replace(/\/+$/, "")}` : ""

const getFrontendUrlCanary = (frontend: IFrontend): string => {
    if (!frontend.canary?.url) {
        throw new Error("Frontend canary URL is not defined")
    }
    return frontend.canary.url
}

/**
 * @param servedVersion Version the url actually resolves to. It is the one reported back, so that a
 * browser landing on a canary is not told it is running the stable version.
 */
const buildFrontendAdaptedToServe = (frontend: IFrontend, url: string, servedVersion?: string): FrontendAdaptedToServe => ({
    url,
    version: servedVersion || frontend.version,
    name: frontend.name,
    slug: frontend.slug,
    continuousDeployment: frontend.continuousDeployment,
    nameToIntegrate: frontend?.slug ? federationName(frontend.slug) : `mfe${frontend._id}`
})
