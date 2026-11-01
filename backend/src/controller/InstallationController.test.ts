import Fastify, { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { settingsModel, sandboxes, templateClient, finders } = vi.hoisted(() => {
    const finder = () => ({ find: vi.fn(() => ({ lean: () => Promise.resolve([] as unknown[]) })) })
    const templateClient = { listAll: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn() }
    return {
        settingsModel: { findById: vi.fn(), updateOne: vi.fn(async () => ({})) },
        templateClient,
        sandboxes: {
            inventory: vi.fn(),
            logs: vi.fn(),
            delete: vi.fn(),
            idleMs: vi.fn(async () => 300_000),
            templates: vi.fn(async () => ({ client: templateClient, workspace: "flightroom" })),
            forgetTemplates: vi.fn()
        },
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
            { method: "DELETE" as const, url: "/installation/sandboxes/fr-0123456789abcdef" },
            { method: "GET" as const, url: "/installation/sandbox-templates" },
            { method: "POST" as const, url: "/installation/sandbox-templates/flightroom-node", payload: { image: "node:24" } },
            { method: "PUT" as const, url: "/installation/sandbox-templates/flightroom-node", payload: { image: "node:24" } },
            { method: "DELETE" as const, url: "/installation/sandbox-templates/flightroom-node" }
        ]) {
            const response = await app.inject(request)
            expect(response.statusCode).toBe(403)
            expect(response.json().error.code).toBe("INSTALLATION_ADMIN_REQUIRED")
        }
        expect(settingsModel.updateOne).not.toHaveBeenCalled()
        expect(sandboxes.delete).not.toHaveBeenCalled()
        expect(sandboxes.logs).not.toHaveBeenCalled()
        expect(templateClient.create).not.toHaveBeenCalled()
        expect(templateClient.delete).not.toHaveBeenCalled()
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
                $unset: { maxHours: 1, sharing: 1, previewsEnabled: 1, previewUrl: 1, image: 1, template: 1 }
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
        ["a public URL of the previews without a scheme", { previewUrl: "*.sandbox.example.com" }],
        ["a public URL of the previews without the *", { previewUrl: "https://sandbox.example.com" }],
        ["a public URL of the previews with a path", { previewUrl: "https://*.example.com/previews" }],
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

    describe("sandbox templates", () => {
        const template = (name: string, workload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
            metadata: { name, labels: { app: "flightroom" }, createdTime: { seconds: 1_700_000_000n } },
            spec: { workload: { environment: {}, ...workload }, ...extra }
        })
        const NODE = template("flightroom-node", { image: "acr.example.com/node:0.0.4", resources: { cpu: "2", memory: "2Gi" } })
        const KATA_DRIVER = { kubernetes: { pod: { runtime_class_name: "kata" } } }
        const KATA = template("flightroom-java", { image: "maven:3.9", resources: { cpu: "1", memory: "2Gi" } }, { driverConfig: KATA_DRIVER })
        // As the SDK names them: InvalidArgument is invalid_config, FailedPrecondition and OutOfRange rpc.
        const refusal = (code: string, connectCode: number) => Object.assign(new Error("template name must be at most 19 characters"), { code, connectCode })
        const inUse = (name?: string) => settingsModel.findById.mockReturnValue({ lean: () => Promise.resolve({ _id: "installation", template: name }) })

        it("Given templates on the gateway, when they are listed, then each comes by name with what it runs, whether it has settings not shown, and whether new sandboxes use it", async () => {
            inUse("flightroom-node")
            templateClient.listAll.mockResolvedValue([NODE, KATA])

            const response = await app.inject({ method: "GET", url: "/installation/sandbox-templates" })

            expect(response.statusCode).toBe(200)
            expect(templateClient.listAll).toHaveBeenCalledWith({ workspace: "flightroom" })
            expect(response.json()).toEqual([
                {
                    name: "flightroom-java",
                    image: "maven:3.9",
                    cpu: "1",
                    memory: "2Gi",
                    labels: { app: "flightroom" },
                    environment: {},
                    advanced: true,
                    languages: [],
                    createdAt: "2023-11-14T22:13:20.000Z",
                    inUse: false
                },
                {
                    name: "flightroom-node",
                    image: "acr.example.com/node:0.0.4",
                    cpu: "2",
                    memory: "2Gi",
                    labels: { app: "flightroom" },
                    environment: {},
                    advanced: false,
                    languages: [],
                    createdAt: "2023-11-14T22:13:20.000Z",
                    inUse: true
                }
            ])
        })

        it("Given a new template, when it is created, then the gateway gets it in the installation's workspace and the creation is audited; a name already taken is a conflict", async () => {
            templateClient.create.mockResolvedValueOnce(template("flightroom-python", { image: "python:3.13", environment: { PIP_NO_CACHE_DIR: "1" } }))
            const payload = { image: "python:3.13", cpu: "1", memory: "", labels: { app: "flightroom" }, environment: { PIP_NO_CACHE_DIR: "1" } }

            const response = await app.inject({ method: "POST", url: "/installation/sandbox-templates/flightroom-python", payload })

            expect(response.statusCode).toBe(201)
            expect(response.json()).toMatchObject({ name: "flightroom-python", image: "python:3.13", environment: { PIP_NO_CACHE_DIR: "1" }, inUse: false })
            expect(templateClient.create).toHaveBeenCalledWith(
                {
                    metadata: { name: "flightroom-python", labels: { app: "flightroom" } },
                    spec: {
                        workload: { image: "python:3.13", environment: { PIP_NO_CACHE_DIR: "1" }, resources: { cpu: "1", memory: "", gpu: undefined } },
                        driverConfig: undefined,
                        desiredServiceLevel: undefined
                    }
                },
                { workspace: "flightroom" }
            )
            expect(logs).toContainEqual(expect.objectContaining({ audit: "sandbox_template_created", userId: ADMIN._id, name: "flightroom-python" }))

            templateClient.create.mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "already_exists" }))
            const taken = await app.inject({ method: "POST", url: "/installation/sandbox-templates/flightroom-python", payload })
            expect(taken.statusCode).toBe(409)
            expect(taken.json().error.code).toBe("SANDBOX_TEMPLATE_EXISTS")
        })

        it("Given the languages of a template, when it is saved, then each is a label of it on the gateway, listed apart from its labels; a change that does not say them keeps them", async () => {
            inUse(undefined)
            templateClient.create.mockImplementation(async (init: { metadata: { name: string; labels: Record<string, string> } }) => ({
                ...template(init.metadata.name, { image: "maven:3.9" }),
                metadata: { ...init.metadata, createdTime: { seconds: 1_700_000_000n } }
            }))

            const created = await app.inject({
                method: "POST",
                url: "/installation/sandbox-templates/jvm",
                payload: { image: "maven:3.9", labels: { app: "flightroom" }, languages: ["java", "node"] }
            })

            expect(created.statusCode).toBe(201)
            const labels = { app: "flightroom", "languages.flightroom.dev/java": "true", "languages.flightroom.dev/node": "true" }
            expect(templateClient.create).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: { name: "jvm", labels } }), { workspace: "flightroom" })
            expect(created.json()).toMatchObject({ labels: { app: "flightroom" }, languages: ["node", "java"] })
            expect(sandboxes.forgetTemplates).toHaveBeenCalled()

            templateClient.get.mockResolvedValueOnce({ ...template("jvm", { image: "maven:3.9" }), metadata: { name: "jvm", labels } })
            templateClient.delete.mockResolvedValue({ outcome: "completed" })
            const changed = await app.inject({ method: "PUT", url: "/installation/sandbox-templates/jvm", payload: { image: "maven:3.9.9", labels: { app: "flightroom" } } })

            expect(changed.statusCode).toBe(200)
            expect(templateClient.create).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ labels }) }), { workspace: "flightroom" })

            const unknown = await app.inject({ method: "POST", url: "/installation/sandbox-templates/ruby", payload: { image: "ruby:3", languages: ["ruby"] } })
            expect(unknown.statusCode).toBe(400)
        })

        it("Given an identity of the installation the gateway does not let manage templates, when they are listed or saved, then it is forbidden with what the gateway says to do", async () => {
            const auth = Object.assign(new Error("[auth] workspace role 'admin' required in workspace 'default'; ask a platform admin to run: openshell workspace member add"), {
                code: "auth",
                connectCode: 7
            })
            templateClient.listAll.mockRejectedValueOnce(auth)
            templateClient.create.mockRejectedValueOnce(auth)
            templateClient.get.mockResolvedValueOnce(NODE)
            templateClient.delete.mockRejectedValueOnce(auth)

            const listed = await app.inject({ method: "GET", url: "/installation/sandbox-templates" })
            const created = await app.inject({ method: "POST", url: "/installation/sandbox-templates/jvm", payload: { image: "maven:3.9" } })
            const changed = await app.inject({ method: "PUT", url: "/installation/sandbox-templates/flightroom-node", payload: { image: "node:24" } })

            for (const response of [listed, created, changed]) {
                expect(response.statusCode).toBe(403)
                expect(response.json().error).toMatchObject({ code: "SANDBOX_GATEWAY_FORBIDDEN", message: expect.stringMatching(/^workspace role 'admin' required/) })
            }
            // Refused before anything was deleted: nothing to put back.
            expect(templateClient.create).toHaveBeenCalledTimes(1)
        })

        it("Given the template new sandboxes use, when it is changed, then it is created again with the settings not shown kept, and its revision changes so the warm sandboxes made from the previous one are replaced", async () => {
            inUse("flightroom-java")
            templateClient.get.mockResolvedValue({ ...KATA, metadata: { ...KATA.metadata, annotations: { owner: "platform" } } })
            templateClient.delete.mockResolvedValue({ outcome: "completed" })
            templateClient.create.mockImplementation(async (init: { metadata: { name: string } }) => template(init.metadata.name, { image: "maven:3.9.9" }))

            const response = await app.inject({ method: "PUT", url: "/installation/sandbox-templates/flightroom-java", payload: { image: "maven:3.9.9", cpu: "1", memory: "4Gi" } })

            expect(response.statusCode).toBe(200)
            expect(response.json()).toMatchObject({ name: "flightroom-java", inUse: true })
            expect(templateClient.delete).toHaveBeenCalledWith("flightroom-java", { workspace: "flightroom", allowMissing: true })
            expect(templateClient.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: { name: "flightroom-java", labels: {}, annotations: { owner: "platform" } },
                    spec: expect.objectContaining({
                        workload: expect.objectContaining({ image: "maven:3.9.9", resources: { cpu: "1", memory: "4Gi", gpu: undefined } }),
                        driverConfig: KATA_DRIVER
                    })
                }),
                { workspace: "flightroom" }
            )
            expect(settingsModel.updateOne).toHaveBeenCalledWith({ _id: "installation" }, { $set: { templateRevision: expect.any(String) } }, { upsert: true })
            expect(sandboxes.delete).not.toHaveBeenCalled()
            expect(logs).toContainEqual(expect.objectContaining({ audit: "sandbox_template_updated", name: "flightroom-java" }))
        })

        it("Given a change the gateway refuses, when it is saved, then the previous template is put back and the refusal is told; a template that does not exist is not found", async () => {
            inUse(undefined)
            templateClient.get.mockResolvedValueOnce(NODE)
            templateClient.delete.mockResolvedValue({ outcome: "completed" })
            templateClient.create.mockRejectedValueOnce(refusal("invalid_config", 3)).mockResolvedValueOnce(NODE)

            const response = await app.inject({ method: "PUT", url: "/installation/sandbox-templates/flightroom-node", payload: { image: "node:24" } })

            expect(response.statusCode).toBe(400)
            expect(response.json().error.code).toBe("SANDBOX_TEMPLATE_INVALID")
            expect(templateClient.create).toHaveBeenLastCalledWith(
                { metadata: { name: "flightroom-node", labels: NODE.metadata.labels, annotations: undefined }, spec: NODE.spec },
                { workspace: "flightroom" }
            )
            expect(settingsModel.updateOne).not.toHaveBeenCalled()
            expect(sandboxes.delete).not.toHaveBeenCalled()

            templateClient.get.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "not_found" }))
            expect((await app.inject({ method: "PUT", url: "/installation/sandbox-templates/flightroom-ruby", payload: { image: "ruby:3" } })).statusCode).toBe(404)
        })

        it("Given a change refused and a gateway that does not take the previous template back, when it is saved, then the loss is told and logged with what the template ran", async () => {
            inUse(undefined)
            templateClient.get.mockResolvedValueOnce(NODE)
            templateClient.delete.mockResolvedValue({ outcome: "completed" })
            templateClient.create.mockRejectedValueOnce(refusal("rpc", 9)).mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "connect" }))

            const response = await app.inject({ method: "PUT", url: "/installation/sandbox-templates/flightroom-node", payload: { image: "node:24" } })

            expect(response.statusCode).toBe(502)
            expect(response.json().error.code).toBe("SANDBOX_TEMPLATE_LOST")
            expect(logs).toContainEqual(expect.objectContaining({ audit: "sandbox_template_lost", name: "flightroom-node", image: "acr.example.com/node:0.0.4" }))
        })

        it("Given the template new sandboxes use, when it is deleted, then it is refused; another one goes, one already gone is not found", async () => {
            inUse("flightroom-node")

            const used = await app.inject({ method: "DELETE", url: "/installation/sandbox-templates/flightroom-node" })
            expect(used.statusCode).toBe(409)
            expect(used.json().error.code).toBe("SANDBOX_TEMPLATE_IN_USE")
            expect(templateClient.delete).not.toHaveBeenCalled()

            templateClient.delete.mockResolvedValueOnce({ outcome: "completed" }).mockResolvedValueOnce({ outcome: "already_absent" })
            expect((await app.inject({ method: "DELETE", url: "/installation/sandbox-templates/flightroom-java" })).statusCode).toBe(204)
            expect(templateClient.delete).toHaveBeenCalledWith("flightroom-java", { workspace: "flightroom", allowMissing: true })
            expect(logs).toContainEqual(expect.objectContaining({ audit: "sandbox_template_deleted", name: "flightroom-java" }))
            expect((await app.inject({ method: "DELETE", url: "/installation/sandbox-templates/flightroom-java" })).statusCode).toBe(404)

            templateClient.delete.mockRejectedValueOnce(refusal("rpc", 9))
            const refused = await app.inject({ method: "DELETE", url: "/installation/sandbox-templates/flightroom-java" })
            expect(refused.statusCode).toBe(400)
            expect(refused.json().error.code).toBe("SANDBOX_TEMPLATE_INVALID")
        })

        it.each([
            ["a name over 19 characters", "flightroom-java-gradle", { image: "gradle:9" }],
            ["a name with capitals", "Flightroom", { image: "gradle:9" }],
            ["no image", "flightroom-gradle", { cpu: "1" }],
            ["an image with a space", "flightroom-gradle", { image: "gradle:9 --privileged" }],
            ["a memory in words", "flightroom-gradle", { image: "gradle:9", memory: "2 GB" }],
            ["a cpu that is no quantity", "flightroom-gradle", { image: "gradle:9", cpu: "two" }],
            ["a label with a space", "flightroom-gradle", { image: "gradle:9", labels: { "my app": "x" } }],
            ["an environment variable with a dash", "flightroom-gradle", { image: "gradle:9", environment: { "GRADLE-OPTS": "x" } }]
        ])("Given %s, when a template is created, then it is refused before the gateway is asked", async (_case, name, payload) => {
            const response = await app.inject({ method: "POST", url: `/installation/sandbox-templates/${name}`, payload })

            expect(response.statusCode).toBe(400)
            expect(templateClient.create).not.toHaveBeenCalled()
        })
    })
})
