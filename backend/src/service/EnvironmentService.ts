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
import { isTimeZone, KUBE_GREEN_DEFAULTS, KUBE_GREEN_TIME, KUBE_GREEN_WEEKDAYS, KubeGreenSettings } from "../types/KubeGreen"
import { isLogLevel, LOG_LEVELS } from "../types/RuntimeVariables"
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

/**
 * The data of an environment with its log level as it is saved, in lowercase, when it carries one. Refused when it is
 * none of LOG_LEVELS: the containers would get a LOG_LEVEL their logger does not know.
 */
const withValidLogLevel = <T extends Partial<EnvironmentDTO>>(data: T): T => {
    if (data.logLevel === undefined || data.logLevel === null) return data
    const logLevel = typeof data.logLevel === "string" ? data.logLevel.trim().toLowerCase() : data.logLevel
    if (!isLogLevel(logLevel)) {
        throw createBusinessException({
            code: "ENVIRONMENT_LOG_LEVEL_INVALID",
            message: `"${data.logLevel}" is not a log level: one of ${LOG_LEVELS.join(", ")}`,
            details: { value: String(data.logLevel) }
        })
    }
    return { ...data, logLevel }
}

const invalidKubeGreen = (field: string, value: unknown, message: string) => createBusinessException({ code: "ENVIRONMENT_KUBE_GREEN_INVALID", message, details: { field, value: String(value) } })

/**
 * The kube-green schedule as it is saved: filled in with the defaults, trimmed, the excluded applications without blanks
 * or repeats. Checked only when it is on: kube-green ignores a SleepInfo it cannot parse, and the environment never sleeps.
 */
export const normalizeKubeGreen = (kubeGreen: Partial<KubeGreenSettings>): KubeGreenSettings => {
    const trimmed = (value: unknown, fallback = "") => (typeof value === "string" ? value.trim() : fallback)
    const settings: KubeGreenSettings = {
        enabled: kubeGreen.enabled === true,
        weekdays: trimmed(kubeGreen.weekdays, KUBE_GREEN_DEFAULTS.weekdays).replace(/\s+/g, ""),
        sleepAt: trimmed(kubeGreen.sleepAt, KUBE_GREEN_DEFAULTS.sleepAt),
        wakeUpAt: trimmed(kubeGreen.wakeUpAt),
        timeZone: trimmed(kubeGreen.timeZone, KUBE_GREEN_DEFAULTS.timeZone),
        suspendDeployments: kubeGreen.suspendDeployments ?? KUBE_GREEN_DEFAULTS.suspendDeployments,
        suspendStatefulSets: kubeGreen.suspendStatefulSets ?? KUBE_GREEN_DEFAULTS.suspendStatefulSets,
        suspendCronJobs: kubeGreen.suspendCronJobs ?? KUBE_GREEN_DEFAULTS.suspendCronJobs,
        excludeApplications: [...new Set((Array.isArray(kubeGreen.excludeApplications) ? kubeGreen.excludeApplications : []).map(slug => trimmed(slug)).filter(Boolean))]
    }
    if (!settings.enabled) return settings
    if (!KUBE_GREEN_WEEKDAYS.test(settings.weekdays)) {
        throw invalidKubeGreen("weekdays", settings.weekdays, `"${settings.weekdays}" are not days of the week: 0 (Sunday) to 6, ranges and commas, e.g. 1-5, or * for every day`)
    }
    for (const field of ["sleepAt", "wakeUpAt"] as const) {
        const value = settings[field]
        if ((field === "sleepAt" || value) && !KUBE_GREEN_TIME.test(value ?? "")) throw invalidKubeGreen(field, value, `"${value}" is not a time as HH:MM, e.g. 20:00`)
    }
    if (!isTimeZone(settings.timeZone)) throw invalidKubeGreen("timeZone", settings.timeZone, `"${settings.timeZone}" is not an IANA time zone, e.g. Europe/Rome`)
    return settings
}

/** The data of an environment with its kube-green schedule normalized, when it carries one */
const withNormalizedKubeGreen = <T extends Partial<EnvironmentDTO>>(data: T): T =>
    data.kubeGreen === undefined || data.kubeGreen === null ? data : { ...data, kubeGreen: normalizeKubeGreen(data.kubeGreen) }

/** Everything the data of an environment is checked and normalized for before it is saved */
const normalized = <T extends Partial<EnvironmentDTO>>(data: T, hadIpAllowList = false): T => withNormalizedKubeGreen(withValidLogLevel(withNormalizedIpAllowList(data, hadIpAllowList)))

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
        const environment = new Environment(normalized(environmentData))
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
        const environments = body.map(env => new Environment(normalized(env)))
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
        const updatedEnvironment = await Environment.findOneAndUpdate({ _id: environmentIdObj }, normalized(updateData, Array.isArray(current?.ipAllowList)), {
            new: true
        })

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
     * maintenance agents lose the CPU, the memory and the version they set apart for it.
     */
    private async deleteWithContents(environmentIds: ObjectId[], session?: ClientSession) {
        const deployments = await Deployment.find({ environmentId: { $in: environmentIds } }, null, { session })
        const deploymentIds = deployments.map(deployment => deployment._id)

        await DeploymentToCanaryUsers.deleteMany({ deploymentId: { $in: deploymentIds } }, { session })
        await Deployment.deleteMany({ environmentId: { $in: environmentIds } }, { session })
        await GlobalVariable.deleteMany({ environmentId: { $in: environmentIds } }, { session })
        // The versions the deploy pipelines reported as running there
        await BackendDeployment.deleteMany({ environmentId: { $in: environmentIds } }, { session })
        // The CPU, the memory and the version the applications set apart there
        const inEnvironment = { environmentId: { $in: environmentIds } }
        const setApart = { $or: [{ "environmentResources.environmentId": { $in: environmentIds } }, { "environmentVersions.environmentId": { $in: environmentIds } }] }
        const pull = { $pull: { environmentResources: inEnvironment, environmentVersions: inEnvironment } }
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
