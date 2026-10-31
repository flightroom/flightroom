import { ObjectId, Schema } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import { ApiKeyRole } from "../models/ApiKeyModel"
import BackendDeployment from "../models/BackendDeploymentModel"
import Backend, { IBackend } from "../models/BackendModel"
import BuiltBackend, { IBuiltBackend } from "../models/BuiltBackendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Environment from "../models/EnvironmentModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project from "../models/ProjectModel"
import BackendDTO, { BackendVersionRegistrationDTO, EnvironmentResourcesDTO } from "../types/BackendDTO"
import { BACKEND_SLUG, BACKEND_VERSION, isBackendTemplateType, parseRuntime } from "../types/BackendStack"
import {
    CONTAINER_RESOURCE_FIELDS,
    ContainerResources,
    ContainerResourcesByEnvironment,
    isReplicaCount,
    MAX_REPLICAS,
    parseCpu,
    parseMemory,
    requestAboveLimit,
    resourcesIn
} from "../types/ContainerResources"
import { FrontendStackSource } from "../types/FrontendStack"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService, { ensureOnlyNewRepositoryLinked, ensureRepositoryLinkUnchanged } from "./BaseAuthorizedService"
import { resolveDomainId } from "./DomainService"
import MarketService from "./MarketService"
import { ensureAttachableResources, withResourcesOutOfScope } from "./ResourceService"
import TemplateScaffoldService from "./TemplateScaffoldService"
import { placeholderDomain } from "./templateScaffold/pipelineTemplates"
import { ensureAttachableMaps, resolveAttachedMaps } from "./VariableMapService"
import { forgetBackends } from "./workspace/workspaceCleanup"

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: number })?.code === 11000

/** Checked before anything is created at the provider: the slug names the repository folder and the CI registration URL */
const ensureValidSlug = (slug: string) => {
    if (!BACKEND_SLUG.test(slug)) {
        throw createBusinessException({
            code: "BACKEND_SLUG_INVALID",
            message: `"${slug}" is not a valid slug: 2 to 50 lowercase letters, digits or dashes, not starting with a dash`
        })
    }
}

/**
 * Refuses update operators and dotted paths: `{"$set": {"secretIds": [...]}}` or `{"secretIds.0": ...}`
 * would reach Mongo past every check here, attaching a secret of another project to this backend.
 */
export const ensurePlainFields = (fields: object, code = "BACKEND_INVALID") => {
    const key = Object.keys(fields).find(candidate => candidate.startsWith("$") || candidate.includes("."))
    if (key) {
        throw createBusinessException({ code, message: `"${key}" is not a field: update operators and dotted paths are refused` })
    }
}

/**
 * A request above its limit is a Deployment Kubernetes refuses: checked on what the container ends up with, the
 * stored value where `fields` leaves one out and the default of the chart where neither sets it.
 */
export const ensureRequestsWithinLimits = (fields: ContainerResourcesByEnvironment, existing?: ContainerResourcesByEnvironment, code = "BACKEND_INVALID") => {
    const resources = Object.fromEntries(CONTAINER_RESOURCE_FIELDS.map(field => [field, fields[field] !== undefined ? fields[field] : existing?.[field]])) as ContainerResources
    const refuse = (resource: "cpu" | "memory", where = "") =>
        createBusinessException({
            code,
            message: `The ${resource === "cpu" ? "CPU" : "memory"} request is above its limit${where}, which Kubernetes refuses: a value left blank is the default of the chart`
        })
    const resource = requestAboveLimit(resources)
    if (resource) throw refuse(resource)
    // Each environment with values of its own, on what it ends up with: its own, else the ones above
    const environmentResources = fields.environmentResources !== undefined ? fields.environmentResources : existing?.environmentResources
    for (const entry of environmentResources ?? []) {
        const inEnvironment = requestAboveLimit(resourcesIn({ ...resources, environmentResources: [entry] }, entry.environmentId))
        if (inEnvironment) throw refuse(inEnvironment, ` in environment ${String(entry.environmentId)}`)
    }
}

