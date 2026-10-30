import { ClientSession, ObjectId, Schema } from "mongoose"
import { createBusinessException } from "../errors/BusinessException"
import { EnvironmentNotFoundError } from "../errors/EnvironmentNotFoundError"
import BackendDeployment from "../models/BackendDeploymentModel"
import Backend from "../models/BackendModel"
import Deployment from "../models/DeploymentModel"
import DeploymentToCanaryUsers from "../models/DeploymentsToCanaryUsersModel"
import Environment, { IEnvironment } from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import GlobalVariable from "../models/GlobalVariableModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import { EnvironmentDTO } from "../types/EnvironmentDTO"
import { IP_ALLOW_LIST_MAX, isIpRange } from "../types/Exposure"
import { toObjectId } from "../utils/mongooseUtils"
import { runInTransaction } from "../utils/runInTransaction"
import BaseAuthorizedService from "./BaseAuthorizedService"

/**
 * The allow list as it is saved: trimmed, without blanks or repeats. Refused before it reaches the Gateway: Traefik
 * drops a Middleware with a range it cannot parse, and every route through it with it.
 */
export const normalizeIpAllowList = (ipAllowList: unknown): string[] => {
    if (ipAllowList === null || ipAllowList === undefined) return []
    if (!Array.isArray(ipAllowList)) {
        throw createBusinessException({ code: "ENVIRONMENT_IP_ALLOWLIST_INVALID", message: "The IP allow list must be a list of addresses and CIDR ranges", details: { value: String(ipAllowList) } })
    }
    const ranges = [...new Set(ipAllowList.map(range => (typeof range === "string" ? range.trim() : String(range))).filter(Boolean))]
    const invalid = ranges.find(range => !isIpRange(range))
    if (invalid !== undefined) {
        throw createBusinessException({
            code: "ENVIRONMENT_IP_ALLOWLIST_INVALID",
            message: `"${invalid}" is neither an IP address nor a CIDR range, e.g. 203.0.113.7 or 203.0.113.0/24`,
            details: { value: invalid }
        })
    }
    if (ranges.length > IP_ALLOW_LIST_MAX) {
        throw createBusinessException({
            code: "ENVIRONMENT_IP_ALLOWLIST_TOO_LONG",
            message: `An environment allows at most ${IP_ALLOW_LIST_MAX} addresses and ranges`,
            details: { value: String(IP_ALLOW_LIST_MAX) }
        })
    }
    return ranges
}

/**
 * The data of an environment with its allow list normalized, when it carries one. An empty list is kept only on an
 * environment that has had one: its Middleware stays, open to every address, as the routes of the applications a
 * scoped deploy left alone still go through it. On any other, it is left out, and the environment gets no Middleware.
 */
const withNormalizedIpAllowList = <T extends Partial<EnvironmentDTO>>(data: T, hadIpAllowList = false): T => {
    if (data.ipAllowList === undefined) return data
    const ipAllowList = normalizeIpAllowList(data.ipAllowList)
    if (ipAllowList.length > 0 || hadIpAllowList) return { ...data, ipAllowList }
    const { ipAllowList: _left, ...rest } = data
    return rest as T
}

class EnvironmentService extends BaseAuthorizedService {
    async getByProjectId(projectId: string) {
        await this.ensureAccessToProject(projectId)
        const projectIdObj = toObjectId(projectId)
        return Environment.find({ projectId: projectIdObj }).sort({ order: 1, createdAt: 1 })
    }

    async getById(id: string | Schema.Types.ObjectId, session?: ClientSession) {
        await this.ensureAccessToEnvironment(id, session)
        return await Environment.findOne({ _id: toObjectId(id) }).session(session ?? null)
    }

    async getMaxOrderByProjectId(projectId: Schema.Types.ObjectId): Promise<number> {
        return (await Environment.findOne({ projectId: toObjectId(projectId) }).sort({ order: -1 }))?.order ?? 0
    }

