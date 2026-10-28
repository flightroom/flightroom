import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

const podsOf = vi.fn()
const logsOf = vi.fn()
vi.mock("./ArgoCdService", () => ({
    default: class {
        podsOf = podsOf
        logsOf = logsOf
    }
}))

const runsOf = vi.fn()
const failedRunLogsOf = vi.fn()
vi.mock("./BuildStatusService", () => ({
    default: class {
        runsOf = runsOf
        failedRunLogsOf = failedRunLogsOf
    }
}))

import AuthenticationError from "../errors/AuthenticationError"
import { BusinessException } from "../errors/BusinessException"
import Backend from "../models/BackendModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import { isEncryptedSecret, resetSecretEncryptionKeyCache } from "../utils/secretCrypto"
import MaintenanceAgentRuntimeService, { ensureRuntimeTokens, MaintenanceAgentCaller, resolveRuntimeToken, runtimeTokenOf } from "./MaintenanceAgentRuntimeService"

const projectId = new Types.ObjectId()
const agentId = new Types.ObjectId()
const production = new Types.ObjectId()
const development = new Types.ObjectId()
const tokenOf = (environmentId: Types.ObjectId, secret = "a") => `fra_${agentId}_${environmentId}_${secret.repeat(64)}`

/** What a query of the agent answers, whether it is awaited or chained with select first */
const answering = (agents: object[]) => vi.spyOn(MaintenanceAgent, "find").mockImplementation((() => Object.assign(Promise.resolve(agents), { select: () => Promise.resolve(agents) })) as never)

afterEach(() => {
    vi.restoreAllMocks()
    for (const spy of [podsOf, logsOf, runsOf, failedRunLogsOf]) spy.mockReset()
})

describe("ensureRuntimeTokens", () => {
    it("given an agent with a token in production only, when development is deployed too, then one is minted for development and the one of production stays", async () => {
        const stored = [{ environmentId: production, token: tokenOf(production) }]
        const agents = [{ _id: agentId, runtimeTokens: stored }]
        answering(agents)
        const push = vi.spyOn(MaintenanceAgent, "updateOne").mockImplementation((async (_filter: unknown, update: { $push: { runtimeTokens: { environmentId: Types.ObjectId; token: string } } }) => {
            stored.push(update.$push.runtimeTokens)
        }) as never)

        const tokens = await ensureRuntimeTokens([agentId], [production, development] as never)

        expect(push).toHaveBeenCalledTimes(1)
        expect(push.mock.calls[0][0]).toEqual({ _id: agentId, "runtimeTokens.environmentId": { $ne: development } })
        expect(runtimeTokenOf(tokens, agentId, production)).toBe(tokenOf(production))
        expect(runtimeTokenOf(tokens, agentId, development)).toMatch(new RegExp(`^fra_${agentId}_${development}_[0-9a-f]{64}$`))
    })

    it("given a token minted before a key was configured, when the environment is deployed again, then it is encrypted in place and stays the same token", async () => {
        vi.stubEnv("SECRETS_ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"))
        resetSecretEncryptionKeyCache()
        try {
            answering([{ _id: agentId, runtimeTokens: [{ environmentId: production, token: tokenOf(production) }] }])
            const update = vi.spyOn(MaintenanceAgent, "updateOne").mockResolvedValue({} as never)

            const tokens = await ensureRuntimeTokens([agentId], [production] as never)

            expect(runtimeTokenOf(tokens, agentId, production)).toBe(tokenOf(production))
            expect(update.mock.calls[0][0]).toEqual({ _id: agentId, "runtimeTokens.environmentId": production })
            expect(isEncryptedSecret((update.mock.calls[0][1] as { $set: Record<string, string> }).$set["runtimeTokens.$.token"])).toBe(true)
        } finally {
            vi.unstubAllEnvs()
            resetSecretEncryptionKeyCache()
        }
    })

    it("given no agent, when an environment is deployed, then nothing is read", async () => {
        const find = vi.spyOn(MaintenanceAgent, "find")

        expect((await ensureRuntimeTokens([], [production] as never)).size).toBe(0)
        expect(find).not.toHaveBeenCalled()
    })
})