/** Replicas as stored: a number, or the digits a form sends; blank or null is the default of the chart */
const replicaCount = (value: unknown, code: string, where = ""): number | null => {
    if (value == null || (typeof value === "string" && !value.trim())) return null
    const count = typeof value === "string" ? Number(value.trim()) : value
    if (!isReplicaCount(count)) throw createBusinessException({ code, message: `replicas "${String(value)}"${where} is not a whole number from 1 to ${MAX_REPLICAS}` })
    return count
}

/** The replicas of the container, as stored; left out, the stored ones stay */
export const withNormalizedReplicas = <T extends Pick<BackendDTO, "replicas">>(dto: T, code = "BACKEND_INVALID"): T =>
    dto.replicas === undefined ? dto : { ...dto, replicas: replicaCount(dto.replicas, code) }

/**
 * The CPU, memory and replicas set apart per environment, as stored: values trimmed, blank ones null, an environment
 * that sets none left out. Refused: an environment that is not of the project, one listed twice, a value that is no
 * quantity or no count of replicas.
 */
export const withNormalizedEnvironmentResources = async <T extends Pick<BackendDTO, "environmentResources">>(dto: T, projectId: Schema.Types.ObjectId, code = "BACKEND_INVALID"): Promise<T> => {
    if (dto.environmentResources === undefined) return dto
    if (dto.environmentResources !== null && !Array.isArray(dto.environmentResources)) {
        throw createBusinessException({ code, message: "environmentResources must be a list of { environmentId, cpuRequest, cpuLimit, memoryRequest, memoryLimit, replicas }" })
    }
    const quantity = (entry: EnvironmentResourcesDTO, field: (typeof CONTAINER_RESOURCE_FIELDS)[number]) => {
        const value = entry[field]
        if (value == null) return null
        const trimmed = typeof value === "string" ? value.trim() : ""
        if (typeof value !== "string" || (trimmed && (field.startsWith("cpu") ? parseCpu : parseMemory)(trimmed) === undefined)) {
            throw createBusinessException({ code, message: `${field} "${String(value)}" of environment ${entry.environmentId} is not a Kubernetes quantity above zero` })
        }
        return trimmed || null
    }
    const entries = (dto.environmentResources ?? [])
        .map(entry => ({
            environmentId: String(entry?.environmentId ?? ""),
            ...Object.fromEntries(CONTAINER_RESOURCE_FIELDS.map(field => [field, quantity(entry, field)])),
            replicas: replicaCount(entry?.replicas, code, ` of environment ${entry?.environmentId}`)
        }))
        .filter(entry => entry.replicas !== null || CONTAINER_RESOURCE_FIELDS.some(field => entry[field as keyof typeof entry]))
    const ids = entries.map(entry => entry.environmentId)
    const twice = ids.find((id, index) => ids.indexOf(id) !== index)
    if (twice) throw createBusinessException({ code, message: `Environment ${twice} is listed twice in environmentResources` })
    if (ids.length > 0) {
        const known = new Set((await Environment.find({ projectId }, { _id: 1 })).map(environment => String(environment._id)))
        const unknown = ids.find(id => !known.has(id))
        if (unknown) throw createBusinessException({ code, message: `${unknown} is not an environment of this project` })
    }
    return { ...dto, environmentResources: entries }
}

/**
 * The version each environment runs, as stored: trimmed, an environment left blank left out. Refused: an
 * environment that is not of the project, one listed twice, a version that is no tag of an image.
 */
export const withNormalizedEnvironmentVersions = async <T extends Pick<BackendDTO, "environmentVersions">>(dto: T, projectId: Schema.Types.ObjectId, code = "BACKEND_INVALID"): Promise<T> => {
    if (dto.environmentVersions === undefined) return dto
    if (dto.environmentVersions !== null && !Array.isArray(dto.environmentVersions)) {
        throw createBusinessException({ code, message: "environmentVersions must be a list of { environmentId, version }" })
    }
    const entries = (dto.environmentVersions ?? [])
        .map(entry => {
            const version = entry?.version
            if (version != null && (typeof version !== "string" || (version.trim() && !BACKEND_VERSION.test(version.trim())))) {
                throw createBusinessException({
                    code: "BACKEND_VERSION_INVALID",
                    message: `The version of environment ${entry.environmentId} may hold only letters, digits, dots, dashes and underscores (at most 128)`
                })
            }
            return { environmentId: String(entry?.environmentId ?? ""), version: version?.trim() ?? "" }
        })
        .filter(entry => entry.version)
    const ids = entries.map(entry => entry.environmentId)
    const twice = ids.find((id, index) => ids.indexOf(id) !== index)
    if (twice) throw createBusinessException({ code, message: `Environment ${twice} is listed twice in environmentVersions` })
    if (ids.length > 0) {
        const known = new Set((await Environment.find({ projectId }, { _id: 1 })).map(environment => String(environment._id)))
        const unknown = ids.find(id => !known.has(id))
        if (unknown) throw createBusinessException({ code, message: `${unknown} is not an environment of this project` })
    }
    return { ...dto, environmentVersions: entries }
}