    async create(environmentData: EnvironmentDTO, projectId: string): Promise<IEnvironment> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        // Every domain is deployed to the environments: only those reaching the whole project change them
        await this.ensureWholeProject(projectIdObj)
        const environment = new Environment(withNormalizedIpAllowList(environmentData))
        environment.projectId = projectIdObj
        if (environment.order === undefined || environment.order === null) {
            environment.order = (await this.getMaxOrderByProjectId(projectIdObj)) + 1
        }
        return environment.save()
    }

    async createBulk(body: EnvironmentDTO[], projectId: string) {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        await this.ensureWholeProject(projectIdObj)
        const environments = body.map(env => new Environment(withNormalizedIpAllowList(env)))
        let maxOrder = (await this.getMaxOrderByProjectId(projectIdObj)) + 1
        environments.forEach(env => {
            env.projectId = projectIdObj
            if (env.order === undefined || env.order === null) {
                env.order = maxOrder
                maxOrder++
            }
        })
        return Environment.insertMany(environments)
    }

    async update(environmentId: string | ObjectId, updateData: EnvironmentDTO) {
        await this.ensureAccessToEnvironment(environmentId)
        await this.ensureWholeProjectOfEnvironment(environmentId)
        const environmentIdObj = toObjectId(environmentId)
        const current = updateData.ipAllowList === undefined ? null : await Environment.findById(environmentIdObj, { ipAllowList: 1 })
        const updatedEnvironment = await Environment.findOneAndUpdate({ _id: environmentIdObj }, withNormalizedIpAllowList(updateData, Array.isArray(current?.ipAllowList)), { new: true })

        if (!updatedEnvironment) {
            throw new EnvironmentNotFoundError(environmentIdObj.toString())
        }
        return updatedEnvironment
    }

    /**
     * Persists a new ordering for the environments of a project.
     * The position of each id inside the array becomes the environment order.
     * @param projectId The project owning the environments
     * @param ids The environment ids, already sorted as they have to be displayed
     */
    async updateOrder(projectId: string, ids: (string | ObjectId)[]): Promise<IEnvironment[]> {
        await this.ensureAccessToProject(projectId)
        await this.ensureWholeProject(projectId)
        const projectIdObj = toObjectId(projectId)

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            throw new Error("Ids array is required")
        }

        const idsObj = ids.map(id => toObjectId(id))
        const uniqueIds = new Set(idsObj.map(id => id.toString()))
        if (uniqueIds.size !== idsObj.length) {
            throw new Error("Ids array cannot contain duplicates")
        }

        const environments = await Environment.find({ projectId: projectIdObj }).select("_id")
        const projectEnvironmentIds = new Set(environments.map(environment => environment._id.toString()))
        const notInProject = idsObj.find(id => !projectEnvironmentIds.has(id.toString()))
        if (notInProject) {
            throw new EnvironmentNotFoundError(notInProject.toString())
        }

        await Environment.bulkWrite(
            idsObj.map((id, index) => ({
                updateOne: {
                    filter: { _id: id, projectId: projectIdObj },
                    update: { $set: { order: index } }
                }
            }))
        )

        return this.getByProjectId(projectId)
    }

    /**
     * Removes everything that belongs to the given environments, then the environments.
     *
     * An environment owns its deployments and its global variables, and each deployment owns the
     * canary enrolments recorded against it, so the enrolments have to go first: once the
     * deployments are gone there is nothing left to find them by. The backends, frontends and
     * maintenance agents lose the CPU and memory they set apart for it.
     */
    private async deleteWithContents(environmentIds: ObjectId[], session?: ClientSession) {
        const deployments = await Deployment.find({ environmentId: { $in: environmentIds } }, null, { session })
        const deploymentIds = deployments.map(deployment => deployment._id)

        await DeploymentToCanaryUsers.deleteMany({ deploymentId: { $in: deploymentIds } }, { session })
        await Deployment.deleteMany({ environmentId: { $in: environmentIds } }, { session })
        await GlobalVariable.deleteMany({ environmentId: { $in: environmentIds } }, { session })
        // The versions the deploy pipelines reported as running there
        await BackendDeployment.deleteMany({ environmentId: { $in: environmentIds } }, { session })
        // The CPU and memory the applications set apart there
        const setApart = { "environmentResources.environmentId": { $in: environmentIds } }
        const pull = { $pull: { environmentResources: { environmentId: { $in: environmentIds } } } }
        await Backend.updateMany(setApart, pull, { session })
        await Frontend.updateMany(setApart, pull, { session })
        await MaintenanceAgent.updateMany(setApart, pull, { session })

        return Environment.deleteMany({ _id: { $in: environmentIds } }, { session })
    }

    async deleteSingle(environmentId: string | ObjectId) {
        await this.ensureAccessToEnvironment(environmentId)
        await this.ensureWholeProjectOfEnvironment(environmentId)
        const environmentIdObj = toObjectId(environmentId)

        await runInTransaction(async session => {
            const environment = await Environment.findById(environmentIdObj).session(session ?? null)
            if (!environment) {
                throw new EnvironmentNotFoundError(environmentIdObj.toString())
            }

            await this.deleteWithContents([environmentIdObj], session)
        })
    }

    // Delete multiple environments
    async deleteMultiple(ids: (string | ObjectId)[]) {
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            throw new Error("Ids array is required")
        }

        const idsObj = await Promise.all(
            ids.map(async id => {
                await this.ensureAccessToEnvironment(id)
                await this.ensureWholeProjectOfEnvironment(id)
                return toObjectId(id)
            })
        )

        return runInTransaction(session => this.deleteWithContents(idsObj, session))
    }
}

export default EnvironmentService
