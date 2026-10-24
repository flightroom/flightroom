import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { CommandSandbox, SandboxCommandResult, SandboxExecOptions } from "./commandSandbox"

/** ESM only: loaded with import(), so the console starts, and runs, without a gateway configured. */
type OpenShellSdk = typeof import("@nvidia/openshell-sdk")
type OpenShellClient = Awaited<ReturnType<OpenShellSdk["OpenShellClient"]["connect"]>>

/**
 * The values the schema of the configuration defaults to. The image is the official Node.js one:
 * npm and corepack (for pnpm and yarn) are in it, and its node is the binary that reaches the registries.
 * The registries: npm, Maven Central, Azure Artifacts feeds (they redirect the download of a package to
 * a storage account of theirs, <account>.blob.core.windows.net) and the GitHub Container Registry (ghcr.io
 * redirects its blobs to pkg-containers.githubusercontent.com). The binaries: node, the java of the
 * eclipse-temurin images Maven runs on, and the python of the python:3.13 images.
 */
export const OPENSHELL_DEFAULTS = {
    image: "node:24-bookworm-slim",
    root: "/sandbox",
    registryHosts: [
        "registry.npmjs.org",
        "repo.maven.apache.org",
        "repo1.maven.org",
        "pkgs.dev.azure.com",
        "*.pkgs.visualstudio.com",
        "*.blob.core.windows.net",
        "ghcr.io",
        "pkg-containers.githubusercontent.com"
    ].join(","),
    networkBinary: "/usr/local/bin/node,/opt/java/openjdk/bin/java,/usr/local/bin/python3.13",
    idleMinutes: 5
}

/** NetworkEnforcementMode.ENFORCE and NetworkAccessPreset.READ_ONLY of the SDK, which is loaded lazily. */
const ENFORCE = 1
const READ_ONLY = 1

/**
 * The gateway the coding agent creates its sandboxes through. Without OPENSHELL_GATEWAY_URL there is
 * none, and the agent is offered no tool that runs code.
 */
export interface OpenShellConfiguration {
    OPENSHELL_GATEWAY_URL?: string
    /** An OIDC token already issued, which expires; or the client credentials below, renewed before they do. */
    OPENSHELL_TOKEN?: string
    OPENSHELL_OIDC_ISSUER?: string
    OPENSHELL_OIDC_CLIENT_ID?: string
    OPENSHELL_OIDC_CLIENT_SECRET?: string
    OPENSHELL_OIDC_AUDIENCE?: string
    /** Space or comma separated. */
    OPENSHELL_OIDC_SCOPES?: string
    /** The CA of the gateway as PEM text, for a container where mounting a file is a chore: it wins over the file. */
    OPENSHELL_CA_CERT?: string
    /** PEM files: the CA of the gateway, and the client certificate a local gateway asks for (mTLS). */
    OPENSHELL_CA_CERT_FILE?: string
    OPENSHELL_CLIENT_CERT_FILE?: string
    OPENSHELL_CLIENT_KEY_FILE?: string
    OPENSHELL_WORKSPACE?: string
    /** A workload template defined on the gateway (image, resources, runtime class): it wins over the image. */
    OPENSHELL_SANDBOX_TEMPLATE?: string
    OPENSHELL_SANDBOX_IMAGE?: string
    OPENSHELL_SANDBOX_ROOT?: string
    /** Comma separated hosts the sandbox may reach on 443; empty leaves the network to the gateway's own policy. */
    OPENSHELL_REGISTRY_HOSTS?: string
    /** Comma separated executables allowed to open those connections: OpenShell matches the real path, not a symlink. */
    OPENSHELL_NETWORK_BINARY?: string
    OPENSHELL_SANDBOX_IDLE_MINUTES?: number
    OPENSHELL_PREVIEWS_ENABLED?: boolean
}

/** Every sandbox of the coding agent carries both: the sweep finds them by the role, and asks about the conversation. */
const ROLE_LABEL = "flightroom.dev/role"
const ROLE = "ai-change"
const CONVERSATION_LABEL = "flightroom.dev/conversation"

/** The end of the output of a command kept in memory: the agent reads less, this is only a bound. */
const MAX_OUTPUT_BYTES = 64_000
/** Creating a sandbox may pull its image: minutes on a cold node. */
const READY_TIMEOUT_SECS = 300
const DELETE_TIMEOUT_SECS = 120

/** A sandbox in one of these runs nothing again: it is replaced. */
const DEAD_PHASES = new Set(["error", "deleting", "stopping", "stopped", "completed"])

const hasCode = (error: unknown, code: string) => (error as { code?: unknown } | null)?.code === code