/**
 * The maps `dto` attaches, checked: a caller that leaves them out (an MCP update of the name, say)
 * changes none of them and costs no query. A DOCKER frontend goes through it too, since it has the
 * same container fields, but without `resources`: only a backend attaches resources. The CPU and memory
 * set apart per environment, and the versions, are normalized here too, as every one of them has them.
 */
export const withNormalizedReferences = async <T extends Pick<BackendDTO, "configMapIds" | "secretIds" | "resourceIds" | "replicas" | "environmentResources" | "environmentVersions">>(
    dto: T,
    projectId: Schema.Types.ObjectId,
    existing?: Partial<Pick<IBackend, "name" | "configMapIds" | "secretIds" | "resourceIds">>,
    options: { resources?: boolean } = {}
): Promise<T> => {
    ensurePlainFields(dto)
    const normalized = await withNormalizedEnvironmentVersions(await withNormalizedEnvironmentResources(withNormalizedReplicas(dto), projectId), projectId)
    // Only the name and the attached ids of what is stored are read
    return resolveAttachedMaps(normalized, projectId, existing as IBackend | undefined, options)
}

/**
 * A version set by hand rather than registered by the CI, held to the same rule: the deploy pulls it as the
 * tag of the image. Left out, the stored one stays; the CI still moves it on to a newer one it registers.
 */
export const withManualVersion = <T extends { version?: string }>(fields: T): T => {
    if (fields.version === undefined) return fields
    const version = typeof fields.version === "string" ? fields.version.trim() : ""
    if (!BACKEND_VERSION.test(version)) {
        throw createBusinessException({ code: "BACKEND_VERSION_INVALID", message: "The version may hold only letters, digits, dots, dashes and underscores (at most 128)" })
    }
    return { ...fields, version }
}

/**
 * The body the CI posts once it pushed an image. It arrives with an API key only, from a pipeline
 * nobody watches: a malformed one is refused with a 400 rather than stored half filled.
 */
export const parseRegistration = (body: unknown): BackendVersionRegistrationDTO => {
    const registration = (body ?? {}) as Record<string, unknown>
    if (!isNonEmptyString(registration.image)) {
        throw createBusinessException({ code: "BACKEND_VERSION_IMAGE_REQUIRED", message: "The image reference is required, e.g. ghcr.io/acme/orders-api:1.2.0" })
    }
    for (const field of ["digest", "commitSha"] as const) {
        if (registration[field] !== undefined && typeof registration[field] !== "string") {
            throw createBusinessException({ code: "BACKEND_VERSION_INVALID", message: `${field} must be a string` })
        }
    }
    return {
        image: registration.image.trim(),
        digest: (registration.digest as string | undefined)?.trim() || undefined,
        commitSha: (registration.commitSha as string | undefined)?.trim() || undefined
    }
}

/**
 * The repository part of an image reference, without tag nor digest:
 * `host:5000/acme/orders:1.2.0@sha256:…` → `host:5000/acme/orders`. A colon before the last slash
 * is a registry port, not a tag.
 */
export const imageRepositoryOf = (image: string): string => {
    const withoutDigest = image.split("@")[0]
    const tagAt = withoutDigest.lastIndexOf(":")
    return tagAt > withoutDigest.lastIndexOf("/") ? withoutDigest.slice(0, tagAt) : withoutDigest
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Semver precedence of two pre-release tags (`alpha.1` < `alpha.2` < `beta`). */
const comparePrerelease = (a: string, b: string): number => {
    const left = a.split(".")
    const right = b.split(".")
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
        const [x, y] = [left[index], right[index]]
        const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)]
        if (xNumeric && yNumeric && Number(x) !== Number(y)) return Number(x) - Number(y)
        if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
        if (x !== y) return x < y ? -1 : 1
    }
    return left.length - right.length
}

