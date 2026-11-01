import useApiClient from "../useApiClient"
import type { AiSandboxStatusSummary } from "./useAiSandboxApi"

export type SandboxSharing = "domain" | "conversation"

/** The settings of the sandboxes an installation administrator may change: each one missing is the environment's. */
export interface SandboxSettingsValues {
    idleMinutes?: number
    maxHours?: number
    sharing?: SandboxSharing
    previewsEnabled?: boolean
    warmSandboxes?: number
    image?: string
    template?: string
    registryHosts?: string
    networkBinary?: string
}

/** What is sent: null, or left out, goes back to the environment's value. */
export type SandboxSettingsUpdate = { [Name in keyof SandboxSettingsValues]: SandboxSettingsValues[Name] | null }

export interface SandboxSettingsSummary {
    values: SandboxSettingsValues
    /** The environment's values, which apply where nothing is saved. */
    defaults: Required<Omit<SandboxSettingsValues, "template">> & { template?: string }
    updatedAt?: string
    pool: { warm: number; creating: number; assigned: number }
    gateway: AiSandboxStatusSummary
}

export type SandboxPoolState = "warm" | "creating" | "assigned" | "legacy" | "orphan"
export type SandboxUsage = "running" | "busy" | "idle" | "unknown"

export interface InstallationSandbox {
    name: string
    phase?: string
    pool: SandboxPoolState
    target?: { kind: "domain" | "project" | "conversation" | "preview"; name?: string; projectName?: string }
    organization?: { id: string; name: string }
    usage?: SandboxUsage
    shared: boolean
    createdAt?: string
}

export interface SandboxLogLine {
    timestampMs?: number
    level: string
    source: string
    target: string
    message: string
}

export const SANDBOX_SETTINGS_QUERY_KEY = "installation-sandbox-settings"
export const INSTALLATION_SANDBOXES_QUERY_KEY = "installation-sandboxes"

/** The settings of the whole installation: only its administrators, those of INSTALLATION_ADMINS, are let in. */
const useInstallationApi = () => {
    const apiClient = useApiClient()

    // Silent: the page says in place what could not load, and the mutations toast their own failure
    const getSandboxSettings = async (): Promise<SandboxSettingsSummary> => (await apiClient.doRequest<SandboxSettingsSummary>({ url: "/api/installation/sandbox-settings", silent: true })).data

    const updateSandboxSettings = async (values: SandboxSettingsUpdate): Promise<SandboxSettingsSummary> =>
        (await apiClient.doRequest<SandboxSettingsSummary>({ url: "/api/installation/sandbox-settings", method: "PUT", data: values, silent: true })).data

    const getSandboxes = async (): Promise<InstallationSandbox[]> => (await apiClient.doRequest<InstallationSandbox[]>({ url: "/api/installation/sandboxes", silent: true })).data

    const getSandboxLogs = async (name: string): Promise<SandboxLogLine[]> =>
        (await apiClient.doRequest<SandboxLogLine[]>({ url: `/api/installation/sandboxes/${name}/logs`, params: { lines: 500 }, silent: true })).data

    const deleteSandbox = async (name: string): Promise<void> => {
        await apiClient.doRequest({ url: `/api/installation/sandboxes/${name}`, method: "DELETE", silent: true })
    }

    return { getSandboxSettings, updateSandboxSettings, getSandboxes, getSandboxLogs, deleteSandbox }
}

export default useInstallationApi
