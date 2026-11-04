import { FastifyInstance, FastifyRequest } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import ProvisionedDatabaseService from "../service/ProvisionedDatabaseService"
import { ProvisionedDatabaseCreateDTO, ProvisionedDatabaseLinkDTO, reachesServers } from "../types/MongoServerDTO"
import { CONNECTION_TEST_ROUTE_CONFIG } from "../utils/connectionTest"
import { getProjectIdFromRequest } from "../utils/requestUtils"

/** Each of these reaches the server of the database: they share the budget of the connection tests */
const EXTERNAL = { config: CONNECTION_TEST_ROUTE_CONFIG }
/** A removal "from Flightroom only" reaches no server: it is not counted */
const REMOVAL = {
    config: {
        ...CONNECTION_TEST_ROUTE_CONFIG,
        rateLimit: { ...CONNECTION_TEST_ROUTE_CONFIG.rateLimit, allowList: (request: FastifyRequest) => !reachesServers((request.query as { mode?: string })?.mode) }
    }
}

export default async function provisionedDatabaseController(fastify: FastifyInstance) {
    fastify.get<{ Params: { mongoServerId: string } }>("/mongo-servers/:mongoServerId/databases", async (request, reply) => {
        const databases = await new ProvisionedDatabaseService(request.databaseUser).getByServerId(request.params.mongoServerId)
        return reply.send(databases.map(database => database.toFrontendObject()))
    })

    fastify.post<{ Body: ProvisionedDatabaseCreateDTO; Params: { mongoServerId: string } }>("/mongo-servers/:mongoServerId/databases", EXTERNAL, async (request, reply) => {
        const database = await new ProvisionedDatabaseService(request.databaseUser).create(request.params.mongoServerId, request.body)
        return reply.send(database.toFrontendObject())
    })

    // Every database of the project, whatever its server: what the resources read to say which of their environments one feeds
    fastify.get("/provisioned-databases", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        const databases = await new ProvisionedDatabaseService(request.databaseUser).getByProjectId(projectId)
        return reply.send(databases.map(database => database.toFrontendObject()))
    })

    fastify.put<{ Body: ProvisionedDatabaseLinkDTO; Params: { provisionedDatabaseId: string } }>("/provisioned-databases/:provisionedDatabaseId/link", EXTERNAL, async (request, reply) => {
        const database = await new ProvisionedDatabaseService(request.databaseUser).link(request.params.provisionedDatabaseId, request.body)
        return reply.send(database.toFrontendObject())
    })

    fastify.delete<{ Params: { provisionedDatabaseId: string } }>("/provisioned-databases/:provisionedDatabaseId/link", async (request, reply) => {
        const database = await new ProvisionedDatabaseService(request.databaseUser).unlink(request.params.provisionedDatabaseId)
        return reply.send(database.toFrontendObject())
    })

    // The mode is in the query, with the name typed again for a drop: a DELETE carries no body through every proxy
    fastify.delete<{ Params: { provisionedDatabaseId: string }; Querystring: { mode?: string; confirmName?: string } }>(
        "/provisioned-databases/:provisionedDatabaseId",
        REMOVAL,
        async (request, reply) => {
            await new ProvisionedDatabaseService(request.databaseUser).delete(request.params.provisionedDatabaseId, request.query.mode, request.query.confirmName)
            return reply.status(204).send()
        }
    )
}
