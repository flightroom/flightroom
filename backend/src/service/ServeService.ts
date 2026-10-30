import { FastifyRequest } from "fastify"
import { ObjectId, Schema } from "mongoose"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { EnvironmentNotFoundError } from "../errors/EnvironmentNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import Deployment, { IDeployment } from "../models/DeploymentModel"
import Environment, { IEnvironment } from "../models/EnvironmentModel"
import Frontend, { FrontendType, HostedOn, IFrontend } from "../models/FrontendModel"
import { IGlobalVariable } from "../models/GlobalVariableModel"
import Project, { IProject } from "../models/ProjectModel"
import { IStorage } from "../models/StorageModel"
import { parseCompiler, parseFramework } from "../types/FrontendStack"
import { getBackendUrl } from "../utils/backendUrl"
import { toObjectId } from "../utils/mongooseUtils"
import DeploymentService from "./DeploymentService"
import FederationConfigService from "./FederationConfigService"
import FrontendVersionResolver, { isVersionCanary } from "./serve/FrontendVersionResolver"
import { getFrontendStreamCustomUrl, getFrontendStreamLocal, getFrontendStreamStorage } from "./serve/frontendStreams"
import { CodeIntegrationRequestDTO, CodeIntegrationResponseDTO, FrontendAdaptedToServe, GetAllDataDTO, GetRemotesRequestDTO, GetRemotesResponseDTO, ServeFileResult } from "./serve/serveTypes"
import { escapeRegExp, isDocker, refererMatchCandidates } from "./serve/serveUrls"

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

/** Response header telling the caller which version has actually been served. */
const VERSION_HEADER = "x-mfe-version"

/** The frontend of the deployment `matches` picks, not found as `notFound` when it holds none */
const deployedFrontend = (deployment: IDeployment, matches: (frontend: IFrontend) => boolean, notFound: string): IFrontend => {
    const frontend = deployment.frontends?.find(matches)
    if (!frontend) {
        throw new EntityNotFoundError(notFound)
    }
    return frontend
}

export default class ServeService {
    private readonly versions: FrontendVersionResolver

    /** @param request Fastify request being served, used to read the version override and the identities a canary is drawn on */
    constructor(request?: FastifyRequest) {
        this.versions = new FrontendVersionResolver(request)
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
        const frontend = deployedFrontend(deployment, mfe => mfe._id.toString() === frontendId?.toString(), frontendId?.toString())

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

    /**
     * The integration instructions of a frontend, generated for the stack it is actually
     * built with. `framework` and `compiler` only override what is stored on it, so the screen
     * can still show another stack on request.
     */
    async getCodeIntegration({ framework, compiler, frontendId, deploymentId }: CodeIntegrationRequestDTO): Promise<CodeIntegrationResponseDTO> {
        const allData = await this.getRemotes({ frontendId, deploymentId })

        const childs = await Promise.all(allData.filteredFrontends.map(child => this.versions.adaptFrontendToServe(child, allData.environment, allData.deployment._id)))

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
            ? await Promise.all(deployment.frontends.filter(frontend => !isDocker(frontend)).map(frontend => this.versions.adaptFrontendToServe(frontend, environment, deployment._id)))
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

    /** As findEnvironmentByProjectIdAndSlug, failing when the project has no such environment */
    private async getEnvironmentByProjectIdAndSlugOrFail(projectId: string | ObjectId | Schema.Types.ObjectId, environmentSlug: string): Promise<IEnvironment> {
        const environment = await this.findEnvironmentByProjectIdAndSlug(projectId, environmentSlug)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentSlug)
        }
        return environment
    }

