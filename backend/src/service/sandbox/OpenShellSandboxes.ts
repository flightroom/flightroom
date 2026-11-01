import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import TelemetryService from "../TelemetryService"
import { CommandSandbox, SandboxCommandResult, SandboxExecOptions } from "./commandSandbox"
import { languagesOfLabels, TemplateLanguages, templateForLanguages } from "./sandboxLanguages"
import { mongoSandboxPool, PooledSandbox, SandboxPool } from "./sandboxPool"
import { effectiveOpenShellConfig, SANDBOX_SETTINGS_CACHE_MS } from "./sandboxSettings"

/** ESM only: loaded with import(), so the console starts, and runs, without a gateway configured. */
type OpenShellSdk = typeof import("@nvidia/openshell-sdk")
type OpenShellClient = Awaited<ReturnType<OpenShellSdk["OpenShellClient"]["connect"]>>
type SandboxRef = Awaited<ReturnType<OpenShellClient["sandbox"]["get"]>>

/** A workload template of the gateway, the languages it holds and when it was created: the gateway recreates a template it changes. */
type LanguageTemplate = TemplateLanguages & { revision?: string }

/**
 * The default image has Node.js only. Other runtimes are allowed for a configured polyglot image/template;
 * network access stays read-only and restricted to package registries and the listed runtime executables.
 */
export const OPENSHELL_DEFAULTS = {
    image: "node:24-bookworm-slim",
    root: "/sandbox",
    registryHosts: [
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
        "pkg-containers.githubusercontent.com",
        // The Gradle wrapper downloads its distribution from services.gradle.org, redirected to the GitHub releases of Gradle.
        "services.gradle.org",
        "github.com",
        "release-assets.githubusercontent.com"
    ].join(","),
    networkBinary: "/usr/local/bin/node,/opt/java/openjdk/bin/java,/usr/local/bin/python3.13,/usr/local/go/bin/go,/usr/share/dotnet/dotnet",
    idleMinutes: 5,
    maxHours: 24,
    warmSandboxes: 0
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
    /** No environment variable: changed when the template in use is changed from the console, so the sandboxes made from the previous one are not handed out. */
    OPENSHELL_SANDBOX_TEMPLATE_REVISION?: string
    OPENSHELL_SANDBOX_IMAGE?: string
    OPENSHELL_SANDBOX_ROOT?: string
    /** Comma separated hosts the sandbox may reach on 443; empty leaves the network to the gateway's own policy. */
    OPENSHELL_REGISTRY_HOSTS?: string
    /** Comma separated executables allowed to open those connections: OpenShell matches the real path, not a symlink. */
    OPENSHELL_NETWORK_BINARY?: string
    OPENSHELL_SANDBOX_IDLE_MINUTES?: number
    /** Past this age a sandbox is deleted at the first sweep that finds none of its jobs waiting or running: it never piles up for good. */
    OPENSHELL_SANDBOX_MAX_HOURS?: number
    /** "domain": the jobs of one domain (else of one project) share a sandbox, each conversation in a folder of its own. "conversation": one sandbox per conversation. */
    OPENSHELL_SANDBOX_SHARING?: "domain" | "conversation"
    OPENSHELL_PREVIEWS_ENABLED?: boolean
    /**
     * Where the browser reaches the previews when an ingress serves them, `*` standing for each one
     * (https://*.sandbox.example.com). Unset: the URL the gateway returns, with the scheme and the port it binds.
     */
    OPENSHELL_PREVIEW_URL?: string
    /** How many sandboxes the installation keeps created and unassigned, so that a new conversation does not wait for one. */
    OPENSHELL_SANDBOX_WARM?: number
    /** Who owns the sandboxes of this installation on the gateway: its installation id unless set. */
    OPENSHELL_SANDBOX_OWNER?: string
}

/**
 * Every sandbox of the coding agent carries the role and the owner: the sweep finds them by the role and keeps to those
 * of its own installation. Installations sharing a gateway see each other's sandboxes, and never touch them.
 */
const ROLE_LABEL = "flightroom.dev/role"
const ROLE = "ai-change"
const OWNER_LABEL = "flightroom.dev/owner"
/**
 * On the sandboxes created since the warm pool, which serve one key after another: what each one serves is in the
 * database, as the labels of a sandbox cannot change. One with this label and no record there is deleted.
 */
const POOL_LABEL = "flightroom.dev/pool"
/** On a sandbox created before the warm pool, named after the key it served for good. */
const CONVERSATION_LABEL = "flightroom.dev/conversation"
/** On a sandbox created before the warm pool that several conversations share. */
const SPACES_LABEL = "flightroom.dev/spaces"

/**
 * Running (a job waits or runs, a preview session is alive) and busy (one ended within the idle time) keep a
 * sandbox; past its maximum age only running does. Unknown, a conversation this installation has no record of,
 * lets go only an owned one.
 */
export type ConversationState = "running" | "busy" | "idle" | "unknown"

/** The name of the folder of a conversation in a sandbox, and of a sandbox key: a Kubernetes label value. */
const SPACE = /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/

