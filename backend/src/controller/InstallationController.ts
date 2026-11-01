import { FastifyInstance } from "fastify"
import InstallationSandboxService from "../service/sandbox/InstallationSandboxService"
import { MAX_LOG_LINES } from "../service/sandbox/OpenShellSandboxes"
import SandboxTemplateService, { SandboxTemplateInput } from "../service/sandbox/SandboxTemplateService"
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

/** A template name as the gateway takes it: a DNS label of at most 19 characters. */
const templateParamsSchema = { type: "object", required: ["name"], properties: { name: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]{0,17}[a-z0-9])?$" } } }

/** A Kubernetes label: an optional DNS prefix and a name of at most 63 characters; its value the same, or empty. */
const LABEL_NAME = "[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?"
const LABEL_KEY = `^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?/)?${LABEL_NAME}$`

/** What a template runs: its image, the resources it is limited to, its labels and environment. */
export const sandboxTemplateBodySchema = {
    type: "object",
    additionalProperties: false,
    required: ["image"],
    properties: {
        image: { type: "string", pattern: "^\\S+$", maxLength: 500 },
        cpu: { type: ["string", "null"], pattern: "^([0-9]+(\\.[0-9]+)?m?)?$", maxLength: 20 },
        memory: { type: ["string", "null"], pattern: "^([0-9]+(\\.[0-9]+)?(Ki|Mi|Gi|Ti|k|M|G|T)?)?$", maxLength: 20 },
        labels: { type: "object", maxProperties: 20, propertyNames: { pattern: LABEL_KEY }, additionalProperties: { type: "string", pattern: `^(${LABEL_NAME})?$` } },
        environment: { type: "object", maxProperties: 50, propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" }, additionalProperties: { type: "string", maxLength: 4000 } }
    }
}

const logsQuerySchema = { type: "object", properties: { lines: { type: "integer", minimum: 1, maximum: MAX_LOG_LINES, default: 200 } } }

/**
 * What an installation administrator, one of INSTALLATION_ADMINS, changes for the whole installation: the sandboxes of
 * the coding agent. Console sessions only, as Edit with AI; anybody else is refused.
 */
export default async function installationController(fastify: FastifyInstance) {
    const jwtOnly = { authMethod: AuthenticationMethod.JWT }
    const service = (request: { databaseUser?: { email?: string } }) => new InstallationSandboxService(request.databaseUser?.email, fastify.config)
    const templates = (request: { databaseUser?: { email?: string } }) => new SandboxTemplateService(request.databaseUser?.email, fastify.config)

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

    fastify.get("/installation/sandbox-templates", { config: jwtOnly }, async (request, reply) => reply.send(await templates(request).list()))

    type TemplateRoute = { Params: { name: string }; Body: SandboxTemplateInput }
    const templateSchema = { schema: { params: templateParamsSchema, body: sandboxTemplateBodySchema }, config: jwtOnly }

    fastify.post<TemplateRoute>("/installation/sandbox-templates/:name", templateSchema, async (request, reply) => {
        const created = await templates(request).create(request.params.name, request.body)
        request.log.info({ audit: "sandbox_template_created", userId: String(request.databaseUser._id), name: request.params.name, image: request.body.image }, "Sandbox template created")
        return reply.status(201).send(created)
    })

    fastify.put<TemplateRoute>("/installation/sandbox-templates/:name", templateSchema, async (request, reply) => {
        const saved = await templates(request).replace(request.params.name, request.body, (error, previous) =>
            request.log.error({ err: error, audit: "sandbox_template_lost", userId: String(request.databaseUser._id), ...previous }, "Sandbox template deleted and not created again")
        )
        request.log.info({ audit: "sandbox_template_updated", userId: String(request.databaseUser._id), name: request.params.name, image: request.body.image }, "Sandbox template updated")
        return reply.send(saved)
    })

    fastify.delete<{ Params: { name: string } }>("/installation/sandbox-templates/:name", { schema: { params: templateParamsSchema }, config: jwtOnly }, async (request, reply) => {
        await templates(request).delete(request.params.name)
        request.log.info({ audit: "sandbox_template_deleted", userId: String(request.databaseUser._id), name: request.params.name }, "Sandbox template deleted")
        return reply.status(204).send()
    })
}
