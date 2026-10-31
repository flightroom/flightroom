import type { AxiosError } from "axios"
import { useTranslation } from "react-i18next"
import useApiClient, { errorCodeOf } from "../useApiClient"
import { useVariableMapErrorMessage } from "./useVariableMapsApi"

/** How the console asks for a field (backend ResourceCatalog.ts); the backend checks the same */
export type ResourceFieldInput = "text" | "number" | "boolean" | "select" | "multiline" | "url" | "email"

export interface ResourceFieldSpec {
    name: string
    /** The variable is `<prefix>_<envSuffix>` */
    envSuffix: string
    /** Encrypted at rest and never sent back once written */
    secret: boolean
    /** Not secret: it needs a value in every environment. Secret: it may stay unset, as a secret may */
    required: boolean
    input: ResourceFieldInput
    options?: string[]
    /** Prefilled for a new resource only: the backend never applies it */
    default?: string
    /** Where the credentials are sent: once it changes, the saved credentials must be typed again */
    connection?: boolean
}

export interface ResourceVariantSpec {
    id: string
    fields: ResourceFieldSpec[]
    /** Variables the variant always sets, by suffix */
    fixed?: Record<string, string>
}

export interface ResourceTypeSpec {
    /** A string rather than a union: the form is drawn from the catalog, so a type added later works as it is */
    type: string
    envPrefix: string
    /** The variables are named by envPrefix alone, without the name of the resource: those an SDK reads by itself */
    exactEnvPrefix?: boolean
    variants: ResourceVariantSpec[]
}

/** A variable a `generic` resource defines itself: `<prefix>_<name>`, optional, a credential when `secret` */
export interface ResourceCustomField {
    name: string
    secret: boolean
}

/** A field as the API answers it: a credential that is set comes as the placeholder, one not set is left out */
export interface ResourceFieldValue {
    value?: string
    overrides: Array<{ environmentId: string; value: string }>
}

/** A variable the resource sets on the containers attaching it */
export interface ResourceEnvKey {
    key: string
    /** None for a variable the variant always sets */
    field?: string
    secret: boolean
    required: boolean
    /** The value of a variable the variant always sets */
    value?: string
}

/** A package of variables of a catalog type that backends receive once they attach it */
export interface Resource {
    _id?: string
    projectId?: string
    name: string
    type: string
    variant: string
    description?: string
    /** Markdown per gli agenti AI su questa risorsa */
    context?: string
    envPrefix?: string | null
    /** A `generic` only: the variables it defines */
    customFields?: ResourceCustomField[]
    fields: Record<string, ResourceFieldValue>
    env: ResourceEnvKey[]
    /** An `api` only: whether a Swagger/OpenAPI document was pasted, never the document itself */
    apiSpec?: { present: boolean; bytes: number }
    createdAt?: Date
    updatedAt?: Date
}

export interface ResourceDTO {
    name: string
    type: string
    variant: string
    description?: string
    context?: string
    /** Blank or null derives it from the type and the name */
    envPrefix?: string | null
    /** A `generic` only, sent as a whole: a field renamed, removed or turned secret or plain loses its values */
    customFields?: ResourceCustomField[]
    /** A field left out keeps what it has, one sent replaces it with its overrides */
    fields?: Record<string, { value?: string; overrides?: Array<{ environmentId: string; value?: string }> }>
    /** Left out keeps the stored document, null removes it */
    apiSpec?: string | null
}

