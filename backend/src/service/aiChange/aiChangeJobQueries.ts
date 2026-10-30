import { createBusinessException } from "../../errors/BusinessException"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import AiChangeJob, { IAiChangeJob } from "../../models/AiChangeJobModel"
import AiChangeRequest, { AiChangeStatus } from "../../models/AiChangeRequestModel"
import Backend from "../../models/BackendModel"
import CodeRepository from "../../models/CodeRepositoryModel"
import Frontend from "../../models/FrontendModel"
import User from "../../models/UserModel"
import { toObjectId } from "../../utils/mongooseUtils"
import { domainScopeForbidden, isInDomainScope } from "../BaseAuthorizedService"
import { RepositoryFileService, repositoryNameFor } from "../RepositoryFileService"
import { componentIdOf, componentsOfJob, findComponents, fromBackend, fromFrontend, RepositoryComponent, RepositoryComponentRef } from "../workspace/repositoryComponent"
import { AiChangeBaseService } from "./aiChangeShared"
import { ACTIVE_JOB_STATUSES, failIfStale, fresh, UNFINISHED_REQUEST_STATUSES } from "./aiJobRecords"
import { AiJobView, AiWorkingJobView, JOB_LISTED, ListedJob, toJobView, uniqueRefs, WITHOUT_CONTENTS } from "./aiJobViews"

const LISTED_JOBS = 20
/** Pages of LISTED_JOBS a list reads at most, filling the places of the jobs out of a member's domain scope. */
const MAX_LISTED_PAGES = 10

export const noRepositories = (message: string) => createBusinessException({ code: "AI_JOB_NO_REPOSITORIES", message, statusCode: 422 })

export const sameComponent = (ref: RepositoryComponentRef) => (component: RepositoryComponent) => component.kind === ref.kind && String(component._id) === ref.id

/**
 * How AI agent jobs are read, and the repositories one may work on: one job, a conversation, the lists of
 * the console. Writes are {@link AiChangeJobService}'s.
 */
export abstract class AiChangeJobQueryService extends AiChangeBaseService {
    /** The backends of the project whose repository connection, of this same project, the workspace can open. */
    private async backendsWithRepository(projectId: string): Promise<RepositoryComponent[]> {
        const backends = (await Backend.find({ projectId: toObjectId(projectId) })).filter(backend => backend.codeRepository?.enabled && backend.codeRepository.codeRepositoryId)
        if (backends.length === 0) return []
        const connectionIds = [...new Set(backends.map(backend => String(backend.codeRepository!.codeRepositoryId)))]
        const connections = await CodeRepository.find({ _id: { $in: connectionIds.map(id => toObjectId(id)) }, projectId: toObjectId(projectId) })
        return backends
            .filter(backend => {
                const connection = connections.find(candidate => String(candidate._id) === String(backend.codeRepository!.codeRepositoryId))
                return connection && repositoryNameFor(backend.codeRepository, connection)
            })
            .sort((a, b) => a.slug.localeCompare(b.slug))
            .map(fromBackend)
    }

    /** The frontends, then the backends, of the project whose repository connection the workspace can open. */
    async repositoriesOf(projectId: string): Promise<RepositoryComponent[]> {
        const targets = await new RepositoryFileService(this.user).resolveTargets(projectId)
        const frontends = targets
            .filter(target => target.codeRepository && target.repositoryName && target.codeRepository.projectId?.toString() === projectId)
            .map(target => fromFrontend(target.frontend))
        return [...frontends, ...(await this.backendsWithRepository(projectId))]
    }

    /**
     * The components `refs` names, each of the project, in the caller's domain scope and with a repository
     * the workspace can open; `available` spares reading the repositories of the project again.
     */
    async selectedRepositories(projectId: string, refs: RepositoryComponentRef[], available?: RepositoryComponent[]): Promise<RepositoryComponent[]> {
        const withRepository = available ?? (await this.repositoriesOf(projectId))
        const inProject = (await findComponents(refs, { name: 1, projectId: 1, domainId: 1 })).filter(component => String(component.projectId) === projectId)
        const missing = refs.find(ref => !inProject.some(sameComponent(ref)))
        if (missing) throw new EntityNotFoundError(missing.id)
        for (const component of inProject) await this.ensureInDomainScope(projectId, component.domainId)
        const withoutRepository = inProject.filter(component => !withRepository.some(sameComponent({ kind: component.kind, id: String(component._id) })))
        if (withoutRepository.length) {
            throw noRepositories(`No code repository is connected to ${withoutRepository.map(component => component.name).join(", ")}`)
        }
        return refs.map(ref => withRepository.find(sameComponent(ref))!)
    }

