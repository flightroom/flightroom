import { MultipartFile } from "@fastify/multipart"
import AdmZip from "adm-zip"
import fs from "fs-extra"
import { ClientSession, ObjectId, Schema, Types } from "mongoose"
import os from "os"
import path from "path"
import { fastify } from ".."
import AzureStorageClient from "../client/AzureStorageAccount"
import GoogleStorageClient from "../client/GoogleStorageAccount"
import S3BucketClient from "../client/S3Buckets"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import { ApiKeyRole } from "../models/ApiKeyModel"
import BuiltFrontend, { IBuiltFrontend } from "../models/BuiltFrontendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import { CONTAINER_DEFAULTS } from "../models/ContainerFields"
import FrontendDeployment from "../models/FrontendDeploymentModel"
import Frontend, { FrontendKind, HostedOn, IFrontend, IHostFrontend } from "../models/FrontendModel"
import Project, { IProject } from "../models/ProjectModel"
import Service from "../models/ServiceModel"
import Storage, { StorageType } from "../models/StorageModel"
import FrontendDTO from "../types/FrontendDTO"
import { FrontendStackSource, parseCompiler, parseFramework } from "../types/FrontendStack"
import { isServiceTemplateType } from "../types/ServiceStack"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService, { domainScopeForbidden, ensureOnlyNewRepositoryLinked, ensureRepositoryLinkUnchanged, isInDomainScope } from "./BaseAuthorizedService"
import { resolveDomainId } from "./DomainService"
import MarketService from "./MarketService"
import { ensurePlainFields, imageRepositoryOf, isNewerVersion, parseRegistration, withManualVersion, withNormalizedReferences } from "./ServiceService"
import TemplateScaffoldService from "./TemplateScaffoldService"
import { ensureAttachableMaps } from "./VariableMapService"
import { forgetFrontends } from "./workspace/workspaceCleanup"

/** What a frontend is served by when neither the caller nor a template says otherwise. */
export const DEFAULT_ENTRY_POINT = "assets/remoteEntry.js"

/** A host given without an entry point gets the template's, when there is one: one given is kept */
export const withEntryPoint = (host: IHostFrontend, entryPoint?: string): IHostFrontend => (entryPoint && !host.entryPoint ? { ...host, entryPoint } : host)

const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: number })?.code === 11000

const ensureValidKind = (kind: unknown) => {
    if (kind !== undefined && !Object.values(FrontendKind).includes(kind as FrontendKind)) {
        throw createBusinessException({ code: "FRONTEND_KIND_INVALID", message: `kind must be one of ${Object.values(FrontendKind).join(", ")}` })
    }
}

/**
 * A DOCKER is the top of its tree: it is served by its own container, so nothing can load it as a
 * remote. Checked wherever parentIds is written, so no path leaves a DOCKER with a parent.
 */
const dockerCannotHaveParents = (slug?: string) =>
    createBusinessException({
        code: "DOCKER_FRONTEND_CANNOT_HAVE_PARENTS",
        message: `${slug ? `"${slug}" is a DOCKER frontend` : "A DOCKER frontend"}: it is served by its own container and cannot be a remote of another frontend`
    })

const ensureDockerHasNoParents = (kind: FrontendKind | undefined, parentIds: unknown[] | undefined, slug?: string) => {
    if (kind === FrontendKind.DOCKER && parentIds && parentIds.length > 0) {
        throw dockerCannotHaveParents(slug)
    }
}

/**
 * A DOCKER is reached by browsers only through its HTTPRoute, so it needs the path it is exposed at.
 * Checked when a write makes it a DOCKER or clears the path of one: a DOCKER stored without one
 * before the rule still takes the other edits.
 */
