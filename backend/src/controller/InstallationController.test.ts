import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { settingsModel, sandboxes, finders } = vi.hoisted(() => {
    const finder = () => ({ find: vi.fn(() => ({ lean: () => Promise.resolve([] as unknown[]) })) })
    return {
        settingsModel: { findById: vi.fn(), updateOne: vi.fn(async () => ({})) },
        sandboxes: { inventory: vi.fn(), logs: vi.fn(), delete: vi.fn(), idleMs: vi.fn(async () => 300_000) },
        finders: { Domain: finder(), Project: finder(), Organization: finder(), AiChangeJob: finder(), StandalonePreviewSession: finder() }
    }
})

vi.mock("../models/SandboxSettingsModel", () => ({ default: settingsModel, SANDBOX_SETTINGS_ID: "installation" }))
vi.mock("../models/DomainModel", async importOriginal => ({ ...(await importOriginal<object>()), default: finders.Domain }))
vi.mock("../models/ProjectModel", async importOriginal => ({ ...(await importOriginal<object>()), default: finders.Project }))
vi.mock("../models/OrganizationModel", async importOriginal => ({ ...(await importOriginal<object>()), default: finders.Organization }))
vi.mock("../models/AiChangeJobModel", async importOriginal => ({ ...(await importOriginal<object>()), default: finders.AiChangeJob }))
vi.mock("../models/StandalonePreviewSessionModel", async importOriginal => ({ ...(await importOriginal<object>()), default: finders.StandalonePreviewSession }))
vi.mock("../service/sandbox/sandboxPool", () => ({ sandboxPoolCounts: vi.fn(async () => ({ warm: 2, creating: 1, assigned: 3 })) }))
vi.mock("../service/sandbox/SandboxStatusService", () => ({ sandboxGatewayStatus: vi.fn(async () => ({ status: "online", version: "0.4.1", checkedAt: new Date(0) })) }))
const stateOf = vi.hoisted(() => vi.fn(async (_key: string) => "running"))
vi.mock("../service/aiChange/aiChangeSandboxes", () => ({ closeLifetime: vi.fn(), conversationState: () => stateOf }))
vi.mock("../service/sandbox/OpenShellSandboxes", async importOriginal => ({
    ...(await importOriginal<typeof import("../service/sandbox/OpenShellSandboxes")>()),
    openShellSandboxes: (config: { OPENSHELL_GATEWAY_URL?: string }) => (config.OPENSHELL_GATEWAY_URL ? sandboxes : undefined)
}))

import errorHandler from "../plugins/errorHandler"
import { closeLifetime } from "../service/aiChange/aiChangeSandboxes"
import installationController from "./InstallationController"

const ADMIN = { _id: "65f1a2b3c4d5e6f708192a00", email: "Admin@Example.com" }
const MEMBER = { _id: "65f1a2b3c4d5e6f708192a99", email: "member@example.com" }
const DOMAIN = "65f1a2b3c4d5e6f708192a10"
const PROJECT = "65f1a2b3c4d5e6f708192a20"
const ORGANIZATION = "65f1a2b3c4d5e6f708192a30"
const JOB = "65f1a2b3c4d5e6f708192a40"

