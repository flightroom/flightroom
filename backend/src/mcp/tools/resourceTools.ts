import { z } from "zod"
import { BusinessException, createBusinessException } from "../../errors/BusinessException"
import { IResource } from "../../models/ResourceModel"
import { ResourceService } from "../../service/ResourceService"
import { isResourceType, MAX_RESOURCE_CUSTOM_FIELDS, RESOURCE_CATALOG, RESOURCE_CUSTOM_FIELD_NAME, ResourceCustomField, ResourceType, resourceVariant } from "../../types/ResourceCatalog"
import ResourceDTO from "../../types/ResourceDTO"
import { VARIABLE_MAP_NAME } from "../../types/VariableMapDTO"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE, defineTool, McpToolContext, NO_INPUT, objectId, READ_ONLY, WRITE } from "../toolDefinition"

const resourceId = objectId("Id of the resource, from resources_list")

const name = z.string().regex(VARIABLE_MAP_NAME, "at most 63 lowercase letters, digits or dashes, starting and ending with a letter or digit")

const fields = z
    .record(
        z.string().min(1).max(100),
        z
            .object({
                value: z
                    .string()
                    .max(32 * 1024)
                    .optional()
                    .describe("The value in every environment; blank leaves the field unset"),
                overrides: z
                    .array(
                        z.object({
                            environmentId: objectId("Id of an environment of the project, from environments_list"),
                            value: z
                                .string()
                                .max(32 * 1024)
                                .optional()
                        })
                    )
                    .max(50)
                    .optional()
                    .describe("Environments that take another value")
            })
            // As the service takes it: null unsets the field, overrides included
            .nullable()
    )
    .describe(
        "By field name of the variant (resource_types_list), or by name of a customField of a generic: a field sent replaces its value and overrides, null unsets it, one left out keeps what it has. Fields that are a credential are refused: they are set from the console"
    )

const customFields = z
    .array(
        z.object({
            name: z.string().regex(RESOURCE_CUSTOM_FIELD_NAME, "at most 61 capital letters, digits or underscores").describe("The end of the variable: <prefix>_<name>, e.g. TOKEN"),
            secret: z.boolean().optional().describe("A credential: encrypted, and its value set from the console only")
        })
    )
    .max(MAX_RESOURCE_CUSTOM_FIELDS)
    .optional()
    .describe(
        "A generic only (refused on any other type): the variables it defines, all optional, sent as a whole. Their values go in fields, by name. A field renamed, removed or turned secret or plain loses its values"
    )

const resources = (principal: McpToolContext["principal"]) => new ResourceService(principal)

/**
 * What a resource is sent back as: through the model's own serialisation, the only one that hides the
 * credentials and leaves the pasted API document out (`{ present, bytes }` in its place).
 */
const masked = (resource: IResource | null) => (resource && typeof resource.toJSON === "function" ? resource.toJSON() : resource)

/**
 * A credential is typed in the console only, as for the values of a secret: it never travels through an MCP
 * client. Judged by the catalog for the variant the resource has (or gets); an unknown variant is judged by
 * every variant of the type, and the service then refuses it anyway.
 */
const refuseSecretFields = (type: unknown, variant: unknown, sent: Record<string, unknown> | undefined, custom?: Array<Pick<ResourceCustomField, "name"> & { secret?: boolean }> | null) => {
    if (!sent) return
    const specs =
        resourceVariant(
            type,
            variant,
            custom?.map(({ name, secret }) => ({ name, secret: secret === true }))
        )?.fields ?? (isResourceType(type) ? RESOURCE_CATALOG[type].variants.flatMap(candidate => candidate.fields) : [])
    const secret = Object.keys(sent).filter(field => specs.some(spec => spec.name === field && spec.secret))
    if (secret.length) {
        throw createBusinessException({
            code: "RESOURCE_SECRET_FROM_CONSOLE",
            message: `Secret fields of a resource are set from the console: ${secret.join(", ")}`,
            statusCode: 422
        })
    }
}

const apiSpec = z
    .string()
    .max(5 * 1024 * 1024)
    .nullable()
    .optional()
    .describe("An api only: its OpenAPI/Swagger document, JSON or YAML, when it cannot be fetched from its specUrl. null removes it. Never read back: resources carry only whether there is one")

