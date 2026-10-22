import { FastifyInstance } from "fastify"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import DomainReleaseService from "../service/DomainReleaseService"
import DomainService from "../service/DomainService"
import DomainDTO, { DomainMembersDTO } from "../types/DomainDTO"
import { getProjectIdFromRequest } from "../utils/requestUtils"

export default async function domainController(fastify: FastifyInstance) {
    fastify.get("/domains", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new DomainService(request.databaseUser).getByProjectId(projectId))
    })

    fastify.get<{ Params: { id: string } }>("/domains/:id", async (request, reply) => {
        const domain = await new DomainService(request.databaseUser).getById(request.params.id)
        if (!domain) {
            throw new EntityNotFoundError(request.params.id)
        }
        return reply.send(domain)
    })

    fastify.post<{ Body: DomainDTO }>("/domains", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new DomainService(request.databaseUser).create(request.body, projectId))
    })

    fastify.put<{ Params: { id: string }; Body: DomainDTO }>("/domains/:id", async (request, reply) => {
        return reply.send(await new DomainService(request.databaseUser).update(request.params.id, request.body))
    })

    fastify.post<{ Params: { id: string }; Body: DomainMembersDTO }>("/domains/:id/members", async (request, reply) => {
        return reply.send(await new DomainService(request.databaseUser).addMembers(request.params.id, request.body))
    })

    // Tags the repository of every member with the same version: each tag starts the pipeline of its repository
    fastify.post<{ Params: { id: string }; Body: { version: string; ref?: string } }>("/domains/:id/build", async (request, reply) => {
        return reply.send(await new DomainService(request.databaseUser).build(request.params.id, request.body?.version, request.body?.ref))
    })

    // Builds the domain now; the release tick then waits for the CI, sets the version on its members and deploys it
    fastify.post<{ Params: { id: string }; Body: { version: string; ref?: string; environmentId: string } }>("/domains/:id/build-and-deploy", async (request, reply) => {
        return reply.send(await new DomainReleaseService(request.databaseUser).start(request.params.id, request.body?.version, request.body?.ref, request.body?.environmentId))
    })

    fastify.get<{ Params: { id: string } }>("/domains/:id/releases/latest", async (request, reply) => {
        return reply.send(await new DomainReleaseService(request.databaseUser).getLatest(request.params.id))
    })

    fastify.delete<{ Params: { id: string } }>("/domains/:id", async (request, reply) => {
        return reply.send(await new DomainService(request.databaseUser).delete(request.params.id))
    })
}
