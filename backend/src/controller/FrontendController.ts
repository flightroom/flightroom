import fastifyMultipart from "@fastify/multipart"
import { FastifyInstance } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import FrontendDeploymentService from "../service/FrontendDeploymentService"
import FrontendService from "../service/FrontendService"
import RepositoryCreationService, { CreateRepositoryInput } from "../service/RepositoryCreationService"
import RepositoryRenameService from "../service/RepositoryRenameService"
import StackDetectionService from "../service/StackDetectionService"
import AuthenticationMethod from "../types/AuthenticationMethod"
import FrontendDTO from "../types/FrontendDTO"
import { getProjectIdFromRequest } from "../utils/requestUtils"

export default async function frontendController(fastify: FastifyInstance) {
    fastify.get("/frontends", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendService(request.databaseUser).getByProjectId(projectId))
    })

    fastify.get<{
        Params: {
            id: string
        }
    }>("/frontends/:id", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).getById(request.params.id))
    })

    fastify.get<{
        Params: {
            id: string
        }
    }>("/frontends/:id/versions", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).getVersionsById(request.params.id))
    })

    // The versions as records, newest first: for a DOCKER with the image, digest and commit the CI registered
    fastify.get<{ Params: { id: string } }>("/frontends/:id/builds", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).getBuildsById(request.params.id))
    })

    // Called by the release pipeline of a DOCKER with its deploy secret once the image is pushed, as for a
    // backend: the API key resolves the project, and its role is checked by the service (MANAGER only)
    fastify.post<{
        Params: { frontendSlug: string; version: string }
        Body: unknown
    }>("/frontends/by-slug/:frontendSlug/versions/:version", { config: { authMethod: AuthenticationMethod.API_KEY } }, async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendService().registerVersionWithPermissionCheck(request.params.frontendSlug, request.params.version, projectId, request.body, request.apiKeyRole))
    })

    // Called by the deploy pipeline of the customer once a version of a DOCKER runs in an environment: the
    // orchestrator does not deploy it, so this is how it learns which version each environment runs (MANAGER only)
    fastify.post<{
        Params: { frontendSlug: string; environmentSlug: string }
        Body: unknown
    }>("/frontends/by-slug/:frontendSlug/environments/:environmentSlug/deployments", { config: { authMethod: AuthenticationMethod.API_KEY } }, async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendDeploymentService().registerWithPermissionCheck(request.params.frontendSlug, request.params.environmentSlug, projectId, request.body, request.apiKeyRole))
    })

    fastify.post<{
        Body: FrontendDTO
    }>("/frontends", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendService(request.databaseUser).create(request.body, projectId))
    })

    fastify.put<{ Params: { id: string }; Body: FrontendDTO }>("/frontends/:id", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).update(request.params.id, request.body))
    })

    fastify.delete<{ Params: { id: string } }>("/frontends/:id", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).delete(request.params.id))
    })

    fastify.delete<{ Body: string[] }>("/frontends", async (request, reply) => {
        return reply.send({
            message: "Frontends deleted successfully",
            deletedCount: await new FrontendService(request.databaseUser).bulkDelete(request.body)
        })
    })

    fastify.post("/frontends/stack-detection", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new StackDetectionService(request.databaseUser).detectForProject(projectId))
    })

    fastify.put<{
        Params: { id: string }
        Body: { framework?: string; compiler?: string }
    }>("/frontends/:id/stack", async (request, reply) => {
        return reply.send(await new StackDetectionService(request.databaseUser).setManualStack(request.params.id, request.body.framework, request.body.compiler))
    })

    // Encapsulated scope: the multipart parser stays local to the upload route, so every
    // other endpoint keeps accepting JSON only.
    await fastify.register(async uploadScope => {
        await uploadScope.register(fastifyMultipart)

        uploadScope.post<{
            Params: { frontendSlug: string; version: string }
            Body: { file: string }
        }>("/frontends/by-slug/:frontendSlug/upload/:version", { config: { authMethod: AuthenticationMethod.API_KEY } }, async (request, reply) => {
            const projectId = getProjectIdFromRequest(request)
            if (!projectId) {
                throw new ProjectHeaderNotFoundError()
            }
            const data = await request.file()
            if (!data) {
                throw new Error("File not found")
            }
            return reply.send(await new FrontendService().uploadWithPermissionCheck(request.params.frontendSlug, request.params.version, projectId, data))
        })
    })

    fastify.put<{
        Body: {
            remote: string
            host: string
        }
    }>("/frontends/relation", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).setRelation(request.body.host, request.body.remote))
    })

    fastify.delete<{
        Body: {
            remote: string
            host: string
        }
    }>("/frontends/relation", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).deleteRelation(request.body.host, request.body.remote))
    })

    fastify.put<{
        Params: {
            id: string
            backendId: string
        }
    }>("/frontends/:id/backends/:backendId", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).linkBackend(request.params.id, request.params.backendId))
    })

    fastify.delete<{
        Params: {
            id: string
            backendId: string
        }
    }>("/frontends/:id/backends/:backendId", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).unlinkBackend(request.params.id, request.params.backendId))
    })

    fastify.post<{
        Params: {
            id: string
        }
        Body: {
            version: string
            branch?: string
        }
    }>("/frontends/:id/build", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).build(request.params.id, request.body.version, request.body.branch))
    })

    fastify.post<{ Params: { id: string }; Body: { name: string } }>("/frontends/:id/repository/rename", async (request, reply) => {
        return reply.send(await new RepositoryRenameService(request.databaseUser).renameFrontendRepository(request.params.id, request.body?.name ?? ""))
    })

    // A new repository, scaffolded from a template, for a frontend that has none: the domain AI workspace offers it
    fastify.post<{ Params: { id: string }; Body: CreateRepositoryInput }>("/frontends/:id/repository", async (request, reply) => {
        return reply.send(await new RepositoryCreationService(request.databaseUser).createFrontendRepository(request.params.id, request.body))
    })

    fastify.put<{
        Params: {
            id: string
        }
        Body: {
            x: number
            y: number
        }
    }>("/frontends/:id/position", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).setPosition(request.params.id, request.body.x, request.body.y))
    })

    fastify.put<{
        Params: {
            id: string
        }
        Body: {
            width: number
            height: number
        }
    }>("/frontends/:id/dimension", async (request, reply) => {
        return reply.send(await new FrontendService(request.databaseUser).setDimension(request.params.id, request.body.width, request.body.height))
    })
}