/** The name of every sandbox of the coding agent, before and since the warm pool. */
export const SANDBOX_NAME = /^fr-[0-9a-f]{16}$/

/**
 * Stops the dev servers a conversation left running, their whole process group, and removes its folder, for each
 * folder name given after the folder of the conversations. One written in the last two minutes is left: a job of
 * that conversation started since its state was read. No `--` before the group: dash, the sh of Debian images,
 * refuses it.
 */
const REMOVE_SPACES = [
    'for space in "$@"; do',
    '  [ -z "$(find "$0/$space" -maxdepth 3 -mmin -2 2>/dev/null | head -n 1)" ] || continue',
    '  for pidfile in "$0/$space"/previews/*.pid; do',
    '    [ -f "$pidfile" ] || continue',
    '    pid=$(cat "$pidfile")',
    '    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
    "  done",
    '  rm -rf -- "${0:?}/$space"',
    "done"
].join("\n")

/**
 * Empties the folder of the conversations of a sandbox going back to the pool: the dev servers of each one stopped,
 * their whole process group, then every folder removed. The home, with the caches of the package managers, stays.
 * Anything written in the last two minutes stops it with exit code 3, before it touches anything: a job that took the
 * sandbox just before it left its key may still run in it.
 */
const RESET_SPACES = [
    'cd "$0" 2>/dev/null || exit 0',
    '[ -z "$(find . -mindepth 1 -maxdepth 4 -mmin -2 2>/dev/null | head -n 1)" ] || exit 3',
    "for pidfile in */previews/*.pid; do",
    '  [ -f "$pidfile" ] || continue',
    '  pid=$(cat "$pidfile")',
    '  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
    "done",
    "find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +"
].join("\n")

/** The folders of the conversations a sandbox holds, one per line. */
const LIST_SPACES = 'cd "$0" 2>/dev/null || exit 0; for entry in */; do [ -d "$entry" ] && echo "${entry%/}"; done; exit 0'

/** How often the sweep looks into a shared sandbox for the folders of idle conversations: each look is a command. */
const PRUNE_EVERY_MS = 5 * 60_000

/**
 * A record or a sandbox younger than this may still be in the making on another replica: its record is written before
 * the gateway creates it, and the gateway lists it a moment after.
 */
const YOUNG_MS = 2 * 60_000

/** A sandbox being emptied for the pool longer than this was left halfway by a replica that stopped: it is deleted. */
const RECYCLE_TIMEOUT_MS = 5 * 60_000

/** How often a replica looks again for the sandbox another one is creating for the same key. */
const POLL_MS = 1_000

/** A sandbox of the coding agent as the sweep lists it. */
interface Listed {
    id: string
    name: string
    phase: string
    owner?: string
    /** Created before the warm pool: the key it serves for good. */
    conversationId?: string
    shared: boolean
    pool: boolean
    createdAtMs?: number
}

/** What a sandbox of this installation is doing for the pool: warm, being created for it, serving a key, or none of these. */
export type SandboxPoolState = "warm" | "creating" | "assigned" | "legacy" | "orphan"

/** A sandbox of this installation, as the gateway and the database know it together. */
export interface SandboxInventoryItem {
    name: string
    sandboxId?: string
    /** Its phase on the gateway; missing while it is being created. */
    phase?: string
    pool: SandboxPoolState
    /** The key it serves: a domain, a project, a conversation or a live preview. */
    key?: string
    organizationId?: string
    shared: boolean
    createdAtMs?: number
}

/** One line of the log of a sandbox, as the gateway keeps it. */
export interface SandboxLogLine {
    timestampMs?: number
    level: string
    /** `gateway` or `sandbox`. */
    source: string
    target: string
    message: string
}

/**
 * Told when this installation creates or deletes the sandbox of a conversation: a sandbox costs while it lives, and
 * the caller keeps how long. The gateway knows nothing of who it was for; the caller does. Each sandbox comes with
 * the id the gateway gave it: the conversation keeps its name across sandboxes, the id is this one's alone. A warm
 * sandbox counts from when a key claims it to when it lets it go: its time in the pool is nobody's.
 */
export interface SandboxLifecycle {
    created?: (conversationId: string, sandboxId: string) => Promise<void>
    deleted?: (conversationId: string, sandboxId: string) => Promise<void>
}

/** The end of the output of a command kept in memory: the agent reads less, this is only a bound. */
const MAX_OUTPUT_BYTES = 64_000
/** Creating a sandbox may pull its image: minutes on a cold node. */
const READY_TIMEOUT_SECS = 300
/** The most log lines one call returns: the console lets an installation administrator pick up to these. */
export const MAX_LOG_LINES = 2000

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
 * A new name, random: a sandbox serves one key after another, so it cannot be named after one. 16 hex characters fit
 * the 19 the gateway takes, and make a valid Kubernetes name no other installation on the gateway will pick.
 */
export const randomSandboxName = () => `fr-${randomBytes(8).toString("hex")}`

