import { FastifyInstance } from "fastify"
import SandboxStatusService from "../service/sandbox/SandboxStatusService"
import AuthenticationMethod from "../types/AuthenticationMethod"

const organizationParamsSchema = { type: "object", required: ["organizationId"], properties: { organizationId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" } } }

/** Whether the OpenShell gateway the coding agent runs code on is up. Console sessions only, as Edit with AI. */
export default async function aiSandboxController(fastify: FastifyInstance) {
    fastify.get<{ Params: { organizationId: string } }>(
        "/organizations/:organizationId/ai-sandbox",
        { schema: { params: organizationParamsSchema }, config: { authMethod: AuthenticationMethod.JWT } },
        async (request, reply) =>
            reply.send(
                // Why it is down stays in the log: the answer may carry the address of the gateway
                await new SandboxStatusService(request.databaseUser).forOrganization(request.params.organizationId, fastify.config, error =>
                    request.log.warn({ err: error }, "OpenShell gateway health check failed")
                )
            )
    )
}
