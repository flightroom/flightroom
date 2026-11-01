import { isValidObjectId } from "mongoose"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import AiChangeJob from "../../models/AiChangeJobModel"
import Domain from "../../models/DomainModel"
import Organization from "../../models/OrganizationModel"
import Project from "../../models/ProjectModel"
import SandboxSettings, { SANDBOX_SETTINGS_ID } from "../../models/SandboxSettingsModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { ensureInstallationAdmin } from "../../utils/installationAdmins"
import { toObjectId } from "../../utils/mongooseUtils"
import { redactSecrets } from "../../utils/redactSecrets"
import { closeLifetime, conversationState } from "../aiChange/aiChangeSandboxes"
import { ConversationState, OPENSHELL_DEFAULTS, OpenShellConfiguration, openShellSandboxes, SandboxLogLine, SandboxPoolState } from "./OpenShellSandboxes"
import { SandboxStatusSummary, sandboxGatewayStatus } from "./SandboxStatusService"
import { sandboxPoolCounts } from "./sandboxPool"
import { invalidateSandboxSettings, SANDBOX_SETTING_NAMES, SandboxSettingsValues, storedSandboxSettings } from "./sandboxSettings"

/** The settings of the sandboxes as the installation page shows them. */
export interface SandboxSettingsSummary {
    /** What an installation administrator saved: each one missing is the environment's. */
    values: SandboxSettingsValues
    /** The environment's values, which apply where nothing is saved. */
    defaults: Required<Omit<SandboxSettingsValues, "template" | "previewUrl">> & { template?: string; previewUrl?: string }
    updatedAt?: Date
    pool: { warm: number; creating: number; assigned: number }
    gateway: SandboxStatusSummary
}

/** What a sandbox serves, in words a person reads. */
export interface SandboxTarget {
    kind: "domain" | "project" | "conversation" | "preview"
    /** The domain, the project, or the title of the conversation (else the start of its first prompt). */
    name?: string
    projectName?: string
}

/** A sandbox of this installation as the installation page lists it. */
export interface InstallationSandbox {
    name: string
    phase?: string
    pool: SandboxPoolState
    target?: SandboxTarget
    organization?: { id: string; name: string }
    /** Whether somebody uses it, for one that serves a key. */
    usage?: ConversationState
    shared: boolean
    createdAt?: Date
}

/** The environment's value of each setting, with the built-in default where the environment has none. */
export const sandboxSettingsDefaults = (env: OpenShellConfiguration): SandboxSettingsSummary["defaults"] => ({
    idleMinutes: env.OPENSHELL_SANDBOX_IDLE_MINUTES ?? OPENSHELL_DEFAULTS.idleMinutes,
    maxHours: env.OPENSHELL_SANDBOX_MAX_HOURS ?? OPENSHELL_DEFAULTS.maxHours,
    sharing: env.OPENSHELL_SANDBOX_SHARING ?? "domain",
    previewsEnabled: Boolean(env.OPENSHELL_PREVIEWS_ENABLED),
    previewUrl: env.OPENSHELL_PREVIEW_URL || undefined,
    warmSandboxes: env.OPENSHELL_SANDBOX_WARM ?? OPENSHELL_DEFAULTS.warmSandboxes,
    image: env.OPENSHELL_SANDBOX_IMAGE || OPENSHELL_DEFAULTS.image,
    template: env.OPENSHELL_SANDBOX_TEMPLATE || undefined,
    registryHosts: env.OPENSHELL_REGISTRY_HOSTS ?? OPENSHELL_DEFAULTS.registryHosts,
    networkBinary: env.OPENSHELL_NETWORK_BINARY || OPENSHELL_DEFAULTS.networkBinary
})

const LISTS = new Set(["registryHosts", "networkBinary"])

/** The values to store: null and empty are the environment's; the lists without spaces nor empty items. */
export const normalizeSandboxSettings = (values: Record<string, unknown>): SandboxSettingsValues => {
    const normalized: Record<string, unknown> = {}
    for (const name of SANDBOX_SETTING_NAMES) {
        let value = values[name]
        if (typeof value === "string") {
            value = LISTS.has(name)
                ? value
                      .split(",")
                      .map(item => item.trim())
                      .filter(Boolean)
                      .join(",")
                : value.trim()
        }
        if (value !== undefined && value !== null && value !== "") normalized[name] = value
    }
    return normalized as SandboxSettingsValues
}

/** How much of a first prompt names a conversation without a title. */
const PROMPT_EXCERPT = 80

const SHARED_KEY = /^(domain|project)-([0-9a-f]{24})$/

/**
 * What an installation administrator does from the console with the sandboxes of the coding agent: their settings,
 * the list of them, their logs, and deleting one. Refused to anybody else.
 */
export default class InstallationSandboxService {
    constructor(
        private readonly email: string | undefined,
        private readonly config: OpenShellConfiguration & { INSTALLATION_ADMINS?: string }
    ) {
        ensureInstallationAdmin(email, config.INSTALLATION_ADMINS)
    }

    async settings(onGatewayError?: (error: unknown) => void): Promise<SandboxSettingsSummary> {
        const [document, pool, gateway] = await Promise.all([SandboxSettings.findById(SANDBOX_SETTINGS_ID).lean(), sandboxPoolCounts(), sandboxGatewayStatus(this.config, onGatewayError)])
        return { values: storedSandboxSettings(document), defaults: sandboxSettingsDefaults(this.config), updatedAt: document?.updatedAt, pool, gateway }
    }

