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
        // The variables the running container got in one environment, read from its live pod; with ?reveal=true its Secrets' values too
        fastify.get<{ Params: { id: string; environmentId: string }; Querystring: { reveal?: string } }>(`${path}/:id/environments/:environmentId/variables`, async (request, reply) => {
            const projectId = getProjectIdFromRequest(request)
            if (!projectId) {
                throw new ProjectHeaderNotFoundError()
            }
            const reveal = request.query.reveal === "true"
            const environment = await new ArgoCdService(request.databaseUser).runningEnvironment(projectId, { kind, id: request.params.id }, request.params.environmentId, { reveal })
            if (reveal) {
                request.log.info({ [`${kind}Id`]: request.params.id, environmentId: request.params.environmentId, userId: String(request.databaseUser?._id) }, "Container secret values revealed")
            }
            return reply.send(environment)
        })
    }
}
