import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { log } = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("../..", () => ({ fastify: { log, config: { REPOSITORIES_FOLDER: "/tmp/repos", REPOSITORIES_MAX_SIZE_MB: 500 } } }))

import AiChangeJob, { AiJobStatus } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AiChangeStatus } from "../../models/AiChangeRequestModel"
import AiMission, { AiMissionMode, AiMissionStatus } from "../../models/AiMissionModel"
import AiModel from "../../models/AiModelModel"
import Backend from "../../models/BackendModel"
import Frontend from "../../models/FrontendModel"
import Project from "../../models/ProjectModel"
import User, { IUser } from "../../models/UserModel"
import UserProject, { RoleInProject } from "../../models/UserProjectModel"
import BaseAuthorizedService from "../BaseAuthorizedService"
import { RepositoryComponentRef } from "../workspace/repositoryComponent"
import AiChangeJobService from "./AiChangeJobService"
import AiMissionService, { sweepRunningMissions } from "./AiMissionService"

type WithGates = { ensureAccessToProject: () => Promise<void>; isOrganizationAdmin: () => Promise<boolean> }

const user = { _id: new Types.ObjectId(), email: "ada@example.com", name: "Ada", surname: "Lovelace" } as unknown as IUser
const projectId = new Types.ObjectId().toString()

const frontend = (index: number) => ({ _id: new Types.ObjectId(), projectId, kind: "frontend" as const, slug: `mfe-${index}`, name: `Mfe ${index}` })
const frontends = (count: number) => Array.from({ length: count }, (_, index) => frontend(index))

type Doc = Record<string, unknown>
interface FakeJob {
    _id: Types.ObjectId
    rootJobId: Types.ObjectId
    parentJobId?: Types.ObjectId
    missionId: unknown
    frontendIds: unknown[]
    createdAt: Date
    status: AiJobStatus
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }
    updatedAt: Date
}
interface Started {
    refs: RepositoryComponentRef[]
    jobId: Types.ObjectId
    scope: string
}

/** A query both awaited as is and chained with sort and limit, as lists read it. */
const query = <T>(result: T) => Object.assign(Promise.resolve(result), { sort: () => query(result), limit: () => query(result) })

