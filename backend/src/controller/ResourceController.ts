import { FastifyInstance } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import ResourceService from "../service/ResourceService"
import ResourceDTO from "../types/ResourceDTO"
import { getProjectIdFromRequest } from "../utils/requestUtils"

/**
 * Past the default 1 MiB, which a pasted OpenAPI document alone can exceed: up to 5 MiB of it, and
 * escaped into a JSON body a document made of quotes and newlines can come close to twice that.
 */
const RESOURCE_BODY_LIMIT = 12 * 1024 * 1024

export default async function resourceController(fastify: FastifyInstance) {
    fastify.get("/resources", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new ResourceService(request.databaseUser).getByProjectId(projectId))
    })

    // Registered as a static path, so Fastify routes it here rather than to /resources/:id
    fastify.get("/resources/catalog", async (request, reply) => {
        return reply.send(new ResourceService(request.databaseUser).catalog())
    })

    fastify.get<{ Params: { id: string } }>("/resources/:id", async (request, reply) => {
        return reply.send(await new ResourceService(request.databaseUser).getById(request.params.id))
    })

    fastify.get<{ Params: { id: string } }>("/resources/:id/api-spec", async (request, reply) => {
        return reply.type("text/plain; charset=utf-8").send(await new ResourceService(request.databaseUser).getApiSpec(request.params.id))
    })

    fastify.post<{ Body: ResourceDTO }>("/resources", { bodyLimit: RESOURCE_BODY_LIMIT }, async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new ResourceService(request.databaseUser).create(request.body, projectId))
    })

    fastify.put<{ Params: { id: string }; Body: ResourceDTO }>("/resources/:id", { bodyLimit: RESOURCE_BODY_LIMIT }, async (request, reply) => {
        return reply.send(await new ResourceService(request.databaseUser).update(request.params.id, request.body))
    })

    fastify.delete<{ Params: { id: string } }>("/resources/:id", async (request, reply) => {
        return reply.send(await new ResourceService(request.databaseUser).delete(request.params.id))
    })
}