const list = (value: string) =>
    value
        .split(",")
        .map(item => item.trim())
        .filter(Boolean)

/** The longest sandbox name the gateway accepts: CreateSandbox refuses anything longer with INVALID_ARGUMENT. */
export const MAX_SANDBOX_NAME_LENGTH = 19

/**
 * One per conversation, so that its next message finds it. The gateway takes at most 19 characters, too few
 * for the 24 of an ObjectId: the name keeps 16 hex characters of its hash, a valid Kubernetes name.
 */
export const sandboxNameFor = (conversationId: string) => `fr-${createHash("sha256").update(conversationId.toLowerCase()).digest("hex").slice(0, 16)}`

class OpenShellCommandSandbox implements CommandSandbox {
    constructor(
        private readonly client: OpenShellClient,
        private readonly name: string,
        private readonly workspace: string | undefined,
        readonly root: string
    ) {}

    async exec(command: string[], options: SandboxExecOptions = {}): Promise<SandboxCommandResult> {
        const chunks: Buffer[] = []
        let kept = 0
        let cutBytes = 0
        let exitCode: number | undefined
        const events = this.client.sandbox.execStream(this.name, command, {
            workspace: this.workspace,
            workdir: options.workdir,
            environment: options.environment,
            stdin: options.stdin,
            timeoutSecs: options.timeoutSecs,
            signal: options.signal,
            // No profile of the image runs first: the same command behaves the same in every image.
            noLoginShell: true
        })
        for await (const event of events) {
            if ("type" in event) {
                exitCode = event.exitCode
                continue
            }
            chunks.push(event.data)
            kept += event.data.length
            // Whole chunks are dropped while what is left still fills the bound.
            while (chunks.length > 1 && kept - chunks[0].length >= MAX_OUTPUT_BYTES) {
                const dropped = chunks.shift()!
                kept -= dropped.length
                cutBytes += dropped.length
            }
        }
        let output = Buffer.concat(chunks)
        if (output.length > MAX_OUTPUT_BYTES) {
            cutBytes += output.length - MAX_OUTPUT_BYTES
            output = output.subarray(output.length - MAX_OUTPUT_BYTES)
        }
        return { exitCode: exitCode ?? -1, output: output.toString("utf8"), cutBytes }
    }

    async exposeService(targetPort: number, name: string): Promise<string> {
        const response = await this.client.raw.exposeService({
            sandbox: this.name,
            workspaceScope: { selection: { case: "workspace", value: this.workspace || "default" } },
            name,
            targetPort,
            domain: true,
            requestId: randomUUID()
        })
        if (!response.url) throw new Error(`OpenShell did not return a URL for the ${name} preview`)
        return response.url
    }
}

/**
 * The sandboxes of the coding agent on an OpenShell gateway: one per conversation, reused by its
 * next messages, deleted once the conversation has been idle for a while.
 */
export class OpenShellSandboxes {
    private client?: Promise<OpenShellClient>

    constructor(private readonly config: OpenShellConfiguration) {}

    get idleMs() {
        return (this.config.OPENSHELL_SANDBOX_IDLE_MINUTES ?? OPENSHELL_DEFAULTS.idleMinutes) * 60_000
    }

    private get workspace() {
        return this.config.OPENSHELL_WORKSPACE || undefined
    }

    private connect(): Promise<OpenShellClient> {
        // A failed connection is not kept: the next job tries again.
        this.client ??= this.createClient().catch(error => {
            this.client = undefined
            throw error
        })
        return this.client
    }

    private async createClient(): Promise<OpenShellClient> {
        const { OpenShellClient, clientCredentials } = await import("@nvidia/openshell-sdk")
        const config = this.config
        const pem = (file?: string) => (file ? readFile(file) : Promise.resolve(undefined))
        const [caCert, clientCert, clientKey] = await Promise.all([
            config.OPENSHELL_CA_CERT ? Buffer.from(config.OPENSHELL_CA_CERT) : pem(config.OPENSHELL_CA_CERT_FILE),
            pem(config.OPENSHELL_CLIENT_CERT_FILE),
            pem(config.OPENSHELL_CLIENT_KEY_FILE)
        ])
        const auth =
            config.OPENSHELL_OIDC_ISSUER && config.OPENSHELL_OIDC_CLIENT_ID
                ? {
                      oidcTokenProvider: clientCredentials({
                          issuer: config.OPENSHELL_OIDC_ISSUER,
                          clientId: config.OPENSHELL_OIDC_CLIENT_ID,
                          clientSecret: () => config.OPENSHELL_OIDC_CLIENT_SECRET ?? "",
                          audience: config.OPENSHELL_OIDC_AUDIENCE || undefined,
                          scopes: config.OPENSHELL_OIDC_SCOPES?.split(/[\s,]+/).filter(Boolean)
                      })
                  }
                : config.OPENSHELL_TOKEN
                  ? { oidcToken: config.OPENSHELL_TOKEN }
                  : {}
        return OpenShellClient.connect({ gateway: config.OPENSHELL_GATEWAY_URL!, caCert, clientCert, clientKey, ...auth })
    }

