import { beforeEach, describe, expect, it, vi } from "vitest"
import { OpenShellSandboxes, sandboxNameFor } from "./OpenShellSandboxes"

const { sandbox, connect } = vi.hoisted(() => {
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
    return { sandbox, connect: vi.fn(async (_options: unknown) => ({ sandbox })) }
})

vi.mock("@nvidia/openshell-sdk", () => ({ OpenShellClient: { connect }, clientCredentials: vi.fn(() => ({ getToken: async () => "renewed" })) }))

const sdkError = (code: string) => Object.assign(new Error(code), { code })

const CONVERSATION = "65f1a2b3c4d5e6f708192a3b"
const NAME = `flightroom-ai-${CONVERSATION}`

describe("OpenShellSandboxes", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        sandbox.waitReady.mockResolvedValue({ name: NAME, phase: "ready" })
    })

    it("Given no sandbox for the conversation, when one is acquired, then it is created with its labels and a policy letting only node reach the registry", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway", OPENSHELL_TOKEN: "token" }).acquire(CONVERSATION)

        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ gateway: "https://gateway", oidcToken: "token" }))
        expect(sandbox.create).toHaveBeenCalledWith({
            name: NAME,
            workspace: undefined,
            image: "node:24-bookworm-slim",
            labels: { "flightroom.dev/role": "ai-change", "flightroom.dev/conversation": CONVERSATION },
            policy: {
                version: 1,
                networkPolicies: {
                    "package-registries": {
                        name: "package-registries",
                        endpoints: [{ host: "registry.npmjs.org", port: 443 }],
                        binaries: [{ path: "/usr/local/bin/node" }]
                    }
                }
            }
        })
        expect(sandbox.waitReady).toHaveBeenCalledWith(NAME, 300, { workspace: undefined })
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

    it("Given a sandbox in error, when one is acquired, then it is deleted and replaced", async () => {
        sandbox.get.mockResolvedValue({ id: "dead-1", name: NAME, phase: "error" })
        await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)
        expect(sandbox.delete).toHaveBeenCalledWith(NAME, { workspace: undefined, allowMissing: true })
        expect(sandbox.waitDeleted).toHaveBeenCalledWith(NAME, 120, { workspace: undefined, expectedSandboxId: "dead-1" })
        expect(sandbox.create).toHaveBeenCalled()
    })

    it("Given another replica creating it at the same time, when one is acquired, then the existing one is waited for", async () => {
        sandbox.get.mockRejectedValue(sdkError("not_found"))
        sandbox.create.mockRejectedValue(sdkError("already_exists"))
        await expect(new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).acquire(CONVERSATION)).resolves.toBeDefined()
        expect(sandbox.waitReady).toHaveBeenCalled()
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

    it("Given sandboxes of busy and idle conversations, when they are swept, then only the idle ones and those of no conversation are deleted", async () => {
        sandbox.list.mockReturnValue(
            (async function* () {
                yield {
                    items: [
                        { name: "flightroom-ai-busy", labels: { "flightroom.dev/conversation": "busy" } },
                        { name: "flightroom-ai-idle", labels: { "flightroom.dev/conversation": "idle" } },
                        { name: "flightroom-ai-orphan", labels: {} }
                    ]
                }
            })()
        )
        const deleted = await new OpenShellSandboxes({ OPENSHELL_GATEWAY_URL: "https://gateway" }).sweep(async conversation => conversation === "idle")

        expect(sandbox.list).toHaveBeenCalledWith({ workspace: undefined, labelSelector: "flightroom.dev/role=ai-change" })
        expect(sandbox.delete.mock.calls.map(([name]) => name)).toEqual(["flightroom-ai-idle", "flightroom-ai-orphan"])
        expect(deleted).toBe(2)
    })

    it("Given a conversation id, then its sandbox is named after it in lowercase", () => {
        expect(sandboxNameFor("65F1A2B3C4D5E6F708192A3B")).toBe("flightroom-ai-65f1a2b3c4d5e6f708192a3b")
    })
})