    /**
     * Get all frontends by project ID and environment slug
     * @param projectId The ID of the project
     * @param environmentSlug The slug of the environment
     * @returns Promise with array of Frontend objects
     */
    async getAllByProjectIdAndEnvironmentSlug(projectId: string, environmentSlug: string): Promise<GetAllDataDTO> {
        const environment = await this.getEnvironmentByProjectIdAndSlugOrFail(projectId, environmentSlug)
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

    /** The active deployment of the environment, the latest should there be more than one */
    private async getActiveDeployment(environment: Pick<IEnvironment, "_id">): Promise<IDeployment> {
        const deployment = await Deployment.findOne({ environmentId: environment._id, active: true }).sort({ createdAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        return deployment
    }

    /** The deployment created last in the environment, active or not: the files of its frontends are the ones served */
    private async getLatestDeployment(environment: Pick<IEnvironment, "_id">): Promise<IDeployment> {
        const deployment = await Deployment.findOne({ environmentId: environment._id }).sort({ createdAt: -1 })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        return deployment
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
        const deployment = await this.getActiveDeployment(environment)
        const deployedMFE = deployedFrontend(deployment, mfe => mfe._id.toString() === mfeId, mfeId)
        return await this.versions.adaptFrontendToServe(deployedMFE, environment, deployment._id)
    }

    /**
     * Get frontend by project ID and environment slug
     * @param projectId The ID of the project
     * @param environmentSlug The slug of the environment
     * @param mfeSlug The slug of the frontend
     * @returns Promise with Frontend object or null if not found
     */
    async getFrontendConfigurationByProjectIdEnvironmentSlugAndMfeSlug(projectId: string, environmentSlug: string, mfeSlug: string): Promise<FrontendAdaptedToServe> {
        const environment = await this.getEnvironmentByProjectIdAndSlugOrFail(projectId, environmentSlug)
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
        const deployment = await this.getActiveDeployment(environment)
        const deployedMFE = deployedFrontend(deployment, mfe => mfe.slug === mfeSlug, mfeSlug)
        return await this.versions.adaptFrontendToServe(deployedMFE, environment, deployment._id)
    }

    async getFrontendConfigurationByEnvironmentIdAndMfeSlug(environmentId: string, mfeSlug: string): Promise<FrontendAdaptedToServe> {
        const deployment = await Deployment.findOne({ environmentId: toObjectId(environmentId), active: true })
        if (!deployment) {
            throw new EntityNotFoundError("Active deployment")
        }
        const deployedMFE = deployedFrontend(deployment, mfe => mfe.slug === mfeSlug, mfeSlug)
        const environment = await Environment.findById(environmentId)
        if (!environment) {
            throw new EnvironmentNotFoundError(environmentId.toString())
        }
        return await this.versions.adaptFrontendToServe(deployedMFE, environment, deployment._id)
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
        const environment = await this.getEnvironmentByProjectIdAndSlugOrFail(projectId, environmentSlug)
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
        const deployment = await this.getActiveDeployment(environment)
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
        const environment = await this.getEnvironmentByProjectIdAndSlugOrFail(projectIdObj, environmentSlug)

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
        const deployment = await this.getLatestDeployment(environment)
        return this.getFrontendByDeployment(project, deployment, frontendSlug, filePath, version)
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

        // A canary rolling out a version of ours draws it once, on the entrypoint, and pins it in the URL
        if (!version && isEntryPoint && isVersionCanary(frontend)) {
            return {
                headers: HEADERS_NO_CACHE,
                redirectToVersion: await this.versions.getFrontendVersion(frontend, deployment._id)
            }
        }

        const versionToServe = this.versions.getVersionToServe(frontend, version)
        const headers = { ...(isEntryPoint ? HEADERS_NO_CACHE : HEADERS_CACHE), [VERSION_HEADER]: versionToServe }

        switch (frontend.host.type) {
            case HostedOn.CUSTOM_SOURCE: {
                const storage = this.getStorage(frontend, deployment)
                if (!storage) {
                    throw new Error("Storage not found for frontend " + frontend.slug)
                }
                return {
                    headers,
                    stream: await getFrontendStreamStorage(project, frontendSlug, versionToServe, filePath, storage)
                }
            }
            case HostedOn.CUSTOM_URL:
                if (!frontend.host.url) {
                    throw new Error("Frontend url is not defined from frontend " + frontend.slug)
                }
                return {
                    headers,
                    stream: await getFrontendStreamCustomUrl(project, frontendSlug, versionToServe, filePath, frontend.host.url)
                }
            case HostedOn.MFE_ORCHESTRATOR_HUB:
                return {
                    headers,
                    stream: await getFrontendStreamLocal(project, frontendSlug, versionToServe, filePath)
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

        const deployment = await this.getLatestDeployment(environment)
        const deployedMFE = deployedFrontend(deployment, mfe => mfe._id.toString() === mfeId, mfeId)

        return this.getFrontendByDeployment(project, deployment, deployedMFE.slug, filePath, version)
    }

    getEnvironmentFomRefererAndProjectId(referer: string, projectId: string | Schema.Types.ObjectId) {
        return Environment.findOne({
            projectId: toObjectId(projectId),
            $or: refererMatchCandidates(referer).map(candidate => ({ domains: { $regex: new RegExp(escapeRegExp(candidate), "i") } }))
        })
    }
}
