import { PipelineStage, Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import UserCannotAccessThisOrganizationError from "../errors/UserCannotAccessThisOrganizationError"
import AiModel from "../models/AiModelModel"
import AiUsage from "../models/AiUsageModel"
import Backend from "../models/BackendModel"
import Domain from "../models/DomainModel"
import Frontend from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import SandboxUsage from "../models/SandboxUsageModel"
import User, { IUser } from "../models/UserModel"
import UserOrganization, { RoleInOrganization } from "../models/UserOrganizationModel"
import UserProject, { RoleInProject } from "../models/UserProjectModel"
import AiUsageService, {
    calculateAiUsageCost,
    componentPipeline,
    costsSpentThisMonth,
    ensureWithinTokenLimit,
    memberSeriesPipeline,
    membersMonthCostPipeline,
    membersMonthPipeline,
    periodStart,
    recordAiUsage,
    sandboxPipeline
} from "./AiUsageService"
import BaseAuthorizedService from "./BaseAuthorizedService"

type WithGates = {
    ensureAccessToProject: (projectId: unknown) => Promise<void>
    ensureInDomainScope: (projectId: unknown, domainId: unknown) => Promise<void>
    ensureWholeProject: () => Promise<void>
}

const user = { _id: new Types.ObjectId(), email: "ada@example.com" } as unknown as IUser
const organizationId = new Types.ObjectId()
const projectId = new Types.ObjectId()

/** What a query of mongoose answers to: awaited, narrowed to a session, or made lean. */
const thenable = <T>(value: T) => ({
    session: () => thenable(value),
    lean: () => Promise.resolve(value),
    then: (resolve: (value: T) => unknown) => resolve(value)
})

/**
 * Just enough of the aggregation language to run a pipeline over some documents in memory: its `$match` (equality,
 * membership of an array, `$gte`), then its `$group`. The tests have no MongoDB, and the equal split is arithmetic
 * worth checking on actual numbers.
 */
const evaluate = (expression: unknown, document: Record<string, unknown>): unknown => {
    if (typeof expression === "string" && expression.startsWith("$")) return document[expression.slice(1)]
    if (Array.isArray(expression)) return expression.map(item => evaluate(item, document))
    if (typeof expression !== "object" || expression === null) return expression
    const [[operator, raw]] = Object.entries(expression)
    const args = (Array.isArray(raw) ? raw : [raw]).map(arg => evaluate(arg, document))
    const numbers = args as number[]
    if (operator === "$divide") return numbers[0] / numbers[1]
    // As MongoDB: a missing operand makes the product null, which `$sum` then skips
    if (operator === "$multiply") return numbers.every(value => typeof value === "number") ? numbers.reduce((product, value) => product * value, 1) : null
    if (operator === "$add") return numbers.reduce((sum, value) => sum + value, 0)
    if (operator === "$max") return Math.max(...numbers)
    if (operator === "$size") return (args[0] as unknown[]).length
    if (operator === "$ifNull") return args[0] ?? args[1]
    if (operator === "$eq") return args[0] === args[1]
    if (operator === "$cond") return args[0] ? args[1] : args[2]
    throw new Error(`Operator not supported by the test: ${operator}`)
}

const matches = (filter: Record<string, unknown>, document: Record<string, unknown>) =>
    Object.entries(filter).every(([field, condition]) => {
        const value = document[field]
        if (condition instanceof Date || typeof condition !== "object" || condition === null || condition instanceof Types.ObjectId) {
            return Array.isArray(value) ? value.some(item => String(item) === String(condition)) : String(value) === String(condition)
        }
        const { $gte, $in } = condition as { $gte?: Date; $in?: unknown[] }
        if ($in) return $in.some(item => String(item) === String(value))
        if ($gte === undefined) throw new Error(`Condition not supported by the test: ${JSON.stringify(condition)}`)
        return value instanceof Date && value >= $gte
    })

const groupOver = (pipeline: PipelineStage[], documents: Record<string, unknown>[]) => {
    const filter = (pipeline.find(stage => "$match" in stage) as PipelineStage.Match).$match
    const matched = documents.filter(document => matches(filter, document))
    const group = (pipeline.find(stage => "$group" in stage) as PipelineStage.Group).$group
    return Object.fromEntries(
        Object.entries(group)
            .filter(([field]) => field !== "_id")
            .map(([field, accumulator]) => [
                field,
                matched.reduce((sum, document) => {
                    const value = evaluate((accumulator as { $sum: unknown }).$sum, document)
                    return typeof value === "number" ? sum + value : sum
                }, 0)
            ])
    )
}

const matchOf = (pipeline: PipelineStage[]) => (pipeline[0] as PipelineStage.Match).$match

const NO_SANDBOX = { commands: 0, execSeconds: 0, lifetimeSeconds: 0 }
const noSandboxSummary = { total: NO_SANDBOX, bySource: { agent: NO_SANDBOX, mission: NO_SANDBOX, preview: NO_SANDBOX } }

describe("AiUsageService", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] })
        vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"))
        const gates = BaseAuthorizedService.prototype as unknown as WithGates
        vi.spyOn(gates, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(gates, "ensureInDomainScope").mockResolvedValue(undefined)
        vi.spyOn(gates, "ensureWholeProject").mockResolvedValue(undefined)
        vi.spyOn(AiUsage, "aggregate").mockResolvedValue([] as never)
        vi.spyOn(SandboxUsage, "aggregate").mockResolvedValue([] as never)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    const service = () => new AiUsageService(user)

    describe("periodStart", () => {
        it("Given each period, when its start is asked, then it is 30 or 90 days back, the first of the month at midnight UTC, or none for all", () => {
            expect(periodStart("30d")).toEqual(new Date("2026-09-22T10:00:00.000Z"))
            expect(periodStart("90d")).toEqual(new Date("2026-07-24T10:00:00.000Z"))
            expect(periodStart("month")).toEqual(new Date("2026-10-01T00:00:00.000Z"))
            expect(periodStart("all")).toBeUndefined()
        })
    })

    describe("recordAiUsage", () => {
        beforeEach(() => {
            vi.spyOn(AiUsage, "create").mockResolvedValue({} as never)
        })

        describe("calculateAiUsageCost", () => {
            it("Given configured rates, when cached and regular tokens are counted, then it applies the matching rate per million tokens", async () => {
                vi.spyOn(AiModel, "findById").mockReturnValue(thenable({ tokenCosts: { input: 3, cachedInput: 0.3, output: 15 } }) as never)

                await expect(calculateAiUsageCost(new Types.ObjectId().toString(), { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 })).resolves.toEqual({
                    amount: 0.000396,
                    currency: "USD"
                })
            })

            it("Given euro rates, when the interaction cost is calculated, then it keeps the selected currency", async () => {
                vi.spyOn(AiModel, "findById").mockReturnValue(thenable({ tokenCosts: { input: 3, cachedInput: 0.3, output: 15, currency: "EUR" } }) as never)

                await expect(calculateAiUsageCost(new Types.ObjectId().toString(), { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 })).resolves.toEqual({
                    amount: 0.000396,
                    currency: "EUR"
                })
            })

            it("Given an unpriced or system AI, when the interaction is checked, then no cost is reported", async () => {
                vi.spyOn(AiModel, "findById").mockReturnValue(thenable({ tokenCosts: undefined }) as never)

                await expect(calculateAiUsageCost(new Types.ObjectId().toString(), { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 })).resolves.toBeUndefined()
                await expect(calculateAiUsageCost("system", { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 })).resolves.toBeUndefined()
                expect(AiModel.findById).toHaveBeenCalledTimes(1)
            })
        })

        it("Given a usage without its organization, when it is recorded, then the organization is read from the project", async () => {
            vi.spyOn(Project, "findById").mockReturnValue(thenable({ _id: projectId, organizationId }) as never)

            await recordAiUsage({ projectId: String(projectId), source: "assistant", inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 })

            expect(AiUsage.create).toHaveBeenCalledWith(
                expect.objectContaining({ organizationId, projectId: String(projectId), source: "assistant", inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 })
            )
        })

        it("Given a usage with its organization, when it is recorded, then the project is not read", async () => {
            const findById = vi.spyOn(Project, "findById")

            await recordAiUsage({ organizationId, projectId, source: "agent", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })

            expect(findById).not.toHaveBeenCalled()
            expect(AiUsage.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId, projectId }))
        })

        it("Given a round that spent no token, when it is recorded, then nothing is written", async () => {
            await recordAiUsage({ organizationId, projectId, source: "agent", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })

            expect(AiUsage.create).not.toHaveBeenCalled()
        })

        it("Given a project that no longer exists, when its usage is recorded, then it fails for the caller to log", async () => {
            vi.spyOn(Project, "findById").mockReturnValue(thenable(null) as never)

            await expect(recordAiUsage({ projectId, source: "assistant", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).rejects.toThrow()
            expect(AiUsage.create).not.toHaveBeenCalled()
        })
    })

    describe("the equal split among repositories", () => {
        const catalog = new Types.ObjectId()
        const cart = new Types.ObjectId()
        const catalogApi = new Types.ObjectId()
        const checkout = new Types.ObjectId()
        const documents = [
            // A job on two frontends and a backend, asked from the checkout domain: a third each.
            { domainId: checkout, frontendIds: [catalog, cart], backendIds: [catalogApi], inputTokens: 300, cachedInputTokens: 90, outputTokens: 30, createdAt: new Date("2026-10-20") },
            // A job on the catalog alone, from the same domain: all of it.
            { domainId: checkout, frontendIds: [catalog], backendIds: [], inputTokens: 50, cachedInputTokens: 0, outputTokens: 5, createdAt: new Date("2026-10-21") },
            // Another domain, on the cart alone: none of the catalog, the backend or the checkout domain.
            { domainId: new Types.ObjectId(), frontendIds: [cart], backendIds: [], inputTokens: 1_000, cachedInputTokens: 500, outputTokens: 100, createdAt: new Date("2026-10-21") },
            // The catalog and the backend again, but before the last 30 days.
            { domainId: checkout, frontendIds: [catalog], backendIds: [catalogApi], inputTokens: 4_000, cachedInputTokens: 0, outputTokens: 400, createdAt: new Date("2026-08-01") }
        ]

        it("Given jobs on several repositories, when a frontend's total is computed, then it counts an equal share of each job on it and nothing of the others", () => {
            expect(groupOver(componentPipeline("frontendIds", catalog, "30d"), documents)).toEqual({ inputTokens: 150, cachedInputTokens: 30, outputTokens: 15, costUSD: 0, costEUR: 0 })
        })

        it("Given a job on two frontends and a backend, when the backend's total is computed, then it counts a third", () => {
            expect(groupOver(componentPipeline("backendIds", catalogApi, "30d"), documents)).toEqual({ inputTokens: 100, cachedInputTokens: 30, outputTokens: 10, costUSD: 0, costEUR: 0 })
        })

        it("Given jobs on several repositories, when their domain's total is computed, then the domain counts all of them and nothing of another domain", () => {
            expect(groupOver(componentPipeline("domainId", checkout, "30d"), documents)).toEqual({ inputTokens: 350, cachedInputTokens: 90, outputTokens: 35, costUSD: 0, costEUR: 0 })
        })

        it("Given all time, when a frontend's total is computed, then the older jobs count too", () => {
            expect(groupOver(componentPipeline("frontendIds", catalog, "all"), documents)).toEqual({ inputTokens: 2_150, cachedInputTokens: 30, outputTokens: 215, costUSD: 0, costEUR: 0 })
        })

        it("Given a document with no list of backends, when the share is computed, then the missing list counts as empty", () => {
            expect(groupOver(componentPipeline("frontendIds", catalog, "all"), [{ frontendIds: [catalog, cart], inputTokens: 8, cachedInputTokens: 0, outputTokens: 2 }])).toEqual({
                inputTokens: 4,
                cachedInputTokens: 0,
                outputTokens: 1,
                costUSD: 0,
                costEUR: 0
            })
        })

        it("Given priced, legacy and unpriced jobs, when a frontend's total is computed, then the cost is shared as the tokens, by currency, the legacy one in USD", () => {
            const priced = [
                { frontendIds: [catalog, cart], inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, cost: 0.5, currency: "EUR" },
                { frontendIds: [catalog], inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, costUsd: 0.2 },
                { frontendIds: [catalog], inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, cost: 0.1, currency: "USD" },
                { frontendIds: [catalog], inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 }
            ]

            const totals = groupOver(componentPipeline("frontendIds", catalog, "all"), priced)

            expect(totals.costEUR).toBeCloseTo(0.25)
            expect(totals.costUSD).toBeCloseTo(0.3)
        })

        it("Given sandbox time on several repositories, when a frontend's usage is asked, then commands and seconds are shared as the tokens and an open lifetime counts nothing", async () => {
            vi.spyOn(Frontend, "findById").mockResolvedValue({ _id: catalog, projectId } as never)
            const sandboxTime = [
                { frontendIds: [catalog, cart], backendIds: [], commands: 1, execSeconds: 60, createdAt: new Date("2026-10-20") },
                { frontendIds: [catalog, cart], backendIds: [], commands: 0, execSeconds: 0, lifetimeSeconds: 600, createdAt: new Date("2026-10-20") },
                // Still alive: its lifetime is not known yet.
                { frontendIds: [catalog], backendIds: [], commands: 0, execSeconds: 0, createdAt: new Date("2026-10-21") }
            ]

            await service().forFrontend(String(catalog), "30d")

            expect(groupOver(vi.mocked(SandboxUsage.aggregate).mock.calls[0][0] as PipelineStage[], sandboxTime)).toEqual({ commands: 0.5, execSeconds: 30, lifetimeSeconds: 300 })
        })

        it("Given the sandbox time of a domain, when the pipeline is built, then the domain counts all of it, grouped by project and source", () => {
            expect(sandboxPipeline({ domainId: checkout }, "all")).toEqual([
                { $match: { domainId: checkout } },
                {
                    $group: {
                        _id: { projectId: "$projectId", source: "$source" },
                        commands: { $sum: "$commands" },
                        execSeconds: { $sum: "$execSeconds" },
                        lifetimeSeconds: { $sum: "$lifetimeSeconds" }
                    }
                }
            ])
        })

        it("Given shares that do not divide evenly, when a frontend's total is returned, then it is rounded once at the end", async () => {
            vi.spyOn(Frontend, "findById").mockResolvedValue({ _id: catalog, projectId } as never)
            vi.mocked(AiUsage.aggregate).mockResolvedValue([{ _id: null, inputTokens: 33.333333, cachedInputTokens: 0.5, outputTokens: 3.4999 }] as never)

            const summary = await service().forFrontend(String(catalog), "30d")

            expect(summary.total).toEqual({ inputTokens: 33, cachedInputTokens: 1, outputTokens: 3, costs: [] })
        })
    })

    describe("the period", () => {
        it("Given the last 30 days, when the pipeline is built, then it matches the id as an ObjectId and the documents from 30 days back", () => {
            const id = new Types.ObjectId()

            expect(matchOf(componentPipeline("backendIds", String(id), "30d"))).toEqual({ backendIds: id, createdAt: { $gte: new Date("2026-09-22T10:00:00.000Z") } })
        })

        it("Given all time, when the pipeline is built, then it matches no date", () => {
            const id = new Types.ObjectId()

            expect(matchOf(componentPipeline("domainId", id, "all"))).toEqual({ domainId: id })
        })
    })

    describe("forFrontend and forBackend", () => {
        const gate = () => vi.mocked((BaseAuthorizedService.prototype as unknown as WithGates).ensureAccessToProject)

        it("Given a frontend whose project the user cannot open, when its usage is asked, then the project of the frontend is checked and nothing is summed", async () => {
            const frontendId = new Types.ObjectId()
            const ownProject = new Types.ObjectId()
            vi.spyOn(Frontend, "findById").mockResolvedValue({ _id: frontendId, projectId: ownProject } as never)
            gate().mockRejectedValue(new Error("not your project"))

            await expect(service().forFrontend(String(frontendId), "30d")).rejects.toThrow("not your project")
            expect(gate()).toHaveBeenCalledWith(ownProject)
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a backend whose project the user cannot open, when its usage is asked, then the project of the backend is checked and nothing is summed", async () => {
            const backendId = new Types.ObjectId()
            const ownProject = new Types.ObjectId()
            vi.spyOn(Backend, "findById").mockResolvedValue({ _id: backendId, projectId: ownProject } as never)
            gate().mockRejectedValue(new Error("not your project"))

            await expect(service().forBackend(String(backendId), "30d")).rejects.toThrow("not your project")
            expect(gate()).toHaveBeenCalledWith(ownProject)
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a frontend outside the domains of a scoped member, when its usage is asked, then it is refused before anything is summed", async () => {
            const domainId = new Types.ObjectId()
            vi.spyOn(Frontend, "findById").mockResolvedValue({ _id: new Types.ObjectId(), projectId, domainId } as never)
            vi.mocked((BaseAuthorizedService.prototype as unknown as WithGates).ensureInDomainScope).mockRejectedValue(new Error("outside"))

            await expect(service().forFrontend(String(new Types.ObjectId()), "30d")).rejects.toThrow("outside")
            expect((BaseAuthorizedService.prototype as unknown as WithGates).ensureInDomainScope).toHaveBeenCalledWith(projectId, domainId)
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a backend that does not exist, when its usage is asked, then it answers not found", async () => {
            vi.spyOn(Backend, "findById").mockResolvedValue(null as never)

            await expect(service().forBackend(String(new Types.ObjectId()), "30d")).rejects.toMatchObject({ statusCode: 404 })
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })
    })

    describe("forDomain", () => {
        it("Given a domain that does not exist, when its usage is asked, then it answers not found", async () => {
            vi.spyOn(Domain, "findById").mockResolvedValue(null as never)

            await expect(service().forDomain(String(new Types.ObjectId()), "30d")).rejects.toMatchObject({ statusCode: 404 })
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a member confined to other domains, when the usage of this one is asked, then it is refused before anything is summed", async () => {
            const domainId = new Types.ObjectId()
            vi.spyOn(Domain, "findById").mockResolvedValue({ _id: domainId, projectId } as never)
            vi.mocked((BaseAuthorizedService.prototype as unknown as WithGates).ensureInDomainScope).mockRejectedValue(new Error("outside"))

            await expect(service().forDomain(String(domainId), "30d")).rejects.toThrow("outside")
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a domain, when its usage is asked, then the period and its total come back", async () => {
            const domainId = new Types.ObjectId()
            vi.spyOn(Domain, "findById").mockResolvedValue({ _id: domainId, projectId } as never)
            vi.mocked(AiUsage.aggregate).mockResolvedValue([{ _id: null, inputTokens: 1000, cachedInputTokens: 600, outputTokens: 80 }] as never)

            expect(await service().forDomain(String(domainId), "month")).toEqual({
                period: "month",
                since: new Date("2026-10-01T00:00:00.000Z"),
                total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 80, costs: [] },
                sandbox: noSandboxSummary
            })
        })
    })

    describe("forProject", () => {
        it("Given usage of the agent only, when the project's is asked, then it is split by source, the assistant at zero, and the total adds them", async () => {
            vi.mocked(AiUsage.aggregate).mockResolvedValue([{ _id: "agent", inputTokens: 500, cachedInputTokens: 200, outputTokens: 50 }] as never)

            const summary = await service().forProject(String(projectId), "all")

            expect(summary).toEqual({
                period: "all",
                since: undefined,
                total: { inputTokens: 500, cachedInputTokens: 200, outputTokens: 50, costs: [] },
                bySource: {
                    agent: { inputTokens: 500, cachedInputTokens: 200, outputTokens: 50, costs: [] },
                    mission: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costs: [] },
                    assistant: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costs: [] }
                },
                sandbox: noSandboxSummary
            })
            expect(matchOf(vi.mocked(AiUsage.aggregate).mock.calls[0][0] as PipelineStage[])).toEqual({ projectId })
        })

        it("Given usage priced in two currencies, when the project's is asked, then each source keeps its amounts and the total adds them by currency", async () => {
            vi.mocked(AiUsage.aggregate).mockResolvedValue([
                { _id: "agent", inputTokens: 500, cachedInputTokens: 0, outputTokens: 50, costUSD: 1.5, costEUR: 0 },
                { _id: "assistant", inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costUSD: 0.5, costEUR: 0.25 }
            ] as never)

            const summary = await service().forProject(String(projectId), "30d")

            expect(summary.bySource.agent.costs).toEqual([{ amount: 1.5, currency: "USD" }])
            expect(summary.bySource.assistant.costs).toEqual([
                { amount: 0.5, currency: "USD" },
                { amount: 0.25, currency: "EUR" }
            ])
            expect(summary.total.costs).toEqual([
                { amount: 2, currency: "USD" },
                { amount: 0.25, currency: "EUR" }
            ])
        })

        it("Given sandbox time of jobs, missions and previews, when the project's usage is asked, then it comes split by source and added up", async () => {
            vi.mocked(SandboxUsage.aggregate).mockResolvedValue([
                { _id: { projectId, source: "agent" }, commands: 3, execSeconds: 120.4, lifetimeSeconds: 900 },
                { _id: { projectId, source: "mission" }, commands: 1, execSeconds: 30, lifetimeSeconds: 0 },
                { _id: { projectId, source: "preview" }, commands: 0, execSeconds: 0, lifetimeSeconds: 600 }
            ] as never)

            const summary = await service().forProject(String(projectId), "30d")

            expect(summary.sandbox).toEqual({
                total: { commands: 4, execSeconds: 150, lifetimeSeconds: 1500 },
                bySource: {
                    agent: { commands: 3, execSeconds: 120, lifetimeSeconds: 900 },
                    mission: { commands: 1, execSeconds: 30, lifetimeSeconds: 0 },
                    preview: { commands: 0, execSeconds: 0, lifetimeSeconds: 600 }
                }
            })
            expect(matchOf(vi.mocked(SandboxUsage.aggregate).mock.calls[0][0] as PipelineStage[])).toEqual({ projectId, createdAt: { $gte: new Date("2026-09-22T10:00:00.000Z") } })
        })

        it("Given a member confined to some domains, when the project's usage is asked, then it is refused", async () => {
            vi.mocked((BaseAuthorizedService.prototype as unknown as WithGates).ensureWholeProject).mockRejectedValue(new Error("whole project only"))

            await expect(service().forProject(String(projectId), "30d")).rejects.toThrow("whole project only")
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })
    })

    describe("forOrganization", () => {
        const asRole = (role?: RoleInOrganization) => vi.spyOn(UserOrganization, "findOne").mockReturnValue(thenable(role ? { role } : null) as never)

        it("Given a plain member of the organization, when its usage is asked, then it is refused before anything is summed", async () => {
            asRole(RoleInOrganization.MEMBER)

            await expect(service().forOrganization(String(organizationId), "30d")).rejects.toBeInstanceOf(UserCannotAccessThisOrganizationError)
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a project that only ran live previews, when the organization's usage is asked, then it is listed with its sandbox time and no token", async () => {
            asRole(RoleInOrganization.ADMIN)
            const shop = new Types.ObjectId()
            const demo = new Types.ObjectId()
            vi.mocked(AiUsage.aggregate).mockResolvedValue([{ _id: shop, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 }] as never)
            vi.mocked(SandboxUsage.aggregate).mockResolvedValue([
                { _id: { projectId: shop, source: "agent" }, commands: 2, execSeconds: 40, lifetimeSeconds: 300 },
                { _id: { projectId: demo, source: "preview" }, commands: 0, execSeconds: 0, lifetimeSeconds: 3600 }
            ] as never)
            vi.spyOn(Project, "find").mockReturnValue(
                thenable([
                    { _id: shop, name: "Shop" },
                    { _id: demo, name: "Demo" }
                ]) as never
            )

            const summary = await service().forOrganization(String(organizationId), "30d")

            expect(summary.byProject.map(project => [project.name, project.inputTokens, project.sandbox])).toEqual([
                ["Shop", 10, { commands: 2, execSeconds: 40, lifetimeSeconds: 300 }],
                ["Demo", 0, { commands: 0, execSeconds: 0, lifetimeSeconds: 3600 }]
            ])
            expect(summary.sandbox.total).toEqual({ commands: 2, execSeconds: 40, lifetimeSeconds: 3900 })
            expect(summary.sandbox.bySource.preview).toEqual({ commands: 0, execSeconds: 0, lifetimeSeconds: 3600 })
        })

        it("Given someone outside the organization, when its usage is asked, then it is refused", async () => {
            asRole(undefined)

            await expect(service().forOrganization(String(organizationId), "30d")).rejects.toBeInstanceOf(UserCannotAccessThisOrganizationError)
        })

        it("Given an administrator, when the usage is asked, then each project comes with its name, most tokens first, and the total adds them", async () => {
            asRole(RoleInOrganization.ADMIN)
            const shop = new Types.ObjectId()
            const blog = new Types.ObjectId()
            const deleted = new Types.ObjectId()
            vi.mocked(AiUsage.aggregate).mockResolvedValue([
                { _id: blog, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
                { _id: shop, inputTokens: 900, cachedInputTokens: 300, outputTokens: 90 },
                { _id: deleted, inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 }
            ] as never)
            vi.spyOn(Project, "find").mockReturnValue(
                thenable([
                    { _id: shop, name: "Shop" },
                    { _id: blog, name: "Blog" }
                ]) as never
            )

            const summary = await service().forOrganization(String(organizationId), "90d")

            expect(summary.byProject).toEqual([
                { projectId: String(shop), name: "Shop", inputTokens: 900, cachedInputTokens: 300, outputTokens: 90, costs: [], sandbox: NO_SANDBOX },
                { projectId: String(blog), name: "Blog", inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costs: [], sandbox: NO_SANDBOX },
                { projectId: String(deleted), name: undefined, inputTokens: 5, cachedInputTokens: 0, outputTokens: 1, costs: [], sandbox: NO_SANDBOX }
            ])
            expect(summary.total).toEqual({ inputTokens: 1005, cachedInputTokens: 300, outputTokens: 101, costs: [] })
            expect(matchOf(vi.mocked(AiUsage.aggregate).mock.calls[0][0] as PipelineStage[])).toEqual({ organizationId, createdAt: { $gte: new Date("2026-07-24T10:00:00.000Z") } })
        })
    })

    describe("forMember", () => {
        const grace = new Types.ObjectId()
        const days = { from: "2026-10-01", to: "2026-10-23", granularity: "day" } as const
        const asProjectRole = (role?: RoleInProject, domainScoped = false) => vi.spyOn(UserProject, "findOne").mockReturnValue(thenable(role ? { role, domainScoped } : null) as never)
        const asOrganizationRole = (role?: RoleInOrganization) => {
            vi.spyOn(Project, "findById").mockReturnValue(thenable({ _id: projectId, organizationId }) as never)
            vi.spyOn(UserOrganization, "findOne").mockReturnValue(thenable(role ? { role } : null) as never)
        }

        it("Given a day range in a time zone, when the pipeline is built, then the index narrows a day wider and the local days are cut exactly, then summed by day", () => {
            const pipeline = memberSeriesPipeline(projectId, grace, { ...days, timeZone: "Europe/Rome" })
            const local = (format: string) => ({ $dateToString: { date: "$createdAt", format, timezone: "Europe/Rome" } })

            expect(pipeline).toEqual([
                { $match: { projectId, userId: grace, createdAt: { $gte: new Date("2026-09-30T00:00:00.000Z"), $lt: new Date("2026-10-25T00:00:00.000Z") } } },
                { $match: { $expr: { $and: [{ $gte: [local("%Y-%m-%d"), "2026-10-01"] }, { $lte: [local("%Y-%m-%d"), "2026-10-23"] }] } } },
                { $group: { _id: local("%Y-%m-%d"), inputTokens: { $sum: "$inputTokens" }, cachedInputTokens: { $sum: "$cachedInputTokens" }, outputTokens: { $sum: "$outputTokens" } } },
                { $sort: { _id: 1 } }
            ])
        })

        it("Given weeks or months and no time zone, when the pipeline is built, then the periods are ISO weeks or months in UTC", () => {
            const groupId = (granularity: "week" | "month") => (memberSeriesPipeline(projectId, grace, { ...days, granularity })[2] as PipelineStage.Group).$group._id

            expect(groupId("week")).toEqual({ $dateToString: { date: "$createdAt", format: "%G-W%V", timezone: "UTC" } })
            expect(groupId("month")).toEqual({ $dateToString: { date: "$createdAt", format: "%Y-%m", timezone: "UTC" } })
        })

        it("Given their own usage, when a plain member asks it, then each day with usage comes back rounded and the total adds them", async () => {
            const own = vi.spyOn(UserProject, "findOne")
            vi.mocked(AiUsage.aggregate).mockResolvedValue([
                { _id: "2026-10-02", inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
                { _id: "2026-10-20", inputTokens: 50.4, cachedInputTokens: 0, outputTokens: 5 }
            ] as never)

            expect(await service().forMember(String(projectId), { userId: String(user._id) }, days)).toEqual({
                projectId: String(projectId),
                userId: String(user._id),
                ...days,
                timeZone: "UTC",
                total: { inputTokens: 150, cachedInputTokens: 40, outputTokens: 15 },
                series: [
                    { period: "2026-10-02", inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
                    { period: "2026-10-20", inputTokens: 50, cachedInputTokens: 0, outputTokens: 5 }
                ]
            })
            expect(own).not.toHaveBeenCalled()
        })

        it("Given another member by email, when a plain member asks, then it is refused before the email is looked up", async () => {
            asProjectRole(RoleInProject.MEMBER)
            asOrganizationRole(RoleInOrganization.MEMBER)
            const lookup = vi.spyOn(User, "findOne")

            await expect(service().forMember(String(projectId), { email: "grace@example.com" }, days)).rejects.toMatchObject({ code: "PROJECT_OWNER_REQUIRED", statusCode: 403 })
            expect(lookup).not.toHaveBeenCalled()
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given an owner confined to some domains, when they ask another member's usage, then it is refused", async () => {
            asProjectRole(RoleInProject.OWNER, true)
            asOrganizationRole(undefined)

            await expect(service().forMember(String(projectId), { userId: String(grace) }, days)).rejects.toMatchObject({ statusCode: 403 })
        })

        it("Given an owner, when they ask a member's usage by email, then the email is matched lower case and their usage summed", async () => {
            asProjectRole(RoleInProject.OWNER)
            const lookup = vi.spyOn(User, "findOne").mockReturnValue(thenable({ _id: grace }) as never)

            const usage = await service().forMember(String(projectId), { email: "Grace@Example.com" }, days)

            expect(lookup).toHaveBeenCalledWith({ email: "grace@example.com" }, { _id: 1 })
            expect(usage.userId).toBe(String(grace))
            expect(matchOf(vi.mocked(AiUsage.aggregate).mock.calls[0][0] as PipelineStage[])).toMatchObject({ projectId, userId: grace })
        })

        it("Given an administrator of the organization outside the project, when they ask a member's usage, then it is let through", async () => {
            asProjectRole(undefined)
            asOrganizationRole(RoleInOrganization.ADMIN)

            await expect(service().forMember(String(projectId), { userId: String(grace) }, days)).resolves.toMatchObject({ userId: String(grace), series: [] })
        })

        it("Given an email nobody signs in with, when an owner asks, then it answers not found", async () => {
            asProjectRole(RoleInProject.OWNER)
            vi.spyOn(User, "findOne").mockReturnValue(thenable(null) as never)

            await expect(service().forMember(String(projectId), { email: "nobody@example.com" }, days)).rejects.toMatchObject({ statusCode: 404 })
            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a project API key, when it asks a member's usage, then it is refused: there is nobody behind it", async () => {
            const apiKey = { _id: new Types.ObjectId(), email: "api-key:1", apiKeyId: "1", restrictedToProjectIds: [String(projectId)] } as unknown as IUser

            await expect(new AiUsageService(apiKey).forMember(String(projectId), { userId: String(grace) }, days)).rejects.toMatchObject({ statusCode: 403 })
        })

        it("Given a last day before the first, or a daily series longer than a year, when it is asked, then it is refused; by week the two years are let through", async () => {
            const own = { userId: String(user._id) }

            await expect(service().forMember(String(projectId), own, { ...days, from: "2026-10-23", to: "2026-10-22" })).rejects.toMatchObject({ code: "AI_USAGE_RANGE_INVALID", statusCode: 400 })
            await expect(service().forMember(String(projectId), own, { ...days, from: "2025-01-01", to: "2026-01-02" })).rejects.toMatchObject({ code: "AI_USAGE_RANGE_INVALID" })
            await expect(service().forMember(String(projectId), own, { ...days, from: "2025-01-01", to: "2026-01-01" })).resolves.toBeDefined()
            await expect(service().forMember(String(projectId), own, { from: "2024-10-23", to: "2026-10-23", granularity: "week" })).resolves.toBeDefined()
        })
    })

    describe("the monthly limit of a member", () => {
        const ada = user._id
        const grace = new Types.ObjectId()

        it("Given usage of several members, projects and months, when a member's month is summed, then only theirs in the project since the first of the month counts, input and output", () => {
            const documents = [
                { projectId, userId: ada, inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 100, createdAt: new Date("2026-10-01T00:00:00.000Z") },
                { projectId, userId: ada, inputTokens: 500, cachedInputTokens: 0, outputTokens: 50, createdAt: new Date("2026-10-21") },
                // Another member, another project, the month before: none of them
                { projectId, userId: grace, inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 900, createdAt: new Date("2026-10-21") },
                { projectId: new Types.ObjectId(), userId: ada, inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 900, createdAt: new Date("2026-10-21") },
                { projectId, userId: ada, inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 900, createdAt: new Date("2026-09-30T23:59:59.000Z") }
            ]

            expect(groupOver(membersMonthPipeline(projectId, [ada]), documents)).toEqual({ tokens: 1_650 })
        })

        it("Given a member's month, when its cost is summed, then only the priced usage counts, by currency, an entry from before the currency in USD", () => {
            const [match, group] = membersMonthCostPipeline(projectId, [ada]) as [PipelineStage.Match, PipelineStage.Group]

            expect(match.$match).toMatchObject({ projectId, $or: [{ cost: { $type: "number" } }, { costUsd: { $type: "number" } }], createdAt: { $gte: new Date("2026-10-01T00:00:00.000Z") } })
            expect(group.$group._id).toEqual({ userId: "$userId", currency: { $ifNull: ["$currency", "USD"] } })
            expect(groupOver([{ $match: {} }, group], [{ cost: 0.75 }, { costUsd: 0.25 }])).toEqual({ amount: 1 })
        })

        it("Given costs in two currencies, when they are read, then each member gets one amount per currency", async () => {
            vi.mocked(AiUsage.aggregate).mockResolvedValue([
                { _id: { userId: ada, currency: "EUR" }, amount: 0.1 + 0.2 },
                { _id: { userId: ada, currency: "USD" }, amount: 2 }
            ] as never)

            const costs = await costsSpentThisMonth(projectId, [ada])

            expect(costs.get(String(ada))).toEqual([
                { amount: 0.3, currency: "EUR" },
                { amount: 2, currency: "USD" }
            ])
            expect(await costsSpentThisMonth(projectId, [])).toEqual(new Map())
        })

        const withLimit = (aiTokenLimit?: number) => vi.spyOn(UserProject, "findOne").mockReturnValue(thenable(aiTokenLimit === undefined ? {} : { aiTokenLimit }) as never)
        const spent = (tokens: number) => vi.mocked(AiUsage.aggregate).mockResolvedValue([{ _id: ada, tokens }] as never)

        it("Given a member with no limit, when an answer or a job starts, then nothing is summed", async () => {
            withLimit()

            await ensureWithinTokenLimit(projectId, ada)

            expect(AiUsage.aggregate).not.toHaveBeenCalled()
        })

        it("Given a member below their limit, when an answer or a job starts, then it is let through", async () => {
            withLimit(10_000)
            spent(9_999)

            await expect(ensureWithinTokenLimit(projectId, ada)).resolves.toBeUndefined()
        })

        it("Given a member who spent their limit, when an answer or a job starts, then it is refused until next month", async () => {
            withLimit(10_000)
            spent(10_000)

            await expect(ensureWithinTokenLimit(projectId, ada)).rejects.toMatchObject({ code: "AI_TOKEN_LIMIT_REACHED", statusCode: 429 })
        })

        it("Given a limit of zero, when a member who spent nothing starts an answer, then it is refused", async () => {
            withLimit(0)

            await expect(ensureWithinTokenLimit(projectId, ada)).rejects.toMatchObject({ code: "AI_TOKEN_LIMIT_REACHED" })
        })
    })
})
