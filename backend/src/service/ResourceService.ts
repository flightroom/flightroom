import { ObjectId, Schema } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Resource, { IResource, IResourceValue } from "../models/ResourceModel"
import { ConfigMap, Secret } from "../models/VariableMapModel"
import {
    isResourceType,
    MAX_RESOURCE_CUSTOM_FIELDS,
    RESERVED_ENV_KEYS,
    RESOURCE_CATALOG,
    RESOURCE_CUSTOM_FIELD_NAME,
    RESOURCE_ENV_PREFIX,
    ResourceCustomField,
    ResourceFieldSpec,
    ResourceNaming,
    ResourceTypeSpec,
    ResourceVariantSpec,
    resourceEnvKeys,
    resourceVariant
} from "../types/ResourceCatalog"
import ResourceDTO from "../types/ResourceDTO"
import { VARIABLE_MAP_NAME } from "../types/VariableMapDTO"
import { toObjectId } from "../utils/mongooseUtils"
import { isEncryptedSecret, SECRET_PLACEHOLDER } from "../utils/secretCrypto"
import { parseApiDocument } from "./aiChange/apiSpecReader"
import BaseAuthorizedService, { domainScopeForbidden } from "./BaseAuthorizedService"
import { ensureNoKeyClash, KeyedMap, keysOnly, resourceKeys, resourceNaming } from "./VariableMapService"

/** As for a value of a config map: well past any real credential, short of a document Mongo would refuse */
const MAX_RESOURCE_VALUE_LENGTH = 32 * 1024
const MAX_DESCRIPTION_LENGTH = 2000
/** A large OpenAPI document of a whole API, well inside the 16 MB of a Mongo document */
const MAX_API_SPEC_BYTES = 5 * 1024 * 1024

const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: number })?.code === 11000

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Where a credential keeps its value of all, among the ids of the environments it keeps an override in */
const ALL = ""

/** A field as it is stored; Mongoose casts the environments */
export interface NormalizedResourceValue {
    field: string
    value?: string
    overrides: Array<{ environmentId: string; value: string }>
}

/** What a caller may write on a resource, checked; an apiSpec of null removes the stored one */
type ResourceFields = Partial<Pick<IResource, "name" | "type" | "variant" | "description" | "envPrefix" | "customFields" | "apiSpecBytes">> & {
    values?: NormalizedResourceValue[]
    secrets?: NormalizedResourceValue[]
    apiSpec?: string | null
}

/**
 * The pasted document of an API, checked as read_api_spec reads it (parseApiDocument): what is saved here
 * is what the agent can read later.
 */
export const ensureValidApiSpec = (spec: string) => {
    if (Buffer.byteLength(spec, "utf8") > MAX_API_SPEC_BYTES) {
        throw createBusinessException({ code: "RESOURCE_API_SPEC_INVALID", message: `The API document exceeds ${MAX_API_SPEC_BYTES / 1024 / 1024} MiB` })
    }
    try {
        parseApiDocument(spec)
    } catch (error) {
        throw createBusinessException({ code: "RESOURCE_API_SPEC_INVALID", message: (error as Error).message })
    }
}

/**
 * The variables a `generic` resource defines, checked: each named as the end of a variable, in capitals, once.
 * Their values follow from normalizeResourceFields, which keeps a stored value only under the same name and in
 * the same list: a field renamed or removed loses it, and one turned from a credential to a plain value (or
 * back) does too, so a stored credential never comes back readable.
 */
export const normalizeCustomFields = (sent: unknown): ResourceCustomField[] => {
    const refuse = (message: string): never => {
        throw createBusinessException({ code: "RESOURCE_CUSTOM_FIELDS_INVALID", message })
    }
    if (!Array.isArray(sent)) return refuse("customFields must be a list of { name, secret }")
    if (sent.length > MAX_RESOURCE_CUSTOM_FIELDS) refuse(`A resource defines at most ${MAX_RESOURCE_CUSTOM_FIELDS} variables`)
    const names = new Set<string>()
    return sent.map(item => {
        if (!isPlainObject(item) || typeof item.name !== "string" || (item.secret !== undefined && typeof item.secret !== "boolean")) {
            return refuse("Each custom field must be an object with a name and whether it is secret")
        }
        const name = item.name.trim().toUpperCase()
        if (!RESOURCE_CUSTOM_FIELD_NAME.test(name)) refuse(`"${name}" is not a valid variable name: at most 61 capital letters, digits or underscores`)
        if (names.has(name)) refuse(`"${name}" is defined twice`)
        names.add(name)
        return { name, secret: item.secret === true }
    })
}