    protected async getJob(id: string): Promise<IAiChangeJob> {
        const job = await AiChangeJob.findById(id)
        if (!job) throw new EntityNotFoundError(id)
        await this.ensureAccessToProject(job.projectId)
        if ((await this.inDomainScope(job.projectId, [job])).length === 0) throw domainScopeForbidden()
        return this.failIfStale(job)
    }

    /**
     * The jobs a domain-scoped member may see: those working only on frontends and backends they
     * see, and never one on the whole project. Anyone else sees them all, without a query.
     */
    protected async inDomainScope<T extends ListedJob>(projectId: IAiChangeJob["projectId"], jobs: T[]): Promise<T[]> {
        const scope = await this.getDomainScope(projectId)
        if (!scope || jobs.length === 0) return jobs
        const components = await findComponents(uniqueRefs(jobs), { domainId: 1 })
        const visible = new Set(components.filter(component => isInDomainScope(scope, component.domainId)).map(component => String(component._id)))
        return jobs.filter(job => job.scope !== "global" && (!job.domainId || isInDomainScope(scope, job.domainId)) && componentsOfJob(job).every(ref => visible.has(ref.id)))
    }

    /** A job whose process died is reported as failed, and so are its requests still waiting for it. */
    async failIfStale<T extends ListedJob>(job: T): Promise<T | IAiChangeJob> {
        return failIfStale(job)
    }

    protected async views(jobs: ListedJob[], withEvents: boolean): Promise<AiJobView[]> {
        if (jobs.length === 0) return []
        const requests = await AiChangeRequest.find({ jobId: { $in: jobs.map(job => job._id) } }, WITHOUT_CONTENTS)
        const components = await findComponents(uniqueRefs(jobs), { name: 1, slug: 1, "codeRepository.name": 1, "codeRepository.cloneUrlHttps": 1 })
        const byId = new Map(components.map(component => [String(component._id), component]))
        const canAct = await Promise.all(jobs.map(job => this.canAct(job)))
        const others = [...new Set(jobs.filter((_, index) => !canAct[index]).map(job => String(job.userId)))]
        const users = others.length ? await User.find({ _id: { $in: others.map(id => toObjectId(id)) } }, { name: 1, surname: 1, email: 1 }) : []
        const nameOf = (userId: unknown) => {
            const user = users.find(candidate => String(candidate._id) === String(userId))
            return user ? [user.name, user.surname].filter(Boolean).join(" ") || user.email : undefined
        }
        return jobs.map((job, index) => toJobView(job, requests, byId, withEvents, canAct[index], canAct[index] ? undefined : nameOf(job.userId)))
    }

    protected async view(job: IAiChangeJob, withEvents: boolean): Promise<AiJobView> {
        return (await this.views([job], withEvents))[0]
    }

    /** One job with its progress and a line per repository. */
    async get(id: string): Promise<AiJobView> {
        return this.view(await this.getJob(id), true)
    }

    /** Every job of the conversation the given one belongs to, from the first to the latest. */
    async chain(id: string): Promise<AiJobView[]> {
        const job = await this.getJob(id)
        const jobs = await this.inDomainScope(job.projectId, await AiChangeJob.find({ rootJobId: job.rootJobId, projectId: job.projectId }, { transcript: 0 }).sort({ createdAt: 1 }))
        return this.views(await Promise.all(jobs.map(candidate => this.failIfStale(candidate))), true)
    }

    /**
     * The latest conversations on a domain, everyone's, as a frontend page shows everyone's requests:
     * the first job of each chain, which names it, and its latest, which says where it stands. Newest first.
     */
    async domainConversations(projectId: string, domainId: string): Promise<AiJobView[]> {
        await this.ensureAccessToProject(toObjectId(projectId))
        await this.ensureInDomainScope(projectId, domainId)
        // By their roots: a chain with many follow-ups must not push the other conversations out.
        const roots = await AiChangeJob.find(
            {
                projectId: toObjectId(projectId),
                domainId: toObjectId(domainId),
                missionId: { $exists: false },
                deletedAt: { $exists: false },
                $expr: { $eq: ["$_id", "$rootJobId"] }
            },
            JOB_LISTED
        )
            .sort({ createdAt: -1 })
            .limit(LISTED_JOBS)
        const latest = await Promise.all(roots.map(root => AiChangeJob.findOne({ rootJobId: root._id, missionId: { $exists: false } }, JOB_LISTED).sort({ createdAt: -1 })))
        const jobs: ListedJob[] = [...roots, ...latest.flatMap(job => (job ? [job] : []))]
            .filter((job, index, all) => all.findIndex(other => String(other._id) === String(job._id)) === index)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return this.views(await Promise.all(jobs.map(job => this.failIfStale(job))), false)
    }

