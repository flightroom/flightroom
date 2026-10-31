import { ObjectId, Schema, Types } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EnvironmentNotFoundError } from "../errors/EnvironmentNotFoundError"
import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import { CHART_REPLICAS_DEFAULT, ContainerResourcesByEnvironment, isReplicaCount, MAX_REPLICAS, resourcesIn } from "../types/ContainerResources"
import { EnvironmentVersion, versionIn } from "../types/EnvironmentVersions"
import { MaintenanceAgentKind } from "../types/MaintenanceAgent"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService from "./BaseAuthorizedService"
import { PromotionKind } from "./EnvironmentPromotionService"

/** One container the environment runs, with the pods it runs there */
export interface ReplicasRow {
    kind: PromotionKind
    _id: string
    name: string
    slug: string
    replicas: number
}

type Scalable = ContainerResourcesByEnvironment & { _id: unknown; name: string; slug: string; environmentVersions?: EnvironmentVersion[] | null }

const MODELS = { backend: Backend, frontend: Frontend, maintenanceAgent: MaintenanceAgent } as const

/** The rows of the containers of one kind that run in the environment: one without a version there is not deployed to it */
export const replicasRows = (kind: PromotionKind, applications: Scalable[], environmentId: unknown): ReplicasRow[] =>
    applications
        .filter(application => versionIn(application, environmentId))
        .map(application => ({
            kind,
            _id: String(application._id),
            name: application.name,
            slug: application.slug,
            replicas: resourcesIn(application, environmentId).replicas ?? CHART_REPLICAS_DEFAULT
        }))

/**
 * The pipeline that sets the replicas of one environment apart: its entry of environmentResources gets them, its CPU and
 * memory kept, or a new entry with the replicas only when it has none. An aggregation pipeline is not cast by mongoose:
 * the id goes as an ObjectId, or the entry of the environment would never match
 */
export const replicasUpdate = (environmentId: Types.ObjectId, replicas: number) => [
    {
        $set: {
            environmentResources: {
                $cond: [
                    { $in: [environmentId, { $ifNull: ["$environmentResources.environmentId", []] }] },
                    {
                        $map: {
                            input: "$environmentResources",
                            in: { $cond: [{ $eq: ["$$this.environmentId", environmentId] }, { $mergeObjects: ["$$this", { replicas }] }, "$$this"] }
                        }
                    },
                    { $concatArrays: [{ $ifNull: ["$environmentResources", []] }, [{ environmentId, replicas }]] }
                ]
            }
        }
    }
]

const forbidden = { code: "ENVIRONMENT_REPLICAS_FORBIDDEN", message: "A viewer of the project cannot set the replicas" }

/**
 * Sets the pods of every container an environment runs at once, e.g. 0 to stop UAT for the night: each backend, DOCKER
 * frontend and maintenance agent of kind CONTAINER with a version there gets them in that environment. A JOB runs no pod.
 * It writes the replicas per environment only; the next deploy of the environment applies them.
 */
class EnvironmentReplicasService extends BaseAuthorizedService {
    async preview(environmentId: string): Promise<ReplicasRow[]> {
        const environment = await this.environment(environmentId)
        return this.rows(environment.projectId, environment._id)
    }

    async scale(environmentId: string, request: { replicas?: unknown } | undefined): Promise<ReplicasRow[]> {
        const replicas = request?.replicas
        if (!isReplicaCount(replicas)) {
            throw createBusinessException({
                code: "ENVIRONMENT_REPLICAS_INVALID",
                message: `replicas "${String(replicas)}" is not a whole number from 0 to ${MAX_REPLICAS}`,
                details: { value: String(replicas) }
            })
        }
        const environment = await this.environment(environmentId)
        await this.ensureNotViewer(environment.projectId, forbidden)
        const inScope = { projectId: environment.projectId, ...(await this.domainScopeFilter(environment.projectId)) }
        const update = replicasUpdate(new Types.ObjectId(String(environment._id)), replicas)
        for (const row of await this.rows(environment.projectId, environment._id)) {
            await (MODELS[row.kind] as typeof Backend).updateOne({ _id: toObjectId(row._id), ...inScope }, update)
        }
        return this.rows(environment.projectId, environment._id)
    }

    private async environment(environmentId: string) {
        await this.ensureAccessToEnvironment(environmentId)
        const environment = await Environment.findById(toObjectId(environmentId))
        if (!environment) throw new EnvironmentNotFoundError(environmentId)
        return environment
    }

    /** The containers of the project within the caller's domains that run in the environment, by name */
    private async rows(projectId: Schema.Types.ObjectId | ObjectId, environmentId: unknown): Promise<ReplicasRow[]> {
        const inScope = { projectId, ...(await this.domainScopeFilter(projectId)) }
        const fields = { name: 1, slug: 1, environmentVersions: 1, replicas: 1, environmentResources: 1 }
        const [backends, frontends, agents] = await Promise.all([
            Backend.find(inScope, fields).sort({ name: 1 }).lean<Scalable[]>(),
            Frontend.find({ ...inScope, kind: FrontendKind.DOCKER }, fields)
                .sort({ name: 1 })
                .lean<Scalable[]>(),
            MaintenanceAgent.find({ ...inScope, kind: MaintenanceAgentKind.CONTAINER }, fields)
                .sort({ name: 1 })
                .lean<Scalable[]>()
        ])
        return [...replicasRows("backend", backends, environmentId), ...replicasRows("frontend", frontends, environmentId), ...replicasRows("maintenanceAgent", agents, environmentId)]
    }
}

export default EnvironmentReplicasService
