import { ObjectId, Types } from "mongoose"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The service reaches the application instance for its logger; importing the real one would boot
// Fastify and connect to the configured database.
vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

// A standalone mongod cannot open a transaction, and runInTransaction already knows to skip one:
// saying so here keeps the cascade under test instead of the transaction plumbing.
vi.mock("../plugins/noSQL", () => ({ isReplicaSet: false }))

import BackendDeployment from "../models/BackendDeploymentModel"
import Backend from "../models/BackendModel"
import Deployment from "../models/DeploymentModel"
import DeploymentToCanaryUsers from "../models/DeploymentsToCanaryUsersModel"
import Environment from "../models/EnvironmentModel"
import Frontend from "../models/FrontendModel"
import GlobalVariable from "../models/GlobalVariableModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import { KUBE_GREEN_DEFAULT_DAYS } from "../types/KubeGreen"
import EnvironmentService, { normalizeIpAllowList, normalizeKubeGreen } from "./EnvironmentService"

const newId = () => new Types.ObjectId() as unknown as ObjectId

/**
 * Deleting an environment has to take its contents with it.
 *
 * The rows are not reachable through the API once their environment is gone - the project-level
 * reader filters variables by the environments that still exist, and the deployment reader refuses
 * an environment it cannot find - so an orphan is invisible from the outside and only a test at this
 * level can see whether it was removed. That is also why there is no end-to-end test for this.
 */
describe("EnvironmentService cascade on delete", () => {
    const environmentId = newId()
    const otherEnvironmentId = newId()
    const deploymentIds = [newId(), newId()]

    /** The filters each model was asked to delete by, in the order the calls were made. */
    let calls: { model: string; filter: Record<string, unknown> }[]
    /** The updates that take the environments out of the CPU and memory the applications set apart */
    let pulls: { model: string; filter: Record<string, unknown>; update: Record<string, unknown> }[]

    const backend = () => {
        const instance = new EnvironmentService({ _id: newId() } as never)
        // Authorization is BaseAuthorizedService's job and has its own tests; here it would only
        // stand between the test and the cascade. Cast because the method is protected.
        const gate = instance as unknown as { ensureAccessToEnvironment: () => Promise<boolean>; ensureWholeProjectOfEnvironment: () => Promise<void> }
        vi.spyOn(gate, "ensureAccessToEnvironment").mockResolvedValue(true)
        vi.spyOn(gate, "ensureWholeProjectOfEnvironment").mockResolvedValue()
        return instance
    }

    beforeEach(() => {
        calls = []
        pulls = []
        vi.spyOn(Environment, "find").mockResolvedValue([] as never)

        const record = (model: string) => (filter: Record<string, unknown>) => {
            calls.push({ model, filter })
            return Promise.resolve({ acknowledged: true, deletedCount: 1 })
        }

        vi.spyOn(Environment, "findById").mockReturnValue({
            session: () => Promise.resolve({ _id: environmentId })
        } as never)
        vi.spyOn(Deployment, "find").mockReturnValue(Promise.resolve(deploymentIds.map(_id => ({ _id }))) as never)

        vi.spyOn(Deployment, "deleteMany").mockImplementation(record("Deployment") as never)
        vi.spyOn(DeploymentToCanaryUsers, "deleteMany").mockImplementation(record("DeploymentToCanaryUsers") as never)
        vi.spyOn(GlobalVariable, "deleteMany").mockImplementation(record("GlobalVariable") as never)
        vi.spyOn(BackendDeployment, "deleteMany").mockImplementation(record("BackendDeployment") as never)
        vi.spyOn(Environment, "deleteMany").mockImplementation(record("Environment") as never)
        const pull = (model: string) => (filter: Record<string, unknown>, update: Record<string, unknown>) => {
            pulls.push({ model, filter, update })
            return Promise.resolve({ acknowledged: true, modifiedCount: 1 })
        }
        vi.spyOn(Backend, "updateMany").mockImplementation(pull("Backend") as never)
        vi.spyOn(Frontend, "updateMany").mockImplementation(pull("Frontend") as never)
        vi.spyOn(MaintenanceAgent, "updateMany").mockImplementation(pull("MaintenanceAgent") as never)
    })

    it("given an environment with deployments, variables and reported backend deploys, when it is deleted, then they all go with it", async () => {
        await backend().deleteSingle(environmentId)

        expect(calls.map(call => call.model)).toEqual(["DeploymentToCanaryUsers", "Deployment", "GlobalVariable", "BackendDeployment", "Environment"])
    })

    it("given an environment is deleted, then the canary enrolments are removed before the deployments that own them", async () => {
        await backend().deleteSingle(environmentId)

        const enrolments = calls.findIndex(call => call.model === "DeploymentToCanaryUsers")
        const deployments = calls.findIndex(call => call.model === "Deployment")

        // Once the deployments are gone there is nothing left to find their enrolments by.
        expect(enrolments).toBeLessThan(deployments)
    })

    it("given an environment is deleted, then every delete is scoped to that environment alone", async () => {
        await backend().deleteSingle(environmentId)

        const scoped = (model: string) => calls.find(call => call.model === model)?.filter

        expect(scoped("Deployment")).toEqual({ environmentId: { $in: [environmentId] } })
        expect(scoped("GlobalVariable")).toEqual({ environmentId: { $in: [environmentId] } })
        expect(scoped("BackendDeployment")).toEqual({ environmentId: { $in: [environmentId] } })
        expect(scoped("Environment")).toEqual({ _id: { $in: [environmentId] } })
        expect(scoped("DeploymentToCanaryUsers")).toEqual({ deploymentId: { $in: deploymentIds } })
    })

    it("given an environment is deleted, then the backends, frontends and maintenance agents lose the CPU, the memory and the version they set apart for it", async () => {
        await backend().deleteSingle(environmentId)

        expect(pulls.map(pull => pull.model)).toEqual(["Backend", "Frontend", "MaintenanceAgent"])
        for (const pull of pulls) {
            expect(pull.filter).toEqual({ $or: [{ "environmentResources.environmentId": { $in: [environmentId] } }, { "environmentVersions.environmentId": { $in: [environmentId] } }] })
            expect(pull.update).toEqual({ $pull: { environmentResources: { environmentId: { $in: [environmentId] } }, environmentVersions: { environmentId: { $in: [environmentId] } } } })
        }
    })

    it("given an environment that does not exist, when it is deleted, then nothing is deleted", async () => {
        vi.spyOn(Environment, "findById").mockReturnValue({ session: () => Promise.resolve(null) } as never)

        await expect(backend().deleteSingle(environmentId)).rejects.toThrow()
        expect(calls).toEqual([])
    })

    it("given several environments, when they are deleted together, then one pass covers all of them", async () => {
        await backend().deleteMultiple([environmentId, otherEnvironmentId])

        expect(calls.map(call => call.model)).toEqual(["DeploymentToCanaryUsers", "Deployment", "GlobalVariable", "BackendDeployment", "Environment"])
        expect(calls.find(call => call.model === "Environment")?.filter).toEqual({ _id: { $in: [environmentId, otherEnvironmentId] } })
    })

    it("given no ids at all, when a bulk delete is asked for, then it is refused before touching anything", async () => {
        await expect(backend().deleteMultiple([])).rejects.toThrow("Ids array is required")
        expect(calls).toEqual([])
    })
})

