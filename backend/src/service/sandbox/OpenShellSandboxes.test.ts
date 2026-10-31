import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationState, MAX_SANDBOX_NAME_LENGTH, OpenShellSandboxes, sandboxNameFor } from "./OpenShellSandboxes"

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
    const raw = { exposeService: vi.fn() }
    return { sandbox, raw, connect: vi.fn(async (_options: unknown) => ({ sandbox, raw })), OWNER: "0b6c1f2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b" }
})

vi.mock("@nvidia/openshell-sdk", () => ({ OpenShellClient: { connect }, clientCredentials: vi.fn(() => ({ getToken: async () => "renewed" })) }))
vi.mock("../TelemetryService", () => ({
    default: class {
        getInstallationId = async () => OWNER
    }
}))

const sdkError = (code: string) => Object.assign(new Error(code), { code })

const CONVERSATION = "65f1a2b3c4d5e6f708192a3b"
const NAME = sandboxNameFor(OWNER, CONVERSATION)

describe("OpenShellSandboxes", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        sandbox.waitReady.mockResolvedValue({ name: NAME, phase: "ready" })
        sandbox.create.mockResolvedValue({ id: "created-1", name: NAME, phase: "provisioning" })
        sandbox.createFromTemplate.mockResolvedValue({ id: "created-1", name: NAME, phase: "provisioning" })
        sandbox.delete.mockResolvedValue({ sandboxId: "deleted-1" })
    })

    it("Given no sandbox for the conversation, when one is acquired, then it is created with its labels and a read-only policy letting only the package managers reach the registries", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway", OPENSHELL_TOKEN: "token" }).acquire(CONVERSATION)

        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ gateway: "https://gateway", oidcToken: "token" }))
        expect(sandbox.create).toHaveBeenCalledWith({
            name: NAME,
            workspace: undefined,
            image: "node:24-bookworm-slim",
            labels: { "flightroom.dev/role": "ai-change", "flightroom.dev/owner": OWNER, "flightroom.dev/conversation": CONVERSATION },
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
        expect(sandbox.waitReady).toHaveBeenCalledWith(NAME, 300, { workspace: undefined })
    })

    it("Given registry hosts and network binaries as comma separated lists, when a sandbox is created, then the policy allows each of them", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        await new OpenShellSandboxes({
            OPENSHELL_GATEWAY_URL: "https://gateway",
            OPENSHELL_TOKEN: "token",
            OPENSHELL_REGISTRY_HOSTS: " registry.npmjs.org , npm.pkg.github.com ,",
            OPENSHELL_NETWORK_BINARY: "/usr/local/bin/node, /usr/bin/git"
        }).acquire(CONVERSATION)

        const policy = sandbox.create.mock.calls[0][0].policy.networkPolicies["package-registries"]
        expect(policy.endpoints.map((endpoint: { host: string }) => endpoint.host)).toEqual(["registry.npmjs.org", "npm.pkg.github.com"])
        expect(policy.binaries).toEqual([{ path: "/usr/local/bin/node" }, { path: "/usr/bin/git" }])
    })

    it("Given the CA of the gateway as PEM text, when the client connects, then it trusts that CA", async () => {
        sandbox.get.mockResolvedValue({ id: "1", name: NAME, phase: "ready" })
        const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://sandbox.example.com", OPENSHELL_CA_CERT: pem, OPENSHELL_CA_CERT_FILE: "/does/not/exist" }).acquire(CONVERSATION)
        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ caCert: Buffer.from(pem) }))
    })

    it("Given a ready sandbox of the conversation, when one is acquired, then it is reused and none is created", async () => {
        sandbox.get.mockResolvedValue({ id: "1", name: NAME, phase: "ready" })
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)
        expect(sandbox.create).not.toHaveBeenCalled()
        expect(sandbox.delete).not.toHaveBeenCalled()
    })

    it("Given a running preview service, when it is exposed, then OpenShell returns its browser URL", async () => {
        sandbox.get.mockResolvedValue({ id: "1", name: NAME, phase: "ready" })
        raw.exposeService.mockResolvedValue({ url: "https://preview.example.test" })
        const acquired = await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)

        await expect(acquired.exposeService?.(5173, "preview-fe")).resolves.toBe("https://preview.example.test")
        expect(raw.exposeService).toHaveBeenCalledWith({
            sandbox: NAME,
            workspaceScope: { selection: { case: "workspace", value: "default" } },
            name: "preview-fe",
            targetPort: 5173,
            domain: true,
            requestId: expect.any(String)
        })
    })

    it("Given a sandbox in error, when one is acquired, then it is deleted and replaced", async () => {
        sandbox.get.mockResolvedValue({ id: "dead-1", name: NAME, phase: "error" })
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)
        expect(sandbox.delete).toHaveBeenCalledWith(NAME, { workspace: undefined, allowMissing: true })
        expect(sandbox.waitDeleted).toHaveBeenCalledWith(NAME, 120, { workspace: undefined, expectedSandboxId: "dead-1" })
        expect(sandbox.create).toHaveBeenCalled()
    })

    it("Given a sandbox stuck provisioning, when the wait for it times out, then it is deleted for the next attempt and the error says its phase", async () => {
        sandbox.get.mockResolvedValue({ id: "1", name: NAME, phase: "provisioning" })
        sandbox.waitReady.mockRejectedValue(new Error(`timed out waiting for sandbox '${NAME}'`))
        await expect(new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)).rejects.toThrow(/phase: provisioning.*timed out waiting/)
        expect(sandbox.delete).toHaveBeenCalledWith(NAME, { workspace: undefined, allowMissing: true })
    })

    it("Given a ready sandbox, when only the wait for it fails, then it is kept and the error goes through", async () => {
        sandbox.get.mockResolvedValue({ id: "1", name: NAME, phase: "ready" })
        sandbox.waitReady.mockRejectedValue(new Error("network"))
        await expect(new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)).rejects.toThrow("network")
        expect(sandbox.delete).not.toHaveBeenCalled()
    })

    it("Given another replica creating it at the same time, when one is acquired, then the existing one is waited for", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        sandbox.create.mockRejectedValue(sdkError("already_exists"))
        await expect(new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)).resolves.toBeDefined()
        expect(sandbox.waitReady).toHaveBeenCalled()
    })

    it("Given a lifecycle, when a sandbox is created, replaced or deleted as stuck, then it is told of each creation and deletion of the conversation's sandbox", async () => {
        const lifecycle = { created: vi.fn(async (_conversation: string, _id: string) => undefined), deleted: vi.fn(async (_conversation: string, _id: string) => undefined) }
        const sandboxes = new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" })

        sandbox.get.mockRejectedValueOnce(sdkError("not_found"))
        await sandboxes.acquire(CONVERSATION, lifecycle)
        expect(lifecycle.created).toHaveBeenCalledWith(CONVERSATION, "created-1")
        expect(lifecycle.deleted).not.toHaveBeenCalled()

        lifecycle.created.mockClear()
        sandbox.get.mockResolvedValueOnce({ id: "dead-1", name: NAME, phase: "error" })
        sandbox.create.mockResolvedValueOnce({ id: "created-2", name: NAME, phase: "provisioning" })
        await sandboxes.acquire(CONVERSATION, lifecycle)
        expect(lifecycle.deleted).toHaveBeenCalledWith(CONVERSATION, "dead-1")
        expect(lifecycle.created).toHaveBeenCalledWith(CONVERSATION, "created-2")
        expect(lifecycle.deleted.mock.invocationCallOrder[0]).toBeLessThan(lifecycle.created.mock.invocationCallOrder[0])

        lifecycle.created.mockClear()
        lifecycle.deleted.mockClear()
        sandbox.get.mockResolvedValue({ id: "stuck-1", name: NAME, phase: "provisioning" })
        sandbox.waitReady.mockRejectedValueOnce(new Error("timed out"))
        await expect(sandboxes.acquire(CONVERSATION, lifecycle)).rejects.toThrow("timed out")
        expect(lifecycle.deleted).toHaveBeenCalledWith(CONVERSATION, "stuck-1")
        expect(lifecycle.created).not.toHaveBeenCalled()
    })

    it("Given another replica creating it at the same time, when one is acquired with a lifecycle, then only the replica whose create went through counts it", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        sandbox.create.mockRejectedValue(sdkError("already_exists"))
        const created = vi.fn(async (_conversation: string, _id: string) => undefined)

        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION, { created })

        expect(created).not.toHaveBeenCalled()
    })

    it("Given a template and no registry hosts, when a sandbox is created, then it comes from the template under the gateway's own network policy", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway", OPENSHELL_SANDBOX_TEMPLATE: "node-gvisor", OPENSHELL_REGISTRY_HOSTS: "", OPENSHELL_WORKSPACE: "flightroom" }).acquire(
            CONVERSATION
        )
        expect(sandbox.createFromTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: NAME, workspace: "flightroom", workloadTemplate: "node-gvisor", policy: undefined }))
        expect(sandbox.create).not.toHaveBeenCalled()
    })

    it("Given a command printing more than is kept, when it runs, then its exit code and the end of its output come back with how much was cut", async () => {
        sandbox.get.mockResolvedValue({ id: "1", name: NAME, phase: "ready" })
        sandbox.execStream.mockImplementation(async function* () {
            for (let index = 0; index < 100; index++) yield { stream: index % 2 ? "stderr" : "stdout", data: Buffer.from(`${String(index).padStart(999, ".")}\n`) }
            yield { type: "exit", exitCode: 2 }
        })
        const acquired = await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)
        const result = await acquired.exec(["npm", "test"], { workdir: "/sandbox/repositories/shop" })

        expect(result.exitCode).toBe(2)
        expect(result.output.length).toBe(64_000)
        expect(result.cutBytes).toBe(100 * 1_000 - 64_000)
        expect(result.output.endsWith("99\n")).toBe(true)
        expect(sandbox.execStream).toHaveBeenCalledWith(NAME, ["npm", "test"], expect.objectContaining({ workdir: "/sandbox/repositories/shop", noLoginShell: true }))
    })

    const listed = (...items: { name: string; labels: Record<string, string> }[]) =>
        sandbox.list.mockReturnValue(
            (async function* () {
                yield { items: items.map(item => ({ id: `id-${item.name}`, ...item })) }
            })()
        )

    it("Given sandboxes of this installation, when they are swept, then those of busy conversations stay and the others go", async () => {
        const owned = { "flightroom.dev/owner": OWNER }
        listed(
            { name: "fr-busy", labels: { ...owned, "flightroom.dev/conversation": "busy" } },
            { name: "fr-idle", labels: { ...owned, "flightroom.dev/conversation": "idle" } },
            { name: "fr-unknown", labels: { ...owned, "flightroom.dev/conversation": "unknown" } },
            { name: "fr-orphan", labels: owned }
        )
        const deleted = await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).sweep(async conversation => conversation as ConversationState)

        expect(sandbox.list).toHaveBeenCalledWith({ workspace: undefined, labelSelector: "flightroom.dev/role=ai-change" })
        expect(sandbox.delete.mock.calls.map(([name]) => name)).toEqual(["fr-idle", "fr-unknown", "fr-orphan"])
        expect(deleted).toBe(3)
    })

    it("Given a callback, when sandboxes are swept, then it is told the conversation of each one deleted that has one", async () => {
        const owned = { "flightroom.dev/owner": OWNER }
        listed(
            { name: "fr-busy", labels: { ...owned, "flightroom.dev/conversation": "busy" } },
            { name: "fr-idle", labels: { ...owned, "flightroom.dev/conversation": "idle" } },
            { name: "fr-orphan", labels: owned }
        )
        const deleted = vi.fn(async (_conversation: string, _id: string) => undefined)

        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).sweep(async conversation => conversation as ConversationState, deleted)

        expect(deleted.mock.calls).toEqual([["idle", "id-fr-idle"]])
    })

    it("Given a sandbox another replica deleted first, when it is swept, then its lifetime is still told of but it is not counted as deleted here", async () => {
        listed({ name: "fr-idle", labels: { "flightroom.dev/owner": OWNER, "flightroom.dev/conversation": "idle" } })
        sandbox.delete.mockResolvedValue({})
        const deleted = vi.fn(async (_conversation: string, _id: string) => undefined)

        expect(await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).sweep(async conversation => conversation as ConversationState, deleted)).toBe(0)
        expect(deleted).toHaveBeenCalledWith("idle", "id-fr-idle")
    })

    it("Given sandboxes of another installation on the same gateway, when they are swept, then none is deleted, whatever their conversation", async () => {
        const other = { "flightroom.dev/owner": "another-installation" }
        listed(
            { name: "fr-theirs-idle", labels: { ...other, "flightroom.dev/conversation": "idle" } },
            { name: "fr-theirs-unknown", labels: { ...other, "flightroom.dev/conversation": "unknown" } },
            { name: "fr-theirs-orphan", labels: other }
        )
        const stateOf = vi.fn(async (conversation: string) => conversation as ConversationState)

        expect(await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).sweep(stateOf)).toBe(0)
        expect(sandbox.delete).not.toHaveBeenCalled()
        expect(stateOf).not.toHaveBeenCalled()
    })

    it("Given sandboxes made before the owner label, when they are swept, then only those of a conversation known here and idle are deleted", async () => {
        listed(
            { name: "fr-legacy-idle", labels: { "flightroom.dev/conversation": "idle" } },
            { name: "fr-legacy-unknown", labels: { "flightroom.dev/conversation": "unknown" } },
            { name: "fr-legacy-busy", labels: { "flightroom.dev/conversation": "busy" } },
            { name: "fr-legacy-orphan", labels: {} }
        )
        const deleted = await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).sweep(async conversation => conversation as ConversationState)

        expect(sandbox.delete.mock.calls.map(([name]) => name)).toEqual(["fr-legacy-idle"])
        expect(deleted).toBe(1)
    })

    it("Given an owner set in the configuration, when a sandbox is created, then it carries that owner and a name of its own", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway", OPENSHELL_SANDBOX_OWNER: "flightroom-dev" }).acquire(CONVERSATION)

        expect(sandbox.create).toHaveBeenCalledWith(
            expect.objectContaining({ name: sandboxNameFor("flightroom-dev", CONVERSATION), labels: expect.objectContaining({ "flightroom.dev/owner": "flightroom-dev" }) })
        )
    })

    it("Given the installation id cannot be read, when a sandbox is acquired, then it fails and the next one asks again, once for good", async () => {
        sandbox.get.mockResolvedValue({ id: "1", name: NAME, phase: "ready" })
        const installationId = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("database down")).mockResolvedValue(OWNER)
        const sandboxes = new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }, installationId)

        await expect(sandboxes.acquire(CONVERSATION)).rejects.toThrow("database down")
        await sandboxes.acquire(CONVERSATION)
        await sandboxes.acquire(CONVERSATION)
        expect(installationId).toHaveBeenCalledTimes(2)
        expect(sandbox.get).toHaveBeenLastCalledWith(NAME, { workspace: undefined })
    })

    it("Given a conversation id, then its sandbox name fits the gateway, is a valid Kubernetes name and is the same whatever the case", () => {
        const name = sandboxNameFor(OWNER, "65F1A2B3C4D5E6F708192A3B")

        expect(name).toMatch(/^fr-[0-9a-f]{16}$/)
        expect(name.length).toBeLessThanOrEqual(MAX_SANDBOX_NAME_LENGTH)
        expect(name).toBe(sandboxNameFor(OWNER, "65f1a2b3c4d5e6f708192a3b"))
    })

    it("Given two conversations, then their sandboxes have different names", () => {
        expect(sandboxNameFor(OWNER, "65f1a2b3c4d5e6f708192a3b")).not.toBe(sandboxNameFor(OWNER, "65f1a2b3c4d5e6f708192a3c"))
    })

    it("Given the same conversation id in two installations, then their sandboxes have different names", () => {
        expect(sandboxNameFor(OWNER, CONVERSATION)).not.toBe(sandboxNameFor("another-installation", CONVERSATION))
    })
})
