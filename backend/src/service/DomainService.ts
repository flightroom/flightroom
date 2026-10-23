import axios from "axios"
import { isValidObjectId, ObjectId, Schema } from "mongoose"
import { BusinessException, createBusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import CodeRepository, { CodeRepositoryProvider } from "../models/CodeRepositoryModel"
import Domain, { IDomain } from "../models/DomainModel"
import Frontend, { ICodeRepositoryFrontend } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Service from "../models/ServiceModel"
import UserProject from "../models/UserProjectModel"
import DomainDTO, { DomainBuildFailure, DomainBuildRepository, DomainBuildResult, DomainMembersDTO } from "../types/DomainDTO"
import { SERVICE_VERSION } from "../types/ServiceStack"
import { isValidRefName } from "../utils/gitRefUtils"
import { toObjectId } from "../utils/mongooseUtils"
import { runInTransaction } from "../utils/runInTransaction"
import { slugify } from "../utils/slugUtils"
import BaseAuthorizedService, { DOMAIN_SCOPE_FORBIDDEN } from "./BaseAuthorizedService"
import { deleteLinksOfDomain } from "./DomainLinkService"
import { repositoryKeys } from "./repositoryLinks"
import TemplateScaffoldService, { TagLookupError, TagTarget } from "./TemplateScaffoldService"

/**
 * The domain a frontend or a service is put in, as it is stored: null when it is taken out of
 * any. A domain of another project is refused as missing, as a code repository connection is:
 * membership must never reach across projects.
 */
export const resolveDomainId = async (domainId: unknown, projectId: string | Schema.Types.ObjectId): Promise<string | null> => {
    if (domainId === null || domainId === "") {
        return null
    }
    if (typeof domainId !== "string" || !isValidObjectId(domainId)) {
        throw createBusinessException({ code: "DOMAIN_INVALID", message: `Invalid domain identifier: ${JSON.stringify(domainId)}` })
    }
    if (!(await Domain.exists({ _id: toObjectId(domainId), projectId: toObjectId(projectId) }))) {
        // A business exception rather than an EntityNotFoundError: the console translates it by its code
        throw createBusinessException({ code: "DOMAIN_NOT_FOUND", message: `There is no domain ${domainId} in this project`, statusCode: 404 })
    }
    return domainId
}

/** A body field that must be a string when given: anything else is refused with a 400, not a 500 on `.trim()` */
const ensureOptionalString = (field: string, value: unknown) => {
    if (value !== undefined && value !== null && typeof value !== "string") {
        throw createBusinessException({ code: "DOMAIN_INVALID", message: `${field} must be a string` })
    }
}

/** A body field that must be a list of ids when given: anything else is refused with a 400 */
const ensureIdList = (field: string, value: unknown) => {
    if (value === undefined || value === null) {
        return []
    }
    if (!Array.isArray(value) || !value.every(id => typeof id === "string" && isValidObjectId(id))) {
        throw createBusinessException({ code: "DOMAIN_INVALID", message: `${field} must be a list of identifiers` })
    }
    return value.map(id => toObjectId(id as string))
}

/** What the database refuses, as the caller should see it: a 409 for a taken slug, a 400 for a value out of the schema */
const toDomainError = (error: unknown, slug?: string): unknown => {
    if ((error as { code?: number })?.code === 11000) {
        return createBusinessException({ code: "DOMAIN_SLUG_TAKEN", message: `A domain with slug "${slug}" already exists in this project`, statusCode: 409 })
    }
    if ((error as Error)?.name === "ValidationError") {
        return createBusinessException({ code: "DOMAIN_INVALID", message: (error as Error).message })
    }
    return error
}

const countBy = (members: { domainId?: unknown }[]): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const member of members) {
        const key = String(member.domainId)
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
}

/** A repository linked to members of a domain, with every member that links to it */
interface BuildRepository {
    id: string
    link: ICodeRepositoryFrontend
    /** What tells the repository, as {@link repositoryKeys} gives it: another link with any of them is the same repository */
    keys: Set<string>
    members: DomainBuildRepository["members"]
}

type BuildMember = { kind: "frontend" | "service"; _id: unknown; name: string; codeRepository?: ICodeRepositoryFrontend }

/**
 * The members' repositories, once each: two members linked to the same repository would otherwise tag it twice.
 * Two links are the same repository by the rule `linksToRepository` queries with: the same connection and any of
 * id, name or GitLab path in common, so a link that stores a name and one that stores an id still meet.
 */
