import { FastifyInstance } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import MongoServerService from "../service/MongoServerService"
import { MongoServerDTO } from "../types/MongoServerDTO"
import { CONNECTION_TEST_ROUTE_CONFIG } from "../utils/connectionTest"
import { getProjectIdFromRequest } from "../utils/requestUtils"

export default async function mongoServerController(fastify: FastifyInstance) {
    fastify.get("/mongo-servers", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        const servers = await new MongoServerService(request.databaseUser).getByProjectId(projectId)
        return reply.send(servers.map(server => server.toFrontendObject()))
    })

    fastify.get<{ Params: { mongoServerId: string } }>("/mongo-servers/:mongoServerId", async (request, reply) => {
        const server = await new MongoServerService(request.databaseUser).getById(request.params.mongoServerId)
        return reply.send(server.toFrontendObject())
    })

    fastify.post<{ Body: MongoServerDTO }>("/mongo-servers", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        const server = await new MongoServerService(request.databaseUser).create(projectId, request.body)
        return reply.send(server.toFrontendObject())
    })

    // A server that does not answer is the result of the test, not an error: both answer 200
    fastify.post<{ Body: MongoServerDTO }>("/mongo-servers/test", { config: CONNECTION_TEST_ROUTE_CONFIG }, async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new MongoServerService(request.databaseUser).testConnection(request.body, { projectId }))
    })

    fastify.post<{ Body: MongoServerDTO; Params: { mongoServerId: string } }>("/mongo-servers/:mongoServerId/test", { config: CONNECTION_TEST_ROUTE_CONFIG }, async (request, reply) =>
        reply.send(await new MongoServerService(request.databaseUser).testConnection(request.body, { serverId: request.params.mongoServerId }))
    )

    fastify.put<{ Body: MongoServerDTO; Params: { mongoServerId: string } }>("/mongo-servers/:mongoServerId", async (request, reply) => {
        const server = await new MongoServerService(request.databaseUser).update(request.params.mongoServerId, request.body)
        return reply.send(server.toFrontendObject())
    })

    fastify.delete<{ Params: { mongoServerId: string } }>("/mongo-servers/:mongoServerId", async (request, reply) => {
        await new MongoServerService(request.databaseUser).delete(request.params.mongoServerId)
        return reply.status(204).send()
    })
}
