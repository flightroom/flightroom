import { z } from "zod"
import { PROVISIONED_DATABASE_NAME } from "../../models/ProvisionedDatabaseModel"
import ProvisionedDatabaseService from "../../service/ProvisionedDatabaseService"
import { PROVISIONED_DATABASE_DELETE_MODES, reachesServers } from "../../types/ProvisionedDatabaseDTO"
import { takeExternalCall } from "../../utils/externalCallLimiter"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE_EXTERNAL, defineTool, objectId, READ_ONLY, WRITE, WRITE_EXTERNAL } from "../toolDefinition"

const databaseId = objectId("Id of the connected database (see databases_list) the databases are created on: a MongoDB one")
const provisionedDatabaseId = objectId("Id of the provisioned database")
const resourceId = objectId("Id of a resource of type mongodb, variant connectionString")
const environmentId = objectId("Id of the environment of the project the database feeds the resource in")

/**
 * The databases created on the connected databases of a project that can create them (a MongoDB one, see
 * databases_list). Every answer goes through toFrontendObject, so the generated password of a database never
 * reaches the client.
 */
export const provisionedDatabaseTools = [
    defineTool({
        name: "provisioned_databases_list",
        title: "List provisioned databases",
        description:
            'The databases created on the connected MongoDB databases of the project, each with its user and the resource and environment it feeds (link). The passwords are never returned. status "cleanupRequired" warns that a failed create left its user on the server (cleanupReason says why): it cannot be linked, and is removed with mode "user", which tries the drop again, or "record". removedFromServer ("data" or "user") says a removal stopped half way: such a database cannot be linked, only removed again.',
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ databaseId: databaseId.optional().describe("Only the databases created on this connected database") }),
        run: async (args, { principal, projectId }) => (await new ProvisionedDatabaseService(principal).getByProjectId(projectId, args.databaseId)).map(database => database.toFrontendObject())
    }),
    defineTool({
        name: "provisioned_database_get",
        title: "Get provisioned database",
        description:
            'One database created on a connected MongoDB database of the project. The password is never returned. status "cleanupRequired" means its user was left on the server by a failed create.',
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ provisionedDatabaseId }),
        run: async (args, { principal }) => (await new ProvisionedDatabaseService(principal).getById(args.provisionedDatabaseId)).toFrontendObject()
    }),
    defineTool({
        name: "provisioned_database_create",
        title: "Create provisioned database",
        description:
            "Creates a database on a connected MongoDB database of the project (databaseId), with a user of the same name that has readWrite and dbAdmin on it only and a generated password, never returned. Refused when a user or a database of that name already exists on the server: it is never taken over. With link, it feeds that mongodb resource (variant connectionString) in that environment: its connectionString and database are set there.",
        scope: MCP_SCOPE_WRITE,
        // Creates a user on a server outside the console: the assistant asks the user first
        requiresConfirmation: true,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            databaseId,
            databaseName: z
                .string()
                .regex(PROVISIONED_DATABASE_NAME, "at most 63 lowercase letters, digits, dashes or underscores, starting with a letter or digit")
                .describe("Name of the database and of its user"),
            link: z.object({ resourceId, environmentId }).optional().describe("The resource and environment the new database feeds right away")
        }),
        run: async (args, { principal }) => {
            takeExternalCall(String(principal._id))
            return (await new ProvisionedDatabaseService(principal).create(args.databaseId, args)).toFrontendObject()
        }
    }),
    defineTool({
        name: "provisioned_database_link",
        title: "Link provisioned database",
        description:
            "Makes a provisioned database feed a mongodb resource (variant connectionString) in one environment: the connectionString and database of the resource in that environment are overwritten. Refused when another database already feeds that environment of the resource.",
        scope: MCP_SCOPE_WRITE,
        // Changes what the backends attaching the resource receive at their next deploy
        requiresConfirmation: true,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({ provisionedDatabaseId, resourceId, environmentId }),
        run: async (args, { principal }) => {
            takeExternalCall(String(principal._id))
            return (await new ProvisionedDatabaseService(principal).link(args.provisionedDatabaseId, args)).toFrontendObject()
        }
    }),
    defineTool({
        name: "provisioned_database_unlink",
        title: "Unlink provisioned database",
        description: "Stops a provisioned database feeding its resource: the values it set in that environment are removed, and the resource falls back on its value for all environments there.",
        scope: MCP_SCOPE_WRITE,
        requiresConfirmation: true,
        annotations: WRITE,
        inputSchema: z.object({ provisionedDatabaseId }),
        run: async (args, { principal }) => (await new ProvisionedDatabaseService(principal).unlink(args.provisionedDatabaseId)).toFrontendObject()
    }),
    defineTool({
        name: "provisioned_database_delete",
        title: "Delete provisioned database",
        description:
            'Removes a provisioned database, refused while it feeds a resource (unlink it first). mode "record" only forgets it in Flightroom; "user" also deletes its user on the server; "drop" deletes its user and the database with all its data, which cannot be undone, and requires confirmName equal to its databaseName. A database with status "cleanupRequired" takes "user" or "record" only.',
        scope: MCP_SCOPE_WRITE,
        annotations: DESTRUCTIVE_EXTERNAL,
        inputSchema: z.object({
            provisionedDatabaseId,
            mode: z.enum(PROVISIONED_DATABASE_DELETE_MODES).describe("record: Flightroom only; user: also the user on the server; drop: also the database and its data"),
            confirmName: z.string().optional().describe('The databaseName typed again, required by mode "drop"')
        }),
        run: async (args, { principal }) => {
            // A removal "from Flightroom only" reaches no server
            if (reachesServers(args.mode)) takeExternalCall(String(principal._id))
            await new ProvisionedDatabaseService(principal).delete(args.provisionedDatabaseId, args.mode, args.confirmName)
            return { deleted: true }
        }
    })
]