const ensureFrontendExposed = (fields: Pick<FrontendDTO, "kind" | "exposurePath">, existing?: IFrontend) => {
    const becomesFrontend = fields.kind === FrontendKind.DOCKER && existing?.kind !== FrontendKind.DOCKER
    const clearsPath = (fields.kind ?? existing?.kind) === FrontendKind.DOCKER && fields.exposurePath !== undefined && !fields.exposurePath?.trim()
    const exposurePath = fields.exposurePath !== undefined ? fields.exposurePath : existing?.exposurePath
    if ((becomesFrontend && !exposurePath?.trim()) || clearsPath) {
        throw createBusinessException({
            code: "DOCKER_FRONTEND_EXPOSURE_PATH_REQUIRED",
            message: "A DOCKER frontend is served by its own container and reached only at its exposurePath: give it one, e.g. / or /shell"
        })
    }
}

/** Matches a document with no parents: what a write making it a DOCKER requires of what is stored at that moment */
const WITHOUT_PARENTS = { $or: [{ parentIds: { $exists: false } }, { parentIds: { $size: 0 } }] }

/** The service defaults a DOCKER gets for what neither the caller nor what is stored says */
const withDockerDefaults = <T extends Pick<FrontendDTO, "kind" | "port" | "livenessPath" | "readinessPath">>(fields: T, existing?: IFrontend): T => {
    if ((fields.kind ?? existing?.kind) !== FrontendKind.DOCKER) return fields
    return {
        ...fields,
        port: fields.port ?? existing?.port ?? CONTAINER_DEFAULTS.port,
        livenessPath: fields.livenessPath ?? existing?.livenessPath ?? CONTAINER_DEFAULTS.livenessPath,
        readinessPath: fields.readinessPath ?? existing?.readinessPath ?? CONTAINER_DEFAULTS.readinessPath
    }
}

export class FrontendService extends BaseAuthorizedService {
    async getById(id: string | ObjectId, session?: ClientSession): Promise<IFrontend | null> {
        const idObj = typeof id === "string" ? new Types.ObjectId(id) : id
        const frontend = await Frontend.findById(idObj, {}, { session })
        if (!frontend) {
            return null
        }
        await this.ensureAccessToFrontend(frontend)
        return frontend
    }

    async getByProjectId(projectId: string | Schema.Types.ObjectId): Promise<IFrontend[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        return await Frontend.find({ projectId: projectIdObj, ...(await this.domainScopeFilter(projectIdObj)) })
    }