/**
 * Whether `candidate` should become the latest version of a backend: always when it has none yet,
 * otherwise only when both are semver and `candidate` is newer. Tags that are not semver (`latest`,
 * a commit sha) cannot be ordered: they are registered as versions but never move the backend.
 */
export const isNewerVersion = (candidate: string, current?: string): boolean => {
    if (!current?.trim()) return true
    const next = SEMVER.exec(candidate)
    const previous = SEMVER.exec(current)
    if (!next || !previous) return false
    for (let part = 1; part <= 3; part++) {
        const difference = Number(next[part]) - Number(previous[part])
        if (difference !== 0) return difference > 0
    }
    // A release ranks above its pre-releases.
    if (!next[4] || !previous[4]) return !next[4] && Boolean(previous[4])
    return comparePrerelease(next[4], previous[4]) > 0
}

export class BackendService extends BaseAuthorizedService {
    async getById(id: string | ObjectId): Promise<IBackend | null> {
        const backend = await Backend.findById(toObjectId(id))
        if (!backend) {
            return null
        }
        await this.ensureAccessToBackend(backend)
        return backend
    }

    async getByProjectId(projectId: string | Schema.Types.ObjectId): Promise<IBackend[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        return await Backend.find({ projectId: projectIdObj, ...(await this.domainScopeFilter(projectIdObj)) }).sort({ name: 1 })
    }

