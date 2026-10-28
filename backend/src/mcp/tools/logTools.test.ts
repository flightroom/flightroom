import { beforeEach, describe, expect, it, vi } from "vitest"
import { BusinessException } from "../../errors/BusinessException"
import { MCP_SCOPE_READ } from "../../utils/oauthConfig"
import { McpSession, McpToolContext } from "../toolDefinition"
import { logTools } from "./logTools"

const listPods = vi.fn()
const getLogs = vi.fn()
const getFailedRunLogs = vi.fn()
const principals: unknown[] = []

vi.mock("../../service/ArgoCdService", () => ({
    default: class {
        constructor(principal: unknown) {
            principals.push(principal)
        }
        listPods = (...args: unknown[]) => listPods(...args)
        getLogs = (...args: unknown[]) => getLogs(...args)
    }
}))
vi.mock("../../service/BuildStatusService", () => ({
    default: class {
        getFailedRunLogs = (...args: unknown[]) => getFailedRunLogs(...args)
    }
}))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const ENVIRONMENT = "bbbbbbbbbbbbbbbbbbbbbbbb"
const BACKEND = "cccccccccccccccccccccccc"

const tool = (name: string) => logTools.find(candidate => candidate.name === name)!

const context = (credential: McpSession["credential"] = { kind: "console", userId: "user-1" }, role = "MEMBER"): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role }],
        scopes: [MCP_SCOPE_READ],
        credential
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

const run = (name: string, args: Record<string, unknown>, as = context()) => tool(name).run(tool(name).inputSchema.parse(args) as never, as)

describe("log tools", () => {
    beforeEach(() => {
        principals.length = 0
        for (const mock of [listPods, getLogs, getFailedRunLogs]) mock.mockReset().mockResolvedValue([])
    })

    it("given a read-only connection, when the registry is read, then every log tool is offered to it and none writes", () => {
        for (const candidate of logTools) {
            expect(candidate.scope).toBe(MCP_SCOPE_READ)
            expect(candidate.annotations.readOnlyHint).toBe(true)
        }
    })

    it("given a pod of a backend, when its logs are asked, then the console reads them as the principal of the connection, in its project", async () => {
        await run("application_logs_get", { slug: "orders", environmentId: ENVIRONMENT, pod: "orders-1", tailLines: 50, previous: true })

        expect(getLogs).toHaveBeenCalledWith(PROJECT, "orders", ENVIRONMENT, { pod: "orders-1", tailLines: 50, previous: true })
        expect(principals[0]).toMatchObject({ _id: "user-1", restrictedToProjectIds: [PROJECT] })
    })

    it("given a VIEWER API key, when it asks for the pods or the logs, then it is refused before Argo CD is read, as a viewer is in the console", async () => {
        const viewerKey = context({ kind: "api_key", apiKeyId: "key-1" }, "VIEWER")

        await expect(run("application_pods_list", { slug: "orders", environmentId: ENVIRONMENT }, viewerKey)).rejects.toMatchObject({ code: "ARGOCD_LOGS_FORBIDDEN" })
        await expect(run("application_logs_get", { slug: "orders", environmentId: ENVIRONMENT, pod: "orders-1" }, viewerKey)).rejects.toMatchObject({ code: "ARGOCD_LOGS_FORBIDDEN" })
        expect(listPods).not.toHaveBeenCalled()
        expect(getLogs).not.toHaveBeenCalled()
    })

    it("given a MANAGER API key, when it asks for the pods, then they are read", async () => {
        await run("application_pods_list", { slug: "orders", environmentId: ENVIRONMENT }, context({ kind: "api_key", apiKeyId: "key-1" }, "MANAGER"))

        expect(listPods).toHaveBeenCalledWith(PROJECT, "orders", ENVIRONMENT)
    })

    it("given more lines than Argo CD is asked for, when the logs are asked, then the input is refused", () => {
        expect(() => tool("application_logs_get").inputSchema.parse({ slug: "orders", environmentId: ENVIRONMENT, pod: "orders-1", tailLines: 5001 })).toThrow()
    })

    it("given a backend and a run, when the logs of the run are asked, then those of its failed jobs are read for that backend", async () => {
        await run("build_run_logs_get", { backendId: BACKEND, runId: "41" })

        expect(getFailedRunLogs).toHaveBeenCalledWith(PROJECT, { backendId: BACKEND }, "41")
    })

    it("given both a frontend and a backend, or neither, when the logs of a run are asked, then it is refused before the provider is read", async () => {
        for (const owner of [{ backendId: BACKEND, frontendId: BACKEND }, {}]) {
            await expect(run("build_run_logs_get", { ...owner, runId: "41" })).rejects.toBeInstanceOf(BusinessException)
        }
        expect(getFailedRunLogs).not.toHaveBeenCalled()
    })
})
