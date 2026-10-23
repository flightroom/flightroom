import { FastifyInstance, FastifyRequest } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import AiMissionService, { AiMissionCreateInput } from "../service/aiChange/AiMissionService"
import { LLM_EFFORTS } from "../service/llm"
import AuthenticationMethod from "../types/AuthenticationMethod"
import { getProjectIdFromRequest } from "../utils/requestUtils"

// Beyond 200 repositories the service answers AI_MISSION_TOO_MANY_REPOSITORIES, which the console explains; this only bounds the body.
const ids = { type: "array", maxItems: 1_000, items: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } }

const createBodySchema = {
    type: "object",
    required: ["prompt", "mode"],
    additionalProperties: false,
    properties: {
        prompt: { type: "string", minLength: 1, maxLength: 8_000 },
        mode: { type: "string", enum: ["global", "perRepository"] },
        all: { type: "boolean" },
        frontendIds: ids,
        serviceIds: ids,
        concurrency: { type: "integer", minimum: 1, maximum: 10 },
        effort: { type: "string", enum: LLM_EFFORTS },
        // An id of the organization's AIs, or `system`
        aiModelId: { type: "string", minLength: 1, maxLength: 64 }
    }
}

const listQuerySchema = {
    type: "object",
    additionalProperties: false,
    properties: { active: { type: "string" } }
}

const idParamsSchema = {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } }
}

const projectIdOf = (request: FastifyRequest) => {
    const projectId = getProjectIdFromRequest(request)
    if (!projectId) throw new ProjectHeaderNotFoundError()
    return projectId
}

/**
 * AI missions: one prompt over many repositories of a project, run as AI jobs batch after batch.
 *
 * Starting a mission answers at once with its first jobs started; the console polls it. Console
 * sessions only, like the jobs it starts.
 */
export default async function aiMissionController(fastify: FastifyInstance) {
    const service = (request: FastifyRequest) => new AiMissionService(request.databaseUser, fastify.config)
    const config = { authMethod: AuthenticationMethod.JWT }

    // A mission runs paid agents for a long while, and applying it pushes to every repository: the assistant's per-user ceiling.
    const rateLimit = {
        max: fastify.config.ASSISTANT_RATE_LIMIT_MAX,
        timeWindow: "1 minute",
        hook: "preHandler" as const,
        keyGenerator: (request: FastifyRequest) => request.databaseUser?._id?.toString() ?? request.ip
    }

    fastify.post<{ Body: AiMissionCreateInput }>("/ai-missions", { schema: { body: createBodySchema }, config: { ...config, rateLimit } }, async (request, reply) =>
        reply.status(202).send(await service(request).create(projectIdOf(request), request.body))
    )

    // Everyone's missions, not only the caller's: the fleet page shows what the project's agents are doing.
    fastify.get<{ Querystring: { active?: string } }>("/ai-missions", { schema: { querystring: listQuerySchema }, config }, async (request, reply) =>
        reply.send(await service(request).list(projectIdOf(request), ["true", "1"].includes(request.query.active ?? "")))
    )

    // What the caller may start a mission on, by the same rule the start checks: the console lists these.
    fastify.get("/ai-missions/repositories", { config }, async (request, reply) => reply.send(await service(request).repositories(projectIdOf(request))))

    fastify.get<{ Params: { id: string } }>("/ai-missions/:id", { schema: { params: idParamsSchema }, config }, async (request, reply) => reply.send(await service(request).get(request.params.id)))

    // Not rate limited: stopping must always be possible.
    fastify.post<{ Params: { id: string } }>("/ai-missions/:id/stop", { schema: { params: idParamsSchema }, config }, async (request, reply) =>
        reply.send(await service(request).stop(request.params.id))
    )

    // Answers once every proposal is claimed: the pull requests are opened in the background.
    fastify.post<{ Params: { id: string } }>("/ai-missions/:id/apply", { schema: { params: idParamsSchema }, config: { ...config, rateLimit } }, async (request, reply) =>
        reply.status(202).send(await service(request).apply(request.params.id))
    )
}
