import { Schema } from "mongoose"
import { fastify } from "../.."
import { createBusinessException } from "../../errors/BusinessException"
import Project, { IProjectArgoCd } from "../../models/ProjectModel"
import { toErrorMessage } from "../RepositoryFileService"

/** An initialization that has not ended after this long is taken for one that died: the next one may start */
export const LEASE_MS = 5 * 60 * 1000

/** The lease of a run: the time it was last renewed, which every save of the run matches on */
export interface Lease {
    at: Date
}

/** One initialization of a project at a time: two would rotate the deploy tokens under each other */
export const acquire = async (projectId: Schema.Types.ObjectId, lease: Lease) => {
    const leased = await Project.findOneAndUpdate(
        { _id: projectId, "argoCd.initializingAt": { $not: { $gt: new Date(lease.at.getTime() - LEASE_MS) } } },
        { $set: { "argoCd.initializingAt": lease.at } },
        { projection: { _id: 1 } }
    )
    if (!leased) {
        throw createBusinessException({ code: "ARGOCD_BUSY", message: "Argo CD is being initialized for this project already: try again in a moment", statusCode: 409 })
    }
}

export const release = async (projectId: Schema.Types.ObjectId, lease: Lease) => {
    await Project.updateOne({ _id: projectId, "argoCd.initializingAt": lease.at }, { $unset: { "argoCd.initializingAt": 1 } }).catch(error =>
        fastify.log.error({ error: toErrorMessage(error) }, "Argo CD initialization lease not released")
    )
}

/**
 * Saves only while the run still holds its lease, and renews it. A run that took longer than the lease lets
 * another one start, and must not overwrite what that one stores: it stops instead. A copy goes to the
 * update, as the plugin encrypts the credentials in place.
 */
export const save = async (projectId: Schema.Types.ObjectId, argoCd: IProjectArgoCd, lease: Lease) => {
    const renewed = new Date()
    const { matchedCount } = await Project.updateOne({ _id: projectId, "argoCd.initializingAt": lease.at }, { $set: { argoCd: structuredClone({ ...argoCd, initializingAt: renewed }) } })
    if (matchedCount === 0) {
        throw createBusinessException({
            code: "ARGOCD_LEASE_LOST",
            message: "Another initialization of Argo CD took over this project while this one ran: check its outcome, and initialize again if needed",
            statusCode: 409
        })
    }
    lease.at = renewed
}