    /** Replaces what is saved: a setting left out goes back to the environment's. This replica applies it at once, the others within the cache time. */
    async saveSettings(values: Record<string, unknown>, userId: unknown, onGatewayError?: (error: unknown) => void): Promise<SandboxSettingsSummary> {
        const normalized = normalizeSandboxSettings(values)
        const unset = Object.fromEntries(SANDBOX_SETTING_NAMES.filter(name => normalized[name] === undefined).map(name => [name, 1]))
        await SandboxSettings.updateOne({ _id: SANDBOX_SETTINGS_ID }, { $set: { ...normalized, updatedBy: userId }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true })
        invalidateSandboxSettings()
        return this.settings(onGatewayError)
    }

    /** The sandboxes of this installation, each with what it serves and whether it is used: none without a gateway. */
    async sandboxes(): Promise<InstallationSandbox[]> {
        const sandboxes = openShellSandboxes(this.config)
        if (!sandboxes) return []
        const [items, idleMs] = await Promise.all([sandboxes.inventory(), sandboxes.idleMs()])
        const stateOf = conversationState(idleMs)
        const keys = [...new Set(items.flatMap(item => (item.key ? [item.key] : [])))]
        const idsOf = (kind: string) => keys.flatMap(key => (SHARED_KEY.exec(key)?.[1] === kind ? [key.slice(kind.length + 1)] : []))
        const conversationIds = keys.filter(key => isValidObjectId(key) && !SHARED_KEY.test(key)).map(toObjectId)
        const [domains, jobs, previews, usage] = await Promise.all([
            Domain.find({ _id: { $in: idsOf("domain").map(toObjectId) } }, { name: 1, projectId: 1 }).lean(),
            AiChangeJob.find({ _id: { $in: conversationIds } }, { title: 1, prompt: 1, projectId: 1 }).lean(),
            StandalonePreviewSession.find({ _id: { $in: conversationIds } }, { projectId: 1 }).lean(),
            Promise.all(keys.map(async key => [key, await stateOf(key)] as const))
        ])
        const projectIds = [...idsOf("project"), ...[...domains, ...jobs, ...previews].map(target => String(target.projectId))]
        const projects = await Project.find({ _id: { $in: projectIds.map(toObjectId) } }, { name: 1, organizationId: 1 }).lean()
        const projectOf = new Map(projects.map(project => [String(project._id), project]))
        const organizationIds = [...items.flatMap(item => (item.organizationId ? [item.organizationId] : [])), ...projects.map(project => String(project.organizationId))]
        const organizations = await Organization.find({ _id: { $in: organizationIds.map(toObjectId) } }, { name: 1 }).lean()
        const organizationOf = new Map(organizations.map(organization => [String(organization._id), organization.name]))
        const usageOf = new Map(usage)

        const targetOf = (key: string): { target?: SandboxTarget; projectId?: string } => {
            const shared = SHARED_KEY.exec(key)
            if (shared?.[1] === "project") return { target: { kind: "project", name: projectOf.get(shared[2])?.name }, projectId: shared[2] }
            if (shared?.[1] === "domain") {
                const domain = domains.find(candidate => String(candidate._id) === shared[2])
                const projectId = domain ? String(domain.projectId) : undefined
                return { target: { kind: "domain", name: domain?.name, projectName: projectId ? projectOf.get(projectId)?.name : undefined }, projectId }
            }
            const preview = previews.find(candidate => String(candidate._id) === key)
            if (preview) return { target: { kind: "preview", projectName: projectOf.get(String(preview.projectId))?.name }, projectId: String(preview.projectId) }
            const job = jobs.find(candidate => String(candidate._id) === key)
            if (job) {
                const projectId = String(job.projectId)
                return { target: { kind: "conversation", name: job.title || job.prompt.slice(0, PROMPT_EXCERPT), projectName: projectOf.get(projectId)?.name }, projectId }
            }
            return { target: { kind: "conversation" } }
        }

        return items.map(item => {
            const { target, projectId } = item.key ? targetOf(item.key) : {}
            const organizationId = item.organizationId ?? (projectId ? String(projectOf.get(projectId)?.organizationId ?? "") : "")
            const organizationName = organizationId ? organizationOf.get(organizationId) : undefined
            return {
                name: item.name,
                phase: item.phase,
                pool: item.pool,
                target,
                organization: organizationId && organizationName ? { id: organizationId, name: organizationName } : undefined,
                usage: item.key ? usageOf.get(item.key) : undefined,
                shared: item.shared,
                createdAt: item.createdAtMs === undefined ? undefined : new Date(item.createdAtMs)
            }
        })
    }

    /** The last lines of the log of one sandbox of this installation, oldest first, with the usual credentials blanked. */
    async logs(name: string, lines?: number): Promise<SandboxLogLine[]> {
        const sandboxes = openShellSandboxes(this.config)
        const found = sandboxes ? await sandboxes.logs(name, lines) : undefined
        if (!found) throw new EntityNotFoundError(name, `No sandbox ${name} of this installation`)
        return found.map(line => ({ ...line, target: redactSecrets(line.target), message: redactSecrets(line.message) }))
    }

    /** Deletes one sandbox of this installation and closes its lifetime, whatever it serves. */
    async delete(name: string): Promise<void> {
        const sandboxes = openShellSandboxes(this.config)
        if (!sandboxes || !(await sandboxes.delete(name, closeLifetime))) throw new EntityNotFoundError(name, `No sandbox ${name} of this installation`)
    }
}
