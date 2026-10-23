import { FastifyInstance } from "fastify"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import MaintenanceAgentService from "../service/MaintenanceAgentService"
import { MaintenanceAgentDTO } from "../types/MaintenanceAgent"
import { getProjectIdFromRequest } from "../utils/requestUtils"

export default async function maintenanceAgentController(fastify: FastifyInstance) {
    fastify.get("/maintenance-agents", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new MaintenanceAgentService(request.databaseUser).getByProjectId(projectId))
    })

    fastify.get<{ Params: { id: string } }>("/maintenance-agents/:id", async (request, reply) => {
        const agent = await new MaintenanceAgentService(request.databaseUser).getById(request.params.id)
        if (!agent) {
            throw new EntityNotFoundError(request.params.id)
        }
        return reply.send(agent)
    })

    fastify.get<{ Params: { id: string } }>("/maintenance-agents/:id/versions", async (request, reply) => {
        return reply.send(await new MaintenanceAgentService(request.databaseUser).getVersionsById(request.params.id))
    })

    fastify.get<{ Params: { id: string } }>("/maintenance-agents/:id/runs", async (request, reply) => {
        return reply.send(await new MaintenanceAgentService(request.databaseUser).getRuns(request.params.id))
    })

    fastify.post<{ Body: MaintenanceAgentDTO }>("/maintenance-agents", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new MaintenanceAgentService(request.databaseUser).create(request.body, projectId))
    })

    fastify.put<{ Params: { id: string }; Body: MaintenanceAgentDTO }>("/maintenance-agents/:id", async (request, reply) => {
        return reply.send(await new MaintenanceAgentService(request.databaseUser).update(request.params.id, request.body))
    })

    fastify.delete<{ Params: { id: string } }>("/maintenance-agents/:id", async (request, reply) => {
        return reply.send(await new MaintenanceAgentService(request.databaseUser).delete(request.params.id))
    })

    fastify.post<{ Params: { id: string }; Body: { version: string; branch?: string } }>("/maintenance-agents/:id/build", async (request, reply) => {
        return reply.send(await new MaintenanceAgentService(request.databaseUser).build(request.params.id, request.body?.version, request.body?.branch))
    })

    // Play: runs it now in one environment, through Argo CD
    fastify.post<{ Params: { id: string }; Body: { environmentId: string } }>("/maintenance-agents/:id/run", async (request, reply) => {
        return reply.send(await new MaintenanceAgentService(request.databaseUser).run(request.params.id, request.body?.environmentId))
    })
}