/** An absolute address a client can call as it is; one carrying a user or a password would put a credential in a plain value */
const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value)
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    } catch {
        return false
    }
}

/** An address mail can be sent from: one @, no whitespace, a dot in the domain. A full RFC 5322 parse is the server's job */
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The input of the catalog holds as much as the console does: a select takes its options, a number is a port */
const ensureValidValue = (spec: ResourceFieldSpec, value: string) => {
    const refuse = (reason: string) => {
        throw createBusinessException({ code: "RESOURCE_VALUE_INVALID", message: `The value of "${spec.name}" ${reason}` })
    }
    if (value.length > MAX_RESOURCE_VALUE_LENGTH) refuse(`exceeds ${MAX_RESOURCE_VALUE_LENGTH} characters`)
    // Stored as typed, it would read as a ciphertext and make every load of the resource fail to decrypt
    if (spec.secret && isEncryptedSecret(value)) refuse('cannot start with "enc:v1:"')
    if (spec.input === "number" && !(/^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)) refuse("must be a port, from 1 to 65535")
    if (spec.input === "boolean" && value !== "true" && value !== "false") refuse('must be "true" or "false"')
    if (spec.input === "select" && !spec.options?.includes(value)) refuse(`must be one of ${spec.options?.join(", ")}`)
    if (spec.input === "url" && !isHttpUrl(value)) refuse("must be an absolute http or https URL, without a user or a password")
    if (spec.input === "email" && !EMAIL_ADDRESS.test(value)) refuse("must be an email address")
}

/**
 * One field as it is stored: blank values dropped (unset there), every override for an environment of
 * the project and at most one per environment. A credential that comes back as the placeholder keeps
 * the value stored in the same place, told to `onKept`; with none to keep, it is refused rather than saved
 * literally. Undefined when nothing is left.
 */
const normalizeField = (spec: ResourceFieldSpec, sent: unknown, environmentIds: Set<string>, stored?: IResourceValue, onKept?: (environment?: string) => void): NormalizedResourceValue | undefined => {
    if (sent === null) return undefined
    if (!isPlainObject(sent)) {
        throw createBusinessException({ code: "RESOURCE_VALUE_INVALID", message: `"${spec.name}" must be an object with a value and its overrides` })
    }

    const resolve = (value: unknown, environment?: string): string | undefined => {
        if (value === undefined || value === null || value === "") return undefined
        if (typeof value !== "string") {
            throw createBusinessException({ code: "RESOURCE_VALUE_INVALID", message: `The value of "${spec.name}" must be text` })
        }
        if (spec.secret && value === SECRET_PLACEHOLDER) {
            const kept = environment === undefined ? stored?.value : stored?.overrides.find(override => String(override.environmentId) === environment)?.value
            if (!kept) {
                throw createBusinessException({
                    code: "RESOURCE_SECRET_VALUE_REQUIRED",
                    message: `"${spec.name}" has no stored value${environment === undefined ? "" : ` for environment ${environment}`} to keep: type it`
                })
            }
            onKept?.(environment)
            return kept
        }
        // A variable of a generic turned plain, sent back as it was masked: the mask is not a value
        if (value === SECRET_PLACEHOLDER) {
            throw createBusinessException({ code: "RESOURCE_VALUE_INVALID", message: `"${spec.name}" is not a credential: type its value` })
        }
        ensureValidValue(spec, value)
        return value
    }

    const { value, overrides = [] } = sent as { value?: unknown; overrides?: unknown }
    if (!Array.isArray(overrides)) {
        throw createBusinessException({ code: "RESOURCE_VALUE_INVALID", message: `The overrides of "${spec.name}" must be a list` })
    }

    const environments = new Set<string>()
    const kept = overrides.flatMap(item => {
        if (!isPlainObject(item)) {
            throw createBusinessException({ code: "RESOURCE_FIELDS_INVALID", message: `An override of "${spec.name}" must be an object with an environmentId and a value` })
        }
        const environment = String(item.environmentId)
        // Before the value is read: a placeholder for an environment of another project must not reach what is stored
        if (!environmentIds.has(environment)) {
            throw createBusinessException({ code: "RESOURCE_ENVIRONMENT_UNKNOWN", message: `"${spec.name}" has a value for ${environment}, which is not an environment of the project` })
        }
        const resolved = resolve(item.value, environment)
        if (resolved === undefined) return []
        if (environments.has(environment)) {
            throw createBusinessException({ code: "RESOURCE_ENVIRONMENT_DUPLICATED", message: `"${spec.name}" has more than one value for environment ${environment}` })
        }
        environments.add(environment)
        return [{ environmentId: environment, value: resolved }]
    })

    const base = resolve(value)
    if (base === undefined && kept.length === 0) return undefined
    return { field: spec.name, ...(base !== undefined && { value: base }), overrides: kept }
}