/**
 * The resources of the project: packages of variables of a catalog type (a database, an api, an ai...) that
 * backends attach (resourceIds). Read with their credentials masked, every other value readable as
 * on config_map_get. Everything but the credentials can be written; those stay in the console.
 */
export const resourceTools = [
    defineTool({
        name: "resource_types_list",
        title: "List resource types",
        description:
            "The types a resource can be, each with its variants and their fields: the name, the variable suffix, whether it is a credential (set from the console only), required, and how it is typed. A generic has no field of its own: it defines its variables in customFields.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: async (_args, { principal }) => resources(principal).catalog()
    }),
    defineTool({
        name: "resources_list",
        title: "List resources",
        description:
            "The resources of the project with their fields (credentials masked) and the environment variables each sets on the backends attaching it (env). The pasted API document of an api is never returned, only whether there is one.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: async (_args, { principal, projectId }) => (await resources(principal).getByProjectId(projectId)).map(masked)
    }),
    defineTool({
        name: "resource_get",
        title: "Get resource",
        description: "One resource of the project: its values in every environment and their overrides, credentials masked, and the environment variables it sets.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ resourceId }),
        run: async (args, { principal }) => masked(await resources(principal).getById(args.resourceId))
    }),
    defineTool({
        name: "resource_create",
        title: "Create resource",
        description:
            "Adds a resource to the project, with the fields of its variant that are no credential (resource_types_list); set the credentials from the console. For anything the catalog lacks, a generic (variant custom) defines its own variables in customFields. Attach it to a backend with backend_update (resourceIds).",
        scope: MCP_SCOPE_WRITE,
        annotations: WRITE,
        inputSchema: z.object({
            name,
            type: z.enum(Object.keys(RESOURCE_CATALOG) as [ResourceType, ...ResourceType[]]).describe("Fixed once created"),
            variant: z.string().min(1).max(100).describe("A variant of the type, from resource_types_list"),
            description: z.string().max(2000).optional(),
            envPrefix: z.string().max(191).nullable().optional().describe("Prefix of its variables in place of the one derived from type and name, e.g. DB_ORDERS"),
            customFields,
            fields: fields.optional(),
            apiSpec
        }),
        run: async (args, { principal, projectId }) => {
            refuseSecretFields(args.type, args.variant, args.fields, args.customFields)
            return masked(await resources(principal).create(args as ResourceDTO, projectId))
        }
    }),
    defineTool({
        name: "resource_update",
        title: "Update resource",
        description:
            "Changes the name, variant, description, prefix, variables of a generic (customFields) or some fields of a resource: a field left out keeps its value, credentials included, which are set from the console only. A change of variant drops the fields the new one does not have. A change of variant or of where the resource connects (its host, URL...) is refused while it has stored credentials: those must be typed again, in the console.",
        scope: MCP_SCOPE_WRITE,
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({
            resourceId,
            name: name.optional(),
            variant: z.string().min(1).max(100).optional(),
            description: z.string().max(2000).optional(),
            envPrefix: z.string().max(191).nullable().optional(),
            customFields,
            fields: fields.optional(),
            apiSpec
        }),
        run: async ({ resourceId: id, ...changes }, { principal }) => {
            if (changes.fields) {
                const existing = await resources(principal).getById(id)
                refuseSecretFields(existing.type, changes.variant ?? existing.variant, changes.fields, changes.customFields ?? existing.customFields)
            }
            return masked(
                await resources(principal)
                    .update(id, changes as Partial<ResourceDTO>)
                    .catch((error: unknown) => {
                        // The credentials kept would go to the new address: they are typed again, and only the console takes them
                        if (error instanceof BusinessException && error.code === "RESOURCE_SECRET_REENTRY_REQUIRED") {
                            throw createBusinessException({
                                code: error.code,
                                message: `Changing ${((error.details?.connections as string[] | undefined) ?? []).join(", ")} of a resource with stored credentials needs them typed again (${((error.details?.secrets as string[] | undefined) ?? []).join(", ")}): make this change from the console`,
                                statusCode: error.statusCode,
                                details: error.details
                            })
                        }
                        throw error
                    })
            )
        }
    }),
    defineTool({
        name: "resource_delete",
        title: "Delete resource",
        description: "Deletes a resource of the project with its values. Refused while a backend still attaches it.",
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE,
        inputSchema: z.object({ resourceId }),
        run: async (args, { principal }) => {
            await resources(principal).delete(args.resourceId)
            return { deleted: true }
        }
    })
]
