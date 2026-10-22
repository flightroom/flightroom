import { createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ApiKeyRole } from "../models/ApiKeyModel"
import FrontendDeployment, { IFrontendDeployment } from "../models/FrontendDeploymentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import { toObjectId } from "../utils/mongooseUtils"
import BaseAuthorizedService from "./BaseAuthorizedService"
import { findEnvironmentBySlug, parseRegistration } from "./ServiceDeploymentService"

export type LatestFrontendDeployment = { _id: { frontendId: unknown; environmentId: unknown }; version: string; deployedAt: Date }

/**
 * The latest deploy the pipelines reported for each DOCKER in each environment, one query whatever
 * their number; none at all when there is nothing to look for.
 */
export const findLatestFrontendDeployments = async (frontendIds: unknown[], environmentIds: unknown[]): Promise<LatestFrontendDeployment[]> => {
    if (frontendIds.length === 0 || environmentIds.length === 0) return []
    return await FrontendDeployment.aggregate<LatestFrontendDeployment>([
        { $match: { frontendId: { $in: frontendIds }, environmentId: { $in: environmentIds } } },
        // Follows the index { frontendId, environmentId, deployedAt, _id }, so the first of each group is the latest deploy
        { $sort: { frontendId: 1, environmentId: 1, deployedAt: -1, _id: -1 } },
        { $group: { _id: { frontendId: "$frontendId", environmentId: "$environmentId" }, version: { $first: "$version" }, deployedAt: { $first: "$deployedAt" } } }
    ])
}

export class FrontendDeploymentService extends BaseAuthorizedService {
    /**
     * Called by the deploy pipeline of the customer with the deploy API key once `version` of a DOCKER
     * runs in the environment, exactly as for a service: every call is kept, the latest by date is the
     * version running there. A BUNDLE is deployed by the orchestrator itself, so it is refused.
     */
    async registerWithPermissionCheck(frontendSlug: string, environmentSlug: string, projectId: string, body: unknown, apiKeyRole?: ApiKeyRole): Promise<IFrontendDeployment> {
        if (apiKeyRole !== ApiKeyRole.MANAGER) {
            throw createBusinessException({ code: "FRONTEND_DEPLOYMENT_FORBIDDEN", message: "Reporting a deploy requires an API key with the MANAGER role", statusCode: 403 })
        }
        const registration = parseRegistration(body)

        const projectIdObj = toObjectId(projectId)
        const frontend = await Frontend.findOne({ slug: frontendSlug.trim().toLowerCase(), projectId: projectIdObj })
        if (!frontend) {
            throw new EntityNotFoundError(frontendSlug)
        }
        if (frontend.kind !== FrontendKind.DOCKER) {
            throw createBusinessException({
                code: "BUNDLE_DEPLOYMENT_REGISTRATION_NOT_ALLOWED",
                message: `"${frontend.slug}" is a BUNDLE frontend: the orchestrator deploys it, there is no deploy to report`
            })
        }

        const environment = await findEnvironmentBySlug(projectIdObj, environmentSlug)

        return await FrontendDeployment.create({
            frontendId: frontend._id,
            environmentId: environment._id,
            version: registration.version,
            ...(registration.image && { image: registration.image }),
            ...(registration.commitSha && { commitSha: registration.commitSha })
        })
    }
}

export default FrontendDeploymentService