class OpenShellCommandSandbox implements CommandSandbox {
    constructor(
        private readonly client: OpenShellClient,
        private readonly name: string,
        private readonly workspace: string | undefined,
        readonly root: string,
        readonly home?: string,
        private readonly previewUrl?: string
    ) {}

    async exec(command: string[], options: SandboxExecOptions = {}): Promise<SandboxCommandResult> {
        const chunks: Buffer[] = []
        let kept = 0
        let cutBytes = 0
        let exitCode: number | undefined
        // A character split across two chunks of a stream is told whole, with the second: one decoder per stream.
        const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
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
            options.onOutput?.(decoders[event.stream].write(event.data))
            kept += event.data.length
            // Whole chunks are dropped while what is left still fills the bound.
            while (chunks.length > 1 && kept - chunks[0].length >= MAX_OUTPUT_BYTES) {
                const dropped = chunks.shift()!
                kept -= dropped.length
                cutBytes += dropped.length
            }
        }
        // A character the end of a stream cut is told too, as the replacement character.
        const rest = decoders.stdout.end() + decoders.stderr.end()
        if (rest) options.onOutput?.(rest)
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
        return browserUrlOf(response.url, this.previewUrl)
    }
}

/**
 * The gateway writes in the URL of a service the scheme and the port it binds, while an ingress in front of it serves
 * the previews on its own: the service, the first label of the host (`<workspace>--<sandbox>--<service>`), takes the
 * place of the `*` of the public URL set.
 */
const browserUrlOf = (url: string, previewUrl: string | undefined) => {
    if (!previewUrl) return url
    const exposed = new URL(url)
    const service = exposed.hostname.split(".")[0]
    return new URL(`${exposed.pathname}${exposed.search}`, previewUrl.replace("*", service)).toString()
}

export interface OpenShellSandboxesOptions {
    /** Where the sandboxes and what they serve are kept: MongoDB unless given. */
    pool?: SandboxPool
    installationId?: () => Promise<string>
    now?: () => number
    /** The settings that may change while the console runs: the configuration itself unless given. */
    settings?: () => Promise<OpenShellConfiguration>
    sleep?: (ms: number) => Promise<void>
}

const idleMsOf = (settings: OpenShellConfiguration) => (settings.OPENSHELL_SANDBOX_IDLE_MINUTES ?? OPENSHELL_DEFAULTS.idleMinutes) * 60_000

const maxAgeMsOf = (settings: OpenShellConfiguration) => (settings.OPENSHELL_SANDBOX_MAX_HOURS ?? OPENSHELL_DEFAULTS.maxHours) * 3_600_000

/**
 * The sandboxes of the coding agent on an OpenShell gateway, one per key: a conversation, or a domain whose
 * conversations share it, each in a folder of its own. Reused by the next messages; once nobody has used the key for
 * a while, or past their maximum age at a quiet moment, emptied back into the pool of warm sandboxes, or deleted.
 */
export class OpenShellSandboxes {
    private client?: Promise<OpenShellClient>
    private ownerId?: Promise<string>
    /** When this replica last looked into each shared sandbox for the folders of idle conversations. */
    private readonly pruned = new Map<string, number>()
    /** The templates of the gateway and their languages, read again at most as often as the settings. */
    private languageTemplates?: { at: number; list: Promise<LanguageTemplate[]> }
    private readonly pool: SandboxPool
    private readonly installationId: () => Promise<string>
    private readonly now: () => number
    private readonly settings: () => Promise<OpenShellConfiguration>
    private readonly sleep: (ms: number) => Promise<void>

    constructor(
        private readonly config: OpenShellConfiguration,
        options: OpenShellSandboxesOptions = {}
    ) {
        this.pool = options.pool ?? mongoSandboxPool
        this.installationId = options.installationId ?? (() => new TelemetryService().getInstallationId())
        this.now = options.now ?? (() => Date.now())
        this.settings = options.settings ?? (async () => config)
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    }

    /** How long a key goes unused before its sandbox is let go, as currently set. */
    async idleMs() {
        return idleMsOf(await this.settings())
    }

    /** The workload templates of the gateway, in the workspace of this installation's sandboxes. */
    async templates(): Promise<{ client: OpenShellClient["sandboxTemplates"]; workspace?: string }> {
        return { client: (await this.connect()).sandboxTemplates, workspace: this.workspace }
    }

    /** Forgets the templates read: called by the replica that changed one, which applies the change at once. */
    forgetTemplates() {
        this.languageTemplates = undefined
    }

    private templatesWithLanguages(client: OpenShellClient): Promise<LanguageTemplate[]> {
        if (!this.languageTemplates || this.now() - this.languageTemplates.at >= SANDBOX_SETTINGS_CACHE_MS) {
            const list = client.sandboxTemplates.listAll({ workspace: this.workspace }).then(templates =>
                templates.map(template => ({
                    name: template.metadata?.name ?? "",
                    languages: languagesOfLabels(template.metadata?.labels),
                    revision: template.metadata?.createdTime ? String(template.metadata.createdTime.seconds) : undefined
                }))
            )
            const entry = { at: this.now(), list }
            // A failed read is not kept: the next sandbox tries again.
            list.catch(() => {
                if (this.languageTemplates === entry) this.languageTemplates = undefined
            })
            this.languageTemplates = entry
        }
        return this.languageTemplates.list
    }