describe("AiMissionService", () => {
    let role: RoleInProject
    let components: ReturnType<typeof frontend>[]
    /** The one mission of the tests, as stored: every read gets a copy, as from the database. */
    let stored: Doc | undefined
    let jobs: Map<string, FakeJob>
    let started: Started[]
    /** Repositories whose job cannot start. */
    let gone: Set<string>
    let activeJobs: number
    let runningMissions: number

    const copy = () => (stored ? { ...stored, repositories: (stored.repositories as Doc[]).map(entry => ({ ...entry })) } : null)

    const matches = (filter: Doc) => stored !== undefined && Object.entries(filter).every(([key, value]) => (key === "_id" ? String(value) === String(stored!._id) : stored![key] === value))

    const entryMatches = (entry: Doc, filter: Doc) =>
        Object.entries(filter).every(([key, value]) => {
            const field = entry[key.replace("entry.", "")]
            const wanted = value as { $in?: unknown[]; $exists?: boolean }
            if (wanted?.$in) return wanted.$in.map(String).includes(String(field))
            if (wanted?.$exists !== undefined) return (field !== undefined) === wanted.$exists
            return String(field) === String(value)
        })

    /** The updates the service makes on a mission: plain fields, $inc, and $set on the entries of an array filter. */
    const update = (filter: Doc, change: Doc, options?: { arrayFilters?: Doc[] }) => {
        if (!matches(filter)) return null
        for (const [key, value] of Object.entries(change)) {
            if (key === "$set") {
                for (const [path, fieldValue] of Object.entries(value as Doc)) {
                    const field = path.split(".").pop()!
                    for (const entry of stored!.repositories as Doc[]) if (entryMatches(entry, options!.arrayFilters![0])) entry[field] = fieldValue
                }
            } else if (key === "$inc") {
                for (const [field, by] of Object.entries(value as Record<string, number>)) stored![field] = (stored![field] as number) + by
            } else stored![key] = value
        }
        stored!.updatedAt = new Date()
        return copy()
    }

    const byStatus = (job: FakeJob, status: unknown) => {
        const wanted = status as { $in?: AiJobStatus[] } | AiJobStatus | undefined
        if (wanted === undefined) return true
        return typeof wanted === "object" ? wanted.$in!.includes(job.status) : job.status === wanted
    }

    beforeEach(() => {
        role = RoleInProject.MEMBER
        components = frontends(3)
        stored = undefined
        jobs = new Map()
        started = []
        gone = new Set()
        activeJobs = 0
        runningMissions = 0
        const gates = BaseAuthorizedService.prototype as unknown as WithGates
        vi.spyOn(gates, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(gates, "isOrganizationAdmin").mockResolvedValue(false)
        vi.spyOn(UserProject, "findOne").mockImplementation((() => Promise.resolve({ role })) as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId(), name: "Shop" } as never)
        vi.spyOn(AiModel, "find").mockResolvedValue([] as never)
        vi.spyOn(User, "findById").mockResolvedValue(user as never)
        vi.spyOn(User, "find").mockResolvedValue([user] as never)
        vi.spyOn(Frontend, "find").mockImplementation(((filter: { _id: { $in: unknown[] } }) =>
            Promise.resolve(components.filter(candidate => filter._id.$in.map(String).includes(String(candidate._id))))) as never)
        vi.spyOn(Backend, "find").mockResolvedValue([] as never)

        // The selection itself is the job service's, covered there: here every component has a repository.
        vi.spyOn(AiChangeJobService.prototype, "repositoriesOf").mockImplementation(async () => components as never)
        vi.spyOn(AiChangeJobService.prototype, "selectedRepositories").mockImplementation(
            async (_projectId: string, refs: RepositoryComponentRef[]) => refs.map(ref => components.find(candidate => String(candidate._id) === ref.id)!) as never
        )
        vi.spyOn(AiChangeJobService.prototype, "startForMission").mockImplementation(async (mission, refs, jobId, scope) => {
            if (refs.some(ref => gone.has(ref.id))) throw new Error("This frontend has no code repository connected")
            started.push({ refs, jobId: jobId as unknown as Types.ObjectId, scope })
            const id = jobId as unknown as Types.ObjectId
            jobs.set(String(id), {
                _id: id,
                rootJobId: id,
                missionId: mission._id,
                frontendIds: refs.map(ref => ref.id),
                createdAt: new Date(),
                status: AiJobStatus.PENDING,
                usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
                updatedAt: new Date()
            })
        })
        vi.spyOn(AiChangeJobService.prototype, "stop").mockImplementation(async (jobId: string) => {
            jobs.get(jobId)!.status = AiJobStatus.FAILED
            return {} as never
        })
        vi.spyOn(AiChangeJobService.prototype, "apply").mockResolvedValue({} as never)

        vi.spyOn(AiChangeJob, "countDocuments").mockImplementation((() => Promise.resolve(activeJobs)) as never)
        vi.spyOn(AiMission, "countDocuments").mockImplementation((() => Promise.resolve(runningMissions)) as never)
        vi.spyOn(AiChangeJob, "find").mockImplementation(((filter: { _id?: { $in: unknown[] }; rootJobId?: { $in: unknown[] }; missionId?: unknown; status?: unknown }) =>
            Promise.resolve(
                [...jobs.values()].filter(
                    job =>
                        (!filter._id || filter._id.$in.map(String).includes(String(job._id))) &&
                        (!filter.rootJobId || filter.rootJobId.$in.map(String).includes(String(job.rootJobId))) &&
                        (!filter.missionId || String(filter.missionId) === String(job.missionId)) &&
                        byStatus(job, filter.status)
                )
            )) as never)
        vi.spyOn(AiChangeJob, "exists").mockImplementation(((filter: { status: AiJobStatus }) =>
            Promise.resolve([...jobs.values()].some(job => job.status === filter.status) ? { _id: new Types.ObjectId() } : null)) as never)
        vi.spyOn(AiChangeRequest, "find").mockResolvedValue([] as never)
        vi.spyOn(AiChangeJob, "updateMany").mockResolvedValue({} as never)
        vi.spyOn(AiChangeRequest, "updateMany").mockResolvedValue({} as never)

        vi.spyOn(AiMission, "create").mockImplementation(((document: Doc) => {
            stored = {
                _id: new Types.ObjectId(),
                currentBatch: 0,
                claims: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...document,
                repositories: (document.repositories as Doc[]).map(entry => ({ ...entry }))
            }
            return Promise.resolve(copy())
        }) as never)
        vi.spyOn(AiMission, "findById").mockImplementation((() => Promise.resolve(copy())) as never)
        vi.spyOn(AiMission, "find").mockImplementation(((filter: Doc) => query(stored && matches({ ...filter, projectId: stored.projectId }) ? [copy()] : [])) as never)
        vi.spyOn(AiMission, "findOneAndUpdate").mockImplementation(((filter: Doc, change: Doc, options?: { arrayFilters?: Doc[] }) => Promise.resolve(update(filter, change, options))) as never)
        vi.spyOn(AiMission, "updateOne").mockImplementation(((filter: Doc, change: Doc, options?: { arrayFilters?: Doc[] }) => Promise.resolve(update(filter, change, options))) as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    const service = () => new AiMissionService(user, { ANTHROPIC_API_KEY: "sk-test" })

    const start = (mode: AiMissionMode, extra: Doc = { all: true }) => service().create(projectId, { prompt: "Upgrade React", mode, ...extra })

    /** The job started on a repository ends; the mission hears about it as the job's process would tell it. */
    const finish = async (index: number, status = AiJobStatus.DONE) => {
        jobs.get(String(started[index].jobId))!.status = status
        await service().advance(String(stored!._id))
    }

    const idsOf = (refs: RepositoryComponentRef[]) => refs.map(ref => ref.id)

    describe("create", () => {
        it("Given 23 repositories, when a mission is started, then they are split into batches of 10 in the order shown, and only the first batch starts", async () => {
            components = frontends(23)

            const view = await start("perRepository", { all: true, concurrency: 10 })

            expect(view).toMatchObject({ status: AiMissionStatus.RUNNING, currentBatch: 0, batchCount: 3, userName: "Ada Lovelace" })
            expect(view.repositories.map(repository => repository.batch)).toEqual([...Array(10).fill(0), ...Array(10).fill(1), ...Array(3).fill(2)])
            expect(view.repositories.map(repository => repository.id)).toEqual(components.map(component => String(component._id)))
            expect(started.map(({ refs }) => idsOf(refs))).toEqual(components.slice(0, 10).map(component => [String(component._id)]))
            // Created and not started yet: queued, as the console shows them.
            expect(view.counts).toMatchObject({ queued: 23, running: 0 })
        })

        it("Given a mission per repository, when it starts, then at most `concurrency` single-repository jobs run, 3 when left out", async () => {
            components = frontends(8)

            const view = await start("perRepository")

            expect(started).toHaveLength(3)
            expect(started.every(({ refs, scope }) => refs.length === 1 && scope === "selection")).toBe(true)
            expect(view.concurrency).toBe(3)
            expect(view.repositories.filter(repository => repository.jobStatus === AiJobStatus.PENDING)).toHaveLength(3)
        })

        it("Given more than 200 repositories, when a mission is started on all of them, then it is refused before anything is stored", async () => {
            components = frontends(201)

            await expect(start("perRepository")).rejects.toMatchObject({ code: "AI_MISSION_TOO_MANY_REPOSITORIES", statusCode: 400 })
            expect(AiMission.create).not.toHaveBeenCalled()
        })

        it("Given more than 200 selected repositories, when the mission is started, then it is refused", async () => {
            const frontendIds = Array.from({ length: 201 }, () => new Types.ObjectId().toString())

            await expect(start("global", { frontendIds })).rejects.toMatchObject({ code: "AI_MISSION_TOO_MANY_REPOSITORIES" })
            expect(AiMission.create).not.toHaveBeenCalled()
        })

        it("Given every repository and a selection both asked, or neither, when the mission is started, then it is refused", async () => {
            await expect(start("global", { all: true, frontendIds: [String(components[0]._id)] })).rejects.toMatchObject({ code: "AI_MISSION_INVALID_SELECTION", statusCode: 400 })
            await expect(start("global", {})).rejects.toMatchObject({ code: "AI_MISSION_INVALID_SELECTION" })
        })

        it("Given a selection, when the mission is started, then it works on the selected repositories only", async () => {
            const view = await start("perRepository", { frontendIds: [String(components[2]._id), String(components[0]._id)] })

            expect(view.repositories.map(repository => repository.id)).toEqual([String(components[2]._id), String(components[0]._id)])
            expect(AiChangeJobService.prototype.repositoriesOf).not.toHaveBeenCalled()
        })

        it("Given a viewer, when a mission is started, then it is refused before anything is stored", async () => {
            role = RoleInProject.VIEWER

            await expect(start("global")).rejects.toMatchObject({ code: "AI_CHANGE_FORBIDDEN", statusCode: 403 })
            expect(AiMission.create).not.toHaveBeenCalled()
        })

        it("Given a domain-scoped member, when a mission is started on every repository, then it is refused", async () => {
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(new Types.ObjectId())])

            await expect(start("global")).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
            expect(AiMission.create).not.toHaveBeenCalled()
        })

        it("Given 2 jobs and a mission already running, when a mission is started, then it is refused: a mission counts as one", async () => {
            activeJobs = 2
            runningMissions = 1

            await expect(start("global")).rejects.toMatchObject({ code: "AI_CHANGE_TOO_MANY", statusCode: 429 })
            expect(AiMission.create).not.toHaveBeenCalled()
            // The jobs of the running missions are not counted on top of them.
            const [jobFilter] = (AiChangeJob.countDocuments as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
            expect(jobFilter).toMatchObject({ missionId: { $exists: false } })
        })
    })

    describe("advance", () => {
        it("Given a mission per repository, when one of its jobs ends, then the next queued repository of the batch takes its place", async () => {
            components = frontends(5)
            await start("perRepository", { all: true, concurrency: 2 })
            expect(started).toHaveLength(2)

            await finish(0)

            expect(started).toHaveLength(3)
            expect(idsOf(started[2].refs)).toEqual([String(components[2]._id)])
        })

        it("Given two batches, when the first is not over, then the second does not start, and it starts once every job of the first is over", async () => {
            components = frontends(12)
            await start("perRepository", { all: true, concurrency: 10 })

            for (let index = 0; index < 9; index++) await finish(index, index % 2 ? AiJobStatus.FAILED : AiJobStatus.DONE)
            expect(started).toHaveLength(10)
            expect(stored!.currentBatch).toBe(0)

            await finish(9)

            expect(stored!.currentBatch).toBe(1)
            expect(started.slice(10).map(({ refs }) => idsOf(refs))).toEqual([[String(components[10]._id)], [String(components[11]._id)]])
        })

        it("Given the last batch over, when the mission advances, then it is done, and failed when every job failed", async () => {
            components = frontends(2)
            await start("perRepository")
            await finish(0, AiJobStatus.FAILED)
            expect(stored!.status).toBe(AiMissionStatus.RUNNING)

            await finish(1)

            expect(stored).toMatchObject({ status: AiMissionStatus.DONE, expiresAt: expect.any(Date) })

            stored = undefined
            jobs.clear()
            started = []
            await start("perRepository")
            await finish(0, AiJobStatus.FAILED)
            await finish(1, AiJobStatus.FAILED)
            expect(stored).toMatchObject({ status: AiMissionStatus.FAILED })
        })

        it("Given a global mission on 15 repositories, when it runs, then each batch is one job on all its repositories", async () => {
            components = frontends(15)

            await start("global")
            expect(started).toHaveLength(1)
            expect(started[0]).toMatchObject({ scope: "selection" })
            expect(idsOf(started[0].refs)).toEqual(components.slice(0, 10).map(component => String(component._id)))

            await finish(0)

            expect(started).toHaveLength(2)
            expect(idsOf(started[1].refs)).toEqual(components.slice(10).map(component => String(component._id)))
        })

        it("Given a global mission on every repository of the project, all in one batch, when it starts, then its job is a global one", async () => {
            const view = await start("global")

            expect(started).toEqual([expect.objectContaining({ scope: "global" })])
            // One job shared by every repository: its usage is counted once.
            expect(view.usage).toEqual({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 })
            expect(new Set(view.repositories.map(repository => repository.jobId)).size).toBe(1)
        })

        it("Given two advances at once, when a place frees up, then only one of them starts the next repository", async () => {
            components = frontends(5)
            await start("perRepository", { all: true, concurrency: 2 })
            jobs.get(String(started[0].jobId))!.status = AiJobStatus.DONE

            await Promise.all([service().advance(String(stored!._id)), service().advance(String(stored!._id))])

            expect(started).toHaveLength(3)
            expect(new Set(started.map(({ refs }) => refs[0].id)).size).toBe(3)
            expect(stored!.claims).toBe(3)
        })

        it("Given an advance with nothing to do, when it is called again, then nothing more starts", async () => {
            components = frontends(5)
            await start("perRepository", { all: true, concurrency: 2 })

            await service().advance(String(stored!._id))
            await service().advance(String(stored!._id))

            expect(started).toHaveLength(2)
        })

        it("Given a repository whose job cannot start, when the mission advances, then that repository fails and the next one starts in its place", async () => {
            components = frontends(3)
            gone.add(String(components[0]._id))

            const view = await start("perRepository", { all: true, concurrency: 1 })

            expect(idsOf(started[0].refs)).toEqual([String(components[1]._id)])
            // No job to open: it never existed.
            expect(view.repositories[0]).toMatchObject({ error: "This frontend has no code repository connected" })
            expect(view.repositories[0].jobStatus).toBeUndefined()
            expect(view.counts).toMatchObject({ failed: 1, queued: 2 })
        })
    })

    describe("stop", () => {
        it("Given a running mission, when it is stopped, then its active jobs are stopped and its queued repositories never start", async () => {
            components = frontends(5)
            await start("perRepository", { all: true, concurrency: 2 })

            const view = await service().stop(String(stored!._id))

            expect(view.status).toBe(AiMissionStatus.STOPPED)
            expect(AiChangeJobService.prototype.stop).toHaveBeenCalledTimes(2)
            await service().advance(String(stored!._id))
            expect(started).toHaveLength(2)
            expect(view.counts).toMatchObject({ queued: 3, failed: 2 })
        })

        it("Given a mission already over, when it is stopped, then it is refused", async () => {
            components = frontends(1)
            await start("perRepository")
            await finish(0)

            await expect(service().stop(String(stored!._id))).rejects.toMatchObject({ code: "AI_MISSION_NOT_RUNNING", statusCode: 409 })
        })

        it("Given a viewer, when they stop a mission, then it is refused and it keeps running", async () => {
            await start("perRepository")
            role = RoleInProject.VIEWER

            await expect(service().stop(String(stored!._id))).rejects.toMatchObject({ code: "AI_CHANGE_FORBIDDEN" })
            expect(stored!.status).toBe(AiMissionStatus.RUNNING)
        })
    })

    /** The request of the job started on a repository, as the views read it. */
    const request = (index: number, status: AiChangeStatus, files: number, jobId: Types.ObjectId = started[index].jobId) => ({
        jobId,
        frontendId: components[index]._id,
        status,
        files: Array.from({ length: files }, (_, file) => ({ path: `src/${file}.ts` })),
        branch: `ai/mfe-${index}`,
        updatedAt: new Date()
    })

    /** A follow-up asked on the job started on a repository: the job service gives it the mission. */
    const followUp = (index: number, status: AiJobStatus) => {
        const parent = jobs.get(String(started[index].jobId))!
        const id = new Types.ObjectId()
        jobs.set(String(id), { ...parent, _id: id, parentJobId: parent._id, createdAt: new Date(Date.now() + 1000), status, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } })
        return id
    }

    describe("apply", () => {
        it("Given finished jobs, when the mission is applied, then each job with a proposal left is applied, in the order shown", async () => {
            await start("perRepository")
            for (let index = 0; index < 3; index++) await finish(index)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([request(2, AiChangeStatus.PROPOSED, 1), request(1, AiChangeStatus.PROPOSED, 0), request(0, AiChangeStatus.PROPOSED, 2)] as never)

            await service().apply(String(stored!._id))

            expect(vi.mocked(AiChangeJobService.prototype.apply).mock.calls.map(([jobId]) => jobId)).toEqual([String(started[0].jobId), String(started[2].jobId)])
        })

        it("Given no proposal left, when the mission is applied, then it is refused", async () => {
            await start("perRepository")

            await expect(service().apply(String(stored!._id))).rejects.toMatchObject({ code: "AI_CHANGE_NOT_PROPOSED", statusCode: 409 })
        })
    })

    describe("views", () => {
        it("Given repositories at every stage, when the mission is read, then each counts once, without file contents", async () => {
            components = frontends(5)
            await start("perRepository", { all: true, concurrency: 4 })
            for (let index = 0; index < 4; index++) await finish(index, index === 3 ? AiJobStatus.FAILED : AiJobStatus.DONE)
            const find = vi
                .spyOn(AiChangeRequest, "find")
                .mockResolvedValue([request(0, AiChangeStatus.PROPOSED, 2), request(1, AiChangeStatus.APPLIED, 1), request(2, AiChangeStatus.PROPOSED, 0)] as never)

            const view = await service().get(String(stored!._id))

            expect(view.counts).toEqual({ queued: 1, running: 0, proposed: 1, applying: 0, applied: 1, failed: 1, noChanges: 1 })
            expect(view.repositories[0]).toMatchObject({ jobStatus: AiJobStatus.DONE, requestStatus: AiChangeStatus.PROPOSED, filesChanged: 2, branch: "ai/mfe-0" })
            const [, projection] = find.mock.calls[0]
            expect(projection).not.toHaveProperty("files.proposedContent")
            expect(projection).toMatchObject({ "files.path": 1 })
        })

        it("Given a domain-scoped member, when they read a mission on every repository, then it is forbidden", async () => {
            await start("global")
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(new Types.ObjectId())])

            await expect(service().get(String(stored!._id))).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
            expect(await service().list(projectId)).toEqual([])
        })

        it("Given a running mission whose place freed up while nobody listened, when the missions are listed, then it moves on first", async () => {
            components = frontends(3)
            await start("perRepository", { all: true, concurrency: 1 })
            jobs.get(String(started[0].jobId))!.status = AiJobStatus.DONE

            const [view] = await service().list(projectId, true)

            expect(started).toHaveLength(2)
            expect(view.counts).toMatchObject({ noChanges: 1, queued: 2 })
        })
    })

    describe("follow-ups", () => {
        it("Given a follow-up of a mission's job that proposed, when the mission is read and applied, then the repository stands at the follow-up, and the mission still advances on its own jobs", async () => {
            components = frontends(2)
            await start("perRepository", { all: true, concurrency: 1 })
            await finish(0)
            const child = followUp(0, AiJobStatus.DONE)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([request(0, AiChangeStatus.DISCARDED, 2), request(0, AiChangeStatus.PROPOSED, 3, child)] as never)

            const view = await service().get(String(stored!._id))

            expect(view.repositories[0]).toMatchObject({ jobId: String(child), jobStatus: AiJobStatus.DONE, requestStatus: AiChangeStatus.PROPOSED, filesChanged: 3 })
            expect(view.counts).toMatchObject({ proposed: 1, noChanges: 0 })
            // The follow-up's cost is the mission's too.
            expect(view.usage.inputTokens).toBe(21)
            // The second repository started once the first one's own job ended, whatever its follow-up does.
            expect(started).toHaveLength(2)

            await service().apply(String(stored!._id))
            expect(vi.mocked(AiChangeJobService.prototype.apply).mock.calls.map(([jobId]) => jobId)).toEqual([String(child)])
        })

        it("Given a follow-up that failed, when the mission is read, then the repository stands at the proposal it refined, still open", async () => {
            components = frontends(1)
            await start("perRepository")
            await finish(0)
            const child = followUp(0, AiJobStatus.FAILED)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([request(0, AiChangeStatus.PROPOSED, 2), request(0, AiChangeStatus.FAILED, 0, child)] as never)

            const view = await service().get(String(stored!._id))

            expect(view.repositories[0]).toMatchObject({ jobId: String(started[0].jobId), requestStatus: AiChangeStatus.PROPOSED })
            expect(view.counts).toMatchObject({ proposed: 1, failed: 0 })
        })

        it("Given a follow-up running while the batch is over, when the mission advances, then the next batch starts anyway", async () => {
            components = frontends(11)
            await start("perRepository", { all: true, concurrency: 10 })
            for (let index = 0; index < 10; index++) jobs.get(String(started[index].jobId))!.status = AiJobStatus.DONE
            followUp(0, AiJobStatus.RUNNING)

            await service().advance(String(stored!._id))

            expect(stored!.currentBatch).toBe(1)
            expect(started).toHaveLength(11)
        })
    })

    describe("applying", () => {
        it("Given proposals being pushed, when the mission is read, then they count as applying, not as proposals", async () => {
            components = frontends(2)
            await start("perRepository")
            await finish(0)
            await finish(1)
            vi.spyOn(AiChangeRequest, "find").mockResolvedValue([request(0, AiChangeStatus.APPLYING, 2), request(1, AiChangeStatus.PROPOSED, 1)] as never)

            const view = await service().get(String(stored!._id))

            expect(view.counts).toMatchObject({ applying: 1, proposed: 1 })
        })
    })

    describe("cap", () => {
        it("Given the cap reached by a mission whose last job died unnoticed, when a mission is started, then the dead one ends first and the new one starts", async () => {
            components = frontends(1)
            await start("perRepository")
            const stuck = stored!
            // Its job died with a restart: declared failed since, and nobody moved the mission on.
            jobs.get(String(started[0].jobId))!.status = AiJobStatus.FAILED
            activeJobs = 2
            vi.spyOn(AiMission, "countDocuments").mockImplementation((() => Promise.resolve(stored?.status === AiMissionStatus.RUNNING ? 1 : 0)) as never)

            await start("perRepository")

            expect(stuck.status).toBe(AiMissionStatus.FAILED)
            expect(AiMission.create).toHaveBeenCalledTimes(2)
        })

        it("Given the server just started, when it sweeps the running missions, then each moves on and its jobs are kept while it runs", async () => {
            components = frontends(3)
            await start("perRepository", { all: true, concurrency: 1 })
            jobs.get(String(started[0].jobId))!.status = AiJobStatus.DONE

            await sweepRunningMissions({ ANTHROPIC_API_KEY: "sk-test" })

            expect(started).toHaveLength(2)
            expect(AiChangeJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: { $lt: expect.any(Date) } }), { expiresAt: expect.any(Date) })
            expect(AiChangeRequest.updateMany).toHaveBeenCalled()
        })
    })

    describe("expiry", () => {
        it("Given the last job over, when the mission ends, then its jobs and their requests expire from its end, those kept for good aside", async () => {
            components = frontends(1)
            await start("perRepository")

            await finish(0)

            const [jobFilter, jobUpdate] = vi.mocked(AiChangeJob.updateMany).mock.calls[0] as unknown as [Doc, Doc]
            expect(jobFilter).toMatchObject({ _id: { $in: [started[0].jobId] }, expiresAt: { $lt: stored!.expiresAt } })
            expect(jobUpdate).toEqual({ expiresAt: stored!.expiresAt })
            expect(AiChangeRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ jobId: { $in: [started[0].jobId] } }), { expiresAt: stored!.expiresAt })
        })
    })

    describe("owner", () => {
        const someoneElse = { _id: new Types.ObjectId(), email: "grace@example.com", name: "Grace" } as unknown as IUser
        const asSomeoneElse = () => new AiMissionService(someoneElse, { ANTHROPIC_API_KEY: "sk-test" })

        it("Given a mission someone else started, when a member stops or applies it, then it is refused, and they still read it", async () => {
            await start("perRepository")

            await expect(asSomeoneElse().stop(String(stored!._id))).rejects.toMatchObject({ code: "AI_JOB_NOT_OWNER", statusCode: 403 })
            await expect(asSomeoneElse().apply(String(stored!._id))).rejects.toMatchObject({ code: "AI_JOB_NOT_OWNER", statusCode: 403 })
            expect(stored!.status).toBe(AiMissionStatus.RUNNING)
            expect(AiChangeJobService.prototype.stop).not.toHaveBeenCalled()
            expect(await asSomeoneElse().get(String(stored!._id))).toMatchObject({ canAct: false })
            expect(await service().get(String(stored!._id))).toMatchObject({ canAct: true })
        })

        it("Given a mission someone else started, when an organization administrator stops it, then it is stopped", async () => {
            await start("perRepository")
            vi.spyOn(BaseAuthorizedService.prototype as unknown as WithGates, "isOrganizationAdmin").mockResolvedValue(true)

            const view = await asSomeoneElse().stop(String(stored!._id))

            expect(view).toMatchObject({ status: AiMissionStatus.STOPPED, canAct: true })
        })
    })

    describe("stop", () => {
        it("Given a job that cannot be stopped, when the mission is stopped, then the others are stopped anyway and the mission comes back stopped", async () => {
            components = frontends(3)
            await start("perRepository")
            vi.mocked(AiChangeJobService.prototype.stop).mockRejectedValueOnce(new Error("provider down"))

            const view = await service().stop(String(stored!._id))

            expect(AiChangeJobService.prototype.stop).toHaveBeenCalledTimes(3)
            expect(view.status).toBe(AiMissionStatus.STOPPED)
            expect(log.warn).toHaveBeenCalled()
        })
    })

    describe("input", () => {
        it("Given a prompt of blanks, when a mission is started, then it is refused before anything is stored, and a prompt is stored trimmed", async () => {
            await expect(service().create(projectId, { prompt: "  \n ", mode: "global", all: true })).rejects.toMatchObject({ code: "AI_MISSION_EMPTY_PROMPT", statusCode: 400 })
            expect(AiMission.create).not.toHaveBeenCalled()

            await service().create(projectId, { prompt: "  Upgrade React \n", mode: "global", all: true })
            expect(AiMission.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Upgrade React" }))
        })

        it("Given a repository listed twice, when a mission is started on every repository, then it is in the mission once", async () => {
            components = frontends(2)
            const listed = [...components, components[0]]
            vi.mocked(AiChangeJobService.prototype.repositoriesOf).mockResolvedValue(listed as never)

            const view = await start("perRepository")

            expect(view.repositories.map(repository => repository.id)).toEqual(components.map(component => String(component._id)))
        })
    })

    describe("repositories", () => {
        it("Given a member of the whole project, when the repositories are asked, then every one with a repository is offered, and every one at once", async () => {
            const options = await service().repositories(projectId)

            expect(options).toEqual({ all: true, repositories: components.map(component => ({ kind: "frontend", id: String(component._id), name: component.name, domainId: undefined })) })
        })

        it("Given a domain-scoped member, when the repositories are asked, then only those of their domains are offered, and never every one at once", async () => {
            const ownDomain = new Types.ObjectId()
            components = [{ ...frontend(0), domainId: ownDomain }, frontend(1)] as typeof components
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(ownDomain)])

            const options = await service().repositories(projectId)

            expect(options).toEqual({ all: false, repositories: [{ kind: "frontend", id: String(components[0]._id), name: "Mfe 0", domainId: String(ownDomain) }] })
        })
    })
})
