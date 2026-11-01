import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../..", () => ({ fastify: { log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }, config: { REPOSITORIES_FOLDER: "/repositories" } } }))

import Environment from "../../models/EnvironmentModel"
import Resource from "../../models/ResourceModel"
import { ConfigMap, Secret } from "../../models/VariableMapModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { previewEnvironments } from "./StandalonePreviewService"

const projectId = toObjectId(String(new Types.ObjectId()))
const devId = new Types.ObjectId()
const stagingId = new Types.ObjectId()
const frontendId = new Types.ObjectId()
const backendId = new Types.ObjectId()
const loggingId = new Types.ObjectId()
const databaseId = new Types.ObjectId()

describe("previewEnvironments", () => {
    let sort: ReturnType<typeof vi.fn>

    beforeEach(() => {
        sort = vi.fn().mockResolvedValue({ _id: devId, slug: "dev", logLevel: "debug", logJson: false })
        vi.spyOn(Environment, "findOne").mockReturnValue({ sort } as never)
        vi.spyOn(ConfigMap, "find").mockResolvedValue([
            {
                _id: loggingId,
                entries: [
                    { key: "API_BASE", value: "https://api.example.test", values: [{ environmentId: devId, value: "https://api.dev.example.test" }] },
                    { key: "ONLY_STAGING", values: [{ environmentId: stagingId, value: "staging" }] },
                    { key: "LOG_LEVEL", value: "error", values: [] }
                ]
            }
        ] as never)
        vi.spyOn(Secret, "find").mockResolvedValue([
            {
                _id: databaseId,
                entries: [
                    { key: "DB_PASSWORD", value: "s3cret", values: [] },
                    { key: "API_BASE", value: "from-secret", values: [] }
                ]
            }
        ] as never)
        vi.spyOn(Resource, "find").mockResolvedValue([] as never)
    })

    afterEach(() => vi.restoreAllMocks())

    it("Given a project, when the environments of a preview are read, then they come from its first environment that is not production", async () => {
        await previewEnvironments(projectId, [])

        expect(Environment.findOne).toHaveBeenCalledWith({ projectId, isProduction: false }, expect.anything())
        expect(sort).toHaveBeenCalledWith({ order: 1 })
    })

    it("Given config maps and secrets attached, then each component gets their values there, a secret over a config map and the platform's over both", async () => {
        const environments = await previewEnvironments(projectId, [
            { _id: backendId, configMapIds: [loggingId], secretIds: [databaseId] },
            { _id: frontendId, configMapIds: [loggingId] }
        ])

        expect(environments.get(String(backendId))).toEqual({ API_BASE: "from-secret", DB_PASSWORD: "s3cret", LOG_LEVEL: "debug", LOG_JSON: "false", ENVIRONMENT: "dev" })
        expect(environments.get(String(frontendId))).toEqual({ API_BASE: "https://api.dev.example.test", LOG_LEVEL: "debug", LOG_JSON: "false", ENVIRONMENT: "dev" })
    })

    it("Given a project with production only, then no component gets any", async () => {
        sort.mockResolvedValue(null)

        expect((await previewEnvironments(projectId, [{ _id: backendId, secretIds: [databaseId] }])).size).toBe(0)
        expect(Secret.find).not.toHaveBeenCalled()
    })
})
