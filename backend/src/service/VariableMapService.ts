import { isValidObjectId, ObjectId, Schema } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Backend, { IBackend } from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Resource, { IResource } from "../models/ResourceModel"
import { ConfigMap, IVariableMap, IVariableMapEntry, Secret, variableMapModels } from "../models/VariableMapModel"
import { BACKEND_VARIABLE_KEY } from "../types/BackendStack"
import { ResourceNaming, resourceEnvKeys } from "../types/ResourceCatalog"
import VariableMapDTO, { VARIABLE_MAP_NAME, VariableMapEntryDTO, VariableMapKind } from "../types/VariableMapDTO"
import { toObjectId } from "../utils/mongooseUtils"
import { isEncryptedSecret, SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import BaseAuthorizedService, { domainScopeForbidden } from "./BaseAuthorizedService"

/** Per map: well past any real backend, short of a document Mongo would refuse */
const MAX_VARIABLE_MAP_ENTRIES = 200
const MAX_VARIABLE_MAP_VALUE_LENGTH = 32 * 1024
/** Per kind attached to one backend */
const MAX_ATTACHED_MAPS = 50
const MAX_DESCRIPTION_LENGTH = 2000

/** The field of a backend that attaches maps of this kind */
const BACKEND_FIELD: Record<VariableMapKind, "configMapIds" | "secretIds"> = { configMap: "configMapIds", secret: "secretIds" }

const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: number })?.code === 11000

/**
 * The entries as they are stored: keys valid and unique, blank values dropped (the environment gets the value
 * of all, or the key stays unset there), every environment one of the project and at most once per key. A
 * secret that comes back as the placeholder keeps the value stored for that key and environment, or for all;
 * with none to keep, it is refused rather than saved literally.
 */
export const normalizeEntries = (entries: unknown, kind: VariableMapKind, environmentIds: Set<string>, stored: IVariableMapEntry[] = []): VariableMapEntryDTO[] => {
    if (!Array.isArray(entries) || entries.length > MAX_VARIABLE_MAP_ENTRIES) {
        throw createBusinessException({ code: "VARIABLE_MAP_ENTRIES_INVALID", message: `entries must be a list of at most ${MAX_VARIABLE_MAP_ENTRIES} keys` })
    }

    const keys = new Set<string>()
    return entries.map((entry: VariableMapEntryDTO) => {
        const key = typeof entry?.key === "string" ? entry.key.trim() : ""
        if (!BACKEND_VARIABLE_KEY.test(key)) {
            throw createBusinessException({ code: "VARIABLE_MAP_KEY_INVALID", message: `"${key}" is not a valid key: letters, digits and underscores, not starting with a digit` })
        }
        if (keys.has(key)) {
            throw createBusinessException({ code: "VARIABLE_MAP_KEY_DUPLICATED", message: `"${key}" appears more than once` })
        }
        keys.add(key)

        const storedEntry = stored.find(secret => secret.key === key)
        /** A typed value as it is stored, `kept` the one a placeholder stands for */
        const checked = (value: string, kept: string | undefined, where: string): string => {
            if (kind === "secret" && value === SECRET_PLACEHOLDER) {
                if (!kept) {
                    throw createBusinessException({ code: "VARIABLE_MAP_SECRET_VALUE_REQUIRED", message: `The secret "${key}" has no stored value ${where} to keep: type it` })
                }
                return kept
            }
            // Stored as typed, it would read as a ciphertext and make every load of the secret fail to decrypt
            if (kind === "secret" && isEncryptedSecret(value)) {
                throw createBusinessException({ code: "VARIABLE_MAP_VALUE_INVALID", message: `The value of "${key}" cannot start with "enc:v1:"` })
            }
            if (value.length > MAX_VARIABLE_MAP_VALUE_LENGTH) {
                throw createBusinessException({ code: "VARIABLE_MAP_VALUE_TOO_LONG", message: `The value of "${key}" exceeds ${MAX_VARIABLE_MAP_VALUE_LENGTH} characters` })
            }
            return value
        }

        const value = typeof entry.value === "string" && entry.value !== "" ? checked(entry.value, storedEntry?.value, "for all environments") : undefined
        const environments = new Set<string>()
        const values = (Array.isArray(entry.values) ? entry.values : []).flatMap(item => {
            const { environmentId, value } = (item ?? {}) as { environmentId?: unknown; value?: unknown }
            if (typeof value !== "string" || value === "") return []

            const environment = String(environmentId)
            if (!environmentIds.has(environment)) {
                throw createBusinessException({ code: "VARIABLE_MAP_ENVIRONMENT_UNKNOWN", message: `"${key}" has a value for ${environment}, which is not an environment of the project` })
            }
            if (environments.has(environment)) {
                throw createBusinessException({ code: "VARIABLE_MAP_ENVIRONMENT_DUPLICATED", message: `"${key}" has more than one value for environment ${environment}` })
            }
            environments.add(environment)

            const kept = storedEntry?.values.find(stored => String(stored.environmentId) === environment)?.value
            return [{ environmentId: environment, value: checked(value, kept, `for environment ${environment}`) }]
        })

        return { key, ...(value !== undefined && { value }), values }
    })
}

