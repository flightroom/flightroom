import { randomUUID } from "node:crypto"
import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import SandboxSettings, { SANDBOX_SETTINGS_ID } from "../../models/SandboxSettingsModel"
import { ensureInstallationAdmin } from "../../utils/installationAdmins"
import { OPENSHELL_DEFAULTS, OpenShellConfiguration, OpenShellSandboxes, openShellSandboxes } from "./OpenShellSandboxes"
import { packageCacheFolder, packageCacheOf, withoutPackageCache, withPackageCache } from "./packageCache"
import { languagesOfLabels, SandboxLanguage, withLanguageLabels, withoutLanguageLabels } from "./sandboxLanguages"
import { invalidateSandboxSettings } from "./sandboxSettings"

/** ESM only: the types alone, the SDK itself is loaded by OpenShellSandboxes. */
type SandboxWorkloadTemplate = import("@nvidia/openshell-sdk").SandboxWorkloadTemplate
type TemplateClient = Awaited<ReturnType<OpenShellSandboxes["templates"]>>["client"]
type TemplateInit = Parameters<TemplateClient["create"]>[0]
type DriverConfig = NonNullable<NonNullable<SandboxWorkloadTemplate["spec"]>["driverConfig"]>

/** What an installation administrator sets of a workload template: the rest of it, set on the gateway otherwise, is kept. */
export interface SandboxTemplateInput {
    image: string
    cpu?: string | null
    memory?: string | null
    labels?: Record<string, string>
    environment?: Record<string, string>
    /** The languages its image holds: a sandbox needing them is created from it. Missing, those it had stay. */
    languages?: SandboxLanguage[]
    /**
     * The PersistentVolumeClaim its sandboxes share as their package cache, labelled on the cluster for the gateway to
     * mount it. Null or empty: each sandbox keeps its own. Missing: the one it had stays.
     */
    packageCache?: string | null
}

/** A workload template of the gateway as the installation page lists it. */
export interface SandboxTemplateItem {
    name: string
    image: string
    cpu?: string
    memory?: string
    /** Without those of the languages, listed apart. */
    labels: Record<string, string>
    environment: Record<string, string>
    languages: SandboxLanguage[]
    /** The PersistentVolumeClaim mounted as the package cache of its sandboxes, when there is one. */
    packageCache?: string
    /** Whether it has settings this page does not show (runtime class, GPU, service level): they are kept when it is changed here. */
    advanced: boolean
    createdAt?: Date
    /** Whether new sandboxes are created from it. */
    inUse: boolean
}

/** Connect codes the gateway answers a template it refuses with: invalid argument, failed precondition, out of range. */
const REFUSED = new Set([3, 9, 11])

/** Told when a template could not be put back after its change was refused: it is no longer on the gateway. */
export type TemplateLost = (error: unknown, previous: { name: string; image?: string }) => void

const toItem = (template: SandboxWorkloadTemplate, inUse: string | undefined, cacheFolder: string): SandboxTemplateItem => {
    const workload = template.spec?.workload
    const created = template.metadata?.createdTime
    const driverConfig = template.spec?.driverConfig
    return {
        name: template.metadata?.name ?? "",
        image: workload?.image ?? "",
        cpu: workload?.resources?.cpu || undefined,
        memory: workload?.resources?.memory || undefined,
        labels: withoutLanguageLabels(template.metadata?.labels),
        environment: { ...workload?.environment },
        languages: languagesOfLabels(template.metadata?.labels),
        packageCache: packageCacheOf(driverConfig, cacheFolder),
        // The cache is shown: only the rest of the driver config is a setting the page does not show.
        advanced: Boolean(withoutPackageCache(driverConfig, cacheFolder) || template.spec?.desiredServiceLevel || workload?.resources?.gpu || Object.keys(template.metadata?.annotations ?? {}).length),
        createdAt: created ? new Date(Number(created.seconds) * 1000) : undefined,
        inUse: template.metadata?.name === inUse
    }
}

/** The template to create: what the page sets, over what the gateway had that the page does not show. */
const templateOf = (name: string, input: SandboxTemplateInput, cacheFolder: string, previous?: SandboxWorkloadTemplate): TemplateInit => {
    const gpu = previous?.spec?.workload?.resources?.gpu
    const resources = input.cpu || input.memory || gpu ? { cpu: input.cpu ?? "", memory: input.memory ?? "", gpu } : undefined
    const kept = previous?.spec?.driverConfig
    const driverConfig = input.packageCache === undefined ? kept : (withPackageCache(kept, input.packageCache?.trim(), cacheFolder) as DriverConfig | undefined)
    return {
        metadata: {
            name,
            labels: withLanguageLabels(input.labels, input.languages ?? languagesOfLabels(previous?.metadata?.labels)),
            annotations: previous?.metadata?.annotations
        },
        spec: {
            workload: { image: input.image, environment: input.environment ?? {}, resources },
            driverConfig,
            desiredServiceLevel: previous?.spec?.desiredServiceLevel
        }
    }
}