/**
 * The fields of a resource as they are stored, split between plain values and credentials by the
 * catalog, never by the client. Only the fields of the variant are taken. On an update a field left
 * out keeps what is stored, one sent replaces it overrides included, and a field of another variant
 * (left from a change of variant) goes. A required field that is not a credential needs a value in every
 * environment, its own or the one of all; a required credential may stay unset, as a secret may.
 *
 * A credential kept as stored (sent back as the placeholder, or left out) must be typed again when a
 * connection field changes, as the stored value would otherwise go to an address the writer chose:
 * - a change of variant, or of the value of all of a connection field: every credential kept, anywhere;
 * - a change of the override of a connection field in an environment only: the value each credential
 *   takes in that environment, its override there if it has one, its value of all otherwise.
 */
export const normalizeResourceFields = (
    fields: unknown,
    variant: ResourceVariantSpec,
    environmentIds: Set<string>,
    stored: Pick<IResource, "values" | "secrets"> = { values: [], secrets: [] },
    { variantChanged = false }: { variantChanged?: boolean } = {}
): Pick<Required<ResourceFields>, "values" | "secrets"> => {
    if (fields !== undefined && !isPlainObject(fields)) {
        throw createBusinessException({ code: "RESOURCE_FIELDS_INVALID", message: "fields must be an object keyed by field name" })
    }
    const sent = fields ?? {}
    const unknown = Object.keys(sent).find(name => !variant.fields.some(spec => spec.name === name))
    if (unknown !== undefined) {
        throw createBusinessException({ code: "RESOURCE_FIELD_UNKNOWN", message: `"${unknown}" is not a field of the variant ${variant.id}: ${variant.fields.map(spec => spec.name).join(", ")}` })
    }

    const result: Pick<Required<ResourceFields>, "values" | "secrets"> = { values: [], secrets: [] }
    // By credential, where it keeps its stored value: ALL for the value of all, an environment id for its override there
    const keptSecrets = new Map<string, Set<string>>()
    const changedConnections: string[] = variantChanged ? ["variant"] : []
    let changedEverywhere = variantChanged
    const changedEnvironments = new Set<string>()
    for (const spec of variant.fields) {
        const storedField = (spec.secret ? stored.secrets : stored.values).find(candidate => candidate.field === spec.name)
        const keep = (environment = ALL) => keptSecrets.set(spec.name, (keptSecrets.get(spec.name) ?? new Set()).add(environment))
        const isSent = Object.hasOwn(sent, spec.name)
        const normalized = isSent
            ? normalizeField(spec, sent[spec.name], environmentIds, storedField, keep)
            : storedField && {
                  field: spec.name,
                  ...(storedField.value !== undefined && { value: storedField.value }),
                  overrides: storedField.overrides.map(override => ({ environmentId: String(override.environmentId), value: override.value }))
              }
        if (!isSent && spec.secret && normalized) {
            if (normalized.value !== undefined) keep()
            for (const override of normalized.overrides) keep(override.environmentId)
        }
        if (spec.connection && isSent) {
            const overridesOf = (field?: { overrides: Array<{ environmentId: unknown; value: string }> }) =>
                new Map((field?.overrides ?? []).map(override => [String(override.environmentId), override.value]))
            const before = overridesOf(storedField)
            const after = overridesOf(normalized)
            const environments = [...new Set([...before.keys(), ...after.keys()])].filter(environment => before.get(environment) !== after.get(environment))
            const valueChanged = storedField?.value !== normalized?.value
            if (valueChanged || environments.length > 0) changedConnections.push(spec.name)
            if (valueChanged) changedEverywhere = true
            for (const environment of environments) changedEnvironments.add(environment)
        }

        if (spec.required && !spec.secret) {
            const overridden = new Set(normalized?.overrides.map(override => override.environmentId))
            const everywhere = normalized?.value !== undefined || (environmentIds.size > 0 && [...environmentIds].every(environment => overridden.has(environment)))
            if (!everywhere) {
                throw createBusinessException({ code: "RESOURCE_VALUE_REQUIRED", message: `"${spec.name}" needs a value in every environment: give it one for all of them, or one in each` })
            }
        }
        if (normalized) (spec.secret ? result.secrets : result.values).push(normalized)
    }

    const toRetype = [...keptSecrets]
        .filter(([field, kept]) => {
            if (changedEverywhere) return true
            const overridden = new Set(result.secrets.find(secret => secret.field === field)?.overrides.map(override => override.environmentId))
            return [...changedEnvironments].some(environment => kept.has(overridden.has(environment) ? environment : ALL))
        })
        .map(([field]) => field)
    if (toRetype.length > 0) {
        throw createBusinessException({
            code: "RESOURCE_SECRET_REENTRY_REQUIRED",
            message: `${changedConnections.join(", ")} changed: type ${toRetype.join(", ")} again, the stored value is not sent to another address`,
            details: { secrets: toRetype, connections: changedConnections }
        })
    }
    return result
}