export type KeyedMap = Pick<IVariableMap, "name"> & { entries: Pick<IVariableMapEntry, "key">[] }

/** What the variables of a resource are named from: enough to compare them with the keys of the maps */
export type NamedResource = Pick<IResource, "_id" | "name" | "type" | "variant" | "envPrefix">

/** A resource read as a map of its keys: every variable of its variant, set or not */
export const resourceKeys = (resource: ResourceNaming): KeyedMap => ({ name: resource.name, entries: resourceEnvKeys(resource).map(({ key }) => ({ key })) })

/**
 * Every map attached to one backend ends up as variables of one container: a key set by two of them
 * would be there twice, with no telling which value wins.
 */
export const ensureNoKeyClash = (maps: KeyedMap[], backendName?: string) => {
    const owners = new Map<string, string>()
    for (const map of maps) {
        for (const { key } of map.entries) {
            const owner = owners.get(key)
            if (owner !== undefined) {
                throw createBusinessException({
                    code: "BACKEND_VARIABLE_KEY_DUPLICATED",
                    message: `"${key}" is set both by "${owner}" and by "${map.name}"${backendName ? `, both attached to ${backendName}` : ""}`,
                    details: { key, maps: [owner, map.name], ...(backendName && { backend: backendName }) }
                })
            }
            owners.set(key, map.name)
        }
    }
}

export const keysOnly = "name entries.key"
/** The fields the variables of a resource are named from; never its values */
export const resourceNaming = "name type variant envPrefix customFields"

/** The maps of the project with these ids, refused when one is missing or of another project */
const findAttachable = async (kind: VariableMapKind, ids: unknown, projectId: Schema.Types.ObjectId): Promise<{ ids: string[]; maps: KeyedMap[] }> => {
    const field = BACKEND_FIELD[kind]
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHED_MAPS || !ids.every(isValidObjectId)) {
        throw createBusinessException({ code: "BACKEND_VARIABLE_MAPS_INVALID", message: `${field} must be a list of at most ${MAX_ATTACHED_MAPS} ids` })
    }

    const unique = [...new Set(ids.map(String))]
    const maps = await variableMapModels[kind].find({ _id: { $in: unique.map(id => toObjectId(id)) }, projectId }, keysOnly)
    if (maps.length !== unique.length) {
        const found = new Set(maps.map(map => String(map._id)))
        throw createBusinessException({ code: "BACKEND_VARIABLE_MAP_UNKNOWN", message: `${field} holds ${unique.find(id => !found.has(id))}, which is not a ${kind} of the project` })
    }
    return { ids: unique, maps }
}

/** The resources of the project with these ids, refused as for the maps; none to look for reads nothing */
const findAttachableResources = async (ids: unknown, projectId: Schema.Types.ObjectId): Promise<{ ids: string[]; resources: NamedResource[] }> => {
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHED_MAPS || !ids.every(isValidObjectId)) {
        throw createBusinessException({ code: "BACKEND_RESOURCES_INVALID", message: `resourceIds must be a list of at most ${MAX_ATTACHED_MAPS} ids` })
    }

    const unique = [...new Set(ids.map(String))]
    if (unique.length === 0) return { ids: [], resources: [] }
    const resources = await Resource.find({ _id: { $in: unique.map(id => toObjectId(id)) }, projectId }, resourceNaming)
    if (resources.length !== unique.length) {
        const found = new Set(resources.map(resource => String(resource._id)))
        throw createBusinessException({ code: "BACKEND_RESOURCE_UNKNOWN", message: `resourceIds holds ${unique.find(id => !found.has(id))}, which is not a resource of the project` })
    }
    return { ids: unique, resources }
}