    /**
     * The settings a sandbox needing these languages is created with: those of the template holding them all, when it is
     * not the one in use, its creation as its revision. The settings themselves when nothing is needed, no template
     * holds it all, or the templates cannot be read: the sandbox is created as before, and a check its image cannot
     * run is skipped.
     */
    private async settingsFor(client: OpenShellClient, settings: OpenShellConfiguration, languages: readonly string[]): Promise<OpenShellConfiguration> {
        if (!languages.length) return settings
        const templates = await this.templatesWithLanguages(client).catch(() => [])
        const template = templateForLanguages(templates, languages, settings.OPENSHELL_SANDBOX_TEMPLATE)
        if (!template || template === settings.OPENSHELL_SANDBOX_TEMPLATE) return settings
        const revision = templates.find(candidate => candidate.name === template)?.revision
        return { ...settings, OPENSHELL_SANDBOX_TEMPLATE: template, OPENSHELL_SANDBOX_TEMPLATE_REVISION: revision }
    }

    private get workspace() {
        return this.config.OPENSHELL_WORKSPACE || undefined
    }

    private get root() {
        return this.config.OPENSHELL_SANDBOX_ROOT || OPENSHELL_DEFAULTS.root
    }

    /** Where the conversations keep their copies: the home, with the caches of the package managers, is shared by them all. */
    private get spaces() {
        return `${this.root}/spaces`
    }