/** The variables the chart sets on every container are not a resource's to set */
const ensureNoReservedKey = (resource: ResourceNaming) => {
    const reserved = resourceEnvKeys(resource).find(({ key }) => RESERVED_ENV_KEYS.includes(key))
    if (reserved) {
        throw createBusinessException({ code: "RESOURCE_ENV_PREFIX_INVALID", message: `${reserved.key} is set by the platform on every container: choose another prefix` })
    }
}

const keysOf = (resource: ResourceNaming): string =>
    resourceEnvKeys(resource)
        .map(({ key }) => key)
        .join(",")

/**
 * The resources a domain-scoped member may see and edit: those attached to at least one backend, all of
 * them in `scope`, as for the maps. Only backends attach resources.
 */
export const resourceIdsInScope = async (projectId: Schema.Types.ObjectId, scope: string[]): Promise<Set<string>> => {
    const filter = { projectId, resourceIds: { $exists: true, $ne: [] } }
    const backends = [...(await Backend.find(filter, { domainId: 1, resourceIds: 1 })), ...(await MaintenanceAgent.find(filter, { domainId: 1, resourceIds: 1 }))]
    const inScope = new Set<string>()
    const outOfScope = new Set<string>()
    for (const backend of backends) {
        const target = backend.domainId && scope.includes(String(backend.domainId)) ? inScope : outOfScope
        for (const id of backend.resourceIds ?? []) target.add(String(id))
    }
    return new Set([...inScope].filter(id => !outOfScope.has(id)))
}

/**
 * A domain-scoped member attaches to a backend only the resources they can see, as for the maps: anything
 * else would hand them the credentials of another domain. The resources the backend already attaches stay.
 */