describe("resolveRuntimeToken", () => {
    const agent = { _id: agentId, projectId, runtimeTokens: [{ environmentId: production, token: tokenOf(production) }] }

    beforeEach(() => {
        vi.spyOn(MaintenanceAgent, "findById").mockReturnValue({ select: () => Promise.resolve(agent) } as never)
        vi.spyOn(Environment, "findOne").mockResolvedValue({ _id: production, slug: "production", projectId } as never)
    })

    it("given the token of production, when it is resolved, then it is the agent in production", async () => {
        const caller = await resolveRuntimeToken(tokenOf(production))

        expect(caller.agent).toBe(agent)
        expect(caller.environment).toMatchObject({ slug: "production" })
        expect(Environment.findOne).toHaveBeenCalledWith({ _id: String(production), projectId })
    })

    it("given a token with another secret, when it is resolved, then it is refused", async () => {
        await expect(resolveRuntimeToken(tokenOf(production, "b"))).rejects.toBeInstanceOf(AuthenticationError)
    })

    it("given a token of an environment the agent holds none for, when it is resolved, then it is refused", async () => {
        await expect(resolveRuntimeToken(tokenOf(development))).rejects.toBeInstanceOf(AuthenticationError)
    })

    it("given something that is no token, when it is resolved, then it is refused without reading the agents", async () => {
        for (const token of [undefined, "", "an api key", `fra_${agentId}_${production}_short`]) {
            await expect(resolveRuntimeToken(token)).rejects.toBeInstanceOf(AuthenticationError)
        }
        expect(MaintenanceAgent.findById).not.toHaveBeenCalled()
    })

    it("given an environment deleted since, when its token is resolved, then it is refused", async () => {
        vi.mocked(Environment.findOne).mockResolvedValue(null as never)

        await expect(resolveRuntimeToken(tokenOf(production))).rejects.toBeInstanceOf(AuthenticationError)
    })
})

describe("MaintenanceAgentRuntimeService", () => {
    const ordersId = new Types.ObjectId()
    const shopId = new Types.ObjectId()
    const docsId = new Types.ObjectId()
    const environment = { _id: production, slug: "production", projectId }
    const caller = { agent: { _id: agentId, projectId, backendIds: [ordersId], frontendIds: [shopId, docsId] }, environment } as unknown as MaintenanceAgentCaller
    const orders = { _id: ordersId, slug: "orders", name: "Orders", projectId, codeRepository: { enabled: true } }
    const runtime = () => new MaintenanceAgentRuntimeService(caller)

    const codeOf = async (promise: Promise<unknown>) => {
        const error = await promise.catch(failure => failure)
        expect(error).toBeInstanceOf(BusinessException)
        return (error as BusinessException).code
    }

    beforeEach(() => {
        vi.spyOn(Backend, "find").mockReturnValue({ sort: () => Promise.resolve([orders]) } as never)
        vi.spyOn(Frontend, "find").mockReturnValue({
            sort: () =>
                Promise.resolve([
                    { _id: shopId, slug: "shop", name: "Shop", projectId, kind: FrontendKind.DOCKER },
                    { _id: docsId, slug: "docs", name: "Docs", projectId, kind: "STATIC", codeRepository: { enabled: true } }
                ])
        } as never)
    })

    it("given its targets, when it lists them, then it says which have logs and which have builds, and reads those of its project only", async () => {
        expect(await runtime().targets()).toEqual([
            { kind: "backend", slug: "orders", name: "Orders", logs: true, builds: true },
            { kind: "frontend", slug: "shop", name: "Shop", logs: true, builds: false },
            { kind: "frontend", slug: "docs", name: "Docs", logs: false, builds: true }
        ])
        expect(Backend.find).toHaveBeenCalledWith({ _id: { $in: [ordersId] }, projectId })
    })

    it("given a backend it maintains, when it reads its logs, then they are read through Argo CD in its own environment", async () => {
        logsOf.mockResolvedValue([{ content: "started" }])

        expect(await runtime().logs("orders", { pod: "orders-1", tailLines: 50 })).toEqual([{ content: "started" }])
        expect(logsOf).toHaveBeenCalledWith(projectId, "orders", environment, { pod: "orders-1", tailLines: 50 })
    })

    it("given an application it does not maintain, when it reads its pods, then it is refused without asking Argo CD", async () => {
        expect(await codeOf(runtime().pods("payments"))).toBe("MAINTENANCE_AGENT_TARGET_NOT_FOUND")
        expect(podsOf).not.toHaveBeenCalled()
    })

    it("given a frontend served as static files, when it reads its logs, then it is refused: no pod runs it", async () => {
        expect(await codeOf(runtime().logs("docs", { pod: "docs-1" }))).toBe("MAINTENANCE_AGENT_TARGET_NO_LOGS")
        expect(logsOf).not.toHaveBeenCalled()
    })

    it("given a backend it maintains, when it reads its builds and the logs of one, then they are read from the CI of that backend", async () => {
        runsOf.mockResolvedValue([{ id: "7", status: "failure" }])
        failedRunLogsOf.mockResolvedValue([{ name: "build", log: "error TS2322" }])

        expect(await runtime().builds("orders")).toEqual([{ id: "7", status: "failure" }])
        expect(await runtime().buildLogs("orders", "7")).toEqual([{ name: "build", log: "error TS2322" }])
        expect(runsOf).toHaveBeenCalledWith(orders, "backend")
        expect(failedRunLogsOf).toHaveBeenCalledWith(orders, "backend", "7")
    })
})
