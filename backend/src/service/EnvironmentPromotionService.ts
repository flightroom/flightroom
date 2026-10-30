import { ObjectId, Schema, Types } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EnvironmentNotFoundError } from "../errors/EnvironmentNotFoundError"
import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import { EnvironmentVersion, versionIn } from "../types/EnvironmentVersions"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService from "./BaseAuthorizedService"

/** The applications that run a version per environment: a backend, a DOCKER frontend, a maintenance agent */
export const PROMOTION_KINDS = ["backend", "frontend", "maintenanceAgent"] as const
export type PromotionKind = (typeof PROMOTION_KINDS)[number]

/** One application, with the version it runs in the environment it comes from and in the one it goes to */
export interface PromotionRow {
    kind: PromotionKind
    _id: string
    name: string
    slug: string
    from?: string
    to?: string
}

/** The applications picked for the promotion: all those it changes when none is given */
export interface PromotionRequest {
    from?: string
    applications?: { kind: PromotionKind; _id: string }[]
}

type Promotable = { _id: unknown; name: string; slug: string; environmentVersions?: EnvironmentVersion[] | null }

const MODELS = { backend: Backend, frontend: Frontend, maintenanceAgent: MaintenanceAgent } as const

/** The rows of the applications of one kind, between the two environments */
export const promotionRows = (kind: PromotionKind, applications: Promotable[], fromId: unknown, toId: unknown): PromotionRow[] =>
    applications.map(application => ({
        kind,
        _id: String(application._id),
        name: application.name,
        slug: application.slug,
        from: versionIn(application, fromId),
        to: versionIn(application, toId)
    }))

/** Whether the promotion changes the row: an application not running in the source keeps what it runs in the target */
export const promotes = (row: PromotionRow): boolean => Boolean(row.from) && row.from !== row.to

const forbidden = { code: "ENVIRONMENT_PROMOTION_FORBIDDEN", message: "A viewer of the project cannot promote versions" }

/**
 * Brings the versions an environment runs to another, e.g. from development to UAT: each application gets in the
 * target the version it has in the source. It writes the version per environment only; the next deploy of the
 * target applies it.
 */
class EnvironmentPromotionService extends BaseAuthorizedService {
    async preview(toId: string, fromId: string | undefined): Promise<PromotionRow[]> {
        const { from, to } = await this.environments(toId, fromId)
        return this.rows(to.projectId, from._id, to._id)
    }

    async promote(toId: string, request: PromotionRequest | undefined): Promise<PromotionRow[]> {
        const { from, to } = await this.environments(toId, request?.from)
        await this.ensureNotViewer(to.projectId, forbidden)
        const picked = this.picked(request?.applications)
        const rows = (await this.rows(to.projectId, from._id, to._id)).filter(row => promotes(row) && (!picked || picked.has(`${row.kind}:${row._id}`)))
        // An aggregation pipeline is not cast by mongoose: an ObjectId, or the entry of the environment would never match
        const environmentId = new Types.ObjectId(String(to._id))
        const inScope = { projectId: to.projectId, ...(await this.domainScopeFilter(to.projectId)) }
        for (const row of rows) {
            const inTarget = [
                {
                    $set: {
                        environmentVersions: {
                            $concatArrays: [
                                { $filter: { input: { $ifNull: ["$environmentVersions", []] }, cond: { $ne: ["$$this.environmentId", environmentId] } } },
                                [{ environmentId, version: row.from }]
                            ]
                        }
                    }
                }
            ]
            await (MODELS[row.kind] as typeof Backend).updateOne({ _id: toObjectId(row._id), ...inScope }, inTarget)
        }
        return this.rows(to.projectId, from._id, to._id)
    }

    /** The two environments, of the same project, both reachable by the caller */
    private async environments(toId: string, fromId: string | undefined) {
        if (!fromId || typeof fromId !== "string") {
            throw createBusinessException({ code: "ENVIRONMENT_PROMOTION_INVALID", message: "Give the environment the versions come from" })
        }
        if (fromId === toId) {
            throw createBusinessException({ code: "ENVIRONMENT_PROMOTION_INVALID", message: "The versions come from another environment than the one they go to" })
        }
        await this.ensureAccessToEnvironment(toId)
        await this.ensureAccessToEnvironment(fromId)
        const [from, to] = await Promise.all([Environment.findById(toObjectId(fromId)), Environment.findById(toObjectId(toId))])
        if (!from) throw new EnvironmentNotFoundError(fromId)
        if (!to) throw new EnvironmentNotFoundError(toId)
        if (String(from.projectId) !== String(to.projectId)) {
            throw createBusinessException({ code: "ENVIRONMENT_PROMOTION_INVALID", message: "The two environments belong to different projects" })
        }
        return { from, to }
    }

    private picked(applications: PromotionRequest["applications"]): Set<string> | undefined {
        if (applications === undefined) return undefined
        if (!Array.isArray(applications) || applications.some(item => !PROMOTION_KINDS.includes(item?.kind) || typeof item?._id !== "string")) {
            throw createBusinessException({ code: "ENVIRONMENT_PROMOTION_INVALID", message: `applications must be a list of { kind, _id }, kind one of ${PROMOTION_KINDS.join(", ")}` })
        }
        return new Set(applications.map(item => `${item.kind}:${item._id}`))
    }

    /** The applications of the project within the caller's domains, by name */
    private async rows(projectId: Schema.Types.ObjectId | ObjectId, fromId: unknown, toId: unknown): Promise<PromotionRow[]> {
        const inScope = { projectId, ...(await this.domainScopeFilter(projectId)) }
        const fields = { name: 1, slug: 1, environmentVersions: 1 }
        const [backends, frontends, agents] = await Promise.all([
            Backend.find(inScope, fields).sort({ name: 1 }).lean<Promotable[]>(),
            Frontend.find({ ...inScope, kind: FrontendKind.DOCKER }, fields)
                .sort({ name: 1 })
                .lean<Promotable[]>(),
            MaintenanceAgent.find(inScope, fields).sort({ name: 1 }).lean<Promotable[]>()
        ])
        return [...promotionRows("backend", backends, fromId, toId), ...promotionRows("frontend", frontends, fromId, toId), ...promotionRows("maintenanceAgent", agents, fromId, toId)]
    }
}

export default EnvironmentPromotionService
