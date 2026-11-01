import SandboxSettings, { ISandboxSettings, SANDBOX_SETTINGS_ID } from "../../models/SandboxSettingsModel"
import type { OpenShellConfiguration } from "./OpenShellSandboxes"

/** The settings an installation administrator may change from the console, and the environment variable each one overrides. */
export const SANDBOX_SETTINGS = {
    idleMinutes: "OPENSHELL_SANDBOX_IDLE_MINUTES",
    maxHours: "OPENSHELL_SANDBOX_MAX_HOURS",
    sharing: "OPENSHELL_SANDBOX_SHARING",
    previewsEnabled: "OPENSHELL_PREVIEWS_ENABLED",
    warmSandboxes: "OPENSHELL_SANDBOX_WARM",
    image: "OPENSHELL_SANDBOX_IMAGE",
    template: "OPENSHELL_SANDBOX_TEMPLATE",
    registryHosts: "OPENSHELL_REGISTRY_HOSTS",
    networkBinary: "OPENSHELL_NETWORK_BINARY"
} as const satisfies Record<string, keyof OpenShellConfiguration>

export type SandboxSettingName = keyof typeof SANDBOX_SETTINGS

export const SANDBOX_SETTING_NAMES = Object.keys(SANDBOX_SETTINGS) as SandboxSettingName[]

/** The values stored, each one missing where the environment's applies. */
export type SandboxSettingsValues = Partial<Pick<ISandboxSettings, SandboxSettingName>>

/** A replica reads the stored settings at most this often: a change made on another replica reaches it within this time. */
export const SANDBOX_SETTINGS_CACHE_MS = 30_000

/** The environment with the stored values over it: what the sandboxes run with. */
export const overlaySandboxSettings = (env: OpenShellConfiguration, values: SandboxSettingsValues): OpenShellConfiguration => {
    const effective: OpenShellConfiguration = { ...env }
    for (const name of SANDBOX_SETTING_NAMES) {
        const value = values[name]
        if (value !== undefined && value !== null) Object.assign(effective, { [SANDBOX_SETTINGS[name]]: value })
    }
    return effective
}

/** The stored values alone, without the id and the audit fields. */
export const storedSandboxSettings = (document: Partial<ISandboxSettings> | null | undefined): SandboxSettingsValues =>
    Object.fromEntries(SANDBOX_SETTING_NAMES.flatMap(name => (document?.[name] === undefined || document[name] === null ? [] : [[name, document[name]]])))

let cached: { at: number; env: OpenShellConfiguration; config: Promise<OpenShellConfiguration> } | undefined

/**
 * The configuration of the sandboxes: the environment, overlaid by what an installation administrator saved. Read
 * again at most every {@link SANDBOX_SETTINGS_CACHE_MS}; a failed read is not kept, the next call tries again.
 */
export const effectiveOpenShellConfig = (env: OpenShellConfiguration, now = Date.now()): Promise<OpenShellConfiguration> => {
    // Without a gateway there is no sandbox for the settings to apply to.
    if (!env.OPENSHELL_GATEWAY_URL) return Promise.resolve(env)
    if (!cached || cached.env !== env || now - cached.at >= SANDBOX_SETTINGS_CACHE_MS) {
        const config = SandboxSettings.findById(SANDBOX_SETTINGS_ID)
            .lean()
            .then(document => overlaySandboxSettings(env, storedSandboxSettings(document)))
        const entry = { at: now, env, config }
        config.catch(() => {
            if (cached === entry) cached = undefined
        })
        cached = entry
    }
    return cached.config
}

/** Forgets the settings read: called by the replica that saved them, which applies them at once. */
export const invalidateSandboxSettings = () => {
    cached = undefined
}
