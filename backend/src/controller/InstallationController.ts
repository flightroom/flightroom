import { FastifyInstance } from "fastify"
import InstallationSandboxService from "../service/sandbox/InstallationSandboxService"
import { MAX_LOG_LINES } from "../service/sandbox/OpenShellSandboxes"
import AuthenticationMethod from "../types/AuthenticationMethod"

/** A host name, `*.` in front for any subdomain. */
const HOST = "(\\*\\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*"
/** An absolute path, without spaces nor commas. */
const PATH = "/[^\\s,]*"
/** Items separated by commas, or nothing at all: empty is the environment's value. */
const commaList = (item: string) => `^\\s*(${item}\\s*(,\\s*${item}\\s*)*)?$`

/**
 * The settings an installation administrator may save, each one null, empty or left out for the environment's. The image, the
 * template and the network policy decide what the sandbox may reach: they are checked here, strictly.
 */
export const sandboxSettingsBodySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        idleMinutes: { type: ["integer", "null"], minimum: 1, maximum: 1440 },
        maxHours: { type: ["integer", "null"], minimum: 1, maximum: 720 },
        sharing: { type: ["string", "null"], enum: ["domain", "conversation", null] },
        previewsEnabled: { type: ["boolean", "null"] },
        warmSandboxes: { type: ["integer", "null"], minimum: 0, maximum: 50 },
        image: { type: ["string", "null"], pattern: "^\\S*$", maxLength: 500 },
        template: { type: ["string", "null"], pattern: "^\\S*$", maxLength: 253 },
        registryHosts: { type: ["string", "null"], pattern: commaList(HOST), maxLength: 4000 },
        networkBinary: { type: ["string", "null"], pattern: commaList(PATH), maxLength: 4000 }
    }
}

const sandboxParamsSchema = { type: "object", required: ["name"], properties: { name: { type: "string", pattern: "^fr-[0-9a-f]{16}$" } } }

const logsQuerySchema = { type: "object", properties: { lines: { type: "integer", minimum: 1, maximum: MAX_LOG_LINES, default: 200 } } }

/**
 * What an installation administrator, one of INSTALLATION_ADMINS, changes for the whole installation: the sandboxes of
 * the coding agent. Console sessions only, as Edit with AI; anybody else is refused.
 */
export default async function installationController(fastify: FastifyInstance) {
    const jwtOnly = { authMethod: AuthenticationMethod.JWT }
    const service = (request: { databaseUser?: { email?: string } }) => new InstallationSandboxService(request.databaseUser?.email, fastify.config)

    // Why the gateway is down stays in the log: the answer may carry its address.
    fastify.get("/installation/sandbox-settings", { config: jwtOnly }, async (request, reply) =>
        reply.send(await service(request).settings(error => request.log.warn({ err: error }, "OpenShell gateway health check failed")))
    )

    fastify.put<{ Body: Record<string, unknown> }>("/installation/sandbox-settings", { schema: { body: sandboxSettingsBodySchema }, config: jwtOnly }, async (request, reply) => {
        const summary = await service(request).saveSettings(request.body, request.databaseUser._id, error => request.log.warn({ err: error }, "OpenShell gateway health check failed"))
        request.log.info({ audit: "sandbox_settings_updated", userId: String(request.databaseUser._id), values: summary.values }, "Sandbox settings updated")
        return reply.send(summary)
    })

    fastify.get("/installation/sandboxes", { config: jwtOnly }, async (request, reply) => reply.send(await service(request).sandboxes()))

    fastify.get<{ Params: { name: string }; Querystring: { lines?: number } }>(
        "/installation/sandboxes/:name/logs",
        { schema: { params: sandboxParamsSchema, querystring: logsQuerySchema }, config: jwtOnly },
        async (request, reply) => reply.send(await service(request).logs(request.params.name, request.query.lines))
    )

    fastify.delete<{ Params: { name: string } }>("/installation/sandboxes/:name", { schema: { params: sandboxParamsSchema }, config: jwtOnly }, async (request, reply) => {
        await service(request).delete(request.params.name)
        request.log.info({ audit: "sandbox_deleted", userId: String(request.databaseUser._id), name: request.params.name }, "Sandbox deleted")
        return reply.status(204).send()
    })
}
