import { z } from "zod"
import { PROVISIONED_DATABASE_NAME } from "../../models/ProvisionedDatabaseModel"
import MongoServerService from "../../service/MongoServerService"
import ProvisionedDatabaseService from "../../service/ProvisionedDatabaseService"
import { MongoServerDTO, PROVISIONED_DATABASE_DELETE_MODES, reachesServers } from "../../types/MongoServerDTO"
import { takeExternalCall } from "../../utils/externalCallLimiter"
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from "../../utils/oauthConfig"
import { DESTRUCTIVE_EXTERNAL, defineTool, NO_INPUT, objectId, READ_ONLY, WRITE, WRITE_EXTERNAL } from "../toolDefinition"

const serverId = objectId("Id of the MongoDB server")
const provisionedDatabaseId = objectId("Id of the provisioned database")
const resourceId = objectId("Id of a resource of type mongodb, variant connectionString")
const environmentId = objectId("Id of the environment of the project the database feeds the resource in")

/**
 * The MongoDB servers of a project and the databases created on them. Registering or editing a server
 * stays in the console: its input is a super-admin credential. Every answer goes through
 * toFrontendObject, so neither the credentials of a server nor the generated password of a database
 * ever reaches the client.
 */
export const mongoServerTools = [
    defineTool({
        name: "mongo_servers_list",
        title: "List MongoDB servers",
        description:
            "The MongoDB servers (self-hosted, Atlas, or an Azure Cosmos DB for MongoDB RU account) the project creates databases on. Credentials are masked; registering or editing a server, with its super-admin credentials, is only possible from the console.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: NO_INPUT,
        run: async (_args, { principal, projectId }) => (await new MongoServerService(principal).getByProjectId(projectId)).map(server => server.toFrontendObject())
    }),
    defineTool({
        name: "mongo_server_get",
        title: "Get MongoDB server",
        description: "One MongoDB server of the project. Credentials are masked; editing it is only possible from the console.",
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ serverId }),
        run: async (args, { principal }) => (await new MongoServerService(principal).getById(args.serverId)).toFrontendObject()
    }),
    defineTool({
        name: "mongo_server_test",
        title: "Test MongoDB server",
        description: "Checks that a MongoDB server of the project answers with its stored credentials. Says what failed otherwise. Nothing is changed.",
        scope: MCP_SCOPE_WRITE,
        // Connects with the stored super-admin credentials, as an update would: refused to viewers, and
        // under mfe:write like database_test. It changes nothing
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({ serverId }),
        run: async (args, { principal }) => {
            takeExternalCall(String(principal._id))
            const service = new MongoServerService(principal)
            // The masked credentials stand for the stored ones, as when the console tests a saved server
            return service.testConnection((await service.getById(args.serverId)).toFrontendObject() as unknown as MongoServerDTO, { serverId: args.serverId })
        }
    }),
    defineTool({
        name: "provisioned_databases_list",
        title: "List provisioned databases",
        description:
            'The databases created on the MongoDB servers of the project, each with its user and the resource and environment it feeds (link). The passwords are never returned. status "cleanupRequired" warns that a failed create left its user on the server (cleanupReason says why): it cannot be linked, and is removed with mode "user", which tries the drop again, or "record".',
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ serverId: serverId.optional().describe("Only the databases of this server") }),
        run: async (args, { principal, projectId }) => (await new ProvisionedDatabaseService(principal).getByProjectId(projectId, args.serverId)).map(database => database.toFrontendObject())
    }),
    defineTool({
        name: "provisioned_database_get",
        title: "Get provisioned database",
        description: 'One database created on a MongoDB server of the project. The password is never returned. status "cleanupRequired" means its user was left on the server by a failed create.',
        scope: MCP_SCOPE_READ,
        annotations: READ_ONLY,
        inputSchema: z.object({ provisionedDatabaseId }),
        run: async (args, { principal }) => (await new ProvisionedDatabaseService(principal).getById(args.provisionedDatabaseId)).toFrontendObject()
    }),
    defineTool({
        name: "provisioned_database_create",
        title: "Create provisioned database",
        description:
            "Creates a database on a MongoDB server of the project, with a user of the same name that has readWrite and dbAdmin on it only and a generated password, never returned. Refused when a user or a database of that name already exists on the server: it is never taken over. With link, it feeds that mongodb resource (variant connectionString) in that environment: its connectionString and database are set there.",
        scope: MCP_SCOPE_WRITE,
        // Creates a user on a server outside the console: the assistant asks the user first
        requiresConfirmation: true,
        annotations: WRITE_EXTERNAL,
        inputSchema: z.object({
            serverId,
            databaseName: z
                .string()
                .regex(PROVISIONED_DATABASE_NAME, "at most 63 lowercase letters, digits, dashes or underscores, starting with a letter or digit")
                .describe("Name of the database and of its user"),
            link: z.object({ resourceId, environmentId }).optional().describe("The resource and environment the new database feeds right away")
        }),
        run: async (args, { principal }) => {
            takeExternalCall(String(principal._id))
            return (await new ProvisionedDatabaseService(principal).create(args.serverId, args)).toFrontendObject()
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
