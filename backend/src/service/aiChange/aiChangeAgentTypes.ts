import { IDesignSystem } from "../../types/DesignSystem"
import { IProjectTechnologies } from "../../types/ProjectTechnology"
import { LlmEffort, LlmImage, LlmMessage, LlmUsage } from "../llm"
import { CommandSandbox } from "../sandbox/commandSandbox"
import { GitWorkingCopy } from "../workspace/GitWorkingCopy"
import { SandboxExec } from "./aiChangeScripts"
import { AiChangeApiSpecSource } from "./apiSpecReader"

export interface AiChangeAgentFrontend {
    name: string
    slug: string
    framework?: string
    compiler?: string
    context?: string
    /** The one it builds its UI with: its own, else the project's. Its npmrc is redacted when described. */
    designSystem?: IDesignSystem
}

export interface AiChangeAgentBackend {
    name: string
    slug: string
    runtime?: string
    framework?: string
    port?: number
    livenessPath?: string
    readinessPath?: string
    docsPath?: string
    openApiPath?: string
    env?: { name: string; required: boolean; secret: boolean; description?: string }[]
    context?: string
    /** Where it is exposed on the host of every environment */
    exposurePath?: string
    /** Where the other workloads of the cluster reach it */
    clusterUrl?: string
    /** Where browsers reach it, per environment */
    publicUrls?: { environment: string; url: string }[]
    /** What reaches its container as environment variables, by name: never a value */
    configMaps?: { name: string; keys: string[] }[]
    secrets?: { name: string; keys: string[] }[]
    resources?: AiChangeAgentResource[]
}

/** A variable a resource sets on the container: its name and flags, the value only of one its variant always sets */
export interface AiChangeAgentResourceKey {
    key: string
    field?: string
    secret: boolean
    required: boolean
    value?: string
}

/** A resource attached to a backend: what it is and the variables it sets, never a credential */
export interface AiChangeAgentResource {
    name: string
    type: string
    variant: string
    description?: string
    /** What the team wrote for AI agents about the resource */
    context?: string
    keys: AiChangeAgentResourceKey[]
    /** The value every environment shares of the few fields that are no credential and tell how to use it (an api's baseUrl, an ai's model...) */
    values?: Record<string, string>
    /** An api whose document was pasted in the console */
    apiSpec?: boolean
}

/** One repository of the job, its working copy already prepared on `baseBranch`: a frontend's or a backend's. */
export type AiChangeAgentRepository = AiChangeAgentRepositoryBase & ({ frontend: AiChangeAgentFrontend; backend?: never } | { backend: AiChangeAgentBackend; frontend?: never })

interface AiChangeAgentRepositoryBase {
    baseBranch: string
    workingCopy: GitWorkingCopy
    /** The files a follow-up starts from, already on the working copy: they count towards the limits. */
    previousChanges?: AiChangeToolboxChange[]
}

export interface AiChangeAgentDomain {
    name: string
    description?: string
    context?: string
    /** The resources its backends attach, with the slugs of those backends */
    resources?: { name: string; type: string; description?: string; usedBy: string[] }[]
}

export interface AiChangeAgentInput {
    prompt: string
    /** Images the user attached to this request: sent with its message only, earlier ones are not replayed. */
    images?: LlmImage[]
    /** How hard the model reasons on every turn of the run: {@link AI_CHANGE_DEFAULT_EFFORT} when left out. */
    effort?: LlmEffort
    /** The technologies are the defaults the team chose, for what the agent adds: never a reason to rewrite existing code. */
    project: { name: string; context?: string; technologies?: IProjectTechnologies }
    /** The functional domain the job works on: its repositories are its frontend and its backend. */
    domain?: AiChangeAgentDomain
    /** For a job not on a domain: the domains its repositories are in, whose context they follow too. */
    memberDomains?: AiChangeAgentDomain[]
    repositories: AiChangeAgentRepository[]
    /** The earlier jobs of a follow-up, oldest first: the working copies already hold what they proposed. */
    previousRequests?: { prompt: string; summary?: string }[]
    /**
     * The conversation of the previous run, when this one goes on with it on the same repositories:
     * it replaces the description of the job and `previousRequests`, which it already holds.
     */
    history?: LlmMessage[]
    /** Where read_api_spec finds the document of each api resource of the backends: the tool is offered only with one */
    apiSpecs?: AiChangeApiSpecSource[]
    /** The sandbox run_script and run_command run in, asked for at the first script: the tools are offered only with one */
    sandbox?: () => Promise<CommandSandbox>
    /** Told after each script and command run in the sandbox, to count what it costs: it must not throw */
    onSandboxExec?: (exec: SandboxExec) => Promise<void> | void
    /** Starts gateway-routed development previews when explicitly enabled by the installation. */
    previewsEnabled?: boolean
}

export interface AiChangeAgentHooks {
    onEvent: (kind: "info" | "tool" | "output" | "text" | "thinking", message: string) => Promise<void> | void
    onUsage: (usage: LlmUsage) => Promise<void> | void
}

export interface AiChangeAgentResult {
    /** The summary given to finish, else what the agent answered when it stopped on its own. */
    summary: string
    stopReason: "finished" | "end_turn" | "max_rounds" | "max_tokens" | "refusal"
    /** The conversation of this run, stored so that the next message of the user carries on from it. */
    transcript: LlmMessage[]
}

/** What one repository holds, read before the agent starts: its layout and what agents wrote about it. */
export interface AiChangeRepositoryMap {
    layout: string
    files: number
    /** The path of the notes as the agent knows it, prefixed with the slug when the job has more than one repository. */
    notesPath: string
    notes?: string
    instructions?: { path: string; content: string }
}

/** A path changed before the run, with the bytes written to it. */
export interface AiChangeToolboxChange {
    path: string
    bytes: number
}