export const ensureAttachableResources = async (scope: string[] | undefined, projectId: Schema.Types.ObjectId, dto: { resourceIds?: unknown }, existing?: { resourceIds?: unknown[] }) => {
    if (!scope) return
    const attached = new Set((existing?.resourceIds ?? []).map(String))
    const added = ((dto.resourceIds as unknown[] | undefined) ?? []).map(String).filter(id => !attached.has(id))
    if (added.length === 0) return
    const visible = await resourceIdsInScope(projectId, scope)
    if (added.some(id => !visible.has(id))) throw domainScopeForbidden()
}

/**
 * The list of resources a domain-scoped member saves a backend with, with the resources it attaches that they
 * cannot see put back: they can neither add those nor take them away, and the console never shows them. Merged
 * before the list is checked, so that a clash of what they add with one of those is refused too.
 */
export const withResourcesOutOfScope = async <T extends { resourceIds?: unknown }>(
    scope: string[] | undefined,
    projectId: Schema.Types.ObjectId,
    dto: T,
    existing?: { resourceIds?: unknown[] }
): Promise<T> => {
    if (!scope || !Array.isArray(dto.resourceIds) || !existing?.resourceIds?.length) return dto
    const visible = await resourceIdsInScope(projectId, scope)
    const sent = new Set(dto.resourceIds.map(String))
    const hidden = existing.resourceIds.filter(id => !visible.has(String(id)) && !sent.has(String(id)))
    return hidden.length > 0 ? { ...dto, resourceIds: [...dto.resourceIds, ...hidden] } : dto
}

/** The resources of a project, which its backends attach */
export class ResourceService extends BaseAuthorizedService {
    /** The types a resource can be, with their variants and fields */
    catalog(): ResourceTypeSpec[] {
        return Object.values(RESOURCE_CATALOG)
    }

    async getByProjectId(projectId: string | Schema.Types.ObjectId): Promise<IResource[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        const scope = await this.getDomainScope(projectIdObj)
        const visible = scope ? { _id: { $in: [...(await resourceIdsInScope(projectIdObj, scope))].map(id => toObjectId(id)) } } : {}
        return await Resource.find({ projectId: projectIdObj, ...visible }).sort({ name: 1 })
    }

    async getById(id: string | ObjectId): Promise<IResource> {
        const resource = await Resource.findById(toObjectId(id))
        if (!resource) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureAccessToProject(resource.projectId)
        const scope = await this.getDomainScope(resource.projectId)
        if (scope && !(await resourceIdsInScope(resource.projectId, scope)).has(String(resource._id))) {
            throw domainScopeForbidden()
        }
        return resource
    }

    /**
     * The fields a caller may write, picked by name: anything else in the body, an update operator such as
     * `$push` included, never reaches Mongo, where it would skip the checks below and the encryption.
     */
    private async normalize(dto: Partial<ResourceDTO>, projectId: Schema.Types.ObjectId, existing?: IResource): Promise<ResourceFields> {
        const { name: typedName, type, variant: typedVariant, description, envPrefix: typedPrefix, fields: typedFields, customFields: typedCustomFields } = (dto ?? {}) as Partial<ResourceDTO>
        const fields: ResourceFields = {}

        if (typedName !== undefined) {
            const name = typeof typedName === "string" ? typedName.trim().toLowerCase() : ""
            if (!VARIABLE_MAP_NAME.test(name)) {
                throw createBusinessException({
                    code: "RESOURCE_NAME_INVALID",
                    message: `"${name}" is not a valid name: at most 63 lowercase letters, digits or dashes, starting and ending with a letter or digit`
                })
            }
            fields.name = name
        }
        if (description !== undefined) {
            if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
                throw createBusinessException({ code: "RESOURCE_DESCRIPTION_INVALID", message: `The description must be text of at most ${MAX_DESCRIPTION_LENGTH} characters` })
            }
            fields.description = description
        }
        if (typedPrefix !== undefined) {
            const prefix = typeof typedPrefix === "string" ? typedPrefix.trim().toUpperCase() : typedPrefix
            if (prefix !== null && prefix !== "" && (typeof prefix !== "string" || !RESOURCE_ENV_PREFIX.test(prefix))) {
                throw createBusinessException({
                    code: "RESOURCE_ENV_PREFIX_INVALID",
                    message: `"${prefix}" is not a valid prefix: at most 191 capital letters, digits or underscores, not starting with a digit`
                })
            }
            // Blank goes back to the prefix derived from the type and the name
            fields.envPrefix = prefix || null
        }

