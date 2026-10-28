import { FastifyInstance } from "fastify"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import BackendDeploymentService from "../service/BackendDeploymentService"
import BackendService from "../service/BackendService"
import RepositoryCreationService, { CreateRepositoryInput } from "../service/RepositoryCreationService"
import AuthenticationMethod from "../types/AuthenticationMethod"
import BackendDTO from "../types/BackendDTO"
import { getProjectIdFromRequest } from "../utils/requestUtils"

export default async function backendController(fastify: FastifyInstance) {
    fastify.get("/backends", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new BackendService(request.databaseUser).getByProjectId(projectId))
    })

    fastify.get<{ Params: { id: string } }>("/backends/:id", async (request, reply) => {
        const backend = await new BackendService(request.databaseUser).getById(request.params.id)
        if (!backend) {
            throw new EntityNotFoundError(request.params.id)
        }
        return reply.send(backend)
    })

    fastify.get<{ Params: { id: string } }>("/backends/:id/versions", async (request, reply) => {
        return reply.send(await new BackendService(request.databaseUser).getVersionsById(request.params.id))
    })

    fastify.post<{ Body: BackendDTO }>("/backends", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new BackendService(request.databaseUser).create(request.body, projectId))
    })

    fastify.put<{ Params: { id: string }; Body: BackendDTO }>("/backends/:id", async (request, reply) => {
        return reply.send(await new BackendService(request.databaseUser).update(request.params.id, request.body))
    })

    fastify.delete<{ Params: { id: string } }>("/backends/:id", async (request, reply) => {
        return reply.send(await new BackendService(request.databaseUser).delete(request.params.id))
    })

    fastify.post<{ Params: { id: string }; Body: { version: string; branch?: string } }>("/backends/:id/build", async (request, reply) => {
        return reply.send(await new BackendService(request.databaseUser).build(request.params.id, request.body.version, request.body.branch))
    })

    // A new repository, scaffolded from a template, for a backend that has none: the domain AI workspace offers it
    fastify.post<{ Params: { id: string }; Body: CreateRepositoryInput }>("/backends/:id/repository", async (request, reply) => {
        return reply.send(await new RepositoryCreationService(request.databaseUser).createBackendRepository(request.params.id, request.body))
    })

    // Called by the release pipeline of the backend with its deploy secret: the API key resolves the project,
    // and its role is checked by the service (MANAGER only). Also under /services, where backends were before
    // they were renamed: the repositories scaffolded until then still register their versions there
    for (const path of ["/backends/by-slug/:backendSlug/versions/:version", "/services/by-slug/:backendSlug/versions/:version"]) {
        fastify.post<{
            Params: { backendSlug: string; version: string }
            Body: unknown
        }>(path, { config: { authMethod: AuthenticationMethod.API_KEY } }, async (request, reply) => {
            const projectId = getProjectIdFromRequest(request)
            if (!projectId) {
                throw new ProjectHeaderNotFoundError()
            }
            return reply.send(await new BackendService().registerVersionWithPermissionCheck(request.params.backendSlug, request.params.version, projectId, request.body, request.apiKeyRole))
        })
    }

    // Called by the deploy pipeline of the customer once a version runs in an environment: the orchestrator
    // does not deploy backends, so this is how it learns which version each environment runs (MANAGER only)
    fastify.post<{
        Params: { backendSlug: string; environmentSlug: string }
        Body: unknown
    }>("/backends/by-slug/:backendSlug/environments/:environmentSlug/deployments", { config: { authMethod: AuthenticationMethod.API_KEY } }, async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new BackendDeploymentService().registerWithPermissionCheck(request.params.backendSlug, request.params.environmentSlug, projectId, request.body, request.apiKeyRole))
    })
}
