import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { ObjectId } from "mongoose"
import { ArgoCdLogLine, ArgoCdPod } from "../client/ArgoCdClient"
import AuthenticationError from "../errors/AuthenticationError"
import { createBusinessException } from "../errors/BusinessException"
import Backend from "../models/BackendModel"
import Environment, { IEnvironment } from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import MaintenanceAgent, { IMaintenanceAgent } from "../models/MaintenanceAgentModel"
import { BuildJobLogDTO, BuildRunDTO } from "../types/BuildStatusDTO"
import { toObjectId } from "../utils/mongooseUtils"
import { decryptSecret, encryptSecret, isEncryptedSecret, isSecretEncryptionEnabled } from "../utils/secretCrypto"
import ArgoCdService from "./ArgoCdService"
import { ArgoCdLogsInput } from "./argoCd/argoCdTypes"
import BuildStatusService, { BuildableComponent } from "./BuildStatusService"

/** What the ciphertext of a token is bound to: one pasted into another field does not decrypt */
const TOKEN_CONTEXT = "MaintenanceAgent.runtimeTokens.token"

/**
 * `fra_<agent id>_<environment id>_<secret>`: the ids find the stored token without trying every one, the
 * 32 random bytes are what proves the caller holds it.
 */
const TOKEN_FORMAT = /^fra_([0-9a-f]{24})_([0-9a-f]{24})_([0-9a-f]{64})$/

const mintToken = (agentId: string, environmentId: string) => `fra_${agentId}_${environmentId}_${randomBytes(32).toString("hex")}`

/** Compared as digests: equal lengths whatever was sent, and no early exit on the first byte that differs */
const sameToken = (sent: string, stored: string) => timingSafeEqual(createHash("sha256").update(sent).digest(), createHash("sha256").update(stored).digest())

const key = (agentId: unknown, environmentId: unknown) => `${String(agentId)}:${String(environmentId)}`

/**
 * The token of each agent in each environment, minted for those that have none yet. A deploy writes them into the
 * Secret the container reads, so a token stays the same from one deploy to the next: a CONTAINER that kept the one
 * it started with still gets in. Two deploys minting at once keep the first one stored, and both read that one back.
 */
export const ensureRuntimeTokens = async (agentIds: unknown[], environmentIds: ObjectId[]): Promise<Map<string, string>> => {
    if (agentIds.length === 0 || environmentIds.length === 0) return new Map()
    const read = () => MaintenanceAgent.find({ _id: { $in: agentIds as ObjectId[] } }).select("+runtimeTokens")
    let agents = await read()
    let minted = false
    for (const agent of agents) {
        for (const environmentId of environmentIds) {
            if (agent.runtimeTokens?.some(entry => String(entry.environmentId) === String(environmentId))) continue
            const token = encryptSecret(mintToken(String(agent._id), String(environmentId)), TOKEN_CONTEXT) as string
            await MaintenanceAgent.updateOne({ _id: agent._id, "runtimeTokens.environmentId": { $ne: environmentId } }, { $push: { runtimeTokens: { environmentId, token } } })
            minted = true
        }
    }
    if (minted) agents = await read()
    const tokens = new Map<string, string>()
    for (const agent of agents) {
        for (const entry of agent.runtimeTokens ?? []) {
            const token = decryptSecret(entry.token, TOKEN_CONTEXT) as string
            tokens.set(key(agent._id, entry.environmentId), token)
            // Minted before a key was configured: encrypted now, as the boot does with the other credentials
            if (isSecretEncryptionEnabled() && !isEncryptedSecret(entry.token)) {
                await MaintenanceAgent.updateOne({ _id: agent._id, "runtimeTokens.environmentId": entry.environmentId }, { $set: { "runtimeTokens.$.token": encryptSecret(token, TOKEN_CONTEXT) } })
            }
        }
    }
    return tokens
}

/** The token of the agent in the environment, among those {@link ensureRuntimeTokens} returned */
export const runtimeTokenOf = (tokens: Map<string, string>, agentId: unknown, environmentId: unknown) => tokens.get(key(agentId, environmentId))

/** Who calls with a runtime token: an agent, in the one environment its token was minted for */
export interface MaintenanceAgentCaller {
    agent: IMaintenanceAgent
    environment: IEnvironment
}

/**
 * The agent and the environment of a runtime token, refusing one it does not hold any more: the agent or the
 * environment deleted, or the token not the one stored.
 */