const repositoriesOf = (members: BuildMember[], providers: Map<string, CodeRepositoryProvider>): BuildRepository[] => {
    let repositories: BuildRepository[] = []
    for (const { kind, _id, name, codeRepository } of members) {
        if (!codeRepository?.enabled) continue
        const connection = String(codeRepository.codeRepositoryId)
        const keys = new Set(repositoryKeys(providers.get(connection), codeRepository).map(({ field, value }) => `${connection}/${field}:${value}`))
        const same = repositories.filter(repository => [...keys].some(key => repository.keys.has(key)))
        const repository = same[0] ?? {
            id: [connection, codeRepository.repositoryId || codeRepository.name, codeRepository.gitlab?.path].filter(Boolean).join("/"),
            link: codeRepository,
            keys: new Set<string>(),
            members: []
        }
        // A link that holds the keys of two repositories found so far shows they were one
        for (const other of same.slice(1)) {
            for (const key of other.keys) repository.keys.add(key)
            repository.members.push(...other.members)
        }
        for (const key of keys) repository.keys.add(key)
        repository.members.push({ kind, _id: String(_id), name })
        if (same.length === 0) {
            repositories.push(repository)
        } else {
            repositories = repositories.filter(candidate => !same.slice(1).includes(candidate))
        }
    }
    return repositories
}

/** How many repositories are checked at the provider at once */
const CHECK_CONCURRENCY = 4

/**
 * `task` on each item, at most `limit` at a time, the results in the order of the items. `task` must not
 * reject: one rejection would end the run with the other tasks still going.
 */