describe("normalizeIpAllowList", () => {
    it("given ranges with blanks, spaces and repeats, when they are normalized, then each one is kept once, trimmed", () => {
        expect(normalizeIpAllowList([" 203.0.113.7 ", "", "203.0.113.7", "2001:db8::/32"])).toEqual(["203.0.113.7", "2001:db8::/32"])
    })

    it.each([
        ["null", null],
        ["undefined", undefined]
    ])("given %s, when it is normalized, then every address is allowed", (_case, value) => {
        expect(normalizeIpAllowList(value)).toEqual([])
    })

    it.each([
        ["a host name", ["example.com"]],
        ["a prefix too long", ["203.0.113.0/33"]],
        ["no list at all", "203.0.113.7"]
    ])("given %s, when it is normalized, then it is refused", (_case, value) => {
        expect(() => normalizeIpAllowList(value)).toThrow(expect.objectContaining({ code: "ENVIRONMENT_IP_ALLOWLIST_INVALID" }))
    })

    it("given more ranges than an environment takes, when they are normalized, then they are refused", () => {
        const ranges = Array.from({ length: 101 }, (_, index) => `10.0.${index}.0/24`)

        expect(() => normalizeIpAllowList(ranges)).toThrow(expect.objectContaining({ code: "ENVIRONMENT_IP_ALLOWLIST_TOO_LONG" }))
    })
})

