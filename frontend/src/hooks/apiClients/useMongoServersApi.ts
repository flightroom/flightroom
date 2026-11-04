import { AxiosError } from "axios"
import { useTranslation } from "react-i18next"
import type { ConnectionTestResult } from "@/components/ConnectionTest"
import useApiClient, { errorCodeOf } from "../useApiClient"
import { SECRET_PLACEHOLDER } from "./useDatabaseApi"

export { SECRET_PLACEHOLDER }

export enum MongoServerProvider {
    MONGODB = "MONGODB",
    ATLAS = "ATLAS",
    COSMOS_MONGO_RU = "COSMOS_MONGO_RU"
}

/** The API sends the placeholder in place of the admin URI and of the secret of the service account; sending it back keeps the stored one */
export interface MongoServerConnection {
    /** MONGODB: the URI of an account allowed to create users */
    connectionString?: string
    /** ATLAS: the service account, the Atlas project and the cluster. COSMOS_MONGO_RU: clientId and clientSecret are those of the Entra service principal */
    clientId?: string
    clientSecret?: string
    groupId?: string
    clusterName?: string
    /** COSMOS_MONGO_RU: the tenant of the service principal and the Cosmos DB account */
    tenantId?: string
    subscriptionId?: string
    resourceGroup?: string
    accountName?: string
}

export interface MongoServer {
    _id: string
    name: string
    provider: MongoServerProvider
    connection: MongoServerConnection
    createdAt: string
    updatedAt: string
}

export type MongoServerDTO = Pick<MongoServer, "name" | "provider" | "connection">

/** The name of a database Flightroom creates, which its user takes too. The same rule as the backend's */
export const PROVISIONED_DATABASE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

export interface ProvisionedDatabaseLink {
    resourceId: string
    environmentId: string
}

/** A database created on a server, with its own user; the password never leaves the backend */
export interface ProvisionedDatabase {
    _id: string
    projectId: string
    serverId: string
    databaseName: string
    username: string
    link?: ProvisionedDatabaseLink | null
    /** `cleanupRequired`: a failed create left its user on the server; not linkable, removed with `user` or `record` only */
    status?: "cleanupRequired"
    /** Why the user could not be removed, as the server said it */
    cleanupReason?: string
    /** How far a removal got on the server */
    removedFromServer?: "data" | "user"
    createdAt: string
    updatedAt: string
}

export type ProvisionedDatabaseDeleteMode = "record" | "user" | "drop"

/** What deleting an environment does with the databases feeding a resource there: unlink them, or remove them as a removal does */
export type EnvironmentDatabasesChoice = "unlink" | ProvisionedDatabaseDeleteMode

/**
 * A stored secret goes only where it already went: changing the provider, the client id, the Atlas project and
 * cluster, or the tenant and the Cosmos DB account, means typing it again. The same rule the backend applies before keeping it.
 */
export const keepsStoredMongoSecret = (stored: Pick<MongoServer, "provider" | "connection">, current: Pick<MongoServerDTO, "provider" | "connection">): boolean => {
    if (stored.provider !== current.provider) return false
    if (stored.provider === MongoServerProvider.MONGODB) return true
    const same = (keys: Array<keyof MongoServerConnection>) => keys.every(key => stored.connection[key] === current.connection?.[key]?.trim())
    return stored.provider === MongoServerProvider.ATLAS ? same(["clientId", "groupId", "clusterName"]) : same(["tenantId", "clientId", "subscriptionId", "resourceGroup", "accountName"])
}

const ERROR_KEYS: Record<string, string> = {
    MONGO_SERVER_SECRET_REQUIRED: "mongoServers.errors.secret_required",
    MONGO_SERVER_WRITE_FORBIDDEN: "mongoServers.errors.write_forbidden",
    MONGO_SERVER_CONNECTION_INVALID: "mongoServers.errors.connection_invalid",
    MONGO_SERVER_IN_USE: "mongoServers.errors.in_use",
    MONGO_SERVER_PROVIDER_INVALID: "mongoServers.errors.provider_invalid",
    MONGO_SERVER_NAME_REQUIRED: "mongoServers.errors.name_required",
    PROVISIONED_DATABASE_LINK_INVALID: "mongoServers.databases.errors.link_invalid",
    PROVISIONED_DATABASE_DELETE_MODE_INVALID: "mongoServers.databases.errors.delete_mode_invalid",
    PROVISIONED_DATABASE_CLEANUP_REQUIRED: "mongoServers.databases.errors.cleanup_required",
    PROVISIONED_DATABASE_USER_LEFT_ON_SERVER: "mongoServers.databases.errors.user_left_on_server",
    PROVISIONED_DATABASE_CLUSTER_UNREACHABLE: "mongoServers.databases.errors.cluster_unreachable",
    PROVISIONED_DATABASE_USER_ALREADY_REMOVED: "mongoServers.databases.errors.user_already_removed",
    RESOURCE_CHANGED_MEANWHILE: "mongoServers.databases.errors.resource_changed",
    EXTERNAL_CALLS_RATE_LIMITED: "mongoServers.errors.rate_limited",
    PROVISIONED_DATABASE_EXISTS: "mongoServers.databases.errors.exists",
    PROVISIONED_DATABASE_USER_EXISTS: "mongoServers.databases.errors.user_exists",
    PROVISIONED_DATABASE_NAME_INVALID: "mongoServers.databases.errors.name_invalid",
    PROVISIONED_DATABASE_NAME_RESERVED: "mongoServers.databases.errors.name_reserved",
    PROVISIONED_DATABASE_LINKED: "mongoServers.databases.errors.linked",
    PROVISIONED_DATABASE_LINK_TAKEN: "mongoServers.databases.errors.link_taken",
    PROVISIONED_DATABASE_ENVIRONMENT_UNKNOWN: "mongoServers.databases.errors.environment_unknown",
    PROVISIONED_DATABASE_CONFIRMATION_MISMATCH: "mongoServers.databases.errors.confirmation_mismatch",
    PROVISIONED_DATABASE_SERVER_FAILED: "mongoServers.databases.errors.server_failed",
    RESOURCE_TYPE_NOT_SUPPORTED: "mongoServers.databases.errors.resource_type",
    RESOURCE_VARIANT_NOT_SUPPORTED: "mongoServers.databases.errors.resource_variant",
    ARGOCD_REQUIRED_FOR_VARIABLES: "mongoServers.databases.errors.argocd_required"
}