        // The variables, and what the console shows, follow from the type: a database does not become a storage
        if (existing) {
            if (type !== undefined && type !== existing.type) {
                throw createBusinessException({ code: "RESOURCE_TYPE_IMMUTABLE", message: `"${existing.name}" is a ${existing.type}: create another resource for a ${type}` })
            }
        } else {
            if (!isResourceType(type)) {
                throw createBusinessException({ code: "RESOURCE_TYPE_INVALID", message: `"${type}" is not a type of resource: one of ${Object.keys(RESOURCE_CATALOG).join(", ")}` })
            }
            fields.type = type
        }

        const resourceType = existing?.type ?? fields.type
        if (typedCustomFields !== undefined) {
            if (resourceType !== "generic") {
                throw createBusinessException({ code: "RESOURCE_CUSTOM_FIELDS_INVALID", message: "Only a resource of type generic defines its own variables" })
            }
            fields.customFields = normalizeCustomFields(typedCustomFields)
        } else if (!existing && resourceType === "generic") {
            fields.customFields = []
        }
        if (typedVariant !== undefined) fields.variant = typedVariant
        const variant = resourceVariant(resourceType, fields.variant ?? existing?.variant, fields.customFields ?? existing?.customFields)
        if (!variant) {
            const variants = RESOURCE_CATALOG[resourceType as ResourceTypeSpec["type"]].variants.map(candidate => candidate.id).join(", ")
            throw createBusinessException({
                code: "RESOURCE_VARIANT_INVALID",
                message: fields.variant === undefined ? `A ${resourceType} needs a variant: one of ${variants}` : `"${fields.variant}" is not a variant of ${resourceType}: one of ${variants}`
            })
        }
        const typedSpec = (dto as { apiSpec?: unknown } | undefined)?.apiSpec
        if (typedSpec !== undefined) {
            if (resourceType !== "api") {
                throw createBusinessException({ code: "RESOURCE_API_SPEC_INVALID", message: "Only a resource of type api has an API document" })
            }
            if (typedSpec !== null && typeof typedSpec !== "string") {
                throw createBusinessException({ code: "RESOURCE_API_SPEC_INVALID", message: "The API document must be text" })
            }
            if (typedSpec?.trim()) {
                ensureValidApiSpec(typedSpec)
                fields.apiSpec = typedSpec
                fields.apiSpecBytes = Buffer.byteLength(typedSpec, "utf8")
            } else {
                fields.apiSpec = null
            }
        }
        // A change of variant, or of the variables a generic one defines, drops the fields it does not have, so it goes through here even with no field sent
        if (typedFields !== undefined || fields.variant !== undefined || fields.customFields !== undefined) {
            const environmentIds = new Set((await Environment.find({ projectId }, { _id: 1 })).map(environment => String(environment._id)))
            const variantChanged = existing !== undefined && fields.variant !== undefined && fields.variant !== existing.variant
            Object.assign(fields, normalizeResourceFields(typedFields, variant, environmentIds, existing, { variantChanged }))
        }
        return fields
    }

    private refuseTakenName(error: unknown, name?: string): never {
        if (isDuplicateKeyError(error)) {
            throw createBusinessException({ code: "RESOURCE_NAME_TAKEN", message: `A resource named "${name}" already exists in this project`, statusCode: 409 })
        }
        throw error
    }

    async create(dto: ResourceDTO, projectId: string | Schema.Types.ObjectId): Promise<IResource> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        // A new resource is attached to nothing yet, so it would be outside any domain scope from the start
        await this.ensureWholeProject(projectIdObj)

        const { apiSpec, ...fields } = await this.normalize({ ...dto, name: dto?.name ?? "" }, projectIdObj)
        ensureNoReservedKey(fields as ResourceNaming)
        try {
            return await Resource.create({ ...fields, ...(apiSpec && { apiSpec }), projectId: projectIdObj } as unknown as IResource)
        } catch (error) {
            this.refuseTakenName(error, fields.name)
        }
    }

    async update(id: string | ObjectId, dto: Partial<ResourceDTO>): Promise<IResource | null> {
        const resource = await this.getById(id)
        const fields = await this.normalize(dto, resource.projectId, resource)
        const next: ResourceNaming = {
            name: fields.name ?? resource.name,
            type: resource.type,
            variant: fields.variant ?? resource.variant,
            envPrefix: fields.envPrefix !== undefined ? fields.envPrefix : resource.envPrefix,
            customFields: fields.customFields ?? resource.customFields
        }
        ensureNoReservedKey(next)
        // A rename, a prefix or a variant renames its variables: they must not clash where it is attached
        if (keysOf(next) !== keysOf(resource)) {
            await this.ensureNoClashInAttachingBackends(resource, next)
        }
        // A document removed goes with its size; one replaced brings its own
        const { apiSpec, ...set } = fields
        const write = apiSpec === null ? { $set: set, $unset: { apiSpec: "", apiSpecBytes: "" } } : { $set: { ...set, ...(apiSpec !== undefined && { apiSpec }) } }
        try {
            return await Resource.findByIdAndUpdate(resource._id, write, { new: true, runValidators: true })
        } catch (error) {
            this.refuseTakenName(error, fields.name)
        }
    }

    /** The pasted document of an API as it was typed, for whoever may read the resource */
    async getApiSpec(id: string | ObjectId): Promise<string> {
        const resource = await this.getById(id)
        const apiSpec = (await Resource.findById(resource._id, "+apiSpec"))?.apiSpec
        if (!apiSpec) {
            throw new EntityNotFoundError(String(resource._id), `"${resource.name}" has no API document`)
        }
        return apiSpec
    }

    /** The backends and the maintenance agents attaching this resource; a frontend never does */
    private async attachedTo(resource: IResource) {
        const filter = { projectId: resource.projectId, resourceIds: resource._id }
        const projection = { name: 1, configMapIds: 1, secretIds: 1, resourceIds: 1 }
        return [...(await Backend.find(filter, projection)), ...(await MaintenanceAgent.find(filter, projection))]
    }

    /** The new variables must not collide with those of anything else attached to a backend using this resource */
    private async ensureNoClashInAttachingBackends(resource: IResource, next: ResourceNaming) {
        const backends = await this.attachedTo(resource)
        if (backends.length === 0) return

        // One read per kind for all of them; this resource is read with its new variables, not the stored ones
        const projectId = resource.projectId
        const configMaps = await ConfigMap.find({ _id: { $in: backends.flatMap(backend => backend.configMapIds ?? []) }, projectId }, keysOnly)
        const secrets = await Secret.find({ _id: { $in: backends.flatMap(backend => backend.secretIds ?? []) }, projectId }, keysOnly)
        const resources = await Resource.find({ _id: { $in: backends.flatMap(backend => backend.resourceIds ?? []) }, projectId }, resourceNaming)
        const byId = new Map<string, KeyedMap>([
            ...configMaps.map(other => [`configMap:${other._id}`, other] as const),
            ...secrets.map(other => [`secret:${other._id}`, other] as const),
            ...resources.map(other => [`resource:${other._id}`, resourceKeys(other)] as const),
            [`resource:${resource._id}`, resourceKeys(next)]
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
    async delete(id: string | ObjectId): Promise<IResource | null> {
        const resource = await this.getById(id)
        await this.ensureWholeProject(resource.projectId)
        const backends = await this.attachedTo(resource)
        if (backends.length > 0) {
            throw createBusinessException({
                code: "RESOURCE_IN_USE",
                message: `"${resource.name}" is attached to ${backends.map(backend => backend.name).join(", ")}: detach it first`,
                statusCode: 409,
                details: { backends: backends.map(backend => backend.name) }
            })
        }
        return Resource.findByIdAndDelete(resource._id)
    }
}

export default ResourceService