describe("normalizeKubeGreen", () => {
    it("given a schedule with blanks and repeats, when it is normalized, then it is trimmed and filled in with the defaults", () => {
        expect(normalizeKubeGreen({ enabled: true, excludeApplications: [" orders-api ", "", "orders-api"] })).toEqual({
            enabled: true,
            days: KUBE_GREEN_DEFAULT_DAYS(),
            timeZone: "Europe/Rome",
            suspendDeployments: true,
            suspendStatefulSets: true,
            suspendCronJobs: false,
            excludeApplications: ["orders-api"]
        })
    })

    it("given some days of the week, when they are normalized, then every day is there, Sunday first, the days left out awake all day", () => {
        const { days } = normalizeKubeGreen({
            enabled: true,
            days: [
                { weekday: 5, awake: true, wakeUpAt: " 08:00 ", sleepAt: "18:00" },
                { weekday: 6, awake: false }
            ]
        })

        expect(days).toEqual([
            { weekday: 0, awake: true, wakeUpAt: "", sleepAt: "" },
            { weekday: 1, awake: true, wakeUpAt: "", sleepAt: "" },
            { weekday: 2, awake: true, wakeUpAt: "", sleepAt: "" },
            { weekday: 3, awake: true, wakeUpAt: "", sleepAt: "" },
            { weekday: 4, awake: true, wakeUpAt: "", sleepAt: "" },
            { weekday: 5, awake: true, wakeUpAt: "08:00", sleepAt: "18:00" },
            { weekday: 6, awake: false, wakeUpAt: "", sleepAt: "" }
        ])
    })

    it.each([
        ["a time with no minutes", { days: [{ weekday: 1, awake: true, sleepAt: "20" }] }],
        ["a wake up past midnight", { days: [{ weekday: 1, awake: true, wakeUpAt: "24:00" }] }],
        ["a day going to sleep before it wakes up", { days: [{ weekday: 1, awake: true, wakeUpAt: "20:00", sleepAt: "08:00" }] }],
        ["an unknown time zone", { timeZone: "Europe/Atlantis" }]
    ])("given %s, when it is on, then it is refused", (_case, value) => {
        expect(() => normalizeKubeGreen({ enabled: true, ...value })).toThrow(expect.objectContaining({ code: "ENVIRONMENT_KUBE_GREEN_INVALID" }))
    })

    it("given a day asleep all day, when it is normalized, then its times are not checked", () => {
        expect(normalizeKubeGreen({ enabled: true, days: [{ weekday: 0, awake: false, wakeUpAt: "20:00", sleepAt: "08:00" }] }).days[0]).toMatchObject({ awake: false })
    })

    it("given a schedule that is off, when it is normalized, then it is kept as it is, even when it would not parse", () => {
        expect(normalizeKubeGreen({ enabled: false, timeZone: "Europe/Atlantis" })).toMatchObject({ enabled: false, timeZone: "Europe/Atlantis" })
    })
})

describe("EnvironmentService.update, IP allow list", () => {
    const environmentId = newId()

    const service = () => {
        const instance = new EnvironmentService({ _id: newId() } as never)
        const gate = instance as unknown as { ensureAccessToEnvironment: () => Promise<boolean>; ensureWholeProjectOfEnvironment: () => Promise<void> }
        vi.spyOn(gate, "ensureAccessToEnvironment").mockResolvedValue(true)
        vi.spyOn(gate, "ensureWholeProjectOfEnvironment").mockResolvedValue()
        return instance
    }
    const stored = (ipAllowList?: string[]) => vi.spyOn(Environment, "findById").mockResolvedValue({ _id: environmentId, ipAllowList } as never)
    const saved = () => vi.spyOn(Environment, "findOneAndUpdate").mockResolvedValue({ _id: environmentId } as never)

    it("given an environment that had an allow list, when it is emptied, then the empty list is saved and keeps its Middleware open", async () => {
        stored(["203.0.113.0/24"])
        const update = saved()

        await service().update(environmentId, { ipAllowList: [] } as never)

        expect(update.mock.calls[0][1]).toEqual({ ipAllowList: [] })
    })

    it("given an environment that never had an allow list, when an empty one is sent, then it is left out", async () => {
        stored(undefined)
        const update = saved()

        await service().update(environmentId, { name: "Production", ipAllowList: [] } as never)

        expect(update.mock.calls[0][1]).toEqual({ name: "Production" })
    })

    it("given ranges, when they are saved, then they are normalized", async () => {
        stored(undefined)
        const update = saved()

        await service().update(environmentId, { ipAllowList: [" 203.0.113.7 ", "203.0.113.7"] } as never)

        expect(update.mock.calls[0][1]).toEqual({ ipAllowList: ["203.0.113.7"] })
    })
})

describe("EnvironmentService.update, logging", () => {
    const environmentId = newId()

    const service = () => {
        const instance = new EnvironmentService({ _id: newId() } as never)
        const gate = instance as unknown as { ensureAccessToEnvironment: () => Promise<boolean>; ensureWholeProjectOfEnvironment: () => Promise<void> }
        vi.spyOn(gate, "ensureAccessToEnvironment").mockResolvedValue(true)
        vi.spyOn(gate, "ensureWholeProjectOfEnvironment").mockResolvedValue()
        return instance
    }
    const saved = () => vi.spyOn(Environment, "findOneAndUpdate").mockResolvedValue({ _id: environmentId } as never)

    it("given a log level written in capitals and JSON logs, when they are saved, then the level is saved in lowercase", async () => {
        const update = saved()

        await service().update(environmentId, { logLevel: " DEBUG ", logJson: true } as never)

        expect(update.mock.calls[0][1]).toEqual({ logLevel: "debug", logJson: true })
    })

    it("given a log level that is not one, when it is saved, then it is refused before anything is written", async () => {
        const update = saved()

        await expect(service().update(environmentId, { logLevel: "verbose" } as never)).rejects.toMatchObject({ code: "ENVIRONMENT_LOG_LEVEL_INVALID" })
        expect(update).not.toHaveBeenCalled()
    })
})