    /**
     * The latest jobs of the user in a project. `active` keeps those still running and those with a
     * proposal waiting: the console reopens their tabs after a reload.
     */
    async list(projectId: string, active = false): Promise<AiJobView[]> {
        await this.ensureAccessToProject(toObjectId(projectId))
        const filter: Record<string, unknown> = { projectId: toObjectId(projectId), userId: this.getUser()!._id, deletedAt: { $exists: false } }
        if (active) {
            const proposed = await AiChangeRequest.distinct("jobId", { ...filter, status: AiChangeStatus.PROPOSED, jobId: { $exists: true } })
            filter.$or = [{ status: { $in: ACTIVE_JOB_STATUSES } }, { _id: { $in: proposed } }]
            // A mission's jobs are followed on the Fleet page: a mission on 200 repositories would reopen 200 assistant tabs.
            filter.missionId = { $exists: false }
        }
        // Read on page after page until the list is full: a domain-scoped member's jobs out of their scope are
        // dropped after reading, and must not take the places of those they may see. Each page starts after the
        // last job of the one before, by createdAt and then _id for the ties: a job created meanwhile shifts no
        // page, so none is read twice nor skipped. At most MAX_LISTED_PAGES pages: a member whose history is
        // mostly out of their scope gets a shorter list, not a scan of all of it.
        const listed: ListedJob[] = []
        let after: Record<string, unknown> | undefined
        for (let pages = 0; listed.length < LISTED_JOBS && pages < MAX_LISTED_PAGES; pages++) {
            const page = await AiChangeJob.find(after ? { $and: [filter, after] } : filter, JOB_LISTED)
                .sort({ createdAt: -1, _id: -1 })
                .limit(LISTED_JOBS)
            listed.push(...(await this.inDomainScope(toObjectId(projectId), page)))
            if (page.length < LISTED_JOBS) break
            const last = page[page.length - 1]
            after = { $or: [{ createdAt: { $lt: last.createdAt } }, { createdAt: last.createdAt, _id: { $lt: last._id } }] }
        }
        listed.splice(LISTED_JOBS)
        const jobs = await Promise.all(listed.map(job => this.failIfStale(job)))
        const views = await this.views(jobs, false)
        return active ? views.filter(view => ACTIVE_JOB_STATUSES.includes(view.status) || view.repositories.some(repository => repository.status === AiChangeStatus.PROPOSED)) : views
    }

    /**
     * The agents working in the project right now, whoever started them: each job, and each change asked
     * from a component page on its own, with the frontends and backends it works on. A job is fresh by its
     * own date, its requests are not touched while it runs. A mission's jobs are followed on the Fleet page.
     */
    async working(projectId: string): Promise<AiWorkingJobView[]> {
        await this.ensureAccessToProject(toObjectId(projectId))
        const updatedAt = fresh()
        const [jobs, requests, scope] = await Promise.all([
            AiChangeJob.find(
                { projectId: toObjectId(projectId), missionId: { $exists: false }, status: { $in: ACTIVE_JOB_STATUSES }, updatedAt },
                { frontendIds: 1, backendIds: 1, scope: 1, domainId: 1 }
            ),
            AiChangeRequest.find({ projectId: toObjectId(projectId), jobId: { $exists: false }, status: { $in: UNFINISHED_REQUEST_STATUSES }, updatedAt }, { frontendId: 1, backendId: 1 }),
            this.getDomainScope(projectId)
        ])
        // A domain-scoped member is told about the jobs they may open only, as a list of jobs shows them, and about the changes on what they see
        const scoped = Boolean(scope)
        const visibleJobs = scoped ? await this.inDomainScope(toObjectId(projectId), jobs as unknown as ListedJob[]) : jobs
        const working: AiWorkingJobView[] = [
            ...visibleJobs.map(job => ({ jobId: String(job._id), kind: "job" as const, componentIds: componentsOfJob(job).map(ref => ref.id) })),
            ...requests.map(request => ({ jobId: String(request._id), kind: "request" as const, componentIds: [componentIdOf(request)] }))
        ]
        if (!scoped) return working
        const projectFilter = { projectId: toObjectId(projectId), ...(await this.domainScopeFilter(projectId)) }
        const visible = new Set((await Promise.all([Frontend.find(projectFilter, { _id: 1 }), Backend.find(projectFilter, { _id: 1 })])).flat().map(component => String(component._id)))
        return working.filter(entry => entry.kind === "job" || entry.componentIds.every(id => visible.has(id)))
    }
}
