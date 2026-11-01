import { beforeEach, describe, expect, it, vi } from "vitest"
import { BusinessException } from "../../errors/BusinessException"
import { MCP_SCOPE_READ } from "../../utils/oauthConfig"
import { McpSession, McpToolContext } from "../toolDefinition"
import { logTools } from "./logTools"

const listPods = vi.fn()
const getLogs = vi.fn()
const searchLogs = vi.fn()
const environmentStatus = vi.fn()
const rollout = vi.fn()
const rolloutLogs = vi.fn()
const getFailedRunLogs = vi.fn()
const buildOf = vi.fn()
const environments = vi.fn()
const principals: unknown[] = []

vi.mock("../../service/ArgoCdService", () => ({
    default: class {
        constructor(principal: unknown) {
            principals.push(principal)
        }
        listPods = (...args: unknown[]) => listPods(...args)
        getLogs = (...args: unknown[]) => getLogs(...args)
        searchLogs = (...args: unknown[]) => searchLogs(...args)
        environmentStatus = (...args: unknown[]) => environmentStatus(...args)
        rollout = (...args: unknown[]) => rollout(...args)
        rolloutLogs = (...args: unknown[]) => rolloutLogs(...args)
    }
}))
vi.mock("../../service/BuildStatusService", () => ({
    default: class {
        getFailedRunLogs = (...args: unknown[]) => getFailedRunLogs(...args)
        buildOf = (...args: unknown[]) => buildOf(...args)
    }
}))
vi.mock("../../service/EnvironmentService", () => ({
    default: class {
        getByProjectId = (...args: unknown[]) => environments(...args)
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
        for (const mock of [listPods, getLogs, searchLogs, environmentStatus, rollout, rolloutLogs, getFailedRunLogs, buildOf, environments]) mock.mockReset().mockResolvedValue([])
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

        expect(listPods).toHaveBeenCalledWith(PROJECT, "orders", ENVIRONMENT, { details: true })
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

    it("given environments and a filter, when the logs are searched, then the console searches them in its project with what was asked", async () => {
        await run("application_logs_search", { environmentIds: [ENVIRONMENT], filter: "Interrupted", exclude: "health", minLevel: "warn" })

        expect(searchLogs).toHaveBeenCalledWith(PROJECT, { environmentIds: [ENVIRONMENT], filter: "Interrupted", exclude: "health", minLevel: "warn" })
    })

    it("given a level that is none, when the logs are searched, then the input is refused", () => {
        expect(() => tool("application_logs_search").inputSchema.parse({ environmentIds: [ENVIRONMENT], minLevel: "loud" })).toThrow()
    })

    it("given no environment, when the status is asked, then every environment of the project is read", async () => {
        environments.mockResolvedValue([{ _id: ENVIRONMENT }, { _id: BACKEND }])

        await run("environment_status", {})

        expect(environmentStatus.mock.calls).toEqual([
            [PROJECT, ENVIRONMENT],
            [PROJECT, BACKEND]
        ])
    })

    it("given a VIEWER API key, when it searches the logs or asks the status, then it is refused before Argo CD is read", async () => {
        const viewerKey = context({ kind: "api_key", apiKeyId: "key-1" }, "VIEWER")

        await expect(run("application_logs_search", { environmentIds: [ENVIRONMENT] }, viewerKey)).rejects.toMatchObject({ code: "ARGOCD_LOGS_FORBIDDEN" })
        await expect(run("environment_status", { environmentIds: [ENVIRONMENT] }, viewerKey)).rejects.toMatchObject({ code: "ARGOCD_LOGS_FORBIDDEN" })
        expect(searchLogs).not.toHaveBeenCalled()
        expect(environmentStatus).not.toHaveBeenCalled()
    })

    describe("deployment_wait", () => {
        const healthy = { tracked: true, done: true, failed: false, applications: [{ slug: "orders", state: "healthy", updated: true }] }
        const crashing = { tracked: true, done: false, failed: false, applications: [{ slug: "orders", state: "degraded", updated: true, pods: [{ name: "orders-1", restarts: 3 }] }] }

        it("given a deploy rolled out already, when it is waited for, then it answers at once, done, without reading logs", async () => {
            rollout.mockResolvedValue(healthy)

            const result = await run("deployment_wait", { deploymentIds: [ENVIRONMENT] })

            expect(result).toEqual({ done: true, timedOut: false, deployments: [{ deploymentId: ENVIRONMENT, ...healthy }] })
            expect(rollout).toHaveBeenCalledTimes(1)
            expect(rolloutLogs).not.toHaveBeenCalled()
        })

        it("given a deploy left crashing, when it is waited for, then it stops there with the last lines of its pods", async () => {
            rollout.mockResolvedValue(crashing)
            rolloutLogs.mockResolvedValue([{ application: "orders", pod: "orders-1", previous: true, lines: ["Error: boom"] }])

            const result = (await run("deployment_wait", { deploymentIds: [ENVIRONMENT], domainId: BACKEND })) as { done: boolean; deployments: Array<{ logs?: unknown[] }> }

            expect(result.done).toBe(false)
            expect(result.deployments[0].logs).toEqual([{ application: "orders", pod: "orders-1", previous: true, lines: ["Error: boom"] }])
            expect(rollout).toHaveBeenCalledWith(PROJECT, ENVIRONMENT, BACKEND)
            expect(rolloutLogs).toHaveBeenCalledWith(PROJECT, ENVIRONMENT, crashing.applications)
        })

        it("given a deploy still rolling out, when it is waited for, then it reads Argo CD again until it is done", async () => {
            rollout.mockResolvedValueOnce({ ...crashing, applications: [{ slug: "orders", state: "progressing", updated: true }] }).mockResolvedValue(healthy)

            const result = (await run("deployment_wait", { deploymentIds: [ENVIRONMENT], seconds: 1 })) as { done: boolean; timedOut: boolean }

            expect(result).toMatchObject({ done: true, timedOut: false })
            expect(rollout).toHaveBeenCalledTimes(2)
        })

        it("given Argo CD failing for a moment while a deploy rolls out, when it is waited for, then the wait goes on with what it read last", async () => {
            rollout.mockResolvedValueOnce({ ...crashing, applications: [{ slug: "orders", state: "progressing", updated: true }] }).mockRejectedValueOnce(new Error("Argo CD unreachable"))

            await expect(run("deployment_wait", { deploymentIds: [ENVIRONMENT], seconds: 1 })).resolves.toMatchObject({ done: false, timedOut: true })
        })

        it("given a VIEWER API key, when it waits for a crashing deploy, then it gets the states without the logs", async () => {
            rollout.mockResolvedValue(crashing)

            await run("deployment_wait", { deploymentIds: [ENVIRONMENT] }, context({ kind: "api_key", apiKeyId: "key-1" }, "VIEWER"))

            expect(rolloutLogs).not.toHaveBeenCalled()
        })
    })

    describe("build_wait", () => {
        it("given a version already registered, when its build is waited for, then it answers at once", async () => {
            buildOf.mockResolvedValue({ version: "1.2.0", state: "registered" })

            await expect(run("build_wait", { backendId: BACKEND, version: "1.2.0" })).resolves.toEqual({ version: "1.2.0", state: "registered", timedOut: false })
            expect(buildOf).toHaveBeenCalledWith(PROJECT, { backendId: BACKEND }, "1.2.0")
        })

        it("given a failed build, when it is waited for, then the end of the logs of its failed jobs comes with it", async () => {
            buildOf.mockResolvedValue({ version: "1.2.0", state: "failed", run: { id: "41", status: "FAILED" } })
            getFailedRunLogs.mockResolvedValue([{ name: "build", log: `${"x".repeat(7000)}npm ERR! missing script` }])

            const result = (await run("build_wait", { frontendId: BACKEND, version: "1.2.0" })) as { logs: Array<{ log: string }> }

            expect(getFailedRunLogs).toHaveBeenCalledWith(PROJECT, { frontendId: BACKEND }, "41")
            expect(result.logs[0].log).toHaveLength(6000)
            expect(result.logs[0].log.endsWith("npm ERR! missing script")).toBe(true)
        })

        it("given a build still running when the time is up, when it is waited for, then it says so", async () => {
            buildOf.mockResolvedValue({ version: "1.2.0", state: "running" })

            await expect(run("build_wait", { backendId: BACKEND, version: "1.2.0", seconds: 1 })).resolves.toMatchObject({ state: "running", timedOut: true })
        })

        it("given both a frontend and a backend, when a build is waited for, then it is refused before the provider is read", async () => {
            await expect(run("build_wait", { backendId: BACKEND, frontendId: BACKEND, version: "1.2.0" })).rejects.toMatchObject({ code: "BUILD_RUN_OWNER_INVALID" })
            expect(buildOf).not.toHaveBeenCalled()
        })
    })
})
