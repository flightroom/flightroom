import { FastifyInstance } from "fastify"
import ProjectHeaderNotFoundError from "../errors/ProjectHeaderNotFoundError"
import ArgoCdService from "../service/ArgoCdService"
import { getProjectIdFromRequest } from "../utils/requestUtils"

/** The containers whose injected variables can be read: a backend, and a DOCKER frontend */
const ROUTES: Array<[string, "backend" | "frontend"]> = [
    ["/backends", "backend"],
    ["/frontends", "frontend"]
]

export default async function containerEnvironmentController(fastify: FastifyInstance) {
    for (const [path, kind] of ROUTES) {
        // The variables the running container got in one environment, read from its live pod
        fastify.get<{ Params: { id: string; environmentId: string } }>(`${path}/:id/environments/:environmentId/variables`, async (request, reply) => {
            const projectId = getProjectIdFromRequest(request)
            if (!projectId) {
                throw new ProjectHeaderNotFoundError()
            }
            return reply.send(await new ArgoCdService(request.databaseUser).runningEnvironment(projectId, { kind, id: request.params.id }, request.params.environmentId))
        })
    }
}
