import { isValidObjectId } from "mongoose"
import { fastify } from "../.."
import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import Backend from "../../models/BackendModel"
import Frontend from "../../models/FrontendModel"
import StandalonePreviewSession from "../../models/StandalonePreviewSessionModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { closeSandboxLifetime, openSandboxLifetime, recordSandboxUsage, SandboxOwner } from "../SandboxUsageService"
import { CommandSandbox } from "../sandbox/commandSandbox"
import { ConversationState, OpenShellConfiguration, openShellSandboxes, SandboxLifecycle } from "../sandbox/OpenShellSandboxes"
import { languagesOfComponents, SandboxLanguage } from "../sandbox/sandboxLanguages"
import { BackendComponent, FrontendComponent } from "../workspace/repositoryComponent"
import { SandboxExec } from "./aiChangeScripts"
import { loggable } from "./aiChangeShared"

/** A usage that cannot be recorded is logged, never thrown: it must not stop a job, a preview or the sweep. */
const logged = async (what: string, conversationId: string, record: () => Promise<void>) => {
    try {
        await record()
    } catch (error) {
        fastify.log.error({ error: loggable(error), conversationId }, `Sandbox ${what} not recorded`)
    }
}

/** The lifetime of the sandboxes of a conversation, counted against `owner`: who created it, a job or a preview. */
export const sandboxLifecycle = (owner: SandboxOwner): SandboxLifecycle => ({
    created: (conversationId, sandboxId) => logged("lifetime", conversationId, () => openSandboxLifetime(conversationId, sandboxId, owner)),
    deleted: (conversationId, sandboxId) => logged("lifetime", conversationId, () => closeSandboxLifetime(conversationId, sandboxId))
})

/** Who the sandbox time of a job is counted against: what its tokens are, a job of a mission apart. */
export const jobSandboxOwner = (
    job: Pick<IAiChangeJob, "_id" | "projectId" | "userId" | "missionId" | "domainId" | "frontendIds" | "backendIds">,
    organizationId?: SandboxOwner["organizationId"]
): SandboxOwner => ({
    organizationId,
    projectId: job.projectId,
    userId: job.userId,
    source: job.missionId ? "mission" : "agent",
    jobId: job._id,
    domainId: job.domainId,
    frontendIds: job.frontendIds,
    backendIds: job.backendIds
})

/** The key of a sandbox the jobs of a domain, or of a project, share. */
const SHARED_KEY = /^(domain|project)-([0-9a-f]{24})$/

/**
 * The sandbox a job runs its commands in. Shared by domain: the one of its domain, of the one domain all its
 * repositories are in for a job on single frontends or backends, else of its project. Its users share the
 * domain's code already, and the caches of the package managers stay warm. Otherwise its conversation's.
 */
export const sandboxKeyOf = (
    sharing: OpenShellConfiguration["OPENSHELL_SANDBOX_SHARING"],
    job: Pick<IAiChangeJob, "rootJobId" | "projectId" | "domainId">,
    components: { domainId?: unknown }[]
): string => {
    if (sharing === "conversation") return String(job.rootJobId)
    const domains = new Set(job.domainId ? [String(job.domainId)] : components.map(component => (component.domainId ? String(component.domainId) : "")))
    const [domain] = domains
    return domains.size === 1 && domain ? `domain-${domain}` : `project-${String(job.projectId)}`
}

/**
 * The languages the sandbox of a key needs: those of the repositories of the job, and for the sandbox of a domain, which
 * the next job may use on any repository of it, those of every repository of the domain. One that cannot be read
 * leaves the job's.
 */
const sandboxLanguagesOf = async (key: string, components: readonly (FrontendComponent | BackendComponent)[]): Promise<SandboxLanguage[]> => {
    const [, scope, domainId] = SHARED_KEY.exec(key) ?? []
    if (scope !== "domain") return languagesOfComponents(components)
    try {
        const domain = toObjectId(domainId)
        const [backends, frontend] = await Promise.all([Backend.find({ domainId: domain }, { stack: 1 }).lean(), Frontend.exists({ domainId: domain })])
        const members = [...backends.map(backend => ({ kind: "backend" as const, runtime: backend.stack?.runtime })), ...(frontend ? [{ kind: "frontend" as const }] : [])]
        return languagesOfComponents([...components, ...members])
    } catch (error) {
        fastify.log.error({ error: loggable(error), key }, "Languages of the domain of a sandbox not read")
        return languagesOfComponents(components)
    }
}