/** What the gateway refuses, told to the administrator; anything else stays a server error, its details in the log. */
const refused = (error: unknown, name: string): unknown => {
    const { code, connectCode, message } = (error ?? {}) as { code?: unknown; connectCode?: number; message?: string }
    // Unauthenticated or PermissionDenied: the identity of this installation lacks a role on the workspace, and the
    // gateway says which one and how to grant it.
    if (code === "auth") {
        const reason = message?.replace(/^\[auth\] /, "") || "The gateway refused the credentials of this installation"
        return createBusinessException({ code: "SANDBOX_GATEWAY_FORBIDDEN", message: reason, statusCode: 403 })
    }
    if (code === "already_exists") return createBusinessException({ code: "SANDBOX_TEMPLATE_EXISTS", message: `A template named ${name} already exists`, statusCode: 409 })
    // The SDK names InvalidArgument invalid_config, the others rpc: the Connect code is what tells them apart.
    if (connectCode !== undefined && REFUSED.has(connectCode))
        return createBusinessException({ code: "SANDBOX_TEMPLATE_INVALID", message: message ?? "The gateway refused the template", statusCode: 400 })
    return error
}

/**
 * The workload templates of the OpenShell gateway, managed by an installation administrator from the console instead of
 * by hand on the gateway. They live in the gateway, shared by every installation on its workspace, not in this database.
 */
export default class SandboxTemplateService {
    constructor(
        email: string | undefined,
        private readonly config: OpenShellConfiguration & { INSTALLATION_ADMINS?: string }
    ) {
        ensureInstallationAdmin(email, config.INSTALLATION_ADMINS)
    }

    private async gateway() {
        const sandboxes = openShellSandboxes(this.config)
        if (!sandboxes) throw createBusinessException({ code: "SANDBOX_GATEWAY_NOT_CONFIGURED", message: "OPENSHELL_GATEWAY_URL is not set", statusCode: 409 })
        return { sandboxes, ...(await sandboxes.templates()) }
    }

    /** Where the sandboxes keep their package cache: where a template mounts the claim shared by its sandboxes. */
    private get cacheFolder() {
        return packageCacheFolder(this.config.OPENSHELL_SANDBOX_ROOT || OPENSHELL_DEFAULTS.root)
    }

    /** The template new sandboxes are created from: the one saved from the console, else the environment's. */
    private async inUse(): Promise<string | undefined> {
        const stored = await SandboxSettings.findById(SANDBOX_SETTINGS_ID, { template: 1 }).lean()
        return stored?.template || this.config.OPENSHELL_SANDBOX_TEMPLATE || undefined
    }

    /** Every template of the workspace, by name: none without a gateway. */
    async list(): Promise<SandboxTemplateItem[]> {
        if (!this.config.OPENSHELL_GATEWAY_URL) return []
        const [{ client, workspace }, inUse] = await Promise.all([this.gateway(), this.inUse()])
        const templates = await client.listAll({ workspace }).catch(error => {
            throw refused(error, "")
        })
        return templates.map(template => toItem(template, inUse, this.cacheFolder)).sort((a, b) => a.name.localeCompare(b.name))
    }

    async create(name: string, input: SandboxTemplateInput): Promise<SandboxTemplateItem> {
        const { sandboxes, client, workspace } = await this.gateway()
        const created = await client.create(templateOf(name, input, this.cacheFolder), { workspace }).catch(error => {
            throw refused(error, name)
        })
        sandboxes.forgetTemplates()
        return toItem(created, await this.inUse(), this.cacheFolder)
    }

    /**
     * The gateway has no update: the template is deleted and created again, the previous one put back if the new one is
     * refused, `lost` told if even that fails. When new sandboxes are created from it, its revision changes: the warm
     * sandboxes made from the previous one are no longer handed out, and the pool replaces them.
     */
    async replace(name: string, input: SandboxTemplateInput, lost?: TemplateLost): Promise<SandboxTemplateItem> {
        const { sandboxes, client, workspace } = await this.gateway()
        const previous = await client.get(name, { workspace }).catch(error => {
            if ((error as { code?: unknown })?.code === "not_found") throw new EntityNotFoundError(name, `No sandbox template ${name}`)
            throw refused(error, name)
        })
        await client.delete(name, { workspace, allowMissing: true }).catch(error => {
            throw refused(error, name)
        })
        // Gone or back, the templates this replica read are no longer what the gateway has.
        sandboxes.forgetTemplates()
        const saved = await client.create(templateOf(name, input, this.cacheFolder, previous), { workspace }).catch(async error => {
            const restored = await client
                .create({ metadata: { name, labels: previous.metadata?.labels, annotations: previous.metadata?.annotations }, spec: previous.spec }, { workspace })
                .then(() => true)
                .catch(restoreError => {
                    lost?.(restoreError, { name, image: previous.spec?.workload?.image })
                    return false
                })
            if (!restored) {
                throw createBusinessException({ code: "SANDBOX_TEMPLATE_LOST", message: `${name} was deleted and could not be created again`, statusCode: 502 })
            }
            throw refused(error, name)
        })
        const inUse = await this.inUse()
        if (inUse === name) {
            await SandboxSettings.updateOne({ _id: SANDBOX_SETTINGS_ID }, { $set: { templateRevision: randomUUID() } }, { upsert: true })
            invalidateSandboxSettings()
        }
        return toItem(saved, inUse, this.cacheFolder)
    }

    /** Refused for the template new sandboxes are created from: they would no longer start. */
    async delete(name: string): Promise<void> {
        if (name === (await this.inUse())) {
            throw createBusinessException({ code: "SANDBOX_TEMPLATE_IN_USE", message: `New sandboxes are created from ${name}: choose another template first`, statusCode: 409 })
        }
        const { sandboxes, client, workspace } = await this.gateway()
        const result = await client.delete(name, { workspace, allowMissing: true }).catch(error => {
            throw refused(error, name)
        })
        sandboxes.forgetTemplates()
        if (result.outcome === "already_absent") throw new EntityNotFoundError(name, `No sandbox template ${name}`)
    }
}
