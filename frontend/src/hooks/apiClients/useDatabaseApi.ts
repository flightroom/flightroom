import { AxiosError } from "axios"
import { useTranslation } from "react-i18next"
import type { ConnectionTestResult } from "@/components/ConnectionTest"
import useApiClient, { errorCodeOf } from "../useApiClient"

export enum DatabaseType {
    POSTGRESQL = "POSTGRESQL",
    MYSQL = "MYSQL",
    MARIADB = "MARIADB",
    SQLSERVER = "SQLSERVER",
    ORACLE = "ORACLE",
    MONGODB = "MONGODB"
}

/** The port each engine listens on unless told otherwise */
export const DEFAULT_DATABASE_PORT: Record<DatabaseType, number> = {
    [DatabaseType.POSTGRESQL]: 5432,
    [DatabaseType.MYSQL]: 3306,
    [DatabaseType.MARIADB]: 3306,
    [DatabaseType.SQLSERVER]: 1433,
    [DatabaseType.ORACLE]: 1521,
    [DatabaseType.MONGODB]: 27017
}

/**
 * What the API sends in place of a stored password or connection string; sending it back keeps the stored
 * one. The same string as SECRET_PLACEHOLDER in backend/src/utils/secretCrypto.ts: change both or neither.
 */
export const SECRET_PLACEHOLDER = "••••••••••••"

/** The API sends a placeholder in place of the password, the connection string and the client secret; sending it back keeps the stored one */
export type DatabaseConnection =
    | {
          authType: "credentials"
          host: string
          port: number
          database: string
          username: string
          password: string
          ssl: boolean
      }
    | {
          authType: "connectionString"
          connectionString: string
      }
    | {
          /** MongoDB on Atlas: a service account of the Atlas project, and the cluster */
          authType: "atlasServiceAccount"
          clientId: string
          clientSecret: string
          groupId: string
          clusterName: string
      }
    | {
          /** MongoDB on Azure Cosmos DB (RU): an Entra service principal, and the account */
          authType: "azureServicePrincipal"
          tenantId: string
          clientId: string
          clientSecret: string
          subscriptionId: string
          resourceGroup: string
          accountName: string
      }

export type DatabaseAuthType = DatabaseConnection["authType"]

/** How each engine is reached: the same authTypes the backend accepts */
export const AUTH_TYPES_OF = (type: DatabaseType): DatabaseAuthType[] =>
    type === DatabaseType.MONGODB ? ["connectionString", "atlasServiceAccount", "azureServicePrincipal"] : ["credentials", "connectionString"]

export interface Database {
    _id: string
    name: string
    type: DatabaseType
    connection: DatabaseConnection
    createdAt: string
    updatedAt: string
}

export type DatabaseDTO = Pick<Database, "name" | "type" | "connection">

/** Whether databases can be created on it: today a MongoDB, whatever its connection. The same rule as the backend's provisionerOf */
export const canProvision = (database: Pick<Database, "type">): boolean => database.type === DatabaseType.MONGODB

/** Every field a connection of any kind may have, as the form holds it */
type AnyConnection = Partial<Record<string, unknown>>

/**
 * A stored secret goes only where it already went: changing the engine, the kind of connection, or the address it is
 * sent to (with the client id of a service account), means typing it again. The same rule the backend applies before
 * keeping it.
 */
export const keepsStoredSecret = (stored: Pick<Database, "type" | "connection">, current: Pick<DatabaseDTO, "type" | "connection">): boolean => {
    if (stored.type !== current.type || stored.connection.authType !== current.connection?.authType) return false
    const before = stored.connection as AnyConnection
    const after = current.connection as AnyConnection
    const same = (keys: string[]) => keys.every(key => before[key] === (typeof after[key] === "string" ? (after[key] as string).trim() : after[key]))
    switch (stored.connection.authType) {
        case "connectionString":
            return true
        case "atlasServiceAccount":
            return same(["clientId", "groupId", "clusterName"])
        case "azureServicePrincipal":
            return same(["tenantId", "clientId", "subscriptionId", "resourceGroup", "accountName"])
        default:
            return same(["host", "database", "username"]) && before.port === Number(after.port)
    }
}

