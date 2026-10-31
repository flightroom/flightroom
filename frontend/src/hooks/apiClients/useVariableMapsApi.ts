import type { AxiosError } from "axios"
import { useTranslation } from "react-i18next"
import useApiClient, { errorCodeOf } from "../useApiClient"
import useGitOpsErrorMessage from "./useGitOpsErrorMessage"

/** A config map holds values anyone who sees the project may read; a secret holds values never sent back once written */
export type VariableMapKind = "configMap" | "secret"

/** A key with the value of all environments and the ones an environment overrides it with; with neither it is unset there */
export interface VariableMapEntry {
    key: string
    /** The value of every environment without one of its own */
    value?: string
    /** For a secret, the API sends a placeholder in place of every value, and sending it back keeps the stored one */
    values: { environmentId: string; value: string }[]
}

/** Values backends receive as environment variables: it belongs to the project, and backends attach it */
export interface VariableMap {
    _id?: string
    projectId?: string
    name: string
    description?: string
    entries: VariableMapEntry[]
    createdAt?: Date
    updatedAt?: Date
}

export type VariableMapDTO = Pick<VariableMap, "name" | "description" | "entries">

const BASE_URL: Record<VariableMapKind, string> = { configMap: "/api/config-maps", secret: "/api/secrets" }

const ERROR_KEYS: Record<string, string> = {
    VARIABLE_MAP_NAME_TAKEN: "variableMaps.errors.name_taken",
    VARIABLE_MAP_NAME_INVALID: "variableMaps.errors.name_invalid",
    VARIABLE_MAP_DESCRIPTION_INVALID: "variableMaps.errors.description_invalid",
    VARIABLE_MAP_IN_USE: "variableMaps.errors.in_use",
    VARIABLE_MAP_SECRET_VALUE_REQUIRED: "variableMaps.errors.secret_value_required",
    BACKEND_VARIABLE_KEY_DUPLICATED: "variableMaps.errors.key_clash",
    BACKEND_VARIABLE_MAP_UNKNOWN: "variableMaps.errors.map_unknown"
}

interface VariableMapErrorDetails {
    key?: string
    maps?: string[]
    backend?: string
    backends?: string[]
}

/**
 * The refusals of the maps, and of a backend attaching them, in the language of the user: the backend
 * sends what they need in `details` (the key two maps both set, the backends still attaching one).
 */
export const useVariableMapErrorMessage = () => {
    const { t } = useTranslation()
    const gitOpsErrorMessage = useGitOpsErrorMessage()

    return (error: Error): string | undefined => {
        const key = ERROR_KEYS[errorCodeOf(error) ?? ""]
        if (!key) return gitOpsErrorMessage(error)
        const details: VariableMapErrorDetails = (error as AxiosError<{ error?: { details?: VariableMapErrorDetails } }>)?.response?.data?.error?.details ?? {}
        return t(key, { key: details.key, first: details.maps?.[0], second: details.maps?.[1], backends: details.backends?.join(", ") })
    }
}

const useVariableMapsApi = (kind: VariableMapKind) => {
    const apiClient = useApiClient()
    const url = BASE_URL[kind]
    const errorMessage = useVariableMapErrorMessage()

    const getAll = async (): Promise<VariableMap[]> => {
        const response = await apiClient.doRequest<VariableMap[]>({ url })
        return response.data
    }

    const getSingle = async (id: string): Promise<VariableMap> => {
        const response = await apiClient.doRequest<VariableMap>({ url: `${url}/${id}` })
        return response.data
    }

    const create = async (map: VariableMapDTO): Promise<VariableMap> => {
        const response = await apiClient.doRequest<VariableMap>({ url, method: "POST", data: map, customErrorMessage: errorMessage })
        return response.data
    }

    const update = async (id: string, map: VariableMapDTO): Promise<VariableMap> => {
        const response = await apiClient.doRequest<VariableMap>({ url: `${url}/${id}`, method: "PUT", data: map, customErrorMessage: errorMessage })
        return response.data
    }

    const deleteSingle = async (id: string) => {
        const response = await apiClient.doRequest({ url: `${url}/${id}`, method: "DELETE", customErrorMessage: errorMessage })
        return response.data
    }

    return { getAll, getSingle, create, update, deleteSingle }
}

export default useVariableMapsApi
