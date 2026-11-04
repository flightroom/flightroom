import { MongoServerConnection, MongoServerProvider } from "../models/MongoServerModel"

/** A credential sent as the placeholder the API answers with keeps the stored one */
export interface MongoServerDTO {
    name: string
    provider: MongoServerProvider
    connection: MongoServerConnection
}

/** A database to create on a server, and optionally the resource and environment it feeds from the start */
export interface ProvisionedDatabaseCreateDTO {
    databaseName: string
    link?: ProvisionedDatabaseLinkDTO
}

export interface ProvisionedDatabaseLinkDTO {
    resourceId: string
    environmentId: string
}

/** What a removal takes away besides the record: nothing, the user, or the user and the data */
export const PROVISIONED_DATABASE_DELETE_MODES = ["record", "user", "drop"] as const
export type ProvisionedDatabaseDeleteMode = (typeof PROVISIONED_DATABASE_DELETE_MODES)[number]

/** Whether a mode of removal, or a choice for the databases of a deleted environment, reaches their servers: only removing the users or the data does */
export const reachesServers = (choice: unknown): boolean => choice === "user" || choice === "drop"