const mapWithLimit = async <Item, Result>(items: Item[], limit: number, task: (item: Item) => Promise<Result>): Promise<Result[]> => {
    const results: Result[] = new Array(items.length)
    let next = 0
    const worker = async () => {
        while (next < items.length) {
            const index = next++
            results[index] = await task(items[index])
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
}

/** Why a repository could not be tagged, from the error of its check or of its tag */
const toBuildFailure = (error: unknown): { reason: DomainBuildFailure; message: string } => {
    if (error instanceof EntityNotFoundError) {
        return { reason: "CONNECTION_NOT_FOUND", message: "The code repository connection is not one of this project" }
    }
    if (error instanceof BusinessException && error.code === DOMAIN_SCOPE_FORBIDDEN) {
        return { reason: "DOMAIN_SCOPE_FORBIDDEN", message: "The repository is shared with a component outside your domains" }
    }
    if (error instanceof TagLookupError) {
        return { reason: error.reason, message: error.message }
    }
    if (axios.isAxiosError(error)) {
        const providerMessage = (error.response?.data as { message?: unknown } | undefined)?.message
        return { reason: "PROVIDER_ERROR", message: typeof providerMessage === "string" ? providerMessage : error.message }
    }
    return { reason: "PROVIDER_ERROR", message: error instanceof Error ? error.message : String(error) }
}

/** Refuses, before anything is read, a version or a branch the providers would not take as a tag of a domain build */
export function ensureBuildTarget(version: unknown, ref?: unknown): asserts version is string {
    // The rule of a service build: the tag becomes, in the pipelines, an image tag and a URL segment
    if (typeof version !== "string" || !SERVICE_VERSION.test(version)) {
        throw createBusinessException({ code: "DOMAIN_BUILD_VERSION_INVALID", message: "The version may hold only letters, digits, dots, dashes and underscores (at most 128)" })
    }
    // The branch goes into the URL of each provider: only a name git itself accepts
    if (ref !== undefined && ref !== null && ref !== "" && (typeof ref !== "string" || !isValidRefName(ref))) {
        throw createBusinessException({ code: "DOMAIN_BUILD_REF_INVALID", message: "The branch must be a valid git branch name of at most 255 characters" })
    }
}

/** The branch a domain build tags: main when none is given */
export const buildBranchOf = (ref?: unknown): string => (typeof ref === "string" && ref ? ref : "main")

const toOutcome = ({ id, link, members }: BuildRepository, outcome: Pick<DomainBuildRepository, "status" | "reason" | "message">): DomainBuildRepository => ({
    id,
    repository: link.name,
    members,
    ...outcome
})

export class DomainService extends BaseAuthorizedService {
    async getById(id: string | ObjectId): Promise<IDomain | null> {
        const domain = await Domain.findById(toObjectId(id))
        if (!domain) {
            return null
        }
        await this.ensureAccessToProject(domain.projectId)
        await this.ensureInDomainScope(domain.projectId, domain._id)
        return domain
    }

    /** The domains of the project, each with how many frontends and services it groups */
    async getByProjectId(projectId: string | Schema.Types.ObjectId) {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        // The counts need no filter of their own: every member of a domain in scope is in scope too
        const inScope = await this.domainScopeFilter(projectIdObj, "_id")
        const [domains, frontends, services] = await Promise.all([
            Domain.find({ projectId: projectIdObj, ...inScope }).sort({ name: 1 }),
            Frontend.find({ projectId: projectIdObj, domainId: { $ne: null } }, { domainId: 1 }),
            Service.find({ projectId: projectIdObj, domainId: { $ne: null } }, { domainId: 1 })
        ])
        const frontendCounts = countBy(frontends)
        const serviceCounts = countBy(services)
        return domains.map(domain => ({
            ...domain.toObject(),
            frontendsCount: frontendCounts.get(String(domain._id)) ?? 0,
            servicesCount: serviceCounts.get(String(domain._id)) ?? 0
        }))
    }

    async create(dto: DomainDTO, projectId: string | Schema.Types.ObjectId): Promise<IDomain> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        // The domains are the map of the whole project: drawn by those who reach all of it
        await this.ensureWholeProject(projectIdObj)

        ensureOptionalString("name", dto.name)
        ensureOptionalString("slug", dto.slug)
        ensureOptionalString("description", dto.description)
        ensureOptionalString("context", dto.context)
        const name = (dto.name ?? "").trim()
        if (!name) {
            throw createBusinessException({ code: "DOMAIN_NAME_REQUIRED", message: "The domain name is required" })
        }
        const slug = slugify(dto.slug?.trim() || name)
        if (!slug) {
            throw createBusinessException({ code: "DOMAIN_SLUG_INVALID", message: `"${name}" gives no usable slug: use at least one letter or digit` })
        }
        if (await Domain.exists({ slug, projectId: projectIdObj })) {
            throw createBusinessException({ code: "DOMAIN_SLUG_TAKEN", message: `A domain with slug "${slug}" already exists in this project`, statusCode: 409 })
        }

        try {
            return await Domain.create({ name, slug, description: dto.description ?? undefined, context: dto.context || undefined, projectId: projectIdObj })
        } catch (error) {
            // A concurrent create of the same slug passed the check above: the unique index decides
            throw toDomainError(error, slug)
        }
    }

    async update(id: string | ObjectId, updates: DomainDTO): Promise<IDomain | null> {
        const domain = await this.getById(id)
        if (!domain) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureWholeProject(domain.projectId)
        // Never moved to another project nor given another slug through an update
        ensureOptionalString("name", updates.name)
        ensureOptionalString("description", updates.description)
        ensureOptionalString("context", updates.context)
        const allowed: Partial<DomainDTO> = {}
        if (updates.name !== undefined && updates.name !== null) {
            if (!updates.name.trim()) {
                throw createBusinessException({ code: "DOMAIN_NAME_REQUIRED", message: "The domain name is required" })
            }
            allowed.name = updates.name
        }
        if (updates.description !== undefined) {
            allowed.description = updates.description
        }
        if (updates.context !== undefined) {
            allowed.context = updates.context
        }
        try {
            return await Domain.findByIdAndUpdate(domain._id, allowed, { new: true, runValidators: true })
        } catch (error) {
            throw toDomainError(error, domain.slug)
        }
    }

    /**
     * Puts frontends and services in the domain, taking them out of the one they were in. Only members of
     * the domain's project are moved: an id of another project is left as it is, never pulled across projects.
     */
    async addMembers(id: string | ObjectId, dto: DomainMembersDTO): Promise<{ frontends: number; services: number }> {
        const domain = await this.getById(id)
        if (!domain) {
            throw new EntityNotFoundError(String(id))
        }
        // Moving members between domains moves them in or out of the scopes of other members
        await this.ensureWholeProject(domain.projectId)
        const frontendIds = ensureIdList("frontendIds", dto?.frontendIds)
        const serviceIds = ensureIdList("serviceIds", dto?.serviceIds)
        return runInTransaction(async session => {
            const membership = { $set: { domainId: domain._id } }
            const frontends = await Frontend.updateMany({ _id: { $in: frontendIds }, projectId: domain.projectId }, membership, { session })
            const services = await Service.updateMany({ _id: { $in: serviceIds }, projectId: domain.projectId }, membership, { session })
            return { frontends: frontends.matchedCount, services: services.matchedCount }
        })
    }

    /**
     * Releases the whole domain: tags the repository of each of its frontends and services with the same
     * `version`, on the same `ref` (main by default), as their own builds do one at a time. Every repository is
     * checked first (its connection, the domain scope, the ref, a tag of that name): when one fails, none is
     * tagged and the refusal lists each one. A tag that still fails afterwards leaves the others made, and the
     * result says which.
     */
    async build(id: string | ObjectId, version: unknown, ref?: unknown): Promise<DomainBuildResult> {
        ensureBuildTarget(version, ref)
        const branch = buildBranchOf(ref)
        const domain = await this.getById(id)
        if (!domain) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureNotViewer(domain.projectId, { code: "DOMAIN_BUILD_FORBIDDEN", message: "A viewer cannot create a version of a domain" })

        const inDomain = { projectId: domain.projectId, domainId: domain._id }
        const [frontends, services] = await Promise.all([Frontend.find(inDomain, { name: 1, codeRepository: 1 }), Service.find(inDomain, { name: 1, codeRepository: 1 })])
        if (frontends.length + services.length === 0) {
            throw createBusinessException({ code: "DOMAIN_BUILD_EMPTY", message: "The domain has no frontend nor service to build" })
        }
        const members: BuildMember[] = [
            ...frontends.map(member => ({ kind: "frontend" as const, _id: member._id, name: member.name, codeRepository: member.codeRepository })),
            ...services.map(member => ({ kind: "service" as const, _id: member._id, name: member.name, codeRepository: member.codeRepository }))
        ]
        // The provider decides which of name and GitLab path tells a repository
        const connectionIds = [...new Set(members.filter(member => member.codeRepository?.enabled).map(member => String(member.codeRepository?.codeRepositoryId)))]
        const connections = connectionIds.length > 0 ? await CodeRepository.find({ _id: { $in: connectionIds.map(toObjectId) } }, { provider: 1 }) : []
        const repositories = repositoriesOf(members, new Map(connections.map(connection => [String(connection._id), connection.provider])))
        if (repositories.length === 0) {
            throw createBusinessException({ code: "DOMAIN_BUILD_NO_REPOSITORIES", message: "No frontend nor service of the domain has a linked code repository to tag" })
        }

        const scaffold = new TemplateScaffoldService(this.user)
        // A tag starts a release: half a domain released on a typo in the branch is worse than none
        const checks = await mapWithLimit(repositories, CHECK_CONCURRENCY, async repository => {
            try {
                const target = await scaffold.resolveTagTarget(repository.link, domain.projectId, branch)
                if (!target) {
                    return { repository, failure: { reason: "PROVIDER_ERROR" as const, message: "The provider of the connection cannot be tagged" } }
                }
                if (await scaffold.tagExists(target, version)) {
                    return { repository, failure: { reason: "TAG_EXISTS" as const, message: `The tag ${version} already exists in the repository` } }
                }
                return { repository, target }
            } catch (error) {
                return { repository, failure: toBuildFailure(error) }
            }
        })
        if (checks.some(check => check.failure)) {
            const outcomes = checks.map(check => toOutcome(check.repository, check.failure ? { status: "failed", ...check.failure } : { status: "ready" }))
            const failed = outcomes.filter(outcome => outcome.status === "failed").map(outcome => `${outcome.repository}: ${outcome.message}`)
            throw createBusinessException({
                code: "DOMAIN_BUILD_CHECK_FAILED",
                message: `No repository was tagged, the check failed for ${failed.join("; ")}`,
                statusCode: 409,
                details: { version, ref: branch, repositories: outcomes }
            })
        }

        // One after the other: whatever was tagged stays tagged, and a failure is told with the rest
        const outcomes: DomainBuildRepository[] = []
        for (const { repository, target } of checks) {
            try {
                await scaffold.pushTag(target as TagTarget, version)
                outcomes.push(toOutcome(repository, { status: "tagged" }))
            } catch (error) {
                outcomes.push(toOutcome(repository, { status: "failed", ...toBuildFailure(error) }))
            }
        }
        return { version, ref: branch, repositories: outcomes }
    }

    /**
     * Deletes the domain only: its frontends and services stay, without a domain. The memberships
     * scoped to it lose it from their scope and stay scoped, even when it was their last domain: they
     * then reach nothing rather than the whole project, until an owner gives them a new scope.
     */
    async delete(id: string | ObjectId): Promise<IDomain | null> {
        const domain = await this.getById(id)
        if (!domain) {
            throw new EntityNotFoundError(String(id))
        }
        await this.ensureWholeProject(domain.projectId)
        return runInTransaction(async session => {
            const members = { projectId: domain.projectId, domainId: domain._id }
            // null, as the forms store "no domain": the filters and the counts treat it as a missing domainId
            await Frontend.updateMany(members, { $set: { domainId: null } }, { session })
            await Service.updateMany(members, { $set: { domainId: null } }, { session })
            await MaintenanceAgent.updateMany(members, { $set: { domainId: null } }, { session })
            await UserProject.updateMany({ projectId: domain.projectId, domainIds: domain._id }, { $pull: { domainIds: domain._id } }, { session })
            await deleteLinksOfDomain(domain._id, session)
            return await Domain.findByIdAndDelete(domain._id, { session })
        })
    }
}

export default DomainService
