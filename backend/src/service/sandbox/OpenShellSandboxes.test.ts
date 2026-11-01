import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationState, MAX_SANDBOX_NAME_LENGTH, OpenShellConfiguration, OpenShellSandboxes, randomSandboxName } from "./OpenShellSandboxes"
import { PooledSandbox, ReleaseOutcome, SandboxPool } from "./sandboxPool"

const { sandbox, raw, connect, OWNER } = vi.hoisted(() => {
    const sandbox = {
        get: vi.fn(),
        create: vi.fn(),
        createFromTemplate: vi.fn(),
        delete: vi.fn(),
        waitDeleted: vi.fn(),
        waitReady: vi.fn(),
        execStream: vi.fn(),
        list: vi.fn()
    }
    const raw = { exposeService: vi.fn(), getSandboxLogs: vi.fn() }
    return { sandbox, raw, connect: vi.fn(async (_options: unknown) => ({ sandbox, raw, health: async () => ({ status: "healthy", version: "1" }) })), OWNER: "0b6c1f2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b" }
})

vi.mock("@nvidia/openshell-sdk", () => ({ OpenShellClient: { connect }, clientCredentials: vi.fn(() => ({ getToken: async () => "renewed" })) }))
vi.mock("../TelemetryService", () => ({
    default: class {
        getInstallationId = async () => OWNER
    }
}))

const sdkError = (code: string) => Object.assign(new Error(code), { code })

const CONVERSATION = "65f1a2b3c4d5e6f708192a3b"
const ORGANIZATION = "65f1a2b3c4d5e6f708192a01"
const OTHER_ORGANIZATION = "65f1a2b3c4d5e6f708192a02"
const NOW = Date.parse("2026-11-01T12:00:00Z")
const GATEWAY = { OPENSHELL_GATEWAY_URL: "https://gateway" }

/**
 * The pool as MongoDB keeps it: each call is one atomic write, after a turn of the event loop, and the name, the key
 * and the slot are unique. Two instances of OpenShellSandboxes sharing one are two replicas sharing the database.
 */
class FakePool implements SandboxPool {
    readonly records = new Map<string, PooledSandbox>()

    constructor(private readonly clock: () => number) {}

    private tick = () => new Promise(resolve => setImmediate(resolve))

    private holds(field: "key" | "slot", value: unknown, except?: string) {
        return [...this.records.values()].some(record => record.name !== except && record[field] !== undefined && record[field] === value)
    }

    private copy = (record?: PooledSandbox) => (record ? { ...record } : undefined)

    seed(record: Partial<PooledSandbox> & { name: string }) {
        this.records.set(record.name, { shared: false, specHash: "stale", state: "ready", createdAt: new Date(this.clock()), ...record })
    }

    async insert(record: Omit<PooledSandbox, "createdAt">) {
        await this.tick()
        if (this.records.has(record.name) || (record.key !== undefined && this.holds("key", record.key)) || (record.slot !== undefined && this.holds("slot", record.slot))) return false
        this.records.set(record.name, { ...record, createdAt: new Date(this.clock()) })
        return true
    }

    async byKey(key: string) {
        await this.tick()
        return this.copy([...this.records.values()].find(record => record.key === key))
    }

    async byName(name: string) {
        await this.tick()
        return this.copy(this.records.get(name))
    }

    async all() {
        await this.tick()
        return [...this.records.values()].map(record => ({ ...record }))
    }

    async markReady(name: string, sandboxId: string) {
        await this.tick()
        const record = this.records.get(name)
        if (record) {
            Object.assign(record, { sandboxId, state: "ready" })
            delete record.releasedAt
        }
    }

    async claim(key: string, organizationId: string, specHash: string, shared: boolean, bornAfter: Date) {
        await this.tick()
        if (this.holds("key", key)) return undefined
        for (const owner of [organizationId, undefined]) {
            const [claimed] = [...this.records.values()]
                .filter(record => record.slot !== undefined && record.state === "ready" && record.specHash === specHash && record.createdAt > bornAfter && record.organizationId === owner)
                .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
            if (claimed) {
                Object.assign(claimed, { key, organizationId, shared })
                delete claimed.slot
                return { ...claimed }
            }
        }
        return undefined
    }

    async release(name: string, key: string, slot: number, releasedAt: Date): Promise<ReleaseOutcome> {
        await this.tick()
        const record = this.records.get(name)
        if (!record || record.key !== key) return "gone"
        if (this.holds("slot", slot, name)) return "slotTaken"
        Object.assign(record, { slot, shared: false, state: "recycling", releasedAt })
        delete record.key
        return "released"
    }

    async remove(name: string) {
        await this.tick()
        this.records.delete(name)
    }

    async removeWarm(name: string) {
        await this.tick()
        const record = this.records.get(name)
        if (!record || record.slot === undefined || record.key !== undefined) return false
        this.records.delete(name)
        return true
    }
}

interface GatewaySandbox {
    id: string
    name: string
    phase: string
    labels: Record<string, string>
    createdAtMs?: number
}

