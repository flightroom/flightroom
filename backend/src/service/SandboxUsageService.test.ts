import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Project from "../models/ProjectModel"
import SandboxUsage from "../models/SandboxUsageModel"
import { closeSandboxLifetime, openSandboxLifetime, recordSandboxUsage } from "./SandboxUsageService"

const organizationId = new Types.ObjectId()
const projectId = new Types.ObjectId()
const CONVERSATION = "65f1a2b3c4d5e6f708192a3b"

/** What a query of mongoose answers to: made lean, or awaited. */
const query = <T>(value: T) => ({ lean: () => Promise.resolve(value), then: (resolve: (value: T) => unknown) => resolve(value) })

describe("SandboxUsageService", () => {
    beforeEach(() => {
        vi.spyOn(SandboxUsage, "create").mockResolvedValue({} as never)
        vi.spyOn(SandboxUsage, "updateOne").mockResolvedValue({} as never)
    })

    afterEach(() => vi.restoreAllMocks())

    it("Given a command without its organization, when it is recorded, then the organization is read from the project", async () => {
        vi.spyOn(Project, "findById").mockReturnValue(query({ _id: projectId, organizationId }) as never)

        await recordSandboxUsage({ projectId: String(projectId), source: "agent", conversationId: CONVERSATION, commands: 1, execSeconds: 4.2 })

        expect(SandboxUsage.create).toHaveBeenCalledWith({ organizationId, projectId: String(projectId), source: "agent", conversationId: CONVERSATION, commands: 1, execSeconds: 4.2 })
    })

    it("Given a project with no organization, when a usage is recorded, then it throws for the caller to log", async () => {
        vi.spyOn(Project, "findById").mockReturnValue(query(null) as never)

        await expect(recordSandboxUsage({ projectId, source: "preview", conversationId: CONVERSATION })).rejects.toThrow("No organization")
        expect(SandboxUsage.create).not.toHaveBeenCalled()
    })

    describe("lifetimes", () => {
        /** The ledger in memory: the tests have no MongoDB, and which lifetime gets closed is the point. */
        let ledger: Record<string, unknown>[]
        const matches = (filter: Record<string, unknown>, document: Record<string, unknown>) =>
            Object.entries(filter).every(([field, condition]) =>
                condition && typeof condition === "object" && "$exists" in condition
                    ? (document[field] !== undefined) === (condition as { $exists: boolean }).$exists
                    : String(document[field]) === String(condition)
            )
        const at = (time: string) => vi.setSystemTime(new Date(time))
        const owner = { organizationId, projectId, source: "agent" as const }
        const lifetimes = () => ledger.map(document => [document.sandboxId, document.lifetimeSeconds])

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ["Date"] })
            ledger = []
            vi.spyOn(SandboxUsage, "create").mockImplementation((async (document: Record<string, unknown>) => {
                ledger.push({ _id: new Types.ObjectId(), ...document, createdAt: new Date() })
            }) as never)
            vi.spyOn(SandboxUsage, "find").mockImplementation(((filter: Record<string, unknown>) => query(ledger.filter(document => matches(filter, document)))) as never)
            vi.spyOn(SandboxUsage, "updateOne").mockImplementation((async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
                const document = ledger.find(candidate => matches(filter, candidate))
                if (document) Object.assign(document, update.$set)
            }) as never)
        })

        afterEach(() => vi.useRealTimers())

        it("Given a sandbox created then deleted, then its lifetime is opened with no command and closed with the seconds it lived", async () => {
            at("2026-10-31T10:00:00.000Z")
            await openSandboxLifetime(CONVERSATION, "sandbox-1", owner)
            expect(ledger[0]).toMatchObject({ ...owner, conversationId: CONVERSATION, sandboxId: "sandbox-1", commands: 0, execSeconds: 0 })
            expect(ledger[0].lifetimeSeconds).toBeUndefined()

            at("2026-10-31T10:12:30.400Z")
            await closeSandboxLifetime(CONVERSATION, "sandbox-1")

            expect(lifetimes()).toEqual([["sandbox-1", 750]])
        })

        it("Given an orphan lifetime of a sandbox the gateway lost, when the new sandbox is deleted twice, then the orphan ends when the new one opens and nothing counts twice", async () => {
            at("2026-10-31T08:00:00.000Z")
            await openSandboxLifetime(CONVERSATION, "lost", owner)
            at("2026-10-31T10:00:00.000Z")
            await openSandboxLifetime(CONVERSATION, "sandbox-2", owner)
            at("2026-10-31T10:05:00.000Z")
            await closeSandboxLifetime(CONVERSATION, "sandbox-2")
            // A sandbox still deleting is deleted again by the next sweep, of this replica or another.
            at("2026-10-31T13:00:00.000Z")
            await closeSandboxLifetime(CONVERSATION, "sandbox-2")
            await closeSandboxLifetime(CONVERSATION, "lost")

            expect(lifetimes()).toEqual([
                ["lost", 7_200],
                ["sandbox-2", 300]
            ])
        })

        it("Given a replica that replaced a dead sandbox, when another replica late tells of the dead one, then the new lifetime stays open", async () => {
            at("2026-10-31T10:00:00.000Z")
            await openSandboxLifetime(CONVERSATION, "sandbox-1", owner)
            // Replica A: the dead sandbox deleted, a new one created.
            at("2026-10-31T10:30:00.000Z")
            await closeSandboxLifetime(CONVERSATION, "sandbox-1")
            await openSandboxLifetime(CONVERSATION, "sandbox-2", owner)
            // Replica B, late, about the dead one.
            await closeSandboxLifetime(CONVERSATION, "sandbox-1")

            expect(lifetimes()).toEqual([
                ["sandbox-1", 1_800],
                ["sandbox-2", undefined]
            ])
        })

        it("Given no open lifetime, a sandbox made before the ledger, when it is deleted, then nothing is written", async () => {
            await closeSandboxLifetime(CONVERSATION, "older")

            expect(SandboxUsage.updateOne).not.toHaveBeenCalled()
        })
    })
})