/**
 * The maps a backend attaches, checked: every id one of the project, no key set by two of them. A list
 * left out is compared as it is stored, and with all of them left out (an MCP update of the name, say)
 * nothing is read. Resources are read only with `resources`: a backend attaches them, a DOCKER
 * frontend going through here too does not.
 */
export const resolveAttachedMaps = async <T extends { configMapIds?: unknown; secretIds?: unknown; resourceIds?: unknown }>(
    dto: T,
    projectId: Schema.Types.ObjectId,
    existing?: IBackend,
    options: { resources?: boolean } = {}
): Promise<T> => {
    const resourceIds = options.resources ? dto.resourceIds : undefined
    if (dto.configMapIds === undefined && dto.secretIds === undefined && resourceIds === undefined) return dto

    const configMaps = await findAttachable("configMap", dto.configMapIds ?? existing?.configMapIds ?? [], projectId)
    const secrets = await findAttachable("secret", dto.secretIds ?? existing?.secretIds ?? [], projectId)
    const resources = options.resources ? await findAttachableResources(resourceIds ?? existing?.resourceIds ?? [], projectId) : { ids: [], resources: [] }
    ensureNoKeyClash([...configMaps.maps, ...secrets.maps, ...resources.resources.map(resourceKeys)], existing?.name)

    return {
        ...dto,
        ...(dto.configMapIds !== undefined && { configMapIds: configMaps.ids }),
        ...(dto.secretIds !== undefined && { secretIds: secrets.ids }),
        ...(resourceIds !== undefined && { resourceIds: resources.ids })
    }
}

/** A variable that reaches the container from what it attaches: its name and where it comes from, never its value */
export interface AttachedVariable {
    key: string
    secret: boolean
    source: "resource" | VariableMapKind
    /** The name of the resource or map that sets it */
    from: string
    /** A resource only: its type, e.g. database */
    resourceType?: string
}

/**
 * The keys of the variables the resources, config maps and secrets attached to a backend or a DOCKER
 * frontend set on its container: what its code can read, for a coding agent. Only names are read.
 */
export const attachedVariableKeys = async (
    component: { configMapIds?: unknown[]; secretIds?: unknown[]; resourceIds?: unknown[] },
    projectId: Schema.Types.ObjectId | string
): Promise<AttachedVariable[]> => {
    const ids = (list?: unknown[]) => (list ?? []).map(id => toObjectId(String(id)))
    const project = toObjectId(projectId)
    const [configMaps, secrets, resources] = await Promise.all([
        component.configMapIds?.length ? ConfigMap.find({ _id: { $in: ids(component.configMapIds) }, projectId: project }, keysOnly) : [],
        component.secretIds?.length ? Secret.find({ _id: { $in: ids(component.secretIds) }, projectId: project }, keysOnly) : [],
        component.resourceIds?.length ? Resource.find({ _id: { $in: ids(component.resourceIds) }, projectId: project }, resourceNaming) : []
    ])
    const ofMaps = (maps: KeyedMap[], source: VariableMapKind, secret: boolean) => maps.flatMap(map => map.entries.map(({ key }) => ({ key, secret, source, from: map.name })))
    return [
        ...resources.flatMap(resource => resourceEnvKeys(resource).map(({ key, secret }) => ({ key, secret, source: "resource" as const, from: resource.name, resourceType: resource.type }))),
        ...ofMaps(configMaps, "configMap", false),
        ...ofMaps(secrets, "secret", true)
    ]
}

/**
 * The maps of this kind a domain-scoped member may see and edit: those attached to at least one backend or
 * DOCKER frontend, all of them in `scope`. A map shared with a component of another domain, or of
 * none, or attached to nothing, belongs to nobody assigned to only some domains.
 */
export const mapIdsInScope = async (kind: VariableMapKind, projectId: Schema.Types.ObjectId, scope: string[]): Promise<Set<string>> => {
    const field = BACKEND_FIELD[kind]
    const attaching = { projectId, [field]: { $exists: true, $ne: [] } }
    const fields = { domainId: 1, configMapIds: 1, secretIds: 1 }
    const components = [...(await Backend.find(attaching, fields)), ...(await Frontend.find(attaching, fields)), ...(await MaintenanceAgent.find(attaching, fields))]
    const inScope = new Set<string>()
    const outOfScope = new Set<string>()
    for (const component of components) {
        const target = component.domainId && scope.includes(String(component.domainId)) ? inScope : outOfScope
        for (const id of component[field] ?? []) target.add(String(id))
    }
    return new Set([...inScope].filter(id => !outOfScope.has(id)))
}