const ERROR_KEYS: Record<string, string> = {
    RESOURCE_NAME_TAKEN: "resources.errors.name_taken",
    RESOURCE_NAME_INVALID: "resources.errors.name_invalid",
    RESOURCE_DESCRIPTION_INVALID: "resources.errors.description_invalid",
    RESOURCE_CONTEXT_INVALID: "resources.errors.context_invalid",
    RESOURCE_TYPE_INVALID: "resources.errors.type_invalid",
    RESOURCE_TYPE_IMMUTABLE: "resources.errors.type_immutable",
    RESOURCE_VARIANT_INVALID: "resources.errors.variant_invalid",
    RESOURCE_FIELDS_INVALID: "resources.errors.fields_invalid",
    RESOURCE_FIELD_UNKNOWN: "resources.errors.field_unknown",
    RESOURCE_VALUE_INVALID: "resources.errors.value_invalid",
    RESOURCE_VALUE_REQUIRED: "resources.errors.value_required",
    RESOURCE_SECRET_VALUE_REQUIRED: "resources.errors.secret_value_required",
    RESOURCE_ENVIRONMENT_UNKNOWN: "resources.errors.environment_unknown",
    RESOURCE_ENVIRONMENT_DUPLICATED: "resources.errors.environment_duplicated",
    RESOURCE_SECRET_REENTRY_REQUIRED: "resources.errors.secret_reentry_required",
    RESOURCE_ENV_PREFIX_INVALID: "resources.errors.env_prefix_invalid",
    RESOURCE_CUSTOM_FIELDS_INVALID: "resources.errors.custom_fields_invalid",
    RESOURCE_API_SPEC_INVALID: "resources.errors.api_spec_invalid",
    RESOURCE_IN_USE: "resources.errors.in_use",
    BACKEND_RESOURCE_UNKNOWN: "resources.errors.resource_unknown",
    BACKEND_RESOURCES_INVALID: "resources.errors.resources_invalid"
}

/**
 * The refusals of the resources, and of a backend attaching them, in the language of the user. A key
 * two attached things both set is the refusal of the maps (BACKEND_VARIABLE_KEY_DUPLICATED), said by them.
 */
export const useResourceErrorMessage = () => {
    const { t } = useTranslation()
    const variableMapErrorMessage = useVariableMapErrorMessage()

    return (error: Error): string | undefined => {
        const key = ERROR_KEYS[errorCodeOf(error) ?? ""]
        if (!key) return variableMapErrorMessage(error)
        const details: { backends?: string[]; secrets?: string[] } = (error as AxiosError<{ error?: { details?: { backends?: string[]; secrets?: string[] } } }>)?.response?.data?.error?.details ?? {}
        return t(key, {
            backends: details.backends?.join(", "),
            secrets: details.secrets?.map(field => t(`resources.fields.${field}`, { defaultValue: field })).join(", ")
        })
    }
}

const BASE_URL = "/api/resources"

const useResourcesApi = () => {
    const apiClient = useApiClient()
    const errorMessage = useResourceErrorMessage()

    const getAll = async (): Promise<Resource[]> => {
        const response = await apiClient.doRequest<Resource[]>({ url: BASE_URL })
        return response.data
    }

    const getCatalog = async (): Promise<ResourceTypeSpec[]> => {
        const response = await apiClient.doRequest<ResourceTypeSpec[]>({ url: `${BASE_URL}/catalog` })
        return response.data
    }

    const getSingle = async (id: string): Promise<Resource> => {
        const response = await apiClient.doRequest<Resource>({ url: `${BASE_URL}/${id}` })
        return response.data
    }

    /** The pasted Swagger/OpenAPI document of an `api`, as it was typed */
    const getApiSpec = async (id: string): Promise<string> => {
        // Silent: the download says itself why it failed
        const response = await apiClient.doRequest<string>({ url: `${BASE_URL}/${id}/api-spec`, responseType: "text", silent: true })
        return response.data
    }

    const create = async (resource: ResourceDTO): Promise<Resource> => {
        const response = await apiClient.doRequest<Resource>({ url: BASE_URL, method: "POST", data: resource, customErrorMessage: errorMessage })
        return response.data
    }

    const update = async (id: string, resource: ResourceDTO): Promise<Resource> => {
        const response = await apiClient.doRequest<Resource>({ url: `${BASE_URL}/${id}`, method: "PUT", data: resource, customErrorMessage: errorMessage })
        return response.data
    }

    const deleteSingle = async (id: string) => {
        const response = await apiClient.doRequest({ url: `${BASE_URL}/${id}`, method: "DELETE", customErrorMessage: errorMessage })
        return response.data
    }

    return { getAll, getCatalog, getSingle, getApiSpec, create, update, deleteSingle }
}

export default useResourcesApi
