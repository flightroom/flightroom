import { ResourceCustomField, ResourceType } from "./ResourceCatalog"

/**
 * A field of a resource: its value in every environment and the environments that take another one. A
 * blank value leaves it unset; for a credential, the placeholder the API answers with keeps the stored one.
 */
export interface ResourceFieldDTO {
    value?: string
    overrides?: Array<{ environmentId: string; value?: string }>
}

interface ResourceDTO {
    id?: string
    /** A Kubernetes object name, as for a config map */
    name: string
    /** Set once: a resource does not change type */
    type: ResourceType
    variant: string
    description?: string
    /** Blank or null derives it from the type and the name */
    envPrefix?: string | null
    /**
     * A `generic` only, refused on any other type: the variables it defines, each `<prefix>_<name>`, sent as a
     * whole. A field renamed, removed or turned secret or plain loses its stored values.
     */
    customFields?: Array<Pick<ResourceCustomField, "name"> & { secret?: boolean }>
    /** By field name of the catalog, or of the customFields of a generic. On an update a field left out keeps what it has, one sent replaces it with its overrides */
    fields?: Record<string, ResourceFieldDTO>
    /**
     * An `api` only: its Swagger/OpenAPI document, JSON or YAML, when it cannot be fetched from its specUrl.
     * Left out keeps the stored one, null or blank removes it. The API never sends it back but through
     * GET /resources/:id/api-spec; a resource carries `{ present, bytes }` in its place.
     */
    apiSpec?: string | null
    createdAt?: Date
    updatedAt?: Date
}

export default ResourceDTO