/**
 * A domain-scoped member attaches to a backend or a DOCKER only the config maps and secrets they can see,
 * those attached exclusively to components of their domains: anything else would hand them the values of
 * another domain. The maps the component already attaches stay, whoever attached them. `scope` is the
 * caller's domain scope, nothing to check without one.
 */
export const ensureAttachableMaps = async (
    scope: string[] | undefined,
    projectId: Schema.Types.ObjectId,
    dto: { configMapIds?: unknown; secretIds?: unknown },
    existing?: { configMapIds?: unknown[]; secretIds?: unknown[] }
) => {
    if (!scope) return
    for (const [kind, field] of [
        ["configMap", "configMapIds"],
        ["secret", "secretIds"]
    ] as const) {
        const attached = new Set((existing?.[field] ?? []).map(String))
        const added = ((dto[field] as unknown[] | undefined) ?? []).map(String).filter(id => !attached.has(id))
        if (added.length === 0) continue
        const visible = await mapIdsInScope(kind, projectId, scope)
        if (added.some(id => !visible.has(id))) throw domainScopeForbidden()
    }
}

/** The config maps or the secrets of a project, which its backends attach */
export class VariableMapService extends BaseAuthorizedService {
    constructor(
        private readonly kind: VariableMapKind,
        ...args: ConstructorParameters<typeof BaseAuthorizedService>
    ) {
        super(...args)
    }

    private get model() {
        return variableMapModels[this.kind]
    }

    private get backendField() {
        return BACKEND_FIELD[this.kind]
    }

    async getByProjectId(projectId: string | Schema.Types.ObjectId): Promise<IVariableMap[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        const scope = await this.getDomainScope(projectIdObj)
        const visible = scope ? { _id: { $in: [...(await mapIdsInScope(this.kind, projectIdObj, scope))].map(id => toObjectId(id)) } } : {}
        return await this.model.find({ projectId: projectIdObj, ...visible }).sort({ name: 1 })
    }

    async getById(id: string | ObjectId): Promise<IVariableMap> {
        const map = await this.model.findById(toObjectId(id))
        if (!map) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureAccessToProject(map.projectId)
        const scope = await this.getDomainScope(map.projectId)
        if (scope && !(await mapIdsInScope(this.kind, map.projectId, scope)).has(String(map._id))) {
            throw domainScopeForbidden()
        }
        return map
    }