    async create(dto: FrontendDTO, projectId: string | Schema.Types.ObjectId): Promise<IFrontend> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)

        ensurePlainFields(dto, "FRONTEND_INVALID")
        ensureValidKind(dto.kind)
        ensureDockerHasNoParents(dto.kind, dto.parentIds, dto.slug)
        ensureFrontendExposed(dto)
        // The version of a DOCKER is the tag of its image, as for a service; a BUNDLE's names an uploaded bundle
        const frontend = withDockerDefaults(await withNormalizedReferences(dto.kind === FrontendKind.DOCKER ? withManualVersion(dto) : dto, projectIdObj))

        // Both before the repository is created: a refused domain or a taken slug would leave an orphan repository behind
        if (frontend.domainId !== undefined) {
            frontend.domainId = await resolveDomainId(frontend.domainId, projectIdObj)
        }
        // A domain-scoped member creates only inside their domains: one in no domain would be out of their reach at once
        await this.ensureInDomainScope(projectIdObj, frontend.domainId)
        const scope = await this.getDomainScope(projectIdObj)
        await this.ensureReferencesInScope(projectIdObj, scope, frontend)
        await ensureAttachableMaps(scope, projectIdObj, frontend)
        ensureOnlyNewRepositoryLinked(scope, frontend.codeRepository)
        // A DOCKER starts without one, like a service: its first registered version sets it
        if (dto.kind !== FrontendKind.DOCKER && (typeof dto.version !== "string" || !dto.version.trim())) {
            throw createBusinessException({ code: "BUNDLE_VERSION_REQUIRED", message: "A BUNDLE frontend needs a version" })
        }
        if (await Frontend.exists({ slug: frontend.slug, projectId: projectIdObj })) {
            throw createBusinessException({ code: "FRONTEND_SLUG_TAKEN", message: `A frontend with slug "${frontend.slug}" already exists in this project`, statusCode: 409 })
        }

        // The file the template's build serves the frontend by: index.js for a single-spa
        // application, parcel.js for a micro-lc parcel, remoteEntry.js for webpack
        let templateEntryPoint: string | undefined

        if (frontend.codeRepository && frontend.codeRepository.enabled) {
            const codeRepository = await CodeRepository.findById(frontend.codeRepository.codeRepositoryId)
            // A connection of another project would lend this one its access token, as for a service
            if (!codeRepository || String(codeRepository.projectId) !== String(projectIdObj)) {
                throw new EntityNotFoundError(String(frontend.codeRepository.codeRepositoryId))
            }

            if (frontend?.codeRepository?.createData) {
                await this.ensureNotViewer(projectIdObj, { code: "REPOSITORY_CREATE_FORBIDDEN", message: "A viewer cannot create a code repository" })
                const template = frontend.codeRepository.createData.template ? await new MarketService().getSingle(frontend.codeRepository.createData.template) : null

                // Checked before anything is created at the provider: a service template scaffolds a
                // Docker image, which nothing can load as a frontend
                if (template && isServiceTemplateType(template.type)) {
                    throw createBusinessException({
                        code: "SERVICE_TEMPLATE_NOT_ALLOWED",
                        message: `"${template.slug}" is a backend service template: create a service from it, not a frontend`
                    })
                }

                await new TemplateScaffoldService(this.user).createRepository(codeRepository, frontend.codeRepository, frontend.slug, template, { frontendSlug: frontend.slug })

                // The template knows the stack the repository was just scaffolded with: keep it,
                // it is what makes the integration instructions specific to this frontend
                if (template) {
                    templateEntryPoint = template.entryPoint
                    frontend.template = template.slug
                    frontend.stack = {
                        framework: parseFramework(template.framework),
                        compiler: parseCompiler(template.compiler),
                        source: FrontendStackSource.TEMPLATE
                    }
                }

                frontend.codeRepository.createData = undefined
            }
        }

        return await Frontend.create({
            ...frontend,
            host: frontend.host ? withEntryPoint(frontend.host, templateEntryPoint) : await this.defaultHost(projectIdObj, templateEntryPoint),
            projectId: projectIdObj
        } as unknown as IFrontend)
    }

    /**
     * A domain-scoped member references only the frontends and services they can see, as setRelation
     * and linkService require: a parent or a service of another domain given in the body would tie theirs to
     * something out of their reach. The references already stored stay, whoever added them.
     */
    private async ensureReferencesInScope(projectId: Schema.Types.ObjectId, scope: string[] | undefined, fields: { parentIds?: unknown; serviceIds?: unknown }, existing?: IFrontend) {
        if (!scope) return
        const added = (given: unknown, stored: unknown[] = []) => {
            if (given === undefined || given === null) return []
            const kept = new Set(stored.map(String))
            return [...new Set((Array.isArray(given) ? given : [given]).map(String))].filter(id => !kept.has(id))
        }
        const parentIds = added(fields.parentIds, existing?.parentIds)
        const serviceIds = added(fields.serviceIds, existing?.serviceIds)
        const ofProject = (ids: string[]) => ({ _id: { $in: ids.map(id => toObjectId(id)) }, projectId })
        const referenced = [
            ...(parentIds.length > 0 ? await Frontend.find(ofProject(parentIds), { domainId: 1 }) : []),
            ...(serviceIds.length > 0 ? await Service.find(ofProject(serviceIds), { domainId: 1 }) : [])
        ]
        // One not found is of another project or deleted: as much out of their reach
        if (referenced.length !== parentIds.length + serviceIds.length || referenced.some(component => !isInDomainScope(scope, component.domainId))) {
            throw domainScopeForbidden()
        }
    }

    /**
     * The hosting the console preselects for a new frontend: the project's default storage,
     * or the Flightroom hub when it has none, with the template's entry point when it was
     * created from one. Applied when a caller (the assistant, an MCP client) creates one without
     * saying where it is served from.
     */
    private async defaultHost(projectId: ReturnType<typeof toObjectId>, templateEntryPoint?: string): Promise<IHostFrontend> {
        const entryPoint = templateEntryPoint || DEFAULT_ENTRY_POINT
        const storage = await Storage.findOne({ projectId, default: true }, { _id: 1 })
        if (!storage) {
            return { type: HostedOn.MFE_ORCHESTRATOR_HUB, entryPoint }
        }
        return { type: HostedOn.CUSTOM_SOURCE, storageId: storage._id as unknown as IHostFrontend["storageId"], entryPoint }
    }

    async update(frontendId: string | ObjectId, updates: FrontendDTO): Promise<IFrontend | null> {
        const frontendIdObj = typeof frontendId === "string" ? new Types.ObjectId(frontendId) : frontendId
        const frontend = await this.getById(frontendId)
        if (!frontend) {
            throw new EntityNotFoundError(frontendIdObj.toString())
        }
        await this.ensureAccessToFrontend(frontend)

        // Never moved to another project, nor given another identity, through an update: the slug is
        // in the upload URL the CI of the repository calls, as for a service
        const { _id: _mongoId, projectId: _projectId, slug: _slug, ...fields } = updates as Partial<FrontendDTO> & { _id?: unknown; projectId?: unknown }
        ensurePlainFields(fields, "FRONTEND_INVALID")
        ensureValidKind(fields.kind)
        const kind = fields.kind ?? frontend.kind
        // Both sides of the rule can change here: parents given to a DOCKER, or a frontend with parents made one
        ensureDockerHasNoParents(kind, fields.parentIds ?? frontend.parentIds, frontend.slug)
        ensureFrontendExposed(fields, frontend)
        // The version of a DOCKER is the tag of its image, as for a service; a BUNDLE's names an uploaded bundle
        const checked = kind === FrontendKind.DOCKER ? withManualVersion(fields) : fields
        const allowed: Partial<FrontendDTO> & Record<string, unknown> = withDockerDefaults(await withNormalizedReferences(checked, frontend.projectId, frontend), frontend)
        // The orchestrator draws no canary for a DOCKER: one left enabled would only mislead the console
        if (kind === FrontendKind.DOCKER && allowed.canary) {
            allowed.canary = { ...allowed.canary, enabled: false }
        } else if (kind === FrontendKind.DOCKER && frontend.kind !== FrontendKind.DOCKER && frontend.canary) {
            allowed["canary.enabled"] = false
        }
        if (allowed.domainId !== undefined) {
            allowed.domainId = await resolveDomainId(allowed.domainId, frontend.projectId)
            // Moved only between the domains of a domain-scoped member, never out of their reach
            await this.ensureInDomainScope(frontend.projectId, allowed.domainId)
        }
        const scope = await this.getDomainScope(frontend.projectId)
        await this.ensureReferencesInScope(frontend.projectId, scope, allowed, frontend)
        await ensureAttachableMaps(scope, frontend.projectId, allowed, frontend)
        if (ensureRepositoryLinkUnchanged(scope, allowed.codeRepository, frontend.codeRepository)) delete allowed.codeRepository
        // Checked once the link is enabled, as in create: a disabled link lends no token, and refusing it
        // would block every edit of a frontend whose connection was deleted since
        if (allowed.codeRepository?.enabled) {
            const codeRepository = await CodeRepository.findById(allowed.codeRepository.codeRepositoryId)
            // A connection of another project would lend this one its access token
            if (!codeRepository || String(codeRepository.projectId) !== String(frontend.projectId)) {
                throw new EntityNotFoundError(String(allowed.codeRepository.codeRepositoryId))
            }
        }

        if (kind !== FrontendKind.DOCKER || fields.parentIds !== undefined) {
            return await Frontend.findByIdAndUpdate(frontendIdObj, allowed, { new: true, runValidators: true })
        }
        // Conditional on the parents stored when it is written: a relation set since the check above makes it miss
        const result = await Frontend.findOneAndUpdate({ _id: frontend._id, ...WITHOUT_PARENTS }, allowed, { new: true, runValidators: true })
        if (!result) {
            throw dockerCannotHaveParents(frontend.slug)
        }
        return result
    }

    async delete(frontendId: string | ObjectId): Promise<IFrontend | null> {
        const frontendIdObj = typeof frontendId === "string" ? new Types.ObjectId(frontendId) : frontendId
        const frontend = await this.getById(frontendId)
        if (!frontend) {
            throw new EntityNotFoundError(frontendIdObj.toString())
        }
        await this.ensureAccessToFrontend(frontend)
        await FrontendDeployment.deleteMany({ frontendId: frontend._id })
        const deleted = await Frontend.findByIdAndDelete(frontendIdObj)
        await forgetFrontends([frontend])
        return deleted
    }

    async bulkDelete(ids: string[]): Promise<number> {
        const frontends: IFrontend[] = []
        for (const id of ids) {
            const frontend = await this.getById(id)
            if (!frontend) {
                throw new EntityNotFoundError(id)
            }
            await this.ensureAccessToFrontend(frontend)
            frontends.push(frontend)
        }

        await FrontendDeployment.deleteMany({ frontendId: { $in: frontends.map(frontend => frontend._id) } })
        const result = await Frontend.deleteMany({ _id: { $in: ids.map(toObjectId) } })
        await forgetFrontends(frontends)
        return result.deletedCount
    }

    async uploadWithPermissionCheck(frontendSlug: string, version: string, projectId: string, file: MultipartFile): Promise<void> {
        const project = await Project.findById(projectId)
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }
        const frontend = await Frontend.findOne({
            slug: frontendSlug,
            projectId: toObjectId(projectId)
        })
        if (!frontend) {
            throw new EntityNotFoundError(frontendSlug)
        }
        // Its container serves its files: the CI registers the image instead, see registerVersionWithPermissionCheck
        if (frontend.kind === FrontendKind.DOCKER) {
            throw createBusinessException({
                code: "DOCKER_FRONTEND_UPLOAD_NOT_ALLOWED",
                message: `"${frontendSlug}" is a DOCKER frontend: it is served by its own container, register the version of its image instead of uploading a bundle`
            })
        }

        // Validate that the file is a ZIP
        if (file.mimetype !== "application/zip" && !file.filename?.endsWith(".zip")) {
            throw new Error("File must be a ZIP archive")
        }

        if (frontend.host.type === HostedOn.MFE_ORCHESTRATOR_HUB) {
            const basePath = path.join(fastify.config.MICROFRONTEND_HOST_FOLDER, project.slug + "-" + project._id.toString(), frontendSlug, version)
            if (!fs.existsSync(basePath)) {
                fastify.log.info("Creating directory " + basePath)
                fs.mkdirSync(basePath, { recursive: true })
            }

            await this.extractZipToDirectory(file, basePath)
        } else if (frontend.host.type === HostedOn.CUSTOM_URL) {
            throw new Error("Frontend host type is not supported")
        } else if (frontend.host.type === HostedOn.CUSTOM_SOURCE) {
            if (!frontend.host.storageId) {
                throw new EntityNotFoundError("Storage id is not set")
            }
            await this.uploadToCloudSource(frontend.host.storageId, project, frontendSlug, version, file)
        } else {
            throw new Error("Frontend host type is not supported")
        }

        await BuiltFrontend.create({
            frontendId: frontend._id,
            version
        })
    }

    async uploadToCloudSource(storageId: string | ObjectId, project: IProject, frontendSlug: string, version: string, file: MultipartFile) {
        const storage = await Storage.findById(storageId)

        if (!storage) {
            throw new EntityNotFoundError("Storage not found for id " + storageId.toString())
        }

        const pathToWrite = project.slug + "-" + project._id.toString() + "/" + frontendSlug + "/" + version

        // Validate that the file is a ZIP
        if (file.mimetype !== "application/zip" && !file.filename?.endsWith(".zip")) {
            throw new Error("File must be a ZIP archive")
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unzip-"))
        try {
            const extractDir = path.join(tempDir, "extracted")
            // Estrai direttamente dal stream del file
            await this.extractZipToDirectory(file, extractDir)

            let pathToWriteEnriched = storage.path ? path.join(storage.path, pathToWrite) : pathToWrite
            if (pathToWriteEnriched.startsWith("/")) {
                pathToWriteEnriched = pathToWriteEnriched.substring(1)
            }

            if (storage.type === StorageType.GOOGLE) {
                await this.uploadDirectoryToGoogle(extractDir, pathToWriteEnriched, new GoogleStorageClient(storage.authConfig))
            } else if (storage.type === StorageType.AWS) {
                await this.uploadDirectoryToS3(extractDir, pathToWriteEnriched, new S3BucketClient(storage.authConfig))
            } else if (storage.type === StorageType.AZURE) {
                await this.uploadDirectoryToAzure(extractDir, pathToWriteEnriched, new AzureStorageClient(storage.authConfig))
            }
        } finally {
            // Pulisci i file temporanei
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    }

    private async extractZipToDirectory(file: MultipartFile, extractDir: string): Promise<void> {
        // Convert stream to buffer
        const buffer = await file.toBuffer()
        const zip = new AdmZip(buffer)
        zip.extractAllTo(extractDir, true)
    }

    private async uploadDirectoryToS3(localDir: string, s3BasePath: string, s3Client: S3BucketClient): Promise<void> {
        const uploadFile = async (filePath: string, relativePath: string) => {
            const content = fs.readFileSync(filePath)
            const s3Path = path.posix.join(s3BasePath, relativePath.replace(/\\/g, "/"))
            await s3Client.uploadFile(s3Path, content)
        }

        await this.processDirectoryRecursive(localDir, uploadFile)
    }

    private async uploadDirectoryToGoogle(localDir: string, gcsBasePath: string, googleClient: GoogleStorageClient): Promise<void> {
        const uploadFile = async (filePath: string, relativePath: string) => {
            const content = fs.readFileSync(filePath)
            const gcsPath = path.posix.join(gcsBasePath, relativePath.replace(/\\/g, "/"))
            await googleClient.uploadFile(gcsPath, content)
        }

        await this.processDirectoryRecursive(localDir, uploadFile)
    }

    private async uploadDirectoryToAzure(localDir: string, azureBasePath: string, azureClient: AzureStorageClient): Promise<void> {
        const uploadFile = async (filePath: string, relativePath: string) => {
            const content = fs.readFileSync(filePath)
            const azurePath = path.posix.join(azureBasePath, relativePath.replace(/\\/g, "/"))
            await azureClient.uploadFile(azurePath, content)
        }

        await this.processDirectoryRecursive(localDir, uploadFile)
    }

    private async processDirectoryRecursive(localDir: string, fileHandler: (filePath: string, relativePath: string) => Promise<void>): Promise<void> {
        const processDirectory = async (dir: string, basePath: string = "") => {
            const items = fs.readdirSync(dir)

            for (const item of items) {
                const fullPath = path.join(dir, item)
                const relativePath = path.join(basePath, item)
                const stats = fs.statSync(fullPath)

                if (stats.isDirectory()) {
                    await processDirectory(fullPath, relativePath)
                } else if (stats.isFile()) {
                    await fileHandler(fullPath, relativePath)
                }
            }
        }

        await processDirectory(localDir)
    }

    async build(frontendId: string, version: string, ref?: string): Promise<void> {
        const frontend = await this.getById(frontendId)
        if (!frontend) {
            throw new EntityNotFoundError(frontendId)
        }
        await this.ensureAccessToFrontend(frontend)
        // The tag starts a release: a viewer may look, not release
        await this.ensureNotViewer(frontend.projectId, { code: "FRONTEND_BUILD_FORBIDDEN", message: "A viewer cannot create a version of a frontend" })

        await new TemplateScaffoldService(this.user).createTag(frontend.codeRepository, frontend.projectId, version, ref)
    }

    async getVersionsById(id: string) {
        const frontend = await this.getById(id)
        if (!frontend) {
            throw new EntityNotFoundError(id)
        }
        // A kind switch leaves the versions of the other kind behind: a bundle has no image, a registered image has one
        return BuiltFrontend.find({ frontendId: frontend._id, image: { $exists: frontend.kind === FrontendKind.DOCKER } })
            .select("version")
            .distinct("version")
    }

    /** What was built of each version, newest first: for a DOCKER the image the CI registered with it */
    async getBuildsById(id: string): Promise<IBuiltFrontend[]> {
        const frontend = await this.getById(id)
        if (!frontend) {
            throw new EntityNotFoundError(id)
        }
        return await BuiltFrontend.find({ frontendId: frontend._id }).sort({ createdAt: -1 })
    }

    /**
     * Called by the CI of a DOCKER with the deploy API key once the image of `version` is pushed, as
     * for a service: registering the same version again replaces what was stored for it, the DOCKER
     * moves to `version` only when it is newer and learns its image repository from the first
     * registration. A BUNDLE uploads its bundle instead. MANAGER keys only.
     */
    async registerVersionWithPermissionCheck(frontendSlug: string, version: string, projectId: string, body: unknown, apiKeyRole?: ApiKeyRole): Promise<IBuiltFrontend> {
        if (apiKeyRole !== ApiKeyRole.MANAGER) {
            throw createBusinessException({ code: "FRONTEND_VERSION_FORBIDDEN", message: "Registering a version requires an API key with the MANAGER role", statusCode: 403 })
        }
        const registration = parseRegistration(body)
        if (typeof version !== "string" || !version.trim()) {
            throw createBusinessException({ code: "SERVICE_VERSION_INVALID", message: "The version is required" })
        }

        const project = await Project.findById(projectId)
        if (!project) {
            throw new ProjectNotFoundError(projectId)
        }
        const frontend = await Frontend.findOne({ slug: frontendSlug.trim().toLowerCase(), projectId: toObjectId(projectId) })
        if (!frontend) {
            throw new EntityNotFoundError(frontendSlug)
        }
        if (frontend.kind !== FrontendKind.DOCKER) {
            throw createBusinessException({
                code: "BUNDLE_VERSION_REGISTRATION_NOT_ALLOWED",
                message: `"${frontend.slug}" is a BUNDLE frontend: its CI uploads the bundle of a version, there is no image to register`
            })
        }

        const trimmedVersion = version.trim()
        const unset: Record<string, ""> = {}
        if (!registration.digest) unset.digest = ""
        if (!registration.commitSha) unset.commitSha = ""

        const upsert = () =>
            BuiltFrontend.findOneAndUpdate(
                { frontendId: frontend._id, version: trimmedVersion },
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
            if (!isDuplicateKeyError(error)) throw error
            built = await upsert()
        }

        // Compare and set on the version that was read, as for a service: two pipelines finishing
        // together cannot move the DOCKER back to the older of the two
        let current: IFrontend | null = frontend
        for (let attempt = 0; current && attempt < 3; attempt++) {
            const updates: Record<string, string> = {}
            if (isNewerVersion(trimmedVersion, current.version)) updates.version = trimmedVersion
            if (!current.image?.repository?.trim()) updates["image.repository"] = imageRepositoryOf(registration.image)
            if (Object.keys(updates).length === 0) break
            const result = await Frontend.updateOne({ _id: frontend._id, version: current.version ?? null }, { $set: updates })
            if (result.matchedCount > 0) break
            current = await Frontend.findById(frontend._id)
        }

        return built as IBuiltFrontend
    }

    async setRelation(hostId: string, remoteId: string): Promise<IFrontend> {
        const host = await this.getById(hostId)
        if (!host) {
            throw new EntityNotFoundError(hostId)
        }
        const remote = await this.getById(remoteId)
        if (!remote) {
            throw new EntityNotFoundError(remoteId)
        }

        await this.ensureAccessToFrontend(host)
        ensureDockerHasNoParents(remote.kind, [host._id], remote.slug)

        // Conditional on the kind stored when it is written: a switch to DOCKER since the check above makes it miss
        const updated = await Frontend.findOneAndUpdate({ _id: remote._id, kind: { $ne: FrontendKind.DOCKER } }, { $addToSet: { parentIds: host._id } }, { new: true })
        if (!updated) {
            throw dockerCannotHaveParents(remote.slug)
        }
        return updated
    }

    async deleteRelation(hostId: string, remoteId: string): Promise<IFrontend> {
        const host = await this.getById(hostId)
        if (!host) {
            throw new EntityNotFoundError(hostId)
        }
        const remote = await this.getById(remoteId)
        if (!remote) {
            throw new EntityNotFoundError(remoteId)
        }

        await this.ensureAccessToFrontend(host)

        if (remote.parentIds) {
            remote.parentIds = remote.parentIds.filter(id => id.toString() !== host._id.toString())
        }

        return await remote.save()
    }

    /** Links a backend service the frontend calls: both must belong to the same project. */
    async linkService(frontendId: string, serviceId: string): Promise<IFrontend> {
        const frontend = await this.getById(frontendId)
        if (!frontend) {
            throw new EntityNotFoundError(frontendId)
        }
        const service = await Service.findById(toObjectId(serviceId))
        if (!service || service.projectId.toString() !== frontend.projectId.toString()) {
            throw new EntityNotFoundError(serviceId)
        }
        // A domain-scoped member links only services they can see
        await this.ensureInDomainScope(service.projectId, service.domainId)

        if (!frontend.serviceIds?.some(id => id.toString() === service._id.toString())) {
            frontend.serviceIds = [...(frontend.serviceIds ?? []), service._id]
        }
        return await frontend.save()
    }

    /** No check on the service: a link to a service deleted since must still be removable. */
    async unlinkService(frontendId: string, serviceId: string): Promise<IFrontend> {
        const frontend = await this.getById(frontendId)
        if (!frontend) {
            throw new EntityNotFoundError(frontendId)
        }
        frontend.serviceIds = (frontend.serviceIds ?? []).filter(id => id.toString() !== serviceId)
        return await frontend.save()
    }

    async setPosition(id: string, x: number, y: number): Promise<IFrontend> {
        const frontend = await this.getById(id)
        if (!frontend) {
            throw new EntityNotFoundError(id)
        }
        await this.ensureAccessToFrontend(frontend)
        if (!frontend.position) {
            frontend.position = { x, y }
        } else {
            frontend.position.x = x
            frontend.position.y = y
        }
        return await frontend.save()
    }

    async setDimension(id: string, width: number, height: number): Promise<IFrontend> {
        const frontend = await this.getById(id)
        if (!frontend) {
            throw new EntityNotFoundError(id)
        }
        await this.ensureAccessToFrontend(frontend)
        if (!frontend.position) {
            frontend.position = { width, height }
        } else {
            frontend.position.width = width
            frontend.position.height = height
        }
        return await frontend.save()
    }

    ensureAccessToFrontend(frontend: IFrontend) {
        return this.ensureAccessToDomainMember(frontend)
    }
}

export default FrontendService
