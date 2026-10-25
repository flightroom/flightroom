import { FastifyInstance } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import StandalonePreviewService, { StandalonePreviewInput } from "../service/aiChange/StandalonePreviewService"
import AuthenticationMethod from "../types/AuthenticationMethod"
import { getProjectIdFromRequest } from "../utils/requestUtils"

const bodySchema = {
    type: "object",
    required: ["kind", "id"],
    additionalProperties: false,
    properties: {
        kind: { type: "string", enum: ["frontend", "domain"] },
        id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" }
    }
}

export default async function livePreviewController(fastify: FastifyInstance) {
    fastify.post<{ Body: StandalonePreviewInput }>(
        "/live-previews",
        {
            schema: { body: bodySchema },
            config: {
                authMethod: AuthenticationMethod.JWT,
                rateLimit: {
                    max: 5,
                    timeWindow: "1 minute",
                    hook: "preHandler" as const,
                    keyGenerator: request => request.databaseUser?._id?.toString() ?? request.ip
                }
            }
        },
        async (request, reply) => {
            const projectId = getProjectIdFromRequest(request)
            if (!projectId) throw new ProjectHeaderNotFoundError()
            return reply.send(await new StandalonePreviewService(request.databaseUser, fastify.config).start(projectId, request.body))
        }
    )
}
