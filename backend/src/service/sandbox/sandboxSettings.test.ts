import { beforeEach, describe, expect, it, vi } from "vitest"

const findById = vi.hoisted(() => vi.fn())
vi.mock("../../models/SandboxSettingsModel", () => ({ default: { findById }, SANDBOX_SETTINGS_ID: "installation" }))

import { effectiveOpenShellConfig, invalidateSandboxSettings, overlaySandboxSettings, SANDBOX_SETTINGS_CACHE_MS, storedSandboxSettings } from "./sandboxSettings"

const ENV = {
    OPENSHELL_GATEWAY_URL: "https://gateway",
    OPENSHELL_SANDBOX_IDLE_MINUTES: 5,
    OPENSHELL_SANDBOX_IMAGE: "node:24-bookworm-slim",
    OPENSHELL_PREVIEWS_ENABLED: true,
    OPENSHELL_SANDBOX_SHARING: "domain" as const
}

const stored = (document: Record<string, unknown> | null) => findById.mockReturnValue({ lean: () => Promise.resolve(document) })

describe("the settings of the sandboxes", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        invalidateSandboxSettings()
    })

    it("Given values saved from the console, then each one overrides its environment variable and the others stay the environment's", () => {
        expect(overlaySandboxSettings(ENV, { idleMinutes: 30, previewsEnabled: false, warmSandboxes: 2, sharing: "conversation" })).toEqual({
            ...ENV,
            OPENSHELL_SANDBOX_IDLE_MINUTES: 30,
            OPENSHELL_PREVIEWS_ENABLED: false,
            OPENSHELL_SANDBOX_WARM: 2,
            OPENSHELL_SANDBOX_SHARING: "conversation"
        })
    })

    it("Given a stored document, then only the settings come out of it, those unset left out", () => {
        expect(storedSandboxSettings({ _id: "installation", image: "node:26", template: null, updatedBy: "someone", updatedAt: new Date() } as never)).toEqual({ image: "node:26" })
        expect(storedSandboxSettings(null)).toEqual({})
    })

    it("Given settings read once, when they are asked for again within the cache time, then the database is not read again; after it, or once invalidated, it is", async () => {
        stored({ idleMinutes: 30 })
        const now = 1_000_000

        expect((await effectiveOpenShellConfig(ENV, now)).OPENSHELL_SANDBOX_IDLE_MINUTES).toBe(30)
        stored({ idleMinutes: 45 })
        expect((await effectiveOpenShellConfig(ENV, now + SANDBOX_SETTINGS_CACHE_MS - 1)).OPENSHELL_SANDBOX_IDLE_MINUTES).toBe(30)
        expect(findById).toHaveBeenCalledTimes(1)

        expect((await effectiveOpenShellConfig(ENV, now + SANDBOX_SETTINGS_CACHE_MS)).OPENSHELL_SANDBOX_IDLE_MINUTES).toBe(45)
        stored({ idleMinutes: 60 })
        invalidateSandboxSettings()
        expect((await effectiveOpenShellConfig(ENV, now + SANDBOX_SETTINGS_CACHE_MS + 1)).OPENSHELL_SANDBOX_IDLE_MINUTES).toBe(60)
        expect(findById).toHaveBeenCalledTimes(3)
    })

    it("Given the template in use changed from the console, then its revision reaches the configuration, though it is no setting", async () => {
        stored({ template: "flightroom-node", templateRevision: "r2" })

        const config = await effectiveOpenShellConfig(ENV, 0)

        expect(config).toMatchObject({ OPENSHELL_SANDBOX_TEMPLATE: "flightroom-node", OPENSHELL_SANDBOX_TEMPLATE_REVISION: "r2" })
        expect(storedSandboxSettings({ _id: "installation", templateRevision: "r2" } as never)).toEqual({})
    })

    it("Given a read that fails, when the settings are asked for again, then the database is read again instead of failing for the cache time", async () => {
        findById.mockReturnValueOnce({ lean: () => Promise.reject(new Error("mongo down")) })
        await expect(effectiveOpenShellConfig(ENV, 0)).rejects.toThrow("mongo down")

        stored(null)
        await expect(effectiveOpenShellConfig(ENV, 1)).resolves.toEqual(ENV)
    })

    it("Given no gateway, then the environment is the configuration and the database is not read", async () => {
        await expect(effectiveOpenShellConfig({ OPENSHELL_PREVIEWS_ENABLED: true })).resolves.toEqual({ OPENSHELL_PREVIEWS_ENABLED: true })
        expect(findById).not.toHaveBeenCalled()
    })
})