export const resolveRuntimeToken = async (token: unknown): Promise<MaintenanceAgentCaller> => {
    const match = typeof token === "string" ? TOKEN_FORMAT.exec(token) : null
    if (!match) throw new AuthenticationError("Missing or invalid maintenance agent token")
    const [, agentId, environmentId] = match
    const agent = await MaintenanceAgent.findById(agentId).select("+runtimeTokens")
    const stored = agent?.runtimeTokens?.find(entry => String(entry.environmentId) === environmentId)
    if (!agent || !stored || !sameToken(token as string, decryptSecret(stored.token, TOKEN_CONTEXT) as string)) {
        throw new AuthenticationError("Missing or invalid maintenance agent token")
    }
    const environment = await Environment.findOne({ _id: toObjectId(environmentId), projectId: agent.projectId })
    if (!environment) throw new AuthenticationError("Missing or invalid maintenance agent token")
    return { agent, environment }
}

/** One backend or frontend the agent maintains, and what it may read of it */
export interface MaintenanceAgentTargetDTO {
    kind: "backend" | "frontend"
    slug: string
    name: string
    /** It runs as a container: its pods and their logs can be read */
    logs: boolean
    /** It has a code repository: its builds and the logs of their failed jobs can be read */
    builds: boolean
}

interface ResolvedTarget extends MaintenanceAgentTargetDTO {
    component: BuildableComponent
}

const targetNotFound = (slug: string) =>
    createBusinessException({ code: "MAINTENANCE_AGENT_TARGET_NOT_FOUND", message: `"${slug}" is none of the backends and frontends this agent maintains`, statusCode: 404 })

/**
 * What the container of a maintenance agent reads of the backends and frontends it maintains, in the environment it
 * runs in: their pods and logs through Argo CD, their builds from the CI provider. Nothing else of the project: an
 * agent reads only what it was set to maintain, and only where its token was minted.
 */
export class MaintenanceAgentRuntimeService {
    constructor(private readonly caller: MaintenanceAgentCaller) {}

    async targets(): Promise<MaintenanceAgentTargetDTO[]> {
        return (await this.resolvedTargets()).map(({ component: _component, ...target }) => target)
    }

    async pods(slug: string): Promise<ArgoCdPod[]> {
        const target = await this.targetWithLogs(slug)
        return new ArgoCdService().podsOf(this.caller.agent.projectId, target.slug, this.caller.environment)
    }

    async logs(slug: string, query: ArgoCdLogsInput): Promise<ArgoCdLogLine[]> {
        const target = await this.targetWithLogs(slug)
        return new ArgoCdService().logsOf(this.caller.agent.projectId, target.slug, this.caller.environment, query)
    }

    async builds(slug: string): Promise<BuildRunDTO[]> {
        const target = await this.target(slug)
        return new BuildStatusService().runsOf(target.component, target.kind)
    }

    async buildLogs(slug: string, runId: string): Promise<BuildJobLogDTO[]> {
        const target = await this.target(slug)
        return new BuildStatusService().failedRunLogsOf(target.component, target.kind, runId)
    }

    /** The targets as they are now: one detached since is out, even before the next deploy says so */
    private async resolvedTargets(): Promise<ResolvedTarget[]> {
        const { agent } = this.caller
        const [backends, frontends] = await Promise.all([
            Backend.find({ _id: { $in: agent.backendIds ?? [] }, projectId: agent.projectId }).sort({ slug: 1 }),
            Frontend.find({ _id: { $in: agent.frontendIds ?? [] }, projectId: agent.projectId }).sort({ slug: 1 })
        ])
        return [
            ...backends.map(backend => ({ kind: "backend" as const, slug: backend.slug, name: backend.name, logs: true, builds: Boolean(backend.codeRepository?.enabled), component: backend })),
            ...frontends.map(frontend => ({
                kind: "frontend" as const,
                slug: frontend.slug,
                name: frontend.name,
                logs: frontend.kind === FrontendKind.DOCKER,
                builds: Boolean(frontend.codeRepository?.enabled),
                component: frontend as BuildableComponent
            }))
        ]
    }

    private async target(slug: string): Promise<ResolvedTarget> {
        const target = (await this.resolvedTargets()).find(candidate => candidate.slug === slug)
        if (!target) throw targetNotFound(slug)
        return target
    }

    private async targetWithLogs(slug: string): Promise<ResolvedTarget> {
        const target = await this.target(slug)
        if (!target.logs) {
            throw createBusinessException({ code: "MAINTENANCE_AGENT_TARGET_NO_LOGS", message: `"${slug}" runs in no container: it has no pods to read the logs of`, statusCode: 422 })
        }
        return target
    }
}

export default MaintenanceAgentRuntimeService