    private owner(): Promise<string> {
        // Asked once: the replicas of an installation read the same id from its database.
        this.ownerId ??= (this.config.OPENSHELL_SANDBOX_OWNER ? Promise.resolve(this.config.OPENSHELL_SANDBOX_OWNER) : this.installationId()).catch(error => {
            this.ownerId = undefined
            throw error
        })
        return this.ownerId
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
    private policy(settings: OpenShellConfiguration) {
        const hosts = list(settings.OPENSHELL_REGISTRY_HOSTS ?? OPENSHELL_DEFAULTS.registryHosts)
        if (!hosts.length) return undefined
        const binaries = list(settings.OPENSHELL_NETWORK_BINARY || OPENSHELL_DEFAULTS.networkBinary)
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

    /** What a sandbox is created as: one created otherwise, before the settings changed, is not handed out again. */
    private specHash(settings: OpenShellConfiguration) {
        const spec = settings.OPENSHELL_SANDBOX_TEMPLATE
            ? { template: settings.OPENSHELL_SANDBOX_TEMPLATE, revision: settings.OPENSHELL_SANDBOX_TEMPLATE_REVISION }
            : { image: settings.OPENSHELL_SANDBOX_IMAGE || OPENSHELL_DEFAULTS.image }
        return createHash("sha256")
            .update(JSON.stringify({ ...spec, policy: this.policy(settings) ?? null }))
            .digest("hex")
            .slice(0, 16)
    }

    private async create(client: OpenShellClient, name: string, owner: string, settings: OpenShellConfiguration) {
        const labels = { [ROLE_LABEL]: ROLE, [OWNER_LABEL]: owner, [POOL_LABEL]: "true" }
        const policy = this.policy(settings)
        if (settings.OPENSHELL_SANDBOX_TEMPLATE) {
            return client.sandbox.createFromTemplate({ name, workspace: this.workspace, workloadTemplate: settings.OPENSHELL_SANDBOX_TEMPLATE, labels, policy })
        }
        return client.sandbox.create({ name, workspace: this.workspace, image: settings.OPENSHELL_SANDBOX_IMAGE || OPENSHELL_DEFAULTS.image, labels, policy })
    }

    private find(client: OpenShellClient, name: string): Promise<SandboxRef | undefined> {
        return client.sandbox.get(name, { workspace: this.workspace }).catch(error => {
            if (hasCode(error, "not_found")) return undefined
            throw error
        })
    }

    private young(sandbox: Pick<PooledSandbox, "createdAt">) {
        return this.now() - new Date(sandbox.createdAt).getTime() < YOUNG_MS
    }

    /**
     * The sandbox of a key: the one its earlier messages used while it is alive, else a warm one from the pool, else a
     * new one. Two replicas asking at once end up on the same one: the key holds one sandbox in the database. The
     * commands run in the folder of `space`, the conversation, which is the key itself unless several conversations
     * share it. Without `organizationId` no warm sandbox is handed out: it could not go back to the same organization.
     * A new sandbox is created from the template holding every one of `languages`, when there is one: the sandbox the
     * key already has is kept while it is alive, whatever it was created from.
     */
    async acquire(key: string, lifecycle: SandboxLifecycle = {}, space: string = key, organizationId?: string, languages: readonly string[] = []): Promise<CommandSandbox> {
        const folder = space.toLowerCase()
        if (!SPACE.test(folder)) throw new Error(`"${space}" cannot name a folder of the sandbox`)
        const [client, owner, current] = await Promise.all([this.connect(), this.owner(), this.settings()])
        const settings = await this.settingsFor(client, current, languages)
        const workspace = this.workspace
        for (let attempt = 0; attempt < 3; attempt++) {
            const name = await this.sandboxFor(client, owner, settings, key, lifecycle, folder !== key.toLowerCase(), organizationId)
            await client.sandbox.waitReady(name, READY_TIMEOUT_SECS, { workspace }).catch(error => this.unready(client, name, key, lifecycle, error))
            // The sweep may have moved it back into the pool while it was looked up: the key then gets another one.
            if ((await this.pool.byName(name))?.key === key) return new OpenShellCommandSandbox(client, name, workspace, `${this.spaces}/${folder}`, `${this.root}/home`, current.OPENSHELL_PREVIEW_URL)
        }
        throw new Error(`The sandbox of ${key} kept going back to the pool`)
    }

    private async sandboxFor(
        client: OpenShellClient,
        owner: string,
        settings: OpenShellConfiguration,
        key: string,
        lifecycle: SandboxLifecycle,
        shared: boolean,
        organizationId?: string
    ): Promise<string> {
        const specHash = this.specHash(settings)
        const deadline = this.now() + READY_TIMEOUT_SECS * 1000
        while (this.now() < deadline) {
            const assigned = await this.pool.byKey(key)
            if (assigned) {
                const found = await this.find(client, assigned.name)
                if (found && !DEAD_PHASES.has(found.phase)) {
                    // Its creator stopped before writing down the id the gateway gave it.
                    if (!assigned.sandboxId && !this.young(assigned)) await this.pool.markReady(assigned.name, found.id)
                    return assigned.name
                }
                // Another replica is creating it, or the gateway does not list it yet: that replica's is waited for.
                if (!found && this.young(assigned)) {
                    await this.sleep(POLL_MS)
                    continue
                }
                await this.discard(client, assigned, found, lifecycle.deleted)
                continue
            }
            if (organizationId) {
                // Past its maximum age a warm sandbox is the sweep's to delete, even if this replica's settings are older.
                const claimed = await this.pool.claim(key, organizationId, specHash, shared, new Date(this.now() - maxAgeMsOf(settings)))
                if (claimed) {
                    const found = await this.find(client, claimed.name)
                    if (found && !DEAD_PHASES.has(found.phase)) {
                        await lifecycle.created?.(key, claimed.sandboxId ?? found.id)
                        return claimed.name
                    }
                    // Its lifetime was never opened: nothing to close.
                    await this.discard(client, claimed, found)
                    continue
                }
            }
            const name = randomSandboxName()
            // Written before the gateway creates it: another replica asking for the key meanwhile waits for this one.
            if (!(await this.pool.insert({ name, key, organizationId, shared, specHash, state: "creating" }))) continue
            let created: SandboxRef
            try {
                created = await this.create(client, name, owner, settings)
            } catch (error) {
                await this.pool.remove(name).catch(() => undefined)
                throw error
            }
            await this.pool.markReady(name, created.id)
            await lifecycle.created?.(key, created.id)
            return name
        }
        throw new Error(`No sandbox for ${key}: the replica creating it did not finish`)
    }

    /** Deletes a sandbox, dead or gone, and its record, so that its key gets another one. */
    private async discard(client: OpenShellClient, sandbox: PooledSandbox, found: SandboxRef | undefined, deleted?: SandboxLifecycle["deleted"]) {
        if (found) await client.sandbox.delete(sandbox.name, { workspace: this.workspace, allowMissing: true })
        await this.pool.remove(sandbox.name)
        const id = sandbox.sandboxId ?? found?.id
        if (sandbox.key && id) await deleted?.(sandbox.key, id)
        this.pruned.delete(sandbox.name)
    }

    /**
     * A sandbox that never became ready, stuck provisioning on a node that cannot run it, would be waited for again by
     * every next attempt: its key holds it. It is deleted, with its record, so the next attempt gets another one, and
     * the error says the phase it was left in. A ready one is kept: only the wait failed.
     */
    private async unready(client: OpenShellClient, name: string, key: string, lifecycle: SandboxLifecycle, error: unknown): Promise<never> {
        const workspace = this.workspace
        const stuck = await client.sandbox.get(name, { workspace }).catch(() => undefined)
        const phase = stuck?.phase
        if (phase === "ready") throw error
        try {
            await client.sandbox.delete(name, { workspace, allowMissing: true })
            await this.pool.remove(name)
            if (stuck) await lifecycle.deleted?.(key, stuck.id)
        } catch {
            // The next attempt finds it still stuck, and tries again
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`Sandbox ${name} was not ready (phase: ${phase ?? "unknown"}), it was deleted for the next attempt: ${reason}`, { cause: error })
    }

    /** What the gateway says of itself: connecting makes no call, this is the one that reaches it. */
    async health() {
        const client = await this.connect()
        return client.health()
    }

    private async list(client: OpenShellClient): Promise<Listed[]> {
        const found: Listed[] = []
        for await (const page of client.sandbox.list({ workspace: this.workspace, labelSelector: `${ROLE_LABEL}=${ROLE}` })) {
            for (const sandbox of page.items) {
                found.push({
                    id: sandbox.id,
                    name: sandbox.name,
                    phase: sandbox.phase,
                    owner: sandbox.labels[OWNER_LABEL],
                    conversationId: sandbox.labels[CONVERSATION_LABEL],
                    shared: sandbox.labels[SPACES_LABEL] === "true",
                    pool: sandbox.labels[POOL_LABEL] === "true",
                    createdAtMs: sandbox.createdAtMs
                })
            }
        }
        return found
    }

    /**
     * Lets go the sandboxes of this installation whose key nobody uses any more, and those past their maximum age none
     * of whose jobs waits or runs: each one goes back into the pool while it lacks warm sandboxes, else is deleted.
     * Then creates the warm sandboxes missing. How many it deleted. In a shared sandbox it keeps, it removes the
     * folders of the conversations gone idle. Another installation's are never touched. Those created before the
     * pool go as they did: one with no owner, made before the label existed, only once its conversation is known
     * here and idle. `deleted` is told of each lifetime that ends. Every replica sweeps at once: each step is atomic
     * in the database, and a sandbox deleted twice is deleted once.
     */
    async sweep(stateOf: (conversationId: string) => Promise<ConversationState>, deleted?: SandboxLifecycle["deleted"]): Promise<number> {
        const [client, owner, settings] = await Promise.all([this.connect(), this.owner(), this.settings()])
        const workspace = this.workspace
        // The gateway first, the records after: a sandbox listed already has its record, written before its creation.
        const listed = await this.list(client)
        const records = await this.pool.all()
        const recorded = new Set(records.map(record => record.name))
        const ours = new Map(listed.filter(sandbox => sandbox.owner === owner).map(sandbox => [sandbox.name, sandbox]))
        let count = 0
        const remove = async (name: string, key?: string, id?: string) => {
            const result = await client.sandbox.delete(name, { workspace, allowMissing: true })
            // Told even when another replica deleted it first: closing the same sandbox twice counts it once.
            if (key && id) await deleted?.(key, id)
            // One already gone, deleted by another replica, is not counted here.
            if (result?.sandboxId) count++
            this.pruned.delete(name)
        }

        for (const sandbox of listed) {
            if (recorded.has(sandbox.name)) continue
            if (sandbox.pool) {
                // Its creation failed halfway, or its record was removed: nobody hands it out again.
                if (sandbox.owner === owner && (sandbox.createdAtMs === undefined || this.now() - sandbox.createdAtMs >= YOUNG_MS)) await remove(sandbox.name)
                continue
            }
            if (await this.kept(client, sandbox, owner, stateOf)) continue
            await remove(sandbox.name, sandbox.conversationId, sandbox.id)
        }

        const warm = settings.OPENSHELL_SANDBOX_WARM ?? OPENSHELL_DEFAULTS.warmSandboxes
        const specHash = this.specHash(settings)
        const slots = new Set(records.flatMap(record => (record.slot === undefined ? [] : [record.slot])))
        for (const record of records) {
            const sandbox = ours.get(record.name)
            if (!sandbox) {
                // Gone from the gateway, unless another replica is creating it and the gateway does not list it yet.
                if (this.young(record)) continue
                await this.pool.remove(record.name)
                if (record.key && record.sandboxId) await deleted?.(record.key, record.sandboxId)
                if (record.slot !== undefined) slots.delete(record.slot)
                continue
            }
            const old = sandbox.createdAtMs !== undefined && this.now() - sandbox.createdAtMs > maxAgeMsOf(settings)
            if (record.key === undefined) {
                await this.sweepWarm(record, sandbox, old, specHash, warm, slots, remove)
                continue
            }
            const letGo = async () => {
                await remove(record.name, record.key, record.sandboxId ?? sandbox.id)
                await this.pool.remove(record.name)
            }
            const state = await stateOf(record.key)
            if (state === "running" || (state === "busy" && !old)) {
                // A folder left where it is waits for the next sweep: the sandbox itself is fine.
                if (record.shared) await this.prune(client, record.name, stateOf).catch(() => undefined)
                continue
            }
            const recyclable = !old && !DEAD_PHASES.has(sandbox.phase) && record.specHash === specHash && record.organizationId !== undefined
            if (recyclable && (await this.recycle(client, { ...record, key: record.key, sandboxId: record.sandboxId ?? sandbox.id }, slots, warm, stateOf, remove, deleted))) continue
            await letGo()
        }

        for (let slot = 0; slot < warm; slot++) {
            if (slots.has(slot)) continue
            const name = randomSandboxName()
            // Another replica filling the same slot got there first.
            if (!(await this.pool.insert({ name, slot, shared: false, specHash, state: "creating" }))) continue
            slots.add(slot)
            try {
                // Not waited for: it gets ready while nobody needs it, and whoever claims it waits for it then.
                const created = await this.create(client, name, owner, settings)
                await this.pool.markReady(name, created.id)
            } catch (error) {
                await this.pool.remove(name).catch(() => undefined)
                throw error
            }
        }
        return count
    }

    /**
     * Keeps a warm sandbox while it can still be handed out and the pool wants it, else deletes it. Its record goes first,
     * and only if it is still warm: one another replica claimed meanwhile is that replica's, and stays. One whose creation
     * was never written down as done is taken as ready once the gateway says so; one left halfway emptied is deleted.
     */
    private async sweepWarm(record: PooledSandbox, sandbox: Listed, old: boolean, specHash: string, warm: number, slots: Set<number>, remove: (name: string) => Promise<void>) {
        const drop = async () => {
            if (!(await this.pool.removeWarm(record.name))) return
            await remove(record.name)
            if (record.slot !== undefined) slots.delete(record.slot)
        }
        if (record.state === "recycling") {
            // Its replica is still emptying it.
            if (record.releasedAt && this.now() - new Date(record.releasedAt).getTime() < RECYCLE_TIMEOUT_MS) return
            return drop()
        }
        if (record.state === "creating") {
            if (this.now() - new Date(record.createdAt).getTime() < READY_TIMEOUT_SECS * 1000) return
            if (sandbox.phase !== "ready") return drop()
            await this.pool.markReady(record.name, sandbox.id)
        }
        const handedOut = !old && !DEAD_PHASES.has(sandbox.phase) && record.specHash === specHash && record.slot !== undefined && record.slot < warm
        if (!handedOut) await drop()
    }

    /**
     * Puts a sandbox its key let go back into the pool, in a free slot, emptied of the folders of its conversations:
     * whether it is taken care of. False when no slot is free: the caller deletes it. A job of the key that started since
     * its state was read keeps it. The move from the key to the slot is atomic and comes first: only the replica that
     * made it empties the sandbox, which nobody can claim until it is done. Its lifetime ends here: its time in the pool
     * is billed to nobody. One that cannot be emptied, as something was written in it just now, is deleted instead.
     */
    private async recycle(
        client: OpenShellClient,
        record: PooledSandbox & { key: string; sandboxId: string },
        slots: Set<number>,
        warm: number,
        stateOf: (conversationId: string) => Promise<ConversationState>,
        remove: (name: string) => Promise<void>,
        deleted?: SandboxLifecycle["deleted"]
    ): Promise<boolean> {
        const free = Array.from({ length: warm }, (_, slot) => slot).filter(slot => !slots.has(slot))
        if (!free.length) return false
        const now = await stateOf(record.key)
        if (now === "running" || now === "busy") return true
        let won: number | undefined
        for (const slot of free) {
            const outcome = await this.pool.release(record.name, record.key, slot, new Date(this.now()))
            if (outcome === "slotTaken") continue
            // Gone: another replica moved it back, or deleted it, first.
            if (outcome === "gone") return true
            won = slot
            break
        }
        if (won === undefined) return false
        slots.add(won)
        this.pruned.delete(record.name)
        await deleted?.(record.key, record.sandboxId)
        const reset = await new OpenShellCommandSandbox(client, record.name, this.workspace, this.root).exec(["sh", "-c", RESET_SPACES, this.spaces], { timeoutSecs: 120 }).catch(() => undefined)
        if (reset?.exitCode === 0) {
            await this.pool.markReady(record.name, record.sandboxId)
            return true
        }
        if (await this.pool.removeWarm(record.name)) {
            await remove(record.name)
            slots.delete(won)
        }
        return true
    }

    /** Whether the sweep keeps a sandbox created before the pool; one of this installation it keeps is pruned of its idle conversations. */
    private async kept(client: OpenShellClient, sandbox: Listed, owner: string, stateOf: (conversationId: string) => Promise<ConversationState>): Promise<boolean> {
        if (sandbox.owner !== owner) return sandbox.owner !== undefined || !sandbox.conversationId || (await stateOf(sandbox.conversationId)) !== "idle"
        const settings = await this.settings()
        const state = sandbox.conversationId ? await stateOf(sandbox.conversationId) : "unknown"
        const old = sandbox.createdAtMs !== undefined && this.now() - sandbox.createdAtMs > maxAgeMsOf(settings)
        if (state !== "running" && (state !== "busy" || old)) return false
        if (sandbox.shared) await this.prune(client, sandbox.name, stateOf).catch(() => undefined)
        return true
    }

    /**
     * Removes from a shared sandbox the folders of the conversations nobody uses any more, their dev servers
     * stopped, at most once every few minutes per sandbox. A conversation unknown here (its jobs expired) goes too.
     */
    private async prune(client: OpenShellClient, name: string, stateOf: (conversationId: string) => Promise<ConversationState>) {
        const last = this.pruned.get(name)
        if (last !== undefined && this.now() - last < PRUNE_EVERY_MS) return
        this.pruned.set(name, this.now())
        const sandbox = new OpenShellCommandSandbox(client, name, this.workspace, this.root)
        const listed = await sandbox.exec(["sh", "-c", LIST_SPACES, this.spaces], { timeoutSecs: 60 })
        if (listed.exitCode !== 0) return
        const idle: string[] = []
        for (const space of listed.output.split("\n").filter(line => SPACE.test(line))) {
            const state = await stateOf(space)
            if (state === "idle" || state === "unknown") idle.push(space)
        }
        if (idle.length) await sandbox.exec(["sh", "-c", REMOVE_SPACES, this.spaces, ...idle], { timeoutSecs: 120 })
    }

    /** The sandboxes of this installation, never another one's: those the gateway lists, and those still being created. */
    async inventory(): Promise<SandboxInventoryItem[]> {
        const [client, owner] = await Promise.all([this.connect(), this.owner()])
        const listed = (await this.list(client)).filter(sandbox => sandbox.owner === owner)
        const records = new Map((await this.pool.all()).map(record => [record.name, record]))
        const items: SandboxInventoryItem[] = listed.map(sandbox => {
            const record = records.get(sandbox.name)
            records.delete(sandbox.name)
            if (!record) {
                return {
                    name: sandbox.name,
                    sandboxId: sandbox.id,
                    phase: sandbox.phase,
                    pool: sandbox.pool ? "orphan" : "legacy",
                    key: sandbox.conversationId,
                    shared: sandbox.shared,
                    createdAtMs: sandbox.createdAtMs
                }
            }
            return { ...this.itemOf(record), sandboxId: sandbox.id, phase: sandbox.phase, createdAtMs: sandbox.createdAtMs ?? new Date(record.createdAt).getTime() }
        })
        return [...items, ...Array.from(records.values(), record => this.itemOf(record))]
    }

    private itemOf(record: PooledSandbox): SandboxInventoryItem {
        return {
            name: record.name,
            sandboxId: record.sandboxId,
            pool: record.key !== undefined ? "assigned" : record.state === "ready" ? "warm" : "creating",
            key: record.key,
            organizationId: record.organizationId,
            shared: record.shared,
            createdAtMs: new Date(record.createdAt).getTime()
        }
    }

    /** The sandbox of this installation of that name on the gateway, and its record: none of both when it is another installation's. */
    private async owned(client: OpenShellClient, name: string): Promise<{ found?: SandboxRef; record?: PooledSandbox } | undefined> {
        if (!SANDBOX_NAME.test(name)) return undefined
        const [owner, found, record] = await Promise.all([this.owner(), this.find(client, name), this.pool.byName(name)])
        if (found && found.labels[OWNER_LABEL] !== owner) return undefined
        return found || record ? { found, record } : undefined
    }

    /** The last lines of the log of a sandbox of this installation, oldest first; undefined when it has none of that name. */
    async logs(name: string, lines = MAX_LOG_LINES): Promise<SandboxLogLine[] | undefined> {
        const client = await this.connect()
        const owned = await this.owned(client, name)
        if (!owned?.found) return undefined
        const response = await client.raw.getSandboxLogs({
            sandbox: name,
            workspaceScope: { selection: { case: "workspace", value: this.workspace || "default" } },
            lines: Math.min(Math.max(1, Math.floor(lines)), MAX_LOG_LINES),
            sources: []
        })
        return response.logs.map(line => ({
            timestampMs: line.eventTime ? Number(line.eventTime.seconds) * 1000 + Math.floor(line.eventTime.nanos / 1_000_000) : undefined,
            level: line.level,
            source: line.source || "gateway",
            target: line.target,
            message: line.message
        }))
    }

    /**
     * Deletes a sandbox of this installation and its record, as the sweep does, whatever it serves: whether it had one of
     * that name. A job using it runs its next command in a new one. `deleted` is told of the lifetime that ends.
     */
    async delete(name: string, deleted?: SandboxLifecycle["deleted"]): Promise<boolean> {
        const client = await this.connect()
        const owned = await this.owned(client, name)
        if (!owned) return false
        const { found, record } = owned
        if (found) await client.sandbox.delete(name, { workspace: this.workspace, allowMissing: true })
        if (record) await this.pool.remove(name)
        const key = record ? record.key : found?.labels[CONVERSATION_LABEL]
        const id = record?.sandboxId ?? found?.id
        if (key && id) await deleted?.(key, id)
        this.pruned.delete(name)
        return true
    }
}

let sandboxes: OpenShellSandboxes | undefined

/** The sandboxes of this installation, undefined when no gateway is configured. */
export const openShellSandboxes = (config: OpenShellConfiguration): OpenShellSandboxes | undefined => {
    if (!config.OPENSHELL_GATEWAY_URL) return undefined
    sandboxes ??= new OpenShellSandboxes(config, { settings: () => effectiveOpenShellConfig(config) })
    return sandboxes
}