/**
 * The sandbox of a job, under `key`, its commands in the folder of its conversation (the chain of jobs from the
 * same first one), so that the next message finds its dependencies installed, created from the template holding the
 * languages of `components` when it is new. Undefined without a gateway. The
 * lifetime of a conversation's sandbox is counted against `owner` when this job creates it; that of a shared one
 * against its project and domain only, as it is no one job's.
 */
export const sandboxForJob = (
    config: OpenShellConfiguration,
    job: Pick<IAiChangeJob, "_id" | "rootJobId">,
    key: string,
    owner: SandboxOwner,
    components: readonly (FrontendComponent | BackendComponent)[] = []
): (() => Promise<CommandSandbox>) | undefined => {
    const sandboxes = openShellSandboxes(config)
    if (!sandboxes) return undefined
    const domainId = SHARED_KEY.exec(key)?.[1] === "domain" ? key.slice("domain-".length) : undefined
    const lifetimeOwner: SandboxOwner = SHARED_KEY.test(key) ? { organizationId: owner.organizationId, projectId: owner.projectId, source: owner.source, ...(domainId ? { domainId } : {}) } : owner
    return async () => {
        // Saved before the sandbox is asked for: the sweep finds the job under the key and keeps the sandbox.
        await AiChangeJob.updateOne({ _id: job._id }, { $set: { sandboxKey: key } })
        const languages = await sandboxLanguagesOf(key, components)
        return sandboxes.acquire(key, sandboxLifecycle(lifetimeOwner), job.rootJobId.toString(), owner.organizationId ? String(owner.organizationId) : undefined, languages)
    }
}

/** Records the time of each script and command a job runs in the sandbox of its conversation. */
export const sandboxExecRecorder =
    (job: Pick<IAiChangeJob, "rootJobId">, owner: SandboxOwner) =>
    (exec: SandboxExec): Promise<void> => {
        const conversationId = job.rootJobId.toString()
        return logged("command", conversationId, () => recordSandboxUsage({ ...owner, conversationId, commands: 1, execSeconds: exec.seconds }))
    }

const ACTIVE = { status: { $in: [AiJobStatus.PENDING, AiJobStatus.RUNNING] } }

/**
 * Whether somebody still uses a sandbox, or the folder of a conversation in one: running while one of its jobs
 * waits or runs or its standalone preview session has not expired, busy while the last job ended within the idle
 * time. Idle once it has, unknown when this database has neither: a conversation of another installation, or a
 * preview session already expired and removed. A shared sandbox is used by the jobs saved under its key, a
 * conversation by the jobs of its chain. A job that died with its process is declared failed by the missions
 * sweep, and its sandbox goes after it.
 */
export const conversationState =
    (idleMs: number, now = () => Date.now()) =>
    async (conversationId: string): Promise<ConversationState> => {
        const shared = SHARED_KEY.test(conversationId)
        if (!shared && !isValidObjectId(conversationId)) return "unknown"
        const id = shared ? undefined : toObjectId(conversationId)
        const jobs = shared ? { sandboxKey: conversationId } : { rootJobId: id }
        const checkedAt = new Date(now())
        const [usedJob, activePreview] = await Promise.all([
            AiChangeJob.exists({ ...jobs, $or: [ACTIVE, { updatedAt: { $gt: new Date(checkedAt.getTime() - idleMs) } }] }),
            id ? StandalonePreviewSession.exists({ _id: id, expiresAt: { $gt: checkedAt } }) : null
        ])
        if (activePreview) return "running"
        if (usedJob) return (await AiChangeJob.exists({ ...jobs, ...ACTIVE })) ? "running" : "busy"
        const [job, preview] = await Promise.all([AiChangeJob.exists(jobs), id ? StandalonePreviewSession.exists({ _id: id }) : null])
        return job || preview ? "idle" : "unknown"
    }

/** Closes the lifetime of a sandbox let go: by the sweep, or by an installation administrator deleting it. */
export const closeLifetime: NonNullable<SandboxLifecycle["deleted"]> = (conversationId, sandboxId) => logged("lifetime", conversationId, () => closeSandboxLifetime(conversationId, sandboxId))

/** Lets go the sandboxes of the idle conversations of this installation, and fills the warm pool: how many it deleted, 0 without a gateway. */
export const sweepIdleSandboxes = async (config: OpenShellConfiguration): Promise<number> => {
    const sandboxes = openShellSandboxes(config)
    return sandboxes ? sandboxes.sweep(conversationState(await sandboxes.idleMs()), closeLifetime) : 0
}
