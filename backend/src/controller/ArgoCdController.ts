import { FastifyInstance } from "fastify"
import ArgoCdService, { ArgoCdInitializeInput, ArgoCdLogsInput } from "../service/ArgoCdService"

export default async function argoCdController(fastify: FastifyInstance) {
    // Where the project is deployed from, never the credentials
    fastify.get<{ Params: { projectId: string } }>("/projects/:projectId/argocd", async (request, reply) => {
        return reply.send(await new ArgoCdService(request.databaseUser).get(request.params.projectId))
    })

    // Initializes Argo CD for the project, or re-aligns it with the environments and the repositories of now
    fastify.post<{ Params: { projectId: string }; Body: ArgoCdInitializeInput }>("/projects/:projectId/argocd/initialize", async (request, reply) => {
        return reply.send(await new ArgoCdService(request.databaseUser).initialize(request.params.projectId, request.body))
    })

    // The pods a backend, frontend or maintenance agent runs in an environment, through Argo CD
    fastify.get<{ Params: { projectId: string; environmentId: string; slug: string } }>("/projects/:projectId/argocd/environments/:environmentId/applications/:slug/pods", async (request, reply) => {
        const { projectId, environmentId, slug } = request.params
        return reply.send(await new ArgoCdService(request.databaseUser).listPods(projectId, slug, environmentId))
    })

    // The last lines one of those pods wrote
    fastify.get<{ Params: { projectId: string; environmentId: string; slug: string }; Querystring: ArgoCdLogsInput }>(
        "/projects/:projectId/argocd/environments/:environmentId/applications/:slug/logs",
        async (request, reply) => {
            const { projectId, environmentId, slug } = request.params
            return reply.send(await new ArgoCdService(request.databaseUser).getLogs(projectId, slug, environmentId, request.query))
        }
    )
}
