import { FastifyInstance, FastifyRequest } from "fastify"
import AiUsageService, { AI_USAGE_PERIODS, AiUsagePeriod } from "../service/AiUsageService"
import AuthenticationMethod from "../types/AuthenticationMethod"

const OBJECT_ID = "^[a-fA-F0-9]{24}$"

const idParamsSchema = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: OBJECT_ID } } }
const projectParamsSchema = { type: "object", required: ["projectId"], properties: { projectId: { type: "string", pattern: OBJECT_ID } } }
const organizationParamsSchema = { type: "object", required: ["organizationId"], properties: { organizationId: { type: "string", pattern: OBJECT_ID } } }

/** The last 30 days unless asked otherwise: what the console opens on. */
const periodQuerySchema = { type: "object", additionalProperties: false, properties: { period: { type: "string", enum: [...AI_USAGE_PERIODS], default: "30d" } } }

type PeriodQuery = { Querystring: { period: AiUsagePeriod } }

/**
 * The AI tokens spent over a period, by Edit with AI jobs and the assistant: of a domain, a frontend, a backend,
 * a project, an organization. Console sessions only, as the AI features they count.
 */
export default async function aiUsageController(fastify: FastifyInstance) {
    const service = (request: FastifyRequest) => new AiUsageService(request.databaseUser)
    const config = { authMethod: AuthenticationMethod.JWT }

    fastify.get<PeriodQuery & { Params: { id: string } }>("/domains/:id/ai-usage", { schema: { params: idParamsSchema, querystring: periodQuerySchema }, config }, async (request, reply) =>
        reply.send(await service(request).forDomain(request.params.id, request.query.period))
    )

    fastify.get<PeriodQuery & { Params: { id: string } }>("/frontends/:id/ai-usage", { schema: { params: idParamsSchema, querystring: periodQuerySchema }, config }, async (request, reply) =>
        reply.send(await service(request).forFrontend(request.params.id, request.query.period))
    )

    fastify.get<PeriodQuery & { Params: { id: string } }>("/backends/:id/ai-usage", { schema: { params: idParamsSchema, querystring: periodQuerySchema }, config }, async (request, reply) =>
        reply.send(await service(request).forBackend(request.params.id, request.query.period))
    )

    fastify.get<PeriodQuery & { Params: { projectId: string } }>(
        "/projects/:projectId/ai-usage",
        { schema: { params: projectParamsSchema, querystring: periodQuerySchema }, config },
        async (request, reply) => reply.send(await service(request).forProject(request.params.projectId, request.query.period))
    )

    fastify.get<PeriodQuery & { Params: { organizationId: string } }>(
        "/organizations/:organizationId/ai-usage",
        { schema: { params: organizationParamsSchema, querystring: periodQuerySchema }, config },
        async (request, reply) => reply.send(await service(request).forOrganization(request.params.organizationId, request.query.period))
    )
}