    /**
     * Only the package registries, read-only, and only for the package managers' runtimes: the install
     * downloads packages, nothing else the agent runs reaches the network. A connection no rule allows
     * is denied by OpenShell. npm asks for scoped packages as /@scope%2fname, which OpenShell rejects
     * unless the endpoint allows an encoded slash.
     */
    private policy() {
        const hosts = list(this.config.OPENSHELL_REGISTRY_HOSTS ?? OPENSHELL_DEFAULTS.registryHosts)
        if (!hosts.length) return undefined
        const binaries = list(this.config.OPENSHELL_NETWORK_BINARY || OPENSHELL_DEFAULTS.networkBinary)
        return {
            version: 1,
            networkPolicies: {
                "package-registries": {
                    name: "package-registries",
                    endpoints: hosts.map(host => ({ host, port: 443, protocol: "rest", enforcement: ENFORCE, access: READ_ONLY, allowEncodedSlash: true })),
                    binaries: binaries.map(path => ({ path }))
                }
            }
        }
    }

    private async create(client: OpenShellClient, name: string, conversationId: string) {
        const labels = { [ROLE_LABEL]: ROLE, [CONVERSATION_LABEL]: conversationId }
        const policy = this.policy()
        if (this.config.OPENSHELL_SANDBOX_TEMPLATE) {
            await client.sandbox.createFromTemplate({ name, workspace: this.workspace, workloadTemplate: this.config.OPENSHELL_SANDBOX_TEMPLATE, labels, policy })
        } else {
            await client.sandbox.create({ name, workspace: this.workspace, image: this.config.OPENSHELL_SANDBOX_IMAGE || OPENSHELL_DEFAULTS.image, labels, policy })
        }
    }

    /**
     * The sandbox of a conversation: the one its earlier messages used while it is alive, else a new
     * one. Two replicas asking at once end up on the same one: its name is the conversation's.
     */
    async acquire(conversationId: string): Promise<CommandSandbox> {
        const client = await this.connect()
        const name = sandboxNameFor(conversationId)
        const workspace = this.workspace
        const existing = await client.sandbox.get(name, { workspace }).catch(error => {
            if (hasCode(error, "not_found")) return undefined
            throw error
        })
        const dead = existing !== undefined && DEAD_PHASES.has(existing.phase)
        if (existing && dead) {
            await client.sandbox.delete(name, { workspace, allowMissing: true })
            await client.sandbox.waitDeleted(name, DELETE_TIMEOUT_SECS, { workspace, expectedSandboxId: existing.id })
        }
        if (!existing || dead) {
            await this.create(client, name, conversationId).catch(error => {
                if (!hasCode(error, "already_exists")) throw error
            })
        }
        await client.sandbox.waitReady(name, READY_TIMEOUT_SECS, { workspace })
        return new OpenShellCommandSandbox(client, name, workspace, this.config.OPENSHELL_SANDBOX_ROOT || OPENSHELL_DEFAULTS.root)
    }

    /** Deletes the sandboxes of the conversations `isIdle` says nobody uses any more; how many it deleted. */
    async sweep(isIdle: (conversationId: string) => Promise<boolean>): Promise<number> {
        const client = await this.connect()
        const workspace = this.workspace
        const found: { name: string; conversationId?: string }[] = []
        // Listed first, deleted after: deleting while paging could skip some.
        for await (const page of client.sandbox.list({ workspace, labelSelector: `${ROLE_LABEL}=${ROLE}` })) {
            for (const sandbox of page.items) found.push({ name: sandbox.name, conversationId: sandbox.labels[CONVERSATION_LABEL] })
        }
        let deleted = 0
        for (const sandbox of found) {
            if (sandbox.conversationId && !(await isIdle(sandbox.conversationId))) continue
            await client.sandbox.delete(sandbox.name, { workspace, allowMissing: true })
            deleted++
        }
        return deleted
    }
}

let sandboxes: OpenShellSandboxes | undefined

/** The sandboxes of this installation, undefined when no gateway is configured. */
export const openShellSandboxes = (config: OpenShellConfiguration): OpenShellSandboxes | undefined => {
    if (!config.OPENSHELL_GATEWAY_URL) return undefined
    sandboxes ??= new OpenShellSandboxes(config)
    return sandboxes
}
