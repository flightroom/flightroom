import { FastifyInstance, FastifyRequest } from "fastify"
import { ArgoCdLogsInput } from "../service/ArgoCdService"
import MaintenanceAgentRuntimeService from "../service/MaintenanceAgentRuntimeService"
import AuthenticationMethod from "../types/AuthenticationMethod"

/** Called by the container of a maintenance agent, with the token of its environment as bearer */
const runtime = (request: FastifyRequest) => new MaintenanceAgentRuntimeService(request.maintenanceAgent!)

const options = { config: { authMethod: AuthenticationMethod.MAINTENANCE_AGENT } }

export default async function maintenanceAgentRuntimeController(fastify: FastifyInstance) {
    // The backends and frontends the agent maintains, with what it may read of each
    fastify.get("/maintenance-agent-runtime/targets", options, async (request, reply) => {
        return reply.send(await runtime(request).targets())
    })

    // The pods a target runs in the environment of the agent
    fastify.get<{ Params: { slug: string } }>("/maintenance-agent-runtime/targets/:slug/pods", options, async (request, reply) => {
        return reply.send(await runtime(request).pods(request.params.slug))
    })

    // The last lines one of those pods wrote
    fastify.get<{ Params: { slug: string }; Querystring: ArgoCdLogsInput }>("/maintenance-agent-runtime/targets/:slug/logs", options, async (request, reply) => {
        return reply.send(await runtime(request).logs(request.params.slug, request.query))
    })

    // The latest builds of a target, from its CI provider
    fastify.get<{ Params: { slug: string } }>("/maintenance-agent-runtime/targets/:slug/builds", options, async (request, reply) => {
        return reply.send(await runtime(request).builds(request.params.slug))
    })

    // The logs of the failed jobs of one of those builds
    fastify.get<{ Params: { slug: string; runId: string } }>("/maintenance-agent-runtime/targets/:slug/builds/:runId/logs", options, async (request, reply) => {
        return reply.send(await runtime(request).buildLogs(request.params.slug, request.params.runId))
    })
}
