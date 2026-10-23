import { FastifyInstance } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import FrontendDependencyService from "../service/FrontendDependencyService"
import { AlignmentApplyRequestDTO, DependencyScanRequestDTO } from "../types/FrontendDependencyDTO"
import { getProjectIdFromRequest } from "../utils/requestUtils"

export default async function frontendDependencyController(fastify: FastifyInstance) {
    fastify.get("/dependencies/targets", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendDependencyService(request.databaseUser).getScanTargets(projectId))
    })

    fastify.get("/dependencies", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendDependencyService(request.databaseUser).getReport(projectId))
    })

    fastify.get<{
        Params: {
            projectId: string
        }
    }>("/projects/:projectId/dependencies", async (request, reply) => {
        return reply.send(await new FrontendDependencyService(request.databaseUser).getReport(request.params.projectId))
    })

    fastify.post<{
        Body: DependencyScanRequestDTO
    }>("/dependencies/report", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendDependencyService(request.databaseUser).getReport(projectId, request.body || {}))
    })

    fastify.post<{
        Body: AlignmentApplyRequestDTO
    }>("/dependencies/peer/alignment-plan", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendDependencyService(request.databaseUser).getAlignmentPlan(projectId, request.body || {}))
    })

    fastify.post<{
        Body: AlignmentApplyRequestDTO
    }>("/dependencies/peer/align", async (request, reply) => {
        const projectId = getProjectIdFromRequest(request)
        if (!projectId) {
            throw new ProjectHeaderNotFoundError()
        }
        return reply.send(await new FrontendDependencyService(request.databaseUser).applyAlignment(projectId, request.body || {}))
    })
}