describe("InstallationController", () => {
    let app: FastifyInstance
    let logs: Record<string, unknown>[]
    let caller: typeof ADMIN

    beforeEach(async () => {
        vi.clearAllMocks()
        logs = []
        caller = ADMIN
        settingsModel.findById.mockReturnValue({ lean: () => Promise.resolve({ _id: "installation", idleMinutes: 30, updatedAt: new Date(0) }) })
        app = Fastify({ logger: { level: "info", stream: { write: (line: string) => logs.push(JSON.parse(line)) } } })
        app.decorate("config", {
            INSTALLATION_ADMINS: "admin@example.com",
            OPENSHELL_GATEWAY_URL: "https://gateway",
            OPENSHELL_SANDBOX_IDLE_MINUTES: 5,
            OPENSHELL_SANDBOX_WARM: 0,
            OPENSHELL_PREVIEWS_ENABLED: true
        } as never)
        app.addHook("onRequest", async request => {
            ;(request as unknown as { databaseUser: typeof ADMIN }).databaseUser = caller
        })
        await app.register(errorHandler)
        await app.register(installationController)
        await app.ready()
    })

    afterEach(async () => {
        await app.close()
    })

    it("Given an installation administrator, when the settings are read, then they get what is saved, the environment's values, the pool and the gateway", async () => {
        const response = await app.inject({ method: "GET", url: "/installation/sandbox-settings" })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            values: { idleMinutes: 30 },
            defaults: { idleMinutes: 5, maxHours: 24, sharing: "domain", previewsEnabled: true, warmSandboxes: 0, image: "node:24-bookworm-slim" },
            pool: { warm: 2, creating: 1, assigned: 3 },
            gateway: { status: "online", version: "0.4.1" }
        })
    })

    it("Given somebody who is not an installation administrator, when they read or change anything, then they are refused and nothing is touched", async () => {
        caller = MEMBER

        for (const request of [
            { method: "GET" as const, url: "/installation/sandbox-settings" },
            { method: "PUT" as const, url: "/installation/sandbox-settings", payload: { idleMinutes: 10 } },
            { method: "GET" as const, url: "/installation/sandboxes" },
            { method: "GET" as const, url: "/installation/sandboxes/fr-0123456789abcdef/logs" },
            { method: "DELETE" as const, url: "/installation/sandboxes/fr-0123456789abcdef" }
        ]) {
            const response = await app.inject(request)
            expect(response.statusCode).toBe(403)
            expect(response.json().error.code).toBe("INSTALLATION_ADMIN_REQUIRED")
        }
        expect(settingsModel.updateOne).not.toHaveBeenCalled()
        expect(sandboxes.delete).not.toHaveBeenCalled()
        expect(sandboxes.logs).not.toHaveBeenCalled()
    })

    it("Given settings saved, then they replace what was saved, those left out or empty go back to the environment's, the lists are tidied, and the change is audited", async () => {
        const response = await app.inject({
            method: "PUT",
            url: "/installation/sandbox-settings",
            payload: { idleMinutes: 15, warmSandboxes: 3, sharing: null, image: "", registryHosts: " registry.npmjs.org ,*.pkg.example.com ", networkBinary: "/usr/local/bin/node, /usr/bin/git" }
        })

        expect(response.statusCode).toBe(200)
        expect(settingsModel.updateOne).toHaveBeenCalledWith(
            { _id: "installation" },
            {
                $set: { idleMinutes: 15, warmSandboxes: 3, registryHosts: "registry.npmjs.org,*.pkg.example.com", networkBinary: "/usr/local/bin/node,/usr/bin/git", updatedBy: ADMIN._id },
                $unset: { maxHours: 1, sharing: 1, previewsEnabled: 1, image: 1, template: 1 }
            },
            { upsert: true }
        )
        expect(logs).toContainEqual(expect.objectContaining({ audit: "sandbox_settings_updated", userId: ADMIN._id }))
    })

    it.each([
        ["an idle time of 0 minutes", { idleMinutes: 0 }],
        ["an idle time over a day", { idleMinutes: 1441 }],
        ["a maximum age over 30 days", { maxHours: 721 }],
        ["a fractional maximum age", { maxHours: 1.5 }],
        ["more than 50 warm sandboxes", { warmSandboxes: 51 }],
        ["a negative number of warm sandboxes", { warmSandboxes: -1 }],
        ["an unknown sharing", { sharing: "organization" }],
        ["an image with a space", { image: "node:24 --privileged" }],
        ["a template with a space", { template: "a b" }],
        ["a registry host with a path", { registryHosts: "registry.npmjs.org/evil" }],
        ["a registry host with a port", { registryHosts: "registry.npmjs.org:8443" }],
        ["a wildcard in the middle of a host", { registryHosts: "registry.*.org" }],
        ["an empty item among the hosts", { registryHosts: "registry.npmjs.org,,pypi.org" }],
        ["a relative executable", { networkBinary: "/usr/local/bin/node,bin/sh" }],
        ["an executable with a space", { networkBinary: "/usr/local/bin/my node" }]
    ])("Given %s, when the settings are saved, then they are refused before anything is stored", async (_case, payload) => {
        const response = await app.inject({ method: "PUT", url: "/installation/sandbox-settings", payload })

        expect(response.statusCode).toBe(400)
        expect(settingsModel.updateOne).not.toHaveBeenCalled()
    })

    it("Given sandboxes of the installation, when they are listed, then each comes with what it serves in words, its organization and whether it is used", async () => {
        sandboxes.inventory.mockResolvedValue([
            { name: "fr-0000000000000001", phase: "ready", pool: "assigned", key: `domain-${DOMAIN}`, organizationId: ORGANIZATION, shared: true, createdAtMs: 0 },
            { name: "fr-0000000000000002", phase: "ready", pool: "legacy", key: JOB, shared: false },
            { name: "fr-0000000000000003", phase: "provisioning", pool: "warm", shared: false }
        ])
        finders.Domain.find.mockReturnValue({ lean: () => Promise.resolve([{ _id: DOMAIN, name: "Checkout", projectId: PROJECT }]) })
        finders.AiChangeJob.find.mockReturnValue({ lean: () => Promise.resolve([{ _id: JOB, prompt: "x".repeat(200), projectId: PROJECT }]) })
        finders.Project.find.mockReturnValue({ lean: () => Promise.resolve([{ _id: PROJECT, name: "Shop", organizationId: ORGANIZATION }]) })
        finders.Organization.find.mockReturnValue({ lean: () => Promise.resolve([{ _id: ORGANIZATION, name: "Acme" }]) })

        const response = await app.inject({ method: "GET", url: "/installation/sandboxes" })

        expect(response.statusCode).toBe(200)
        const [domain, conversation, warm] = response.json()
        expect(domain).toMatchObject({ pool: "assigned", target: { kind: "domain", name: "Checkout", projectName: "Shop" }, organization: { id: ORGANIZATION, name: "Acme" }, usage: "running" })
        expect(conversation).toMatchObject({ pool: "legacy", target: { kind: "conversation", name: "x".repeat(80), projectName: "Shop" }, organization: { name: "Acme" } })
        expect(warm).toMatchObject({ pool: "warm", phase: "provisioning" })
        expect(warm.usage).toBeUndefined()
        expect(stateOf).toHaveBeenCalledTimes(2)
    })

    it("Given the logs of a sandbox carrying a token, when they are read, then the token is blanked and the lines asked for are capped", async () => {
        sandboxes.logs.mockResolvedValue([{ timestampMs: 1, level: "INFO", source: "sandbox", target: "npm", message: "auth with //registry/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789" }])

        const response = await app.inject({ method: "GET", url: "/installation/sandboxes/fr-0123456789abcdef/logs?lines=100" })

        expect(response.statusCode).toBe(200)
        expect(response.json()[0].message).not.toContain("npm_abcdefghijklmnopqrstuvwxyz0123456789")
        expect(response.json()[0].message).toContain("[REDACTED]")
        expect(sandboxes.logs).toHaveBeenCalledWith("fr-0123456789abcdef", 100)
        expect((await app.inject({ method: "GET", url: "/installation/sandboxes/fr-0123456789abcdef/logs?lines=2001" })).statusCode).toBe(400)
    })

    it("Given a sandbox of the installation, when it is deleted, then it goes with its lifetime closed and the deletion is audited; a name that is no sandbox's is refused, one of another installation not found", async () => {
        sandboxes.delete.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

        expect((await app.inject({ method: "DELETE", url: "/installation/sandboxes/fr-0123456789abcdef" })).statusCode).toBe(204)
        expect(sandboxes.delete).toHaveBeenCalledWith("fr-0123456789abcdef", closeLifetime)
        expect(logs).toContainEqual(expect.objectContaining({ audit: "sandbox_deleted", userId: ADMIN._id, name: "fr-0123456789abcdef" }))

        expect((await app.inject({ method: "DELETE", url: "/installation/sandboxes/fr-0123456789abcdee" })).statusCode).toBe(404)
        expect((await app.inject({ method: "DELETE", url: "/installation/sandboxes/kube-system" })).statusCode).toBe(400)
        expect(sandboxes.delete).toHaveBeenCalledTimes(2)
    })
})