    async create(dto: BackendDTO, projectId: string | Schema.Types.ObjectId): Promise<IBackend> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)

        // Normalised up front, as the model stores it: the scaffolded CI registers against this slug
        const slug = (dto.slug ?? "").trim().toLowerCase()
        ensureValidSlug(slug)
        const { id: _id, ...fields } = { ...dto, slug }
        const backend = await withNormalizedReferences(withManualVersion(fields), projectIdObj, undefined, { resources: true })
        if (backend.domainId !== undefined) {
            backend.domainId = await resolveDomainId(backend.domainId, projectIdObj)
        }
        // A domain-scoped member creates only inside their domains: one in no domain would be out of their reach at once
        await this.ensureInDomainScope(projectIdObj, backend.domainId)
        const scope = await this.getDomainScope(projectIdObj)
        await ensureAttachableMaps(scope, projectIdObj, backend)
        await ensureAttachableResources(scope, projectIdObj, backend)
        ensureOnlyNewRepositoryLinked(scope, backend.codeRepository)
        ensureRequestsWithinLimits(backend)

        // Both before the repository is created: a refused save would leave an orphan repository behind
        // A maintenance agent's values file is named after its slug as well, next to the backend's
        if ((await Backend.exists({ slug, projectId: projectIdObj })) || (await MaintenanceAgent.exists({ slug, projectId: projectIdObj }))) {
            throw createBusinessException({ code: "BACKEND_SLUG_TAKEN", message: `A backend or a maintenance agent with slug "${slug}" already exists in this project`, statusCode: 409 })
        }
        try {
            await new Backend({ ...backend, projectId: projectIdObj }).validate()
        } catch (error) {
            throw createBusinessException({ code: "BACKEND_INVALID", message: (error as Error).message })
        }

        if (backend.codeRepository?.enabled) {
            const codeRepository = await CodeRepository.findById(backend.codeRepository.codeRepositoryId)
            // A connection of another project would lend this one its access token
            if (!codeRepository || String(codeRepository.projectId) !== String(projectIdObj)) {
                throw new EntityNotFoundError(String(backend.codeRepository.codeRepositoryId))
            }

            const createData = backend.codeRepository.createData
            if (createData) {
                await this.ensureNotViewer(projectIdObj, { code: "REPOSITORY_CREATE_FORBIDDEN", message: "A viewer cannot create a code repository" })
                const template = createData.template ? await new MarketService().getSingle(createData.template) : null
                // Both checked before anything is created at the provider
                if (createData.template && !template) {
                    throw createBusinessException({ code: "TEMPLATE_NOT_FOUND", message: `There is no template "${createData.template}"` })
                }
                if (template && !isBackendTemplateType(template.type)) {
                    throw createBusinessException({
                        code: "FRONTEND_TEMPLATE_NOT_ALLOWED",
                        message: `"${template.slug}" is a frontend template: create a frontend from it, not a backend`
                    })
                }

                await new TemplateScaffoldService(this.user).createRepository(codeRepository, backend.codeRepository, slug, template, {
                    placeholders: { "%serviceSlug%": slug, "%domain%": placeholderDomain() }
                })

                if (template) {
                    // What the form or the API caller left out comes from the template, the platform defaults after it
                    const defaults = template.backendDefaults
                    if (defaults) {
                        backend.port ??= defaults.port
                        backend.livenessPath ??= defaults.livenessPath
                        backend.readinessPath ??= defaults.readinessPath
                        backend.docsPath ??= defaults.docsPath
                        backend.openApiPath ??= defaults.openApiPath
                    }
                    backend.template = template.slug
                    backend.stack = {
                        runtime: parseRuntime(template.framework),
                        framework: template.framework,
                        source: FrontendStackSource.TEMPLATE
                    }
                }

                backend.codeRepository.createData = undefined
            }
        }

        return await Backend.create({ ...backend, projectId: projectIdObj } as unknown as IBackend)
    }

    async update(id: string | ObjectId, updates: BackendDTO): Promise<IBackend | null> {
        const backend = await this.getById(id)
        if (!backend) {
            throw new EntityNotFoundError(String(id))
        }

        // Never moved to another project, nor given another identity, through an update: the slug is
        // in the registration URL the CI of the repository calls
        const { id: _id, _id: _mongoId, projectId: _projectId, slug: _slug, ...fields } = updates as Partial<BackendDTO> & { _id?: unknown; projectId?: unknown }
        const scope = await this.getDomainScope(backend.projectId)
        // A domain-scoped member's console lists only the resources they see: the others it attaches stay attached
        const withHidden = await withResourcesOutOfScope(scope, backend.projectId, fields, backend)
        const allowed = await withNormalizedReferences(withManualVersion(withHidden), backend.projectId, backend, { resources: true })
        if (allowed.domainId !== undefined) {
            allowed.domainId = await resolveDomainId(allowed.domainId, backend.projectId)
            // Moved only between the domains of a domain-scoped member, never out of their reach
            await this.ensureInDomainScope(backend.projectId, allowed.domainId)
        }
        await ensureAttachableMaps(scope, backend.projectId, allowed, backend)
        await ensureAttachableResources(scope, backend.projectId, allowed, backend)
        ensureRequestsWithinLimits(allowed, backend)
        if (ensureRepositoryLinkUnchanged(scope, allowed.codeRepository, backend.codeRepository)) delete allowed.codeRepository
        if (allowed.codeRepository) {
            allowed.codeRepository = { ...allowed.codeRepository, createData: undefined }
            if (allowed.codeRepository.enabled || allowed.codeRepository.codeRepositoryId) {
                const codeRepository = await CodeRepository.findById(allowed.codeRepository.codeRepositoryId)
                // A connection of another project would lend this one its access token, as in create
                if (!codeRepository || String(codeRepository.projectId) !== String(backend.projectId)) {
                    throw new EntityNotFoundError(String(allowed.codeRepository.codeRepositoryId))
                }
            }
        }
        return await Backend.findByIdAndUpdate(backend._id, allowed, { new: true, runValidators: true })
    }

    async delete(id: string | ObjectId): Promise<IBackend | null> {
        const backend = await this.getById(id)
        if (!backend) {
            throw new EntityNotFoundError(String(id))
        }
        await BuiltBackend.deleteMany({ backendId: backend._id })
        await BackendDeployment.deleteMany({ backendId: backend._id })
        const deleted = await Backend.findByIdAndDelete(backend._id)
        await MaintenanceAgent.updateMany({ projectId: backend.projectId, backendIds: backend._id }, { $pull: { backendIds: backend._id } })
        // The local clone and the AI change requests go with it, as for a frontend.
        await forgetBackends([backend])
        return deleted
    }

    /** Registered versions, newest first */
    async getVersionsById(id: string): Promise<IBuiltBackend[]> {
        const backend = await this.getById(id)
        if (!backend) {
            throw new EntityNotFoundError(id)
        }
        return await BuiltBackend.find({ backendId: backend._id }).sort({ createdAt: -1 })
    }

    /** Tags the repository with `version`: the tag starts the pipeline that builds and pushes the image */
    async build(id: string, version: string, branch?: string): Promise<void> {
        // It becomes a git tag and then, in the pipeline, an image tag and a URL segment
        if (typeof version !== "string" || !BACKEND_VERSION.test(version)) {
            throw createBusinessException({ code: "BACKEND_VERSION_INVALID", message: "The version may hold only letters, digits, dots, dashes and underscores (at most 128)" })
        }
        const backend = await this.getById(id)
        if (!backend) {
            throw new EntityNotFoundError(id)
        }
        // The tag starts a release: a viewer may look, not release
        await this.ensureNotViewer(backend.projectId, { code: "BACKEND_BUILD_FORBIDDEN", message: "A viewer cannot create a version of a backend" })
        await new TemplateScaffoldService(this.user).createTag(backend.codeRepository, backend.projectId, version, branch)
    }

    /**
     * Called by the CI with the deploy API key once the image of `version` is pushed. Registering
     * the same version again (a rerun of the pipeline) replaces what was stored for it. The backend
     * moves to `version` only when it is newer than its current one, and learns its image repository
     * from the first registration when nobody set it. Only a MANAGER key may register: the deploy
     * secret is one, a VIEWER key handed out to read the project is not meant to publish images.
     */
    async registerVersionWithPermissionCheck(backendSlug: string, version: string, projectId: string, body: unknown, apiKeyRole?: ApiKeyRole): Promise<IBuiltBackend> {
        if (apiKeyRole !== ApiKeyRole.MANAGER) {
            throw createBusinessException({ code: "BACKEND_VERSION_FORBIDDEN", message: "Registering a version requires an API key with the MANAGER role", statusCode: 403 })
        }
        const registration = parseRegistration(body)
        if (!isNonEmptyString(version)) {
            throw createBusinessException({ code: "BACKEND_VERSION_INVALID", message: "The version is required" })
        }

        const project = await Project.findById(projectId)
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }
        const slug = backendSlug.trim().toLowerCase()
        // A maintenance agent is scaffolded from the templates of the backends: its CI registers here too, by its slug
        let model = Backend
        let backend: IBackend | null = await Backend.findOne({ slug, projectId: toObjectId(projectId) })
        if (!backend) {
            model = MaintenanceAgent as unknown as typeof Backend
            backend = (await MaintenanceAgent.findOne({ slug, projectId: toObjectId(projectId) })) as unknown as IBackend | null
        }
        if (!backend) {
            throw new EntityNotFoundError(backendSlug)
        }

        const trimmedVersion = version.trim()
        const unset: Record<string, ""> = {}
        if (!registration.digest) unset.digest = ""
        if (!registration.commitSha) unset.commitSha = ""

        const upsert = () =>
            BuiltBackend.findOneAndUpdate(
                { backendId: backend._id, version: trimmedVersion },
                {
                    $set: {
                        image: registration.image,
                        ...(registration.digest && { digest: registration.digest }),
                        ...(registration.commitSha && { commitSha: registration.commitSha })
                    },
                    ...(Object.keys(unset).length > 0 && { $unset: unset })
                },
                { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
            )
        let built
        try {
            built = await upsert()
        } catch (error) {
            // Two runs of the same tag upserting at once: one inserted, the other now finds it and updates
            if (!isDuplicateKeyError(error)) throw error
            built = await upsert()
        }

        // Compare and set on the version that was read, so two pipelines finishing together cannot
        // move the backend back to the older of the two: the loser reads again and decides again.
        let current: IBackend | null = backend
        for (let attempt = 0; current && attempt < 3; attempt++) {
            const updates: Record<string, string> = {}
            if (isNewerVersion(trimmedVersion, current.version)) updates.version = trimmedVersion
            if (!current.image?.repository?.trim()) updates["image.repository"] = imageRepositoryOf(registration.image)
            if (Object.keys(updates).length === 0) break
            const result = await model.updateOne({ _id: backend._id, version: current.version ?? null }, { $set: updates })
            if (result.matchedCount > 0) break
            current = await model.findById(backend._id)
        }

        return built as IBuiltBackend
    }
}

export default BackendService