/** A refusal of the servers or of the provisioned databases, by code, in the language of the user; undefined for a code of none of them */
export const useMongoServerErrorTranslation = () => {
    const { t } = useTranslation()
    return (code: string | undefined, message?: string, details: { username?: string } = {}): string | undefined => {
        const key = ERROR_KEYS[code ?? ""]
        // What the server said, already stripped of every credential by the backend
        return key ? t(key, { message, username: details.username }) : undefined
    }
}

const useMongoServerErrorMessage = () => {
    const { t } = useTranslation()
    const translate = useMongoServerErrorTranslation()
    return (error: Error): string | undefined => {
        const response = (error as AxiosError<{ error?: { message?: string; details?: { username?: string } } }>)?.response
        // The limiter of the routes reaching a server answers with no code of ours
        if (response?.status === 429 && !errorCodeOf(error)) return t("mongoServers.errors.rate_limited")
        return translate(errorCodeOf(error), response?.data?.error?.message, response?.data?.error?.details)
    }
}

const useMongoServersApi = () => {
    const apiClient = useApiClient()
    const customErrorMessage = useMongoServerErrorMessage()

    const getAll = async (): Promise<MongoServer[]> => {
        const response = await apiClient.doRequest<MongoServer[]>({ url: "/api/mongo-servers" })
        return response.data
    }

    const getSingle = async (id: string): Promise<MongoServer> => {
        const response = await apiClient.doRequest<MongoServer>({ url: `/api/mongo-servers/${id}` })
        return response.data
    }

    const create = async (data: MongoServerDTO): Promise<MongoServer> => {
        const response = await apiClient.doRequest<MongoServer>({ url: "/api/mongo-servers", method: "POST", data, customErrorMessage })
        return response.data
    }

    const update = async (id: string, data: MongoServerDTO): Promise<MongoServer> => {
        const response = await apiClient.doRequest<MongoServer>({ url: `/api/mongo-servers/${id}`, method: "PUT", data, customErrorMessage })
        return response.data
    }

    const deleteSingle = async (id: string): Promise<void> => {
        await apiClient.doRequest({ url: `/api/mongo-servers/${id}`, method: "DELETE", customErrorMessage })
    }

    /** Connects with what the form holds, without saving it; `id` lends the stored credentials on an edit */
    const test = async (data: MongoServerDTO, id?: string): Promise<ConnectionTestResult> => {
        const response = await apiClient.doRequest<ConnectionTestResult>({ url: id ? `/api/mongo-servers/${id}/test` : "/api/mongo-servers/test", method: "POST", data, customErrorMessage })
        return response.data
    }

    const getDatabases = async (serverId: string): Promise<ProvisionedDatabase[]> => {
        const response = await apiClient.doRequest<ProvisionedDatabase[]>({ url: `/api/mongo-servers/${serverId}/databases` })
        return response.data
    }

    /** Every database created on a server of the project: what a resource reads to say which environments one feeds */
    const getAllDatabases = async (): Promise<ProvisionedDatabase[]> => {
        const response = await apiClient.doRequest<ProvisionedDatabase[]>({ url: "/api/provisioned-databases" })
        return response.data
    }

    const createDatabase = async (serverId: string, data: { databaseName: string; link?: ProvisionedDatabaseLink }): Promise<ProvisionedDatabase> => {
        const response = await apiClient.doRequest<ProvisionedDatabase>({ url: `/api/mongo-servers/${serverId}/databases`, method: "POST", data, customErrorMessage })
        return response.data
    }

    const linkDatabase = async (id: string, data: ProvisionedDatabaseLink): Promise<ProvisionedDatabase> => {
        const response = await apiClient.doRequest<ProvisionedDatabase>({ url: `/api/provisioned-databases/${id}/link`, method: "PUT", data, customErrorMessage })
        return response.data
    }

    const unlinkDatabase = async (id: string): Promise<ProvisionedDatabase> => {
        const response = await apiClient.doRequest<ProvisionedDatabase>({ url: `/api/provisioned-databases/${id}/link`, method: "DELETE", customErrorMessage })
        return response.data
    }

    const deleteDatabase = async (id: string, mode: ProvisionedDatabaseDeleteMode, confirmName?: string): Promise<void> => {
        await apiClient.doRequest({ url: `/api/provisioned-databases/${id}`, method: "DELETE", params: { mode, ...(confirmName && { confirmName }) }, customErrorMessage })
    }

    return { getAll, getSingle, create, update, deleteSingle, test, getDatabases, getAllDatabases, createDatabase, linkDatabase, unlinkDatabase, deleteDatabase }
}

export default useMongoServersApi