    /**
     * The fields a caller may write, picked by name: anything else in the body, an update operator such as
     * `$push` included, never reaches Mongo, where it would skip the checks below and the encryption.
     */
    private async normalize(dto: Partial<VariableMapDTO>, projectId: Schema.Types.ObjectId, existing?: IVariableMap): Promise<Partial<Pick<VariableMapDTO, "name" | "description" | "entries">>> {
        const { name: typedName, description, entries } = (dto ?? {}) as Partial<VariableMapDTO>
        const fields: Partial<Pick<VariableMapDTO, "name" | "description" | "entries">> = {}

        if (typedName !== undefined) {
            const name = typeof typedName === "string" ? typedName.trim().toLowerCase() : ""
            if (!VARIABLE_MAP_NAME.test(name)) {
                throw createBusinessException({
                    code: "VARIABLE_MAP_NAME_INVALID",
                    message: `"${name}" is not a valid name: at most 63 lowercase letters, digits or dashes, starting and ending with a letter or digit`
                })
            }
            fields.name = name
        }
        if (description !== undefined) {
            if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
                throw createBusinessException({ code: "VARIABLE_MAP_DESCRIPTION_INVALID", message: `The description must be text of at most ${MAX_DESCRIPTION_LENGTH} characters` })
            }
            fields.description = description
        }
        if (entries !== undefined) {
            const environmentIds = new Set((await Environment.find({ projectId }, { _id: 1 })).map(environment => String(environment._id)))
            fields.entries = normalizeEntries(entries, this.kind, environmentIds, existing?.entries)
        }
        return fields
    }

    private refuseTakenName(error: unknown, name?: string): never {
        if (isDuplicateKeyError(error)) {
            throw createBusinessException({ code: "VARIABLE_MAP_NAME_TAKEN", message: `A ${this.kind} named "${name}" already exists in this project`, statusCode: 409 })
        }
        throw error
    }

    async create(dto: VariableMapDTO, projectId: string | Schema.Types.ObjectId): Promise<IVariableMap> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        // A new map is attached to nothing yet, so it would be outside any domain scope from the start
        await this.ensureWholeProject(projectIdObj)

        const fields = await this.normalize({ entries: [], ...dto, name: dto.name ?? "" }, projectIdObj)
        try {
            return await this.model.create({ ...fields, projectId: projectIdObj } as unknown as IVariableMap)
        } catch (error) {
            this.refuseTakenName(error, fields.name)
        }
    }

    async update(id: string | ObjectId, dto: Partial<VariableMapDTO>): Promise<IVariableMap | null> {
        const map = await this.getById(id)
        const fields = await this.normalize(dto, map.projectId, map)
        if (fields.entries) {
            await this.ensureNoClashInAttachingBackends(map, fields.entries)
        }
        try {
            return await this.model.findByIdAndUpdate(map._id, { $set: fields }, { new: true, runValidators: true })
        } catch (error) {
            this.refuseTakenName(error, fields.name)
        }
    }

    /** What attaches this map: its backends, its DOCKER frontends and its maintenance agents, each a container of its own */
    private async attachedTo(map: IVariableMap): Promise<Array<Pick<IBackend, "name" | "configMapIds" | "secretIds"> & Partial<Pick<IBackend, "resourceIds">>>> {
        const filter = { projectId: map.projectId, [this.backendField]: map._id }
        const projection = { name: 1, configMapIds: 1, secretIds: 1, resourceIds: 1 }
        const [backends, frontends, agents] = await Promise.all([Backend.find(filter, projection), Frontend.find(filter, projection), MaintenanceAgent.find(filter, projection)])
        // A DOCKER carries the same container fields as a backend, resources aside: the projection reads only those
        return [...backends, ...frontends, ...agents] as unknown as Array<Pick<IBackend, "name" | "configMapIds" | "secretIds"> & Partial<Pick<IBackend, "resourceIds">>>
    }

    /** New keys must not collide with those of the other maps attached to any backend or DOCKER using this one */
    private async ensureNoClashInAttachingBackends(map: IVariableMap, entries: VariableMapEntryDTO[]) {
        const backends = await this.attachedTo(map)
        if (backends.length === 0) return

        // One read per kind for all of them; this map is read with the new entries, not the stored ones
        const configMaps = await ConfigMap.find({ _id: { $in: backends.flatMap(backend => backend.configMapIds ?? []) }, projectId: map.projectId }, keysOnly)
        const secrets = await Secret.find({ _id: { $in: backends.flatMap(backend => backend.secretIds ?? []) }, projectId: map.projectId }, keysOnly)
        // Read only when one of them attaches a resource: most backends attach none
        const resourceIds = backends.flatMap(backend => backend.resourceIds ?? [])
        const resources = resourceIds.length > 0 ? await Resource.find({ _id: { $in: resourceIds }, projectId: map.projectId }, resourceNaming) : []
        const byId = new Map<string, KeyedMap>([
            ...configMaps.map(other => [`configMap:${other._id}`, other] as const),
            ...secrets.map(other => [`secret:${other._id}`, other] as const),
            ...resources.map(resource => [`resource:${resource._id}`, resourceKeys(resource)] as const),
            [`${this.kind}:${map._id}`, { name: map.name, entries }]
        ])

        for (const backend of backends) {
            const attached = [
                ...(backend.configMapIds ?? []).map(id => `configMap:${id}`),
                ...(backend.secretIds ?? []).map(id => `secret:${id}`),
                ...(backend.resourceIds ?? []).map(id => `resource:${id}`)
            ]
            ensureNoKeyClash(
                attached.flatMap(key => byId.get(key) ?? []),
                backend.name
            )
        }
    }

    /** Refused while a backend attaches it: deleting it would silently take variables away from a running container */
    async delete(id: string | ObjectId): Promise<IVariableMap | null> {
        const map = await this.getById(id)
        await this.ensureWholeProject(map.projectId)
        const backends = await this.attachedTo(map)
        if (backends.length > 0) {
            throw createBusinessException({
                code: "VARIABLE_MAP_IN_USE",
                message: `"${map.name}" is attached to ${backends.map(backend => backend.name).join(", ")}: detach it first`,
                statusCode: 409,
                details: { backends: backends.map(backend => backend.name) }
            })
        }
        return this.model.findByIdAndDelete(map._id)
    }
}

export default VariableMapService