/** The name of a database Flightroom creates, which its user takes too. The same rule as the backend's */
export const PROVISIONED_DATABASE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

export interface ProvisionedDatabaseLink {
    resourceId: string
    environmentId: string
}

/** A database created on a connected database, with its own user; the password never leaves the backend */
export interface ProvisionedDatabase {
    _id: string
    projectId: string
    /** The connected database it was created on */
    databaseId: string
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

const ERROR_KEYS: Record<string, string> = {
    DATABASE_SECRET_REQUIRED: "database.errors.secret_required",
    DATABASE_WRITE_FORBIDDEN: "database.errors.write_forbidden",
    DATABASE_PORT_INVALID: "database.portInvalid",
    DATABASE_CONNECTION_INVALID: "database.errors.connection_invalid",
    DATABASE_IN_USE: "database.errors.in_use",
    DATABASE_NAME_REQUIRED: "database.errors.name_required",
    DATABASE_PROVISIONING_NOT_SUPPORTED: "database.errors.provisioning_not_supported",
    EXTERNAL_CALLS_RATE_LIMITED: "database.errors.rate_limited",
    PROVISIONED_DATABASE_LINK_INVALID: "database.provisioned.errors.link_invalid",
    PROVISIONED_DATABASE_DELETE_MODE_INVALID: "database.provisioned.errors.delete_mode_invalid",
    PROVISIONED_DATABASE_CLEANUP_REQUIRED: "database.provisioned.errors.cleanup_required",
    PROVISIONED_DATABASE_USER_LEFT_ON_SERVER: "database.provisioned.errors.user_left_on_server",
    PROVISIONED_DATABASE_CLUSTER_UNREACHABLE: "database.provisioned.errors.cluster_unreachable",
    PROVISIONED_DATABASE_USER_ALREADY_REMOVED: "database.provisioned.errors.user_already_removed",
    PROVISIONED_DATABASE_PARTLY_REMOVED: "database.provisioned.errors.partly_removed",
    RESOURCE_CHANGED_MEANWHILE: "database.provisioned.errors.resource_changed",
    PROVISIONED_DATABASE_EXISTS: "database.provisioned.errors.exists",
    PROVISIONED_DATABASE_USER_EXISTS: "database.provisioned.errors.user_exists",
    PROVISIONED_DATABASE_NAME_INVALID: "database.provisioned.errors.name_invalid",
    PROVISIONED_DATABASE_NAME_RESERVED: "database.provisioned.errors.name_reserved",
    PROVISIONED_DATABASE_LINKED: "database.provisioned.errors.linked",
    PROVISIONED_DATABASE_LINK_TAKEN: "database.provisioned.errors.link_taken",
    PROVISIONED_DATABASE_ENVIRONMENT_UNKNOWN: "database.provisioned.errors.environment_unknown",
    PROVISIONED_DATABASE_CONFIRMATION_MISMATCH: "database.provisioned.errors.confirmation_mismatch",
    PROVISIONED_DATABASE_SERVER_FAILED: "database.provisioned.errors.server_failed",
    RESOURCE_TYPE_NOT_SUPPORTED: "database.provisioned.errors.resource_type",
    RESOURCE_VARIANT_NOT_SUPPORTED: "database.provisioned.errors.resource_variant",
    ARGOCD_REQUIRED_FOR_VARIABLES: "database.provisioned.errors.argocd_required"
}

/** A refusal of the databases or of the databases created on them, by code, in the language of the user; undefined for a code of none of them */
export const useDatabaseErrorTranslation = () => {
    const { t } = useTranslation()
    return (code: string | undefined, message?: string, details: { username?: string } = {}): string | undefined => {
        const key = ERROR_KEYS[code ?? ""]
        // What the server said, already stripped of every credential by the backend
        return key ? t(key, { message, username: details.username }) : undefined
    }
}

const useDatabaseErrorMessage = () => {
    const { t } = useTranslation()
    const translate = useDatabaseErrorTranslation()
    return (error: Error): string | undefined => {
        const response = (error as AxiosError<{ error?: { message?: string; details?: { username?: string } } }>)?.response
        // The limiter of the routes reaching a server answers with no code of ours
        if (response?.status === 429 && !errorCodeOf(error)) return t("database.errors.rate_limited")
        return translate(errorCodeOf(error), response?.data?.error?.message, response?.data?.error?.details)
    }
}

const useDatabaseApi = () => {
    const apiClient = useApiClient()
    const customErrorMessage = useDatabaseErrorMessage()

    const getAll = async (): Promise<Database[]> => {
        const response = await apiClient.doRequest<Database[]>({ url: "/api/databases" })
        return response.data
    }

    const getSingle = async (id: string): Promise<Database> => {
        const response = await apiClient.doRequest<Database>({ url: `/api/databases/${id}` })
        return response.data
    }

    const create = async (data: DatabaseDTO): Promise<Database> => {
        const response = await apiClient.doRequest<Database>({ url: "/api/databases", method: "POST", data, customErrorMessage })
        return response.data
    }

    const update = async (id: string, data: DatabaseDTO): Promise<Database> => {
        const response = await apiClient.doRequest<Database>({ url: `/api/databases/${id}`, method: "PUT", data, customErrorMessage })
        return response.data
    }

    const deleteSingle = async (id: string): Promise<void> => {
        await apiClient.doRequest({ url: `/api/databases/${id}`, method: "DELETE", customErrorMessage })
    }

    /** Connects with what the form holds, without saving it; `id` lends the stored credentials on an edit */
    const test = async (data: DatabaseDTO, id?: string): Promise<ConnectionTestResult> => {
        const response = await apiClient.doRequest<ConnectionTestResult>({ url: id ? `/api/databases/${id}/test` : "/api/databases/test", method: "POST", data, customErrorMessage })
        return response.data
    }

    /** The databases created on one connected database */
    const getProvisioned = async (databaseId: string): Promise<ProvisionedDatabase[]> => {
        const response = await apiClient.doRequest<ProvisionedDatabase[]>({ url: `/api/databases/${databaseId}/provisioned-databases` })
        return response.data
    }

    /** Every database created on a connected database of the project: what a resource reads to say which environments one feeds */
    const getAllProvisioned = async (): Promise<ProvisionedDatabase[]> => {
        const response = await apiClient.doRequest<ProvisionedDatabase[]>({ url: "/api/provisioned-databases" })
        return response.data
    }

    const createProvisioned = async (databaseId: string, data: { databaseName: string; link?: ProvisionedDatabaseLink }): Promise<ProvisionedDatabase> => {
        const response = await apiClient.doRequest<ProvisionedDatabase>({ url: `/api/databases/${databaseId}/provisioned-databases`, method: "POST", data, customErrorMessage })
        return response.data
    }

    const linkProvisioned = async (id: string, data: ProvisionedDatabaseLink): Promise<ProvisionedDatabase> => {
        const response = await apiClient.doRequest<ProvisionedDatabase>({ url: `/api/provisioned-databases/${id}/link`, method: "PUT", data, customErrorMessage })
        return response.data
    }

    const unlinkProvisioned = async (id: string): Promise<ProvisionedDatabase> => {
        const response = await apiClient.doRequest<ProvisionedDatabase>({ url: `/api/provisioned-databases/${id}/link`, method: "DELETE", customErrorMessage })
        return response.data
    }

    const deleteProvisioned = async (id: string, mode: ProvisionedDatabaseDeleteMode, confirmName?: string): Promise<void> => {
        await apiClient.doRequest({ url: `/api/provisioned-databases/${id}`, method: "DELETE", params: { mode, ...(confirmName && { confirmName }) }, customErrorMessage })
    }

    return { getAll, getSingle, create, update, deleteSingle, test, getProvisioned, getAllProvisioned, createProvisioned, linkProvisioned, unlinkProvisioned, deleteProvisioned }
}

export default useDatabaseApi
