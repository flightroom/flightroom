import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { RESOURCE_CATALOG, RESOURCE_ENV_PREFIX, ResourceType, resourceEnvKeys } from "../types/ResourceCatalog"
import { VARIABLE_MAP_NAME } from "../types/VariableMapDTO"
import { encryptedFields } from "../utils/encryptedFieldsPlugin"
import { SECRET_PLACEHOLDER } from "../utils/secretCrypto"

/** The value a field takes in one environment instead of the one it has everywhere else */
export interface IResourceOverride {
    environmentId: Schema.Types.ObjectId
    value: string
}

/** A field of the resource: with no value and no override it is unset */
export interface IResourceValue {
    field: string
    value?: string
    overrides: IResourceOverride[]
}

/**
 * A package of variables of a catalog type (a database, a storage...) that backend services receive
 * once they attach it. One value holds in every environment of the project unless an environment
 * overrides it. A resource belongs to the project, as a config map does: services attach it by id.
 */
export interface IResource extends Document<ObjectId> {
    projectId: Schema.Types.ObjectId
    name: string
    type: ResourceType
    variant: string
    description?: string
    /** Typed in place of the prefix derived from the type and the name; null keeps the derived one */
    envPrefix?: string | null
    /** The fields that are not a credential. Which list a field goes to is the catalog's call, never the client's */
    values: IResourceValue[]
    /** The fields that are a credential, encrypted at rest */
    secrets: IResourceValue[]
    /**
     * The Swagger/OpenAPI document of an `api`, pasted when it cannot be fetched from its specUrl. Not read
     * unless asked for (it can take megabytes) and never a variable: it stays with the platform.
     */
    apiSpec?: string
    /** Its size in bytes, kept beside it so a list says whether there is one without reading it */
    apiSpecBytes?: number
    createdAt: Date
    updatedAt: Date
}

/** Encrypted at rest; every answer of the API carries the placeholder in their place */
export const RESOURCE_SECRET_PATHS = ["secrets.value", "secrets.overrides.value"]

// No length limit here: on an update the validators see the ciphertext of a secret, not what was typed.
// ResourceService bounds the values before they get this far.
const resourceOverrideSchema = new Schema<IResourceOverride>(
    {
        environmentId: {
            type: Schema.Types.ObjectId,
            ref: "Environment",
            required: true
        },
        value: {
            type: String,
            required: true
        }
    },
    { _id: false }
)

const resourceValueSchema = new Schema<IResourceValue>(
    {
        field: {
            type: String,
            required: true
        },
        value: {
            type: String,
            required: false
        },
        overrides: {
            type: [resourceOverrideSchema],
            default: []
        }
    },
    { _id: false }
)

const resourceSchema = new Schema<IResource>(
    {
        projectId: {
            type: Schema.Types.ObjectId,
            ref: "Project",
            required: true
        },
        name: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
            match: VARIABLE_MAP_NAME
        },
        type: {
            type: String,
            enum: Object.keys(RESOURCE_CATALOG),
            required: true
        },
        variant: {
            type: String,
            required: true
        },
        description: {
            type: String,
            trim: true
        },
        envPrefix: {
            type: String,
            required: false,
            match: RESOURCE_ENV_PREFIX
        },
        values: {
            type: [resourceValueSchema],
            default: []
        },
        secrets: {
            type: [resourceValueSchema],
            default: []
        },
        apiSpec: {
            type: String,
            required: false,
            select: false
        },
        apiSpecBytes: {
            type: Number,
            required: false
        }
    },
    {
        timestamps: true
    }
)

resourceSchema.index({ name: 1, projectId: 1 }, { unique: true })

resourceSchema.plugin(encryptedFields, { model: "Resource", paths: RESOURCE_SECRET_PATHS })

/** A field as the API answers it: its value everywhere and the environments that override it */
export interface ResourceFieldJSON {
    value?: string
    overrides: Array<{ environmentId: unknown; value: string }>
}

/**
 * Every way out of the backend serialises a resource through here, so this is where the credentials are
 * hidden. The two lists become one map of fields: the console does not need to know which is which, the
 * catalog tells it. A credential that is set comes out as the placeholder, which the form submits back
 * untouched and ResourceService reads as "keep the stored value"; one that is not set is left out.
 * Alongside, the variables the resource sets, so nobody has to derive them again. The API document
 * never comes out here, even when it was read: only whether there is one, and its size.
 */
resourceSchema.set("toJSON", {
    transform: (_document, object) => {
        const {
            values = [],
            secrets = [],
            apiSpec: _apiSpec,
            apiSpecBytes,
            ...rest
        } = object as unknown as Pick<IResource, "values" | "secrets" | "apiSpec" | "apiSpecBytes"> & Record<string, unknown>
        const fields: Record<string, ResourceFieldJSON> = {}
        for (const { field, value, overrides = [] } of values) {
            fields[field] = { ...(value !== undefined && { value }), overrides }
        }
        for (const { field, value, overrides = [] } of secrets) {
            fields[field] = {
                ...(value && { value: SECRET_PLACEHOLDER }),
                overrides: overrides.map(override => ({ ...override, value: SECRET_PLACEHOLDER }))
            }
        }
        return { ...rest, fields, env: resourceEnvKeys(object as unknown as IResource), apiSpec: { present: Boolean(apiSpecBytes), bytes: apiSpecBytes ?? 0 } }
    }
})

const Resource = mongoose.model<IResource>("Resource", resourceSchema)
export default Resource