describe("OpenShellSandboxes", () => {
    let clock: number
    let pool: FakePool
    let gateway: Map<string, GatewaySandbox>
    let commands: string[][]

    const sandboxes = (config: OpenShellConfiguration = GATEWAY, options: { installationId?: () => Promise<string>; sleep?: (ms: number) => Promise<void> } = {}) =>
        new OpenShellSandboxes(config, { pool, now: () => clock, installationId: async () => OWNER, ...options })

    const put = (name: string, labels: Record<string, string>, extra: Partial<GatewaySandbox> = {}) =>
        gateway.set(name, { id: `id-${name}`, name, phase: "ready", labels: { "flightroom.dev/role": "ai-change", ...labels }, createdAtMs: clock, ...extra })

    /**
     * Two replicas, each connected before they race: vitest hands the real SDK to an import() racing another one, so
     * the clients are made one after the other.
     */
    const replicas = async (config: OpenShellConfiguration = GATEWAY, options: { sleep?: (ms: number) => Promise<void> } = {}) => {
        const pair = [sandboxes(config, options), sandboxes(config, options)]
        for (const replica of pair) await replica.health()
        return pair
    }

    const ours = { "flightroom.dev/owner": OWNER, "flightroom.dev/pool": "true" }
    const legacy = { "flightroom.dev/owner": OWNER }
    const lifetimes = () => ({ created: vi.fn(async (_key: string, _id: string) => undefined), deleted: vi.fn(async (_key: string, _id: string) => undefined) })
    const assigned = () => [...pool.records.values()].filter(record => record.key !== undefined)
    const warm = () => [...pool.records.values()].filter(record => record.slot !== undefined)

    beforeEach(() => {
        vi.clearAllMocks()
        clock = NOW
        pool = new FakePool(() => clock)
        gateway = new Map()
        commands = []
        sandbox.get.mockImplementation(async (name: string) => {
            const found = gateway.get(name)
            if (!found) throw sdkError("not_found")
            return { ...found }
        })
        const create = async (spec: { name: string; labels: Record<string, string> }) => {
            const created = { id: `id-${spec.name}`, name: spec.name, phase: "provisioning", labels: spec.labels, createdAtMs: clock }
            gateway.set(spec.name, created)
            return { ...created }
        }
        sandbox.create.mockImplementation(create)
        sandbox.createFromTemplate.mockImplementation(create)
        sandbox.delete.mockImplementation(async (name: string) => {
            const found = gateway.get(name)
            gateway.delete(name)
            return found ? { sandboxId: found.id } : {}
        })
        sandbox.waitReady.mockImplementation(async (name: string) => ({ name, phase: "ready" }))
        sandbox.list.mockImplementation(() =>
            (async function* () {
                yield { items: [...gateway.values()].map(item => ({ ...item })) }
            })()
        )
        sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
            commands.push(command)
            yield { type: "exit", exitCode: 0 }
        })
    })

    describe("acquire", () => {
        it("Given no sandbox for the key, when one is acquired, then one is created under a random name with its labels and a read-only policy letting only the package managers reach the registries", async () => {
            const lifecycle = lifetimes()
            await sandboxes({ ...GATEWAY, OPENSHELL_TOKEN: "token" }).acquire(CONVERSATION, lifecycle, CONVERSATION, ORGANIZATION)

            const [record] = assigned()
            expect(record).toMatchObject({ key: CONVERSATION, organizationId: ORGANIZATION, shared: false, state: "ready", sandboxId: `id-${record.name}` })
            expect(record.name).toMatch(/^fr-[0-9a-f]{16}$/)
            expect(connect).toHaveBeenCalledWith(expect.objectContaining({ gateway: "https://gateway", oidcToken: "token" }))
            expect(sandbox.create).toHaveBeenCalledWith({
                name: record.name,
                workspace: undefined,
                image: "node:24-bookworm-slim",
                labels: { "flightroom.dev/role": "ai-change", "flightroom.dev/owner": OWNER, "flightroom.dev/pool": "true" },
                policy: {
                    version: 1,
                    networkPolicies: {
                        "package-registries": {
                            name: "package-registries",
                            endpoints: [
                                "registry.npmjs.org",
                                "repo.maven.apache.org",
                                "repo1.maven.org",
                                "pypi.org",
                                "files.pythonhosted.org",
                                "proxy.golang.org",
                                "sum.golang.org",
                                "storage.googleapis.com",
                                "api.nuget.org",
                                "globalcdn.nuget.org",
                                "pkgs.dev.azure.com",
                                "*.pkgs.visualstudio.com",
                                "*.blob.core.windows.net",
                                "ghcr.io",
                                "pkg-containers.githubusercontent.com"
                            ].map(host => ({ host, port: 443, protocol: "rest", enforcement: 1, access: 1, allowEncodedSlash: true })),
                            binaries: [
                                { path: "/usr/local/bin/node" },
                                { path: "/opt/java/openjdk/bin/java" },
                                { path: "/usr/local/bin/python3.13" },
                                { path: "/usr/local/go/bin/go" },
                                { path: "/usr/share/dotnet/dotnet" }
                            ]
                        }
                    }
                }
            })
            expect(sandbox.waitReady).toHaveBeenCalledWith(record.name, 300, { workspace: undefined })
            expect(lifecycle.created).toHaveBeenCalledWith(CONVERSATION, `id-${record.name}`)
        })

        it("Given registry hosts and network binaries as comma separated lists, when a sandbox is created, then the policy allows each of them", async () => {
            await sandboxes({
                ...GATEWAY,
                OPENSHELL_REGISTRY_HOSTS: " registry.npmjs.org , npm.pkg.github.com ,",
                OPENSHELL_NETWORK_BINARY: "/usr/local/bin/node, /usr/bin/git"
            }).acquire(CONVERSATION)

            const policy = sandbox.create.mock.calls[0][0].policy.networkPolicies["package-registries"]
            expect(policy.endpoints.map((endpoint: { host: string }) => endpoint.host)).toEqual(["registry.npmjs.org", "npm.pkg.github.com"])
            expect(policy.binaries).toEqual([{ path: "/usr/local/bin/node" }, { path: "/usr/bin/git" }])
        })

        it("Given settings read while the console runs, when a sandbox is created, then it is created as they say, not as the configuration it started with", async () => {
            const settings = vi.fn(async () => ({ ...GATEWAY, OPENSHELL_SANDBOX_IMAGE: "registry.example.com/polyglot:2" }))
            await new OpenShellSandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_IMAGE: "node:24-bookworm-slim" }, { pool, now: () => clock, installationId: async () => OWNER, settings }).acquire(
                CONVERSATION
            )

            expect(sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ image: "registry.example.com/polyglot:2" }))
        })

        it("Given the CA of the gateway as PEM text, when the client connects, then it trusts that CA", async () => {
            const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
            await sandboxes({ OPENSHELL_GATEWAY_URL: "https://sandbox.example.com", OPENSHELL_CA_CERT: pem, OPENSHELL_CA_CERT_FILE: "/does/not/exist" }).acquire(CONVERSATION)
            expect(connect).toHaveBeenCalledWith(expect.objectContaining({ caCert: Buffer.from(pem) }))
        })

        it("Given a ready sandbox assigned to the key, when one is acquired, then it is reused and none is created", async () => {
            put("fr-0000000000000001", ours)
            pool.seed({ name: "fr-0000000000000001", sandboxId: "id-fr-0000000000000001", key: CONVERSATION })

            await sandboxes().acquire(CONVERSATION)

            expect(sandbox.create).not.toHaveBeenCalled()
            expect(sandbox.delete).not.toHaveBeenCalled()
            expect(sandbox.waitReady).toHaveBeenCalledWith("fr-0000000000000001", 300, { workspace: undefined })
        })

        it("Given a running preview service, when it is exposed, then OpenShell returns its browser URL", async () => {
            raw.exposeService.mockResolvedValue({ url: "https://preview.example.test" })
            const acquired = await sandboxes().acquire(CONVERSATION)
            const [record] = assigned()

            await expect(acquired.exposeService?.(5173, "preview-fe")).resolves.toBe("https://preview.example.test")
            expect(raw.exposeService).toHaveBeenCalledWith({
                sandbox: record.name,
                workspaceScope: { selection: { case: "workspace", value: "default" } },
                name: "preview-fe",
                targetPort: 5173,
                domain: true,
                requestId: expect.any(String)
            })
        })

        it("Given the sandbox of the key in error, when one is acquired, then it is deleted with its record, its lifetime closed, and another one is created after", async () => {
            put("fr-0000000000000001", ours, { phase: "error" })
            pool.seed({ name: "fr-0000000000000001", sandboxId: "dead-1", key: CONVERSATION })
            const lifecycle = lifetimes()

            await sandboxes().acquire(CONVERSATION, lifecycle)

            expect(sandbox.delete).toHaveBeenCalledWith("fr-0000000000000001", { workspace: undefined, allowMissing: true })
            expect(pool.records.has("fr-0000000000000001")).toBe(false)
            expect(lifecycle.deleted).toHaveBeenCalledWith(CONVERSATION, "dead-1")
            const [record] = assigned()
            expect(lifecycle.created).toHaveBeenCalledWith(CONVERSATION, record.sandboxId)
            expect(lifecycle.deleted.mock.invocationCallOrder[0]).toBeLessThan(lifecycle.created.mock.invocationCallOrder[0])
        })

        it("Given the record of the key older than a creation takes and no sandbox on the gateway, when one is acquired, then the record goes and another one is created", async () => {
            pool.seed({ name: "fr-0000000000000001", sandboxId: "gone-1", key: CONVERSATION, createdAt: new Date(NOW - 10 * 60_000) })
            const lifecycle = lifetimes()

            await sandboxes().acquire(CONVERSATION, lifecycle)

            expect(lifecycle.deleted).toHaveBeenCalledWith(CONVERSATION, "gone-1")
            expect(assigned()).toHaveLength(1)
            expect(assigned()[0].name).not.toBe("fr-0000000000000001")
        })

        it("Given a sandbox stuck provisioning, when the wait for it times out, then it is deleted with its record for the next attempt and the error says its phase", async () => {
            put("fr-0000000000000001", ours, { phase: "provisioning" })
            pool.seed({ name: "fr-0000000000000001", sandboxId: "id-fr-0000000000000001", key: CONVERSATION })
            sandbox.waitReady.mockRejectedValue(new Error("timed out waiting for sandbox"))
            const lifecycle = lifetimes()

            await expect(sandboxes().acquire(CONVERSATION, lifecycle)).rejects.toThrow(/phase: provisioning.*timed out waiting/)
            expect(sandbox.delete).toHaveBeenCalledWith("fr-0000000000000001", { workspace: undefined, allowMissing: true })
            expect(pool.records.size).toBe(0)
            expect(lifecycle.deleted).toHaveBeenCalledWith(CONVERSATION, "id-fr-0000000000000001")
        })

        it("Given a ready sandbox, when only the wait for it fails, then it is kept and the error goes through", async () => {
            put("fr-0000000000000001", ours)
            pool.seed({ name: "fr-0000000000000001", sandboxId: "id-fr-0000000000000001", key: CONVERSATION })
            sandbox.waitReady.mockRejectedValue(new Error("network"))

            await expect(sandboxes().acquire(CONVERSATION)).rejects.toThrow("network")
            expect(sandbox.delete).not.toHaveBeenCalled()
            expect(pool.records.size).toBe(1)
        })

        it("Given two replicas asking for the same key at once, when they acquire it, then one sandbox is created, both use it, and only its creator opens its lifetime", async () => {
            const first = lifetimes()
            const second = lifetimes()
            const sleep = async () => {
                clock += 1_000
                await new Promise(resolve => setImmediate(resolve))
            }

            const [one, two] = await replicas(GATEWAY, { sleep })
            const [a, b] = await Promise.all([one.acquire(CONVERSATION, first), two.acquire(CONVERSATION, second)])

            expect(sandbox.create).toHaveBeenCalledTimes(1)
            expect(assigned()).toHaveLength(1)
            expect(a.root).toBe(b.root)
            expect(first.created.mock.calls.length + second.created.mock.calls.length).toBe(1)
        })

        it("Given another replica still creating the sandbox of the key, when one is acquired, then that one is waited for instead of creating a second", async () => {
            pool.seed({ name: "fr-0000000000000001", key: CONVERSATION, state: "creating", sandboxId: undefined })
            const sleep = vi.fn(async () => {
                put("fr-0000000000000001", ours, { phase: "provisioning" })
                await pool.markReady("fr-0000000000000001", "id-fr-0000000000000001")
            })

            await sandboxes(GATEWAY, { sleep }).acquire(CONVERSATION)

            expect(sleep).toHaveBeenCalledTimes(1)
            expect(sandbox.create).not.toHaveBeenCalled()
            expect(sandbox.waitReady).toHaveBeenCalledWith("fr-0000000000000001", 300, { workspace: undefined })
        })

        it("Given a gateway refusing the creation, when one is acquired, then the record goes with the error, so the next attempt creates one", async () => {
            sandbox.create.mockRejectedValueOnce(new Error("quota exceeded"))

            await expect(sandboxes().acquire(CONVERSATION)).rejects.toThrow("quota exceeded")
            expect(pool.records.size).toBe(0)
        })

        it("Given warm sandboxes, one recycled by the same organization and one never used, when an organization acquires one, then it gets its own recycled one and its lifetime opens", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 2 }).sweep(async () => "idle")
            const [recycled, fresh] = warm()
            recycled.organizationId = ORGANIZATION
            sandbox.create.mockClear()
            const lifecycle = lifetimes()

            await sandboxes().acquire(CONVERSATION, lifecycle, CONVERSATION, ORGANIZATION)

            expect(sandbox.create).not.toHaveBeenCalled()
            expect(pool.records.get(recycled.name)).toMatchObject({ key: CONVERSATION, organizationId: ORGANIZATION })
            expect(pool.records.get(recycled.name)?.slot).toBeUndefined()
            expect(pool.records.get(fresh.name)?.slot).toBeDefined()
            expect(lifecycle.created).toHaveBeenCalledWith(CONVERSATION, recycled.sandboxId)
        })

        it("Given warm sandboxes, one recycled by another organization and one never used, when an organization acquires one, then it gets the one never used", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 2 }).sweep(async () => "idle")
            const [theirs, fresh] = warm()
            theirs.organizationId = OTHER_ORGANIZATION

            await sandboxes().acquire(CONVERSATION, {}, CONVERSATION, ORGANIZATION)

            expect(pool.records.get(fresh.name)).toMatchObject({ key: CONVERSATION, organizationId: ORGANIZATION })
            expect(pool.records.get(theirs.name)).toMatchObject({ organizationId: OTHER_ORGANIZATION, slot: theirs.slot })
        })

        it("Given only a warm sandbox recycled by another organization, when an organization acquires one, then a new one is created: the caches of the other's home stay with it", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            const [theirs] = warm()
            theirs.organizationId = OTHER_ORGANIZATION
            sandbox.create.mockClear()

            await sandboxes().acquire(CONVERSATION, {}, CONVERSATION, ORGANIZATION)

            expect(sandbox.create).toHaveBeenCalledTimes(1)
            expect(pool.records.get(theirs.name)?.key).toBeUndefined()
        })

        it("Given a warm sandbox created with another image, or a caller that does not say its organization, when one is acquired, then a new one is created", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            sandbox.create.mockClear()

            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_IMAGE: "node:26" }).acquire(CONVERSATION, {}, CONVERSATION, ORGANIZATION)
            await sandboxes().acquire("65f1a2b3c4d5e6f708192a3c")

            expect(sandbox.create).toHaveBeenCalledTimes(2)
            expect(warm()).toHaveLength(1)
        })

        it("Given the sweep moving the sandbox back into the pool while it is looked up, when one is acquired, then the key gets another one", async () => {
            put("fr-0000000000000001", ours)
            pool.seed({ name: "fr-0000000000000001", sandboxId: "id-fr-0000000000000001", key: CONVERSATION })
            sandbox.waitReady.mockImplementationOnce(async (name: string) => {
                await pool.release(name, CONVERSATION, 0, new Date(clock))
                return { name, phase: "ready" }
            })

            const acquired = await sandboxes().acquire(CONVERSATION)

            expect(sandbox.create).toHaveBeenCalledTimes(1)
            const [record] = assigned()
            expect(record.name).not.toBe("fr-0000000000000001")
            expect(acquired.root).toBe(`/sandbox/spaces/${CONVERSATION}`)
        })

        it("Given a template and no registry hosts, when a sandbox is created, then it comes from the template under the gateway's own network policy", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_TEMPLATE: "node-gvisor", OPENSHELL_REGISTRY_HOSTS: "", OPENSHELL_WORKSPACE: "flightroom" }).acquire(CONVERSATION)
            expect(sandbox.createFromTemplate).toHaveBeenCalledWith(expect.objectContaining({ workspace: "flightroom", workloadTemplate: "node-gvisor", policy: undefined }))
            expect(sandbox.create).not.toHaveBeenCalled()
        })

        it("Given a command printing more than is kept, when it runs, then its exit code and the end of its output come back with how much was cut", async () => {
            sandbox.execStream.mockImplementation(async function* () {
                for (let index = 0; index < 100; index++) yield { stream: index % 2 ? "stderr" : "stdout", data: Buffer.from(`${String(index).padStart(999, ".")}\n`) }
                yield { type: "exit", exitCode: 2 }
            })
            const acquired = await sandboxes().acquire(CONVERSATION)
            const result = await acquired.exec(["npm", "test"], { workdir: "/sandbox/repositories/shop" })

            expect(result.exitCode).toBe(2)
            expect(result.output.length).toBe(64_000)
            expect(result.cutBytes).toBe(100 * 1_000 - 64_000)
            expect(result.output.endsWith("99\n")).toBe(true)
            expect(sandbox.execStream).toHaveBeenCalledWith(assigned()[0].name, ["npm", "test"], expect.objectContaining({ workdir: "/sandbox/repositories/shop", noLoginShell: true }))
        })

        it("Given a conversation of a shared sandbox, when it is acquired, then its commands run in the folder of the conversation, with the home shared by them all", async () => {
            const key = "domain-65f1a2b3c4d5e6f708192a3c"

            const acquired = await sandboxes().acquire(key, {}, CONVERSATION)

            expect(acquired.root).toBe(`/sandbox/spaces/${CONVERSATION}`)
            expect(acquired.home).toBe("/sandbox/home")
            expect(assigned()[0]).toMatchObject({ key, shared: true })
        })

        it("Given a sandbox of one conversation, when it is acquired, then its commands run in its own folder and it is not marked as shared", async () => {
            const acquired = await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_ROOT: "/work" }).acquire(CONVERSATION)

            expect(acquired.root).toBe(`/work/spaces/${CONVERSATION}`)
            expect(acquired.home).toBe("/work/home")
            expect(assigned()[0].shared).toBe(false)
        })

        it("Given a folder name a shell could misread, when a sandbox is acquired for it, then it is refused before reaching the gateway", async () => {
            await expect(sandboxes().acquire(CONVERSATION, {}, "../etc")).rejects.toThrow("cannot name a folder")
            expect(sandbox.get).not.toHaveBeenCalled()
        })

        it("Given an owner set in the configuration, when a sandbox is created, then it carries that owner", async () => {
            await new OpenShellSandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_OWNER: "flightroom-dev" }, { pool, now: () => clock }).acquire(CONVERSATION)

            expect(sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ labels: expect.objectContaining({ "flightroom.dev/owner": "flightroom-dev" }) }))
        })

        it("Given the installation id cannot be read, when a sandbox is acquired, then it fails and the next one asks again, once for good", async () => {
            const installationId = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("database down")).mockResolvedValue(OWNER)
            const replica = new OpenShellSandboxes(GATEWAY, { pool, now: () => clock, installationId })

            await expect(replica.acquire(CONVERSATION)).rejects.toThrow("database down")
            await replica.acquire(CONVERSATION)
            await replica.acquire(CONVERSATION)
            expect(installationId).toHaveBeenCalledTimes(2)
            expect(sandbox.create).toHaveBeenCalledTimes(1)
        })
    })

    describe("names", () => {
        it("Given a new sandbox, then its random name fits the gateway, is a valid Kubernetes name, and is never the same twice", () => {
            const names = new Set(Array.from({ length: 100 }, () => randomSandboxName()))

            expect(names.size).toBe(100)
            for (const name of names) {
                expect(name).toMatch(/^fr-[0-9a-f]{16}$/)
                expect(name.length).toBeLessThanOrEqual(MAX_SANDBOX_NAME_LENGTH)
            }
        })
    })

    describe("sweep of the sandboxes created before the pool", () => {
        it("Given sandboxes of this installation, when they are swept, then those of busy conversations stay and the others go", async () => {
            put("fr-busy", { ...legacy, "flightroom.dev/conversation": "busy" })
            put("fr-idle", { ...legacy, "flightroom.dev/conversation": "idle" })
            put("fr-unknown", { ...legacy, "flightroom.dev/conversation": "unknown" })
            put("fr-orphan", legacy)

            const deleted = await sandboxes().sweep(async conversation => conversation as ConversationState)

            expect(sandbox.list).toHaveBeenCalledWith({ workspace: undefined, labelSelector: "flightroom.dev/role=ai-change" })
            expect(sandbox.delete.mock.calls.map(([name]) => name)).toEqual(["fr-idle", "fr-unknown", "fr-orphan"])
            expect(deleted).toBe(3)
        })

        it("Given a callback, when sandboxes are swept, then it is told the conversation of each one deleted that has one", async () => {
            put("fr-busy", { ...legacy, "flightroom.dev/conversation": "busy" })
            put("fr-idle", { ...legacy, "flightroom.dev/conversation": "idle" })
            put("fr-orphan", legacy)
            const deleted = vi.fn(async (_conversation: string, _id: string) => undefined)

            await sandboxes().sweep(async conversation => conversation as ConversationState, deleted)

            expect(deleted.mock.calls).toEqual([["idle", "id-fr-idle"]])
        })

        it("Given a sandbox another replica deleted first, when it is swept, then its lifetime is still told of but it is not counted as deleted here", async () => {
            put("fr-idle", { ...legacy, "flightroom.dev/conversation": "idle" })
            sandbox.delete.mockResolvedValue({})
            const deleted = vi.fn(async (_conversation: string, _id: string) => undefined)

            expect(await sandboxes().sweep(async conversation => conversation as ConversationState, deleted)).toBe(0)
            expect(deleted).toHaveBeenCalledWith("idle", "id-fr-idle")
        })

        it("Given sandboxes of another installation on the same gateway, when they are swept, then none is deleted, whatever their conversation or label", async () => {
            const other = { "flightroom.dev/owner": "another-installation" }
            put("fr-theirs-idle", { ...other, "flightroom.dev/conversation": "idle" })
            put("fr-theirs-unknown", { ...other, "flightroom.dev/conversation": "unknown" })
            put("fr-theirs-orphan", other)
            put("fr-theirs-pool", { ...other, "flightroom.dev/pool": "true" }, { createdAtMs: NOW - 60 * 60_000 })
            const stateOf = vi.fn(async (conversation: string) => conversation as ConversationState)

            expect(await sandboxes().sweep(stateOf)).toBe(0)
            expect(sandbox.delete).not.toHaveBeenCalled()
            expect(stateOf).not.toHaveBeenCalled()
        })

        it("Given sandboxes past their maximum age, when they are swept, then those none of whose jobs waits or runs go, even within the idle time", async () => {
            const old = NOW - 25 * 3_600_000
            put("fr-old-busy", { ...legacy, "flightroom.dev/conversation": "busy" }, { createdAtMs: old })
            put("fr-old-running", { ...legacy, "flightroom.dev/conversation": "running" }, { createdAtMs: old })
            put("fr-young-busy", { ...legacy, "flightroom.dev/conversation": "busy" }, { createdAtMs: NOW - 3_600_000 })
            put("fr-ageless-busy", { ...legacy, "flightroom.dev/conversation": "busy" }, { createdAtMs: undefined })

            const deleted = await sandboxes().sweep(async conversation => conversation as ConversationState)

            expect(sandbox.delete.mock.calls.map(([name]) => name)).toEqual(["fr-old-busy"])
            expect(deleted).toBe(1)
        })

        it("Given a shared sandbox still used, when it is swept, then the folders of its idle and unknown conversations are removed, their dev servers stopped, at most once every few minutes", async () => {
            sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
                commands.push(command)
                if (command[2].includes("for entry in")) yield { stream: "stdout", data: Buffer.from("aaaaaa\nbbbbbb\ncccccc\nNot A Space\n") }
                yield { type: "exit", exitCode: 0 }
            })
            put("fr-domain", { ...legacy, "flightroom.dev/conversation": "domain-key", "flightroom.dev/spaces": "true" })
            const states: Record<string, ConversationState> = { "domain-key": "running", aaaaaa: "busy", bbbbbb: "idle", cccccc: "unknown" }
            const replica = sandboxes()

            expect(await replica.sweep(async conversation => states[conversation])).toBe(0)

            expect(sandbox.delete).not.toHaveBeenCalled()
            expect(commands).toHaveLength(2)
            expect(commands[0].slice(3)).toEqual(["/sandbox/spaces"])
            expect(commands[1][2]).toContain("kill -TERM")
            expect(commands[1].slice(3)).toEqual(["/sandbox/spaces", "bbbbbb", "cccccc"])

            clock += 60_000
            await replica.sweep(async conversation => states[conversation])
            expect(commands).toHaveLength(2)

            clock += 5 * 60_000
            await replica.sweep(async conversation => states[conversation])
            expect(commands).toHaveLength(4)
        })

        it("Given the folders of idle conversations, when the sweep removes them in a real shell, then the dev server group of an old one is stopped and its folder gone, and one written just now stays", async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-spaces-"))
            const server = spawn("sleep", ["60"], { detached: true })
            const stopped = new Promise(resolve => server.once("exit", resolve))
            const old = new Date(Date.now() - 10 * 60_000)
            fs.mkdirSync(path.join(root, "spaces", "aaaaaa", "previews"), { recursive: true })
            fs.writeFileSync(path.join(root, "spaces", "aaaaaa", "previews", "shop.pid"), String(server.pid))
            for (const entry of ["previews/shop.pid", "previews", ""]) fs.utimesSync(path.join(root, "spaces", "aaaaaa", entry), old, old)
            fs.mkdirSync(path.join(root, "spaces", "bbbbbb", "repositories"), { recursive: true })
            sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
                const result = spawnSync(command[0], command.slice(1))
                yield { stream: "stdout", data: Buffer.concat([result.stdout, result.stderr]) }
                yield { type: "exit", exitCode: result.status ?? -1 }
            })
            put("fr-domain", { ...legacy, "flightroom.dev/conversation": "domain-key", "flightroom.dev/spaces": "true" })

            try {
                await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_ROOT: root }).sweep(async conversation => (conversation === "domain-key" ? "running" : "idle"))

                await stopped
                expect(fs.existsSync(path.join(root, "spaces", "aaaaaa"))).toBe(false)
                expect(fs.existsSync(path.join(root, "spaces", "bbbbbb"))).toBe(true)
            } finally {
                server.kill()
                fs.rmSync(root, { recursive: true, force: true })
            }
        })

        it("Given a sandbox of one conversation still used, when it is swept, then nothing runs in it", async () => {
            put("fr-busy", { ...legacy, "flightroom.dev/conversation": "busy" })
            await sandboxes().sweep(async conversation => conversation as ConversationState)
            expect(sandbox.execStream).not.toHaveBeenCalled()
        })

        it("Given sandboxes made before the owner label, when they are swept, then only those of a conversation known here and idle are deleted", async () => {
            put("fr-legacy-idle", { "flightroom.dev/conversation": "idle" })
            put("fr-legacy-unknown", { "flightroom.dev/conversation": "unknown" })
            put("fr-legacy-busy", { "flightroom.dev/conversation": "busy" })
            put("fr-legacy-orphan", {})

            const deleted = await sandboxes().sweep(async conversation => conversation as ConversationState)

            expect(sandbox.delete.mock.calls.map(([name]) => name)).toEqual(["fr-legacy-idle"])
            expect(deleted).toBe(1)
        })
    })

    describe("sweep of the pool", () => {
        /** A sandbox of the pool assigned to `key` since an hour, created as the current settings create one. */
        const assignedSandbox = async (key: string, config: OpenShellConfiguration = GATEWAY, organizationId: string | null = ORGANIZATION) => {
            await sandboxes(config).acquire(key, {}, key, organizationId ?? undefined)
            const record = [...pool.records.values()].find(candidate => candidate.key === key)!
            record.createdAt = new Date(clock - 3_600_000)
            gateway.get(record.name)!.createdAtMs = clock - 3_600_000
            sandbox.create.mockClear()
            commands = []
            return record
        }

        it("Given a key nobody uses any more and no warm sandbox wanted, when it is swept, then its sandbox is deleted with its record and its lifetime closed", async () => {
            const record = await assignedSandbox(CONVERSATION)
            const deleted = vi.fn(async (_key: string, _id: string) => undefined)

            expect(await sandboxes().sweep(async () => "idle", deleted)).toBe(1)

            expect(gateway.has(record.name)).toBe(false)
            expect(pool.records.size).toBe(0)
            expect(deleted).toHaveBeenCalledWith(CONVERSATION, record.sandboxId)
        })

        it("Given a key nobody uses any more while the pool lacks a warm sandbox, when it is swept, then its sandbox is emptied, its lifetime closed and it goes back into the pool instead of being deleted", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }
            const record = await assignedSandbox(CONVERSATION, config)
            const deleted = vi.fn(async (_key: string, _id: string) => undefined)

            expect(await sandboxes(config).sweep(async () => "idle", deleted)).toBe(0)

            expect(sandbox.delete).not.toHaveBeenCalled()
            expect(sandbox.create).not.toHaveBeenCalled()
            expect(commands).toHaveLength(1)
            expect(commands[0][2]).toContain("kill -TERM")
            expect(commands[0][2]).toContain("rm -rf")
            expect(commands[0].slice(3)).toEqual(["/sandbox/spaces"])
            expect(pool.records.get(record.name)).toMatchObject({ slot: 0, organizationId: ORGANIZATION, shared: false, state: "ready" })
            expect(pool.records.get(record.name)?.key).toBeUndefined()
            expect(deleted).toHaveBeenCalledWith(CONVERSATION, record.sandboxId)
        })

        it("Given a sandbox moved back into the pool, while it is being emptied, then nobody can claim it; once emptied, its organization can", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }
            const record = await assignedSandbox(CONVERSATION, config)
            const claims: (string | undefined)[] = []
            sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
                commands.push(command)
                claims.push((await pool.claim("65f1a2b3c4d5e6f708192a3c", ORGANIZATION, record.specHash, false, new Date(0)))?.name)
                yield { type: "exit", exitCode: 0 }
            })

            await sandboxes(config).sweep(async () => "idle")

            expect(claims).toEqual([undefined])
            expect((await pool.claim("65f1a2b3c4d5e6f708192a3c", ORGANIZATION, record.specHash, false, new Date(0)))?.name).toBe(record.name)
        })

        it("Given a job writing in the sandbox while it goes back into the pool, when the sweep empties it, then nothing is removed and it is deleted instead of being handed out", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }
            const record = await assignedSandbox(CONVERSATION, config)
            sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
                commands.push(command)
                yield { type: "exit", exitCode: 3 }
            })
            const deleted = vi.fn(async (_key: string, _id: string) => undefined)

            await sandboxes(config).sweep(async () => "idle", deleted)

            expect(commands[0][2]).toContain("-mmin -2")
            expect(gateway.has(record.name)).toBe(false)
            expect(pool.records.has(record.name)).toBe(false)
            expect(deleted).toHaveBeenCalledWith(CONVERSATION, record.sandboxId)
        })

        it("Given a job of the key starting while its sandbox is emptied, when it is swept, then the sandbox stays the key's and its lifetime stays open", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }
            const record = await assignedSandbox(CONVERSATION, config)
            const states: ConversationState[] = ["idle", "running"]
            const deleted = vi.fn(async (_key: string, _id: string) => undefined)

            await sandboxes(config).sweep(async () => states.shift() ?? "running", deleted)

            expect(pool.records.get(record.name)?.key).toBe(CONVERSATION)
            expect(deleted).not.toHaveBeenCalled()
            expect(sandbox.delete).not.toHaveBeenCalled()
            // Checked again before anything is removed: its folders are left alone
            expect(commands).toHaveLength(0)
        })

        it("Given a warm sandbox a replica with older settings claims while the sweep deletes it as stale, then it stays with the key that claimed it", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            const [warmOne] = warm()
            sandbox.create.mockClear()
            const replica = sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 0, OPENSHELL_SANDBOX_IMAGE: "node:26" })
            // The sweep reads the records, then the other replica claims the warm one before the sweep acts on what it read.
            const read = pool.all.bind(pool)
            pool.all = async () => {
                const snapshot = await read()
                await pool.claim(CONVERSATION, ORGANIZATION, warmOne.specHash, false, new Date(0))
                return snapshot
            }

            await replica.sweep(async () => "running")

            expect(gateway.has(warmOne.name)).toBe(true)
            expect(pool.records.get(warmOne.name)?.key).toBe(CONVERSATION)
        })

        it("Given a warm sandbox past its maximum age the sweep has not deleted yet, when an organization acquires one, then it is not handed out and a new one is created", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            const [warmOne] = warm()
            warmOne.createdAt = new Date(NOW - 25 * 3_600_000)
            sandbox.create.mockClear()

            await sandboxes().acquire(CONVERSATION, {}, CONVERSATION, ORGANIZATION)

            expect(sandbox.create).toHaveBeenCalledTimes(1)
            expect(pool.records.get(warmOne.name)?.key).toBeUndefined()
        })

        it("Given warm records whose creation was never written down as done, when they are swept past the ready timeout, then one the gateway says ready can be handed out and the others are deleted", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            const [{ specHash }] = warm()
            const stale = { specHash, state: "creating" as const, sandboxId: undefined, createdAt: new Date(NOW - 10 * 60_000) }
            pool.seed({ ...stale, name: "fr-0000000000000001", slot: 1 })
            pool.seed({ ...stale, name: "fr-0000000000000002", slot: 2 })
            pool.seed({ ...stale, name: "fr-0000000000000003", slot: 3, createdAt: new Date(NOW - 60_000) })
            put("fr-0000000000000001", ours, { phase: "ready" })
            put("fr-0000000000000002", ours, { phase: "provisioning" })
            put("fr-0000000000000003", ours, { phase: "provisioning" })
            sandbox.create.mockClear()

            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 4 }).sweep(async () => "idle")

            expect(pool.records.get("fr-0000000000000001")).toMatchObject({ state: "ready", sandboxId: "id-fr-0000000000000001" })
            expect(gateway.has("fr-0000000000000002")).toBe(false)
            expect(pool.records.get("fr-0000000000000003")?.state).toBe("creating")
            // Slot 2 is filled again
            expect(sandbox.create).toHaveBeenCalledTimes(1)
        })

        it("Given a sandbox a replica stopped emptying halfway, when it is swept, then it is deleted once that replica has had its time, and left alone before", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            const [warmOne] = warm()
            Object.assign(warmOne, { state: "recycling", releasedAt: new Date(NOW - 60_000) })

            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            expect(gateway.has(warmOne.name)).toBe(true)

            warmOne.releasedAt = new Date(NOW - 10 * 60_000)
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "idle")
            expect(gateway.has(warmOne.name)).toBe(false)
            expect(warm()).toHaveLength(1)
        })

        it("Given sandboxes the pool could take back but past their maximum age, created otherwise, or of no known organization, when they are swept, then they are deleted and the pool gets a new one", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }
            const old = await assignedSandbox("65f1a2b3c4d5e6f708192a31", config)
            gateway.get(old.name)!.createdAtMs = NOW - 25 * 3_600_000
            const otherImage = await assignedSandbox("65f1a2b3c4d5e6f708192a32", { ...config, OPENSHELL_SANDBOX_IMAGE: "node:22" })
            const noOrganization = await assignedSandbox("65f1a2b3c4d5e6f708192a33", config, null)

            await sandboxes(config).sweep(async () => "idle")

            expect(sandbox.delete.mock.calls.map(([name]) => name).sort()).toEqual([old.name, otherImage.name, noOrganization.name].sort())
            expect(assigned()).toHaveLength(0)
            expect(warm()).toHaveLength(1)
            expect(sandbox.create).toHaveBeenCalledTimes(1)
        })

        it("Given a busy shared sandbox, when it is swept, then it stays the key's and the folders of its idle conversations are pruned", async () => {
            await sandboxes().acquire("domain-key", {}, CONVERSATION, ORGANIZATION)
            sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
                commands.push(command)
                if (command[2].includes("for entry in")) yield { stream: "stdout", data: Buffer.from(`${CONVERSATION}\n`) }
                yield { type: "exit", exitCode: 0 }
            })

            await sandboxes().sweep(async key => (key === "domain-key" ? "busy" : "idle"))

            expect(assigned()).toHaveLength(1)
            expect(commands.at(-1)?.slice(3)).toEqual(["/sandbox/spaces", CONVERSATION])
        })

        it("Given warm sandboxes created with an older image, past their maximum age, or above the number wanted, when they are swept, then they are deleted and the slots wanted refilled", async () => {
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 3 }).sweep(async () => "idle")
            const [first, second, third] = warm().sort((left, right) => left.slot! - right.slot!)
            gateway.get(second.name)!.createdAtMs = NOW - 25 * 3_600_000
            sandbox.create.mockClear()

            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 2, OPENSHELL_SANDBOX_IMAGE: "node:26" }).sweep(async () => "idle")

            expect(sandbox.delete.mock.calls.map(([name]) => name).sort()).toEqual([first.name, second.name, third.name].sort())
            expect(sandbox.create).toHaveBeenCalledTimes(2)
            expect(sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ image: "node:26", labels: expect.objectContaining({ "flightroom.dev/pool": "true" }) }))
            expect(
                warm()
                    .map(record => record.slot)
                    .sort()
            ).toEqual([0, 1])
        })

        it("Given the warm sandboxes wanted, when two sweeps run one after the other, then the second creates none", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 2 }
            await sandboxes(config).sweep(async () => "idle")
            await sandboxes(config).sweep(async () => "idle")

            expect(sandbox.create).toHaveBeenCalledTimes(2)
            expect(sandbox.waitReady).not.toHaveBeenCalled()
            expect(warm().map(record => record.state)).toEqual(["ready", "ready"])
        })

        it("Given the warm sandboxes wanted, when two replicas sweep at the same time, then each slot is filled once", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 3 }
            const [one, two] = await replicas(config)
            await Promise.all([one.sweep(async () => "idle"), two.sweep(async () => "idle")])

            expect(sandbox.create).toHaveBeenCalledTimes(3)
            expect(
                warm()
                    .map(record => record.slot)
                    .sort()
            ).toEqual([0, 1, 2])
        })

        it("Given two replicas sweeping the same idle key at the same time, when the pool lacks one sandbox, then it goes back into one slot and nothing is deleted nor created", async () => {
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }
            const record = await assignedSandbox(CONVERSATION, config)
            const [one, two] = await replicas(config)

            await Promise.all([one.sweep(async () => "idle"), two.sweep(async () => "idle")])

            expect(sandbox.delete).not.toHaveBeenCalled()
            expect(sandbox.create).not.toHaveBeenCalled()
            expect(warm()).toEqual([expect.objectContaining({ name: record.name, slot: 0 })])
        })

        it("Given records whose sandbox the gateway no longer has, when they are swept, then the old ones go with their lifetime closed and one just written stays", async () => {
            pool.seed({ name: "fr-0000000000000001", sandboxId: "gone-1", key: CONVERSATION, createdAt: new Date(NOW - 10 * 60_000) })
            pool.seed({ name: "fr-0000000000000002", key: "65f1a2b3c4d5e6f708192a3c", state: "creating", sandboxId: undefined })
            const deleted = vi.fn(async (_key: string, _id: string) => undefined)

            await sandboxes().sweep(async () => "idle", deleted)

            expect([...pool.records.keys()]).toEqual(["fr-0000000000000002"])
            expect(deleted).toHaveBeenCalledWith(CONVERSATION, "gone-1")
        })

        it("Given sandboxes of the pool with no record, when they are swept, then the old ones are deleted and one just created stays", async () => {
            put("fr-0000000000000001", ours, { createdAtMs: NOW - 10 * 60_000 })
            put("fr-0000000000000002", ours, { createdAtMs: NOW - 10_000 })

            await sandboxes().sweep(async () => "idle")

            expect(sandbox.delete.mock.calls.map(([name]) => name)).toEqual(["fr-0000000000000001"])
        })

        it("Given a sandbox going back into the pool, when it is emptied in a real shell, then its dev servers are stopped and every conversation folder removed, while its home stays", async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-reset-"))
            const server = spawn("sleep", ["60"], { detached: true })
            const stopped = new Promise(resolve => server.once("exit", resolve))
            fs.mkdirSync(path.join(root, "spaces", "aaaaaa", "previews"), { recursive: true })
            fs.writeFileSync(path.join(root, "spaces", "aaaaaa", "previews", "shop.pid"), String(server.pid))
            fs.mkdirSync(path.join(root, "spaces", "bbbbbb", "repositories"), { recursive: true })
            fs.writeFileSync(path.join(root, "spaces", ".hidden"), "x")
            fs.mkdirSync(path.join(root, "home", ".npm"), { recursive: true })
            // Nothing written in the last two minutes: the conversations are idle
            const old = new Date(Date.now() - 10 * 60_000)
            for (const entry of ["aaaaaa/previews/shop.pid", "aaaaaa/previews", "aaaaaa", "bbbbbb/repositories", "bbbbbb", ".hidden"]) fs.utimesSync(path.join(root, "spaces", entry), old, old)
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1, OPENSHELL_SANDBOX_ROOT: root }
            await assignedSandbox(CONVERSATION, config)
            sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
                const result = spawnSync(command[0], command.slice(1))
                yield { stream: "stdout", data: Buffer.concat([result.stdout, result.stderr]) }
                yield { type: "exit", exitCode: result.status ?? -1 }
            })

            try {
                await sandboxes(config).sweep(async () => "idle")

                await stopped
                expect(fs.readdirSync(path.join(root, "spaces"))).toEqual([])
                expect(fs.existsSync(path.join(root, "home", ".npm"))).toBe(true)
                expect(warm()).toHaveLength(1)
            } finally {
                server.kill()
                fs.rmSync(root, { recursive: true, force: true })
            }
        })

        it("Given a file written just now in a sandbox going back into the pool, when it is emptied in a real shell, then nothing is removed", async () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-reset-"))
            fs.mkdirSync(path.join(root, "spaces", "aaaaaa", "repositories", "shop"), { recursive: true })
            fs.writeFileSync(path.join(root, "spaces", "aaaaaa", "repositories", "shop", "package.json"), "{}")
            const config = { ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1, OPENSHELL_SANDBOX_ROOT: root }
            const record = await assignedSandbox(CONVERSATION, config)
            sandbox.execStream.mockImplementation(async function* (_name: string, command: string[]) {
                const result = spawnSync(command[0], command.slice(1))
                yield { stream: "stdout", data: Buffer.concat([result.stdout, result.stderr]) }
                yield { type: "exit", exitCode: result.status ?? -1 }
            })

            try {
                await sandboxes(config).sweep(async () => "idle")

                expect(fs.existsSync(path.join(root, "spaces", "aaaaaa", "repositories", "shop", "package.json"))).toBe(true)
                expect(pool.records.has(record.name)).toBe(false)
                expect(gateway.has(record.name)).toBe(false)
            } finally {
                fs.rmSync(root, { recursive: true, force: true })
            }
        })
    })

    describe("for the installation page", () => {
        it("Given sandboxes of the pool, before it and of another installation, when they are listed, then only this installation's come, each with what it does for the pool", async () => {
            await sandboxes().acquire("domain-key", {}, CONVERSATION, ORGANIZATION)
            await sandboxes({ ...GATEWAY, OPENSHELL_SANDBOX_WARM: 1 }).sweep(async () => "running")
            put("fr-legacy", { ...legacy, "flightroom.dev/conversation": CONVERSATION })
            put("fr-theirs", { "flightroom.dev/owner": "another-installation", "flightroom.dev/pool": "true" })
            pool.seed({ name: "fr-0000000000000009", slot: 5, state: "creating", sandboxId: undefined })

            const items = await sandboxes().inventory()

            expect(items.map(item => [item.pool, item.key, item.organizationId]).sort()).toEqual(
                [
                    ["assigned", "domain-key", ORGANIZATION],
                    ["creating", undefined, undefined],
                    ["legacy", CONVERSATION, undefined],
                    ["warm", undefined, undefined]
                ].sort()
            )
            expect(items.find(item => item.pool === "creating")?.phase).toBeUndefined()
            expect(items.find(item => item.pool === "assigned")).toMatchObject({ shared: true, phase: "provisioning" })
        })

        it("Given a sandbox of this installation, when its logs are read, then the last lines come with their time, level and source; another installation's are not read", async () => {
            put("fr-0000000000000001", ours)
            put("fr-0000000000000002", { "flightroom.dev/owner": "another-installation", "flightroom.dev/pool": "true" })
            raw.getSandboxLogs.mockResolvedValue({
                logs: [{ sandboxId: "id", eventTime: { seconds: BigInt(1_800_000_000), nanos: 250_000_000 }, level: "INFO", target: "supervisor", message: "started", source: "" }],
                bufferTotal: 1
            })

            const lines = await sandboxes().logs("fr-0000000000000001", 9_999)

            expect(lines).toEqual([{ timestampMs: 1_800_000_000_250, level: "INFO", source: "gateway", target: "supervisor", message: "started" }])
            expect(raw.getSandboxLogs).toHaveBeenCalledWith(expect.objectContaining({ sandbox: "fr-0000000000000001", lines: 500 }))
            await expect(sandboxes().logs("fr-0000000000000002")).resolves.toBeUndefined()
            await expect(sandboxes().logs("../etc")).resolves.toBeUndefined()
            expect(raw.getSandboxLogs).toHaveBeenCalledTimes(1)
        })

        it("Given a sandbox of this installation, when it is deleted, then the gateway's goes with its record and its lifetime; another installation's is left alone", async () => {
            const record = await assignedSandbox(CONVERSATION)
            put("fr-0000000000000002", { "flightroom.dev/owner": "another-installation", "flightroom.dev/pool": "true" })
            const deleted = vi.fn(async (_key: string, _id: string) => undefined)

            expect(await sandboxes().delete(record.name, deleted)).toBe(true)
            expect(await sandboxes().delete("fr-0000000000000002", deleted)).toBe(false)
            expect(await sandboxes().delete("fr-0000000000000003", deleted)).toBe(false)

            expect(gateway.has(record.name)).toBe(false)
            expect(gateway.has("fr-0000000000000002")).toBe(true)
            expect(pool.records.size).toBe(0)
            expect(deleted.mock.calls).toEqual([[CONVERSATION, record.sandboxId]])
        })

        /** A sandbox of the pool assigned to `key` since an hour. */
        const assignedSandbox = async (key: string) => {
            await sandboxes().acquire(key, {}, key, ORGANIZATION)
            return [...pool.records.values()].find(candidate => candidate.key === key)!
        }
    })
})
