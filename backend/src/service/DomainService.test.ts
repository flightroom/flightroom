import { AxiosError, AxiosHeaders } from "axios"
import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A standalone mongod cannot open a transaction, and runInTransaction already knows to skip one
vi.mock("../plugins/noSQL", () => ({ isReplicaSet: false }))

import GithubClient from "../client/GithubClient"
import GitlabClient from "../client/GitlabClient"
import { BusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Backend from "../models/BackendModel"
import CodeRepository, { CodeRepositoryProvider } from "../models/CodeRepositoryModel"
import DomainLink from "../models/DomainLinkModel"
import Domain from "../models/DomainModel"
import Frontend from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import UserProject from "../models/UserProjectModel"
import { withNoMaintenanceAgents } from "../testing/noMaintenanceAgents"
import BaseAuthorizedService from "./BaseAuthorizedService"
import DomainService, { resolveDomainId } from "./DomainService"

withNoMaintenanceAgents()

const projectId = new Types.ObjectId().toString()
const domainId = new Types.ObjectId()

const allowAccess = () => vi.spyOn(DomainService.prototype as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue(undefined)

afterEach(() => {
    vi.restoreAllMocks()
})

describe("DomainService.create", () => {
    beforeEach(() => {
        allowAccess()
    })

    it("given a name only, when a domain is created, then its slug comes from the name and it belongs to the project", async () => {
        vi.spyOn(Domain, "exists").mockResolvedValue(null)
        const write = vi.spyOn(Domain, "create").mockImplementation((async (doc: unknown) => doc) as never)

        await new DomainService().create({ name: "  Customer Payments ", description: "Checkout and refunds" }, projectId)

        expect(write).toHaveBeenCalledWith({ name: "Customer Payments", slug: "customer-payments", description: "Checkout and refunds", projectId })
    })

    it("given a context, when a domain is created, then it is stored with it", async () => {
        vi.spyOn(Domain, "exists").mockResolvedValue(null)
        const write = vi.spyOn(Domain, "create").mockImplementation((async (doc: unknown) => doc) as never)

        await new DomainService().create({ name: "Payments", context: "Prices are in cents" }, projectId)

        expect(write).toHaveBeenCalledWith(expect.objectContaining({ context: "Prices are in cents" }))
    })

    it("given a slug another domain of the project has, when a domain is created, then it is refused with a conflict and nothing is written", async () => {
        const exists = vi.spyOn(Domain, "exists").mockResolvedValue({ _id: domainId } as never)
        const write = vi.spyOn(Domain, "create")

        const refusal = new DomainService().create({ name: "Payments" }, projectId)

        await expect(refusal).rejects.toMatchObject({ code: "DOMAIN_SLUG_TAKEN", statusCode: 409 })
        expect(exists).toHaveBeenCalledWith({ slug: "payments", projectId })
        expect(write).not.toHaveBeenCalled()
    })

    /** Two creates of one slug at once: both pass the check, the unique index refuses the second */
    it("given the unique index refusing the slug, when a domain is created, then it is a conflict", async () => {
        vi.spyOn(Domain, "exists").mockResolvedValue(null)
        vi.spyOn(Domain, "create").mockRejectedValue(Object.assign(new Error("E11000 duplicate key error"), { code: 11000 }) as never)

        await expect(new DomainService().create({ name: "Payments" }, projectId)).rejects.toMatchObject({ code: "DOMAIN_SLUG_TAKEN", statusCode: 409 })
    })

    it("given a name over the schema limit, when a domain is created, then it is refused with a 400", async () => {
        vi.spyOn(Domain, "exists").mockResolvedValue(null)
        vi.spyOn(Domain, "create").mockRejectedValue(Object.assign(new Error("name is longer than the maximum allowed length (100)"), { name: "ValidationError" }) as never)

        await expect(new DomainService().create({ name: "x".repeat(101) }, projectId)).rejects.toMatchObject({ code: "DOMAIN_INVALID", statusCode: 400 })
    })

    it.each([[{ name: 42 }], [{ name: "Payments", slug: ["payments"] }], [{ name: "Payments", description: { text: "x" } }]])(
        "given the body %j, when a domain is created, then it is refused with a 400 before anything is read",
        async body => {
            const exists = vi.spyOn(Domain, "exists")

            await expect(new DomainService().create(body as never, projectId)).rejects.toMatchObject({ statusCode: 400 })
            expect(exists).not.toHaveBeenCalled()
        }
    )

    it.each([[""], ["   "], ["!!!"]])("given the name %j, when a domain is created, then it is refused", async name => {
        vi.spyOn(Domain, "exists").mockResolvedValue(null)
        const write = vi.spyOn(Domain, "create")

        await expect(new DomainService().create({ name }, projectId)).rejects.toBeInstanceOf(BusinessException)
        expect(write).not.toHaveBeenCalled()
    })
})

describe("resolveDomainId", () => {
    it("given a domain of the project, when it is resolved, then it is kept", async () => {
        const exists = vi.spyOn(Domain, "exists").mockResolvedValue({ _id: domainId } as never)

        await expect(resolveDomainId(String(domainId), projectId)).resolves.toBe(String(domainId))
        expect(exists).toHaveBeenCalledWith({ _id: String(domainId), projectId })
    })

    /** Membership never reaches across projects */
    it("given a domain of another project, when it is resolved, then it is not found", async () => {
        vi.spyOn(Domain, "exists").mockResolvedValue(null)

        await expect(resolveDomainId(String(domainId), projectId)).rejects.toMatchObject({ code: "DOMAIN_NOT_FOUND", statusCode: 404 })
    })

    it.each([[null], [""]])("given %j, when it is resolved, then the member is taken out of any domain without a lookup", async value => {
        const exists = vi.spyOn(Domain, "exists")

        await expect(resolveDomainId(value, projectId)).resolves.toBeNull()
        expect(exists).not.toHaveBeenCalled()
    })

    it.each([["not-an-id"], [42], [{ $ne: null }]])("given %j, when it is resolved, then it is refused", async value => {
        await expect(resolveDomainId(value, projectId)).rejects.toBeInstanceOf(BusinessException)
    })
})

describe("DomainService.getByProjectId", () => {
    it("given members in some domains, when the domains are listed, then each carries how many frontends and backends it groups", async () => {
        allowAccess()
        const otherId = new Types.ObjectId()
        const domain = (id: Types.ObjectId, name: string) => ({ _id: id, toObject: () => ({ _id: id, name }) })
        vi.spyOn(Domain, "find").mockReturnValue({ sort: vi.fn().mockResolvedValue([domain(domainId, "Payments"), domain(otherId, "Search")]) } as never)
        vi.spyOn(Frontend, "find").mockResolvedValue([{ domainId }, { domainId }, { domainId: otherId }] as never)
        vi.spyOn(Backend, "find").mockResolvedValue([{ domainId }] as never)

        const domains = await new DomainService().getByProjectId(projectId)

        expect(domains).toEqual([
            { _id: domainId, name: "Payments", frontendsCount: 2, backendsCount: 1 },
            { _id: otherId, name: "Search", frontendsCount: 1, backendsCount: 0 }
        ])
    })
})

describe("DomainService.delete", () => {
    const domain = { _id: domainId, projectId, slug: "payments", name: "Payments" }

    beforeEach(() => {
        allowAccess()
        vi.spyOn(Domain, "findById").mockResolvedValue(domain as never)
    })

    it("given a domain with members, when it is deleted, then its frontends and backends lose the domain but are kept", async () => {
        const unsetFrontends = vi.spyOn(Frontend, "updateMany").mockResolvedValue({ modifiedCount: 2 } as never)
        const unsetBackends = vi.spyOn(Backend, "updateMany").mockResolvedValue({ modifiedCount: 1 } as never)
        const deleteFrontends = vi.spyOn(Frontend, "deleteMany")
        const deleteBackends = vi.spyOn(Backend, "deleteMany")
        const deleteLinks = vi.spyOn(DomainLink, "deleteMany").mockResolvedValue({ deletedCount: 1 } as never)
        const pullFromScopes = vi.spyOn(UserProject, "updateMany").mockResolvedValue({ modifiedCount: 1 } as never)
        const remove = vi.spyOn(Domain, "findByIdAndDelete").mockResolvedValue(domain as never)

        const deleted = await new DomainService().delete(String(domainId))

        const members = { projectId, domainId }
        expect(unsetFrontends).toHaveBeenCalledWith(members, { $set: { domainId: null } }, expect.anything())
        expect(unsetBackends).toHaveBeenCalledWith(members, { $set: { domainId: null } }, expect.anything())
        expect(deleteLinks).toHaveBeenCalledWith({ $or: [{ sourceDomainId: domainId }, { targetDomainId: domainId }] }, expect.anything())
        // Pulled from the scopes and nothing else: `domainScoped` stays, so an emptied scope reaches nothing rather than the whole project
        expect(pullFromScopes).toHaveBeenCalledWith({ projectId, domainIds: domainId }, { $pull: { domainIds: domainId } }, expect.anything())
        expect(remove).toHaveBeenCalledWith(domainId, expect.anything())
        expect(deleteFrontends).not.toHaveBeenCalled()
        expect(deleteBackends).not.toHaveBeenCalled()
        expect(deleted).toBe(domain)
    })

    it("given an unknown domain, when it is deleted, then it is not found and no member is touched", async () => {
        vi.spyOn(Domain, "findById").mockResolvedValue(null)
        const unset = vi.spyOn(Frontend, "updateMany")

        await expect(new DomainService().delete(String(domainId))).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(unset).not.toHaveBeenCalled()
    })
})

describe("DomainService.addMembers", () => {
    const domain = { _id: domainId, projectId, slug: "payments", name: "Payments" }
    const frontendId = new Types.ObjectId().toString()
    const backendId = new Types.ObjectId().toString()

    beforeEach(() => {
        allowAccess()
        vi.spyOn(Domain, "findById").mockResolvedValue(domain as never)
    })

    it("given frontends and backends, when they are added, then only the ones of the domain's project are put in it", async () => {
        const moveFrontends = vi.spyOn(Frontend, "updateMany").mockResolvedValue({ matchedCount: 1 } as never)
        const moveBackends = vi.spyOn(Backend, "updateMany").mockResolvedValue({ matchedCount: 1 } as never)

        const added = await new DomainService().addMembers(String(domainId), { frontendIds: [frontendId], backendIds: [backendId] })

        const membership = { $set: { domainId } }
        expect(moveFrontends).toHaveBeenCalledWith({ _id: { $in: [frontendId] }, projectId }, membership, expect.anything())
        expect(moveBackends).toHaveBeenCalledWith({ _id: { $in: [backendId] }, projectId }, membership, expect.anything())
        expect(added).toEqual({ frontends: 1, backends: 1 })
    })

    it.each([[{ frontendIds: "abc" }], [{ backendIds: ["not-an-id"] }], [{ backendIds: [42] }]])(
        "given the body %j, when members are added, then it is refused with a 400 and nothing is moved",
        async body => {
            const move = vi.spyOn(Frontend, "updateMany")

            await expect(new DomainService().addMembers(String(domainId), body as never)).rejects.toMatchObject({ code: "DOMAIN_INVALID", statusCode: 400 })
            expect(move).not.toHaveBeenCalled()
        }
    )

    it("given frontends and backends, when they are removed, then only those the domain groups leave it, for no domain", async () => {
        const leaveFrontends = vi.spyOn(Frontend, "updateMany").mockResolvedValue({ modifiedCount: 1 } as never)
        const leaveBackends = vi.spyOn(Backend, "updateMany").mockResolvedValue({ modifiedCount: 0 } as never)

        const removed = await new DomainService().removeMembers(String(domainId), { frontendIds: [frontendId], backendIds: [backendId] })

        const leaving = { $unset: { domainId: 1 } }
        expect(leaveFrontends).toHaveBeenCalledWith({ _id: { $in: [frontendId] }, projectId, domainId }, leaving, expect.anything())
        expect(leaveBackends).toHaveBeenCalledWith({ _id: { $in: [backendId] }, projectId, domainId }, leaving, expect.anything())
        expect(removed).toEqual({ frontends: 1, backends: 0 })
    })

    it("given a body that is no list of ids, when members are removed, then it is refused with a 400 and nothing leaves", async () => {
        const leave = vi.spyOn(Backend, "updateMany")

        await expect(new DomainService().removeMembers(String(domainId), { backendIds: ["not-an-id"] })).rejects.toMatchObject({ code: "DOMAIN_INVALID", statusCode: 400 })
        expect(leave).not.toHaveBeenCalled()
    })

    it("given an unknown domain, when members are added, then it is not found and nothing is moved", async () => {
        vi.spyOn(Domain, "findById").mockResolvedValue(null)
        const move = vi.spyOn(Backend, "updateMany")

        await expect(new DomainService().addMembers(String(domainId), { backendIds: [backendId] })).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(move).not.toHaveBeenCalled()
    })
})

describe("DomainService.update", () => {
    it("given a slug and a project in the updates, when a domain is updated, then only name and description are written", async () => {
        allowAccess()
        const domain = { _id: domainId, projectId, slug: "payments", name: "Payments" }
        vi.spyOn(Domain, "findById").mockResolvedValue(domain as never)
        const write = vi.spyOn(Domain, "findByIdAndUpdate").mockResolvedValue(domain as never)

        await new DomainService().update(String(domainId), { name: "Billing", description: "Invoices", slug: "billing", projectId: "x" } as never)

        expect(write).toHaveBeenCalledWith(domainId, { name: "Billing", description: "Invoices" }, { new: true, runValidators: true })
    })

    it("given a context, when a domain is updated, then it is written, and null clears it", async () => {
        allowAccess()
        const domain = { _id: domainId, projectId, slug: "payments", name: "Payments" }
        vi.spyOn(Domain, "findById").mockResolvedValue(domain as never)
        const write = vi.spyOn(Domain, "findByIdAndUpdate").mockResolvedValue(domain as never)

        await new DomainService().update(String(domainId), { context: "Prices are in cents" } as never)
        await new DomainService().update(String(domainId), { context: null } as never)

        expect(write).toHaveBeenNthCalledWith(1, domainId, { context: "Prices are in cents" }, { new: true, runValidators: true })
        expect(write).toHaveBeenNthCalledWith(2, domainId, { context: null }, { new: true, runValidators: true })
    })

    it("given a context that is not a string, when a domain is updated, then it is refused with a 400 and nothing is written", async () => {
        allowAccess()
        vi.spyOn(Domain, "findById").mockResolvedValue({ _id: domainId, projectId, slug: "payments", name: "Payments" } as never)
        const write = vi.spyOn(Domain, "findByIdAndUpdate")

        await expect(new DomainService().update(String(domainId), { context: 42 } as never)).rejects.toMatchObject({ code: "DOMAIN_INVALID", statusCode: 400 })
        expect(write).not.toHaveBeenCalled()
    })

    it("given a name that is not a string, when a domain is updated, then it is refused with a 400 and nothing is written", async () => {
        allowAccess()
        vi.spyOn(Domain, "findById").mockResolvedValue({ _id: domainId, projectId, slug: "payments", name: "Payments" } as never)
        const write = vi.spyOn(Domain, "findByIdAndUpdate")

        await expect(new DomainService().update(String(domainId), { name: 42 } as never)).rejects.toMatchObject({ code: "DOMAIN_INVALID", statusCode: 400 })
        expect(write).not.toHaveBeenCalled()
    })
})

describe("DomainService.build", () => {
    const codeRepositoryId = new Types.ObjectId()
    const domain = { _id: domainId, projectId, slug: "payments", name: "Payments" }
    const link = (name: string, repositoryId: string) => ({ enabled: true, codeRepositoryId, repositoryId, name })
    const member = (name: string, codeRepository?: Record<string, unknown>, version?: string) => ({ _id: new Types.ObjectId(), name, codeRepository, version })
    const answered = (status: number) =>
        new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", undefined, undefined, {
            status,
            statusText: "",
            data: { message: "Not Found" },
            headers: {},
            config: { headers: new AxiosHeaders() }
        })

    let getBranchCommitSha: ReturnType<typeof vi.spyOn>
    let getRepository: ReturnType<typeof vi.spyOn>
    let tagExists: ReturnType<typeof vi.spyOn>
    let createTag: ReturnType<typeof vi.spyOn>

    /** The domain with these members, each repository on the same GitHub connection of the project */
    const withMembers = (frontends: ReturnType<typeof member>[], backends: ReturnType<typeof member>[] = []) => {
        vi.spyOn(Domain, "findById").mockResolvedValue(domain as never)
        vi.spyOn(Frontend, "find").mockResolvedValue(frontends as never)
        vi.spyOn(Backend, "find").mockResolvedValue(backends as never)
    }

    /** A member of the project with this role, whose organization they do not administer */
    const withRole = (role: string) => {
        vi.spyOn(UserProject, "findOne").mockResolvedValue({ role } as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId() } as never)
        vi.spyOn(BaseAuthorizedService.prototype as unknown as { findRoleInOrganization: () => Promise<undefined> }, "findRoleInOrganization").mockResolvedValue(undefined)
    }
    const asUser = () => new DomainService({ _id: new Types.ObjectId() } as never)

    beforeEach(() => {
        allowAccess()
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({
            _id: codeRepositoryId,
            projectId,
            provider: CodeRepositoryProvider.GITHUB,
            accessToken: "token",
            githubData: { userName: "acme" }
        } as never)
        vi.spyOn(CodeRepository, "find").mockResolvedValue([{ _id: codeRepositoryId, provider: CodeRepositoryProvider.GITHUB }] as never)
        getBranchCommitSha = vi.spyOn(GithubClient.prototype, "getBranchCommitSha").mockImplementation((async (_token: string, name: string) => `sha-of-${name}`) as never)
        getRepository = vi.spyOn(GithubClient.prototype, "getRepository").mockResolvedValue({} as never)
        tagExists = vi.spyOn(GithubClient.prototype, "tagExists").mockResolvedValue(false)
        createTag = vi.spyOn(GithubClient.prototype, "createTag").mockResolvedValue(undefined)
    })

    it("given members with repositories, when the domain is built, then every repository is tagged with the same version on the same branch", async () => {
        withMembers([member("Cart", link("cart-fe", "1")), member("Search", link("search-fe", "2"))], [member("Orders API", link("orders-be", "3"))])

        const result = await new DomainService().build(String(domainId), "1.4.0", "release/1.4")

        expect(getBranchCommitSha.mock.calls.map((call: unknown[]) => call[2])).toEqual(["release/1.4", "release/1.4", "release/1.4"])
        expect(createTag).toHaveBeenCalledTimes(3)
        expect(createTag).toHaveBeenCalledWith("token", "cart-fe", "1.4.0", "sha-of-cart-fe", undefined, "acme")
        expect(createTag).toHaveBeenCalledWith("token", "orders-be", "1.4.0", "sha-of-orders-be", undefined, "acme")
        expect(result.version).toBe("1.4.0")
        expect(result.ref).toBe("release/1.4")
        expect(result.repositories.map(repository => [repository.id, repository.repository, repository.status])).toEqual([
            [`${codeRepositoryId}/1`, "cart-fe", "tagged"],
            [`${codeRepositoryId}/2`, "search-fe", "tagged"],
            [`${codeRepositoryId}/3`, "orders-be", "tagged"]
        ])
    })

    it("given a repository whose branch is still on the commit of its member's version, when the domain is built, then only the others are tagged", async () => {
        withMembers([member("Cart", link("cart-fe", "1"), "1.3.0")], [member("Orders API", link("orders-be", "3"), "1.3.0")])
        vi.spyOn(GithubClient.prototype, "getTagCommitSha").mockImplementation((async (_token: string, name: string) => (name === "cart-fe" ? "sha-of-cart-fe" : "older-sha")) as never)

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(1)
        expect(createTag).toHaveBeenCalledWith("token", "orders-be", "1.4.0", "sha-of-orders-be", undefined, "acme")
        expect(result.repositories.map(repository => [repository.repository, repository.status])).toEqual([
            ["cart-fe", "unchanged"],
            ["orders-be", "tagged"]
        ])
    })

    it("given a shared repository where one member has no version yet, when the domain is built, then it is tagged", async () => {
        withMembers([member("Cart", link("web", "1"), "1.3.0"), member("Search", link("web", "1"))])
        const getTagCommitSha = vi.spyOn(GithubClient.prototype, "getTagCommitSha").mockResolvedValue("sha-of-web")

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(getTagCommitSha).not.toHaveBeenCalled()
        expect(createTag).toHaveBeenCalledTimes(1)
        expect(result.repositories.map(repository => repository.status)).toEqual(["tagged"])
    })

    it("given a version tag the provider cannot read, when the domain is built, then the repository is tagged anyway", async () => {
        withMembers([member("Cart", link("cart-fe", "1"), "1.3.0")])
        vi.spyOn(GithubClient.prototype, "getTagCommitSha").mockRejectedValue(answered(500))

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(1)
        expect(result.repositories.map(repository => repository.status)).toEqual(["tagged"])
    })

    it("given no branch, when the domain is built, then main is tagged", async () => {
        withMembers([member("Cart", link("cart-fe", "1"))])

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(getBranchCommitSha).toHaveBeenCalledWith("token", "cart-fe", "main", undefined, "acme")
        expect(result.ref).toBe("main")
    })

    it("given a branch for some members, when the domain is built, then each repository is tagged on its members' branch and the others on the branch of the build", async () => {
        const cart = member("Cart", link("cart-fe", "1"))
        const orders = member("Orders API", link("orders-be", "3"))
        withMembers([cart, member("Search", link("search-fe", "2"))], [orders])

        const result = await new DomainService().build(String(domainId), "1.4.0", undefined, { [String(cart._id)]: "develop", [String(orders._id)]: "release/1.4" })

        expect(getBranchCommitSha.mock.calls.map((call: unknown[]) => [call[1], call[2]])).toEqual([
            ["cart-fe", "develop"],
            ["search-fe", "main"],
            ["orders-be", "release/1.4"]
        ])
        expect(result.repositories.map(repository => [repository.repository, repository.ref, repository.status])).toEqual([
            ["cart-fe", "develop", "tagged"],
            ["search-fe", "main", "tagged"],
            ["orders-be", "release/1.4", "tagged"]
        ])
    })

    it("given two members sharing a repository on different branches, when the domain is built, then it is refused and nothing is tagged", async () => {
        const front = member("Cart", link("shop", "7"))
        const back = member("Cart API", link("shop", "7"))
        withMembers([front], [back])

        await expect(new DomainService().build(String(domainId), "1.4.0", undefined, { [String(front._id)]: "develop", [String(back._id)]: "main" })).rejects.toMatchObject({
            code: "DOMAIN_BUILD_REF_CONFLICT",
            statusCode: 400
        })
        expect(createTag).not.toHaveBeenCalled()
    })

    it.each([[["main"]], ["main"], [{ any: "has space" }], [{ any: 42 }]])("given the branches %j, when the domain is built, then they are refused before anything is read", async refs => {
        const findDomain = vi.spyOn(Domain, "findById")

        await expect(new DomainService().build(String(domainId), "1.4.0", undefined, refs)).rejects.toMatchObject({ code: "DOMAIN_BUILD_REF_INVALID", statusCode: 400 })
        expect(findDomain).not.toHaveBeenCalled()
    })

    /** A tag of a version starts the pipeline of the whole repository: a second one of the same name would fail */
    it("given a repository shared by a frontend and a backend, when the domain is built, then it is tagged once for both", async () => {
        withMembers([member("Cart", link("shop", "7"))], [member("Cart API", link("shop", "7"))])

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(1)
        expect(result.repositories).toHaveLength(1)
        expect(result.repositories[0].members.map(({ kind, name }) => ({ kind, name }))).toEqual([
            { kind: "frontend", name: "Cart" },
            { kind: "backend", name: "Cart API" }
        ])
    })

    /** As linksToRepository: the same connection and any identifier in common is the same repository */
    it("given two links to one repository, one storing its name and one its id as well, when the domain is built, then it is tagged once", async () => {
        withMembers([member("Cart", { enabled: true, codeRepositoryId, name: "shop" }), member("Checkout", { enabled: true, codeRepositoryId, repositoryId: "guid-7", name: "shop" })])

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(1)
        expect(result.repositories[0].members.map(({ name }) => name)).toEqual(["Cart", "Checkout"])
    })

    it("given a third link that joins two repositories found apart, when the domain is built, then they are one", async () => {
        withMembers([
            member("Cart", { enabled: true, codeRepositoryId, name: "shop" }),
            member("Search", { enabled: true, codeRepositoryId, repositoryId: "guid-7", name: "Shop-renamed" }),
            member("Checkout", { enabled: true, codeRepositoryId, repositoryId: "guid-7", name: "shop" })
        ])

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(1)
        expect(result.repositories[0].members.map(({ name }) => name).sort()).toEqual(["Cart", "Checkout", "Search"])
    })

    /** A GitLab connection can reach two groups with a repository of the same name: the name alone does not tell */
    it("given two GitLab repositories of the same name in two groups, when the domain is built, then both are tagged", async () => {
        vi.spyOn(CodeRepository, "find").mockResolvedValue([{ _id: codeRepositoryId, provider: CodeRepositoryProvider.GITLAB }] as never)
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({
            _id: codeRepositoryId,
            projectId,
            provider: CodeRepositoryProvider.GITLAB,
            accessToken: "token",
            gitlabData: { url: "https://gitlab.example" }
        } as never)
        vi.spyOn(GitlabClient.prototype, "getBranchCommitSha").mockResolvedValue("sha")
        vi.spyOn(GitlabClient.prototype, "tagExists").mockResolvedValue(false)
        const gitlabTag = vi.spyOn(GitlabClient.prototype, "createTag").mockResolvedValue(undefined)
        withMembers([
            member("Cart", { enabled: true, codeRepositoryId, repositoryId: "11", name: "web", gitlab: { path: "shop/web" } }),
            member("Search", { enabled: true, codeRepositoryId, repositoryId: "12", name: "web", gitlab: { path: "search/web" } })
        ])

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(gitlabTag).toHaveBeenCalledTimes(2)
        expect(result.repositories.map(repository => repository.id)).toEqual([`${codeRepositoryId}/11/shop/web`, `${codeRepositoryId}/12/search/web`])
    })

    it("given a member without a linked repository, when the domain is built, then it is left out and the others are tagged", async () => {
        withMembers([member("Cart", link("cart-fe", "1")), member("Legacy"), member("Off", { ...link("off-fe", "9"), enabled: false })])

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(1)
        expect(result.repositories.map(repository => repository.repository)).toEqual(["cart-fe"])
    })

    it("given a repository without the branch, when the domain is built, then no repository is tagged and the refusal lists it", async () => {
        withMembers([member("Cart", link("cart-fe", "1")), member("Search", link("search-fe", "2"))])
        getBranchCommitSha.mockImplementation((async (_token: string, name: string) => {
            if (name === "search-fe") throw answered(404)
            return "sha"
        }) as never)

        const refusal = new DomainService().build(String(domainId), "1.4.0", "release")

        await expect(refusal).rejects.toMatchObject({
            code: "DOMAIN_BUILD_CHECK_FAILED",
            statusCode: 409,
            details: {
                version: "1.4.0",
                ref: "release",
                repositories: [expect.objectContaining({ repository: "cart-fe", status: "ready" }), expect.objectContaining({ repository: "search-fe", status: "failed", reason: "REF_NOT_FOUND" })]
            }
        })
        await expect(refusal).rejects.toThrow(/search-fe/)
        expect(createTag).not.toHaveBeenCalled()
    })

    /** GitHub answers 404 for the branch of a repository that is gone, renamed or private to the token */
    it.each([404, 403])("given a repository the provider answers %i for, when the domain is built, then it is told apart from a missing branch", async status => {
        withMembers([member("Cart", link("cart-fe", "1"))])
        getBranchCommitSha.mockRejectedValue(answered(404))
        getRepository.mockRejectedValue(answered(status))

        await expect(new DomainService().build(String(domainId), "1.4.0")).rejects.toMatchObject({
            code: "DOMAIN_BUILD_CHECK_FAILED",
            details: { repositories: [expect.objectContaining({ repository: "cart-fe", reason: "REPOSITORY_NOT_FOUND" })] }
        })
        expect(createTag).not.toHaveBeenCalled()
    })

    it("given a repository that already has the tag, when the domain is built, then no repository is tagged", async () => {
        withMembers([member("Cart", link("cart-fe", "1")), member("Search", link("search-fe", "2"))])
        tagExists.mockImplementation((async (_token: string, name: string) => name === "cart-fe") as never)

        const refusal = new DomainService().build(String(domainId), "1.4.0")

        await expect(refusal).rejects.toMatchObject({
            code: "DOMAIN_BUILD_CHECK_FAILED",
            details: { repositories: [expect.objectContaining({ repository: "cart-fe", reason: "TAG_EXISTS" }), expect.objectContaining({ repository: "search-fe", status: "ready" })] }
        })
        expect(createTag).not.toHaveBeenCalled()
    })

    it("given a connection of another project, when the domain is built, then no repository is tagged", async () => {
        withMembers([member("Cart", link("cart-fe", "1"))])
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({ _id: codeRepositoryId, projectId: new Types.ObjectId(), provider: CodeRepositoryProvider.GITHUB } as never)

        await expect(new DomainService().build(String(domainId), "1.4.0")).rejects.toMatchObject({
            code: "DOMAIN_BUILD_CHECK_FAILED",
            details: { repositories: [expect.objectContaining({ reason: "CONNECTION_NOT_FOUND" })] }
        })
        expect(getBranchCommitSha).not.toHaveBeenCalled()
        expect(createTag).not.toHaveBeenCalled()
    })

    it("given many repositories, when they are checked, then no more than four reach the provider at once", async () => {
        withMembers(Array.from({ length: 10 }, (_, index) => member(`Member ${index}`, link(`repo-${index}`, String(index)))))
        let running = 0
        let most = 0
        getBranchCommitSha.mockImplementation((async () => {
            running++
            most = Math.max(most, running)
            await new Promise(resolve => setTimeout(resolve, 5))
            running--
            return "sha"
        }) as never)

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(most).toBe(4)
        expect(result.repositories.map(repository => repository.repository)).toEqual(Array.from({ length: 10 }, (_, index) => `repo-${index}`))
    })

    it("given a tag that fails once the checks passed, when the domain is built, then the others stay tagged and the result tells which failed", async () => {
        withMembers([member("Cart", link("cart-fe", "1")), member("Search", link("search-fe", "2"))])
        createTag.mockImplementation((async (_token: string, name: string) => {
            if (name === "cart-fe") throw new Error("Reference already exists")
        }) as never)

        const result = await new DomainService().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(2)
        expect(result.repositories).toEqual([
            expect.objectContaining({ repository: "cart-fe", status: "failed", reason: "PROVIDER_ERROR", message: "Reference already exists" }),
            expect.objectContaining({ repository: "search-fe", status: "tagged" })
        ])
    })

    it.each([[""], ["1.4 beta"], ["x".repeat(129)], [42]])("given the version %j, when the domain is built, then it is refused before anything is read", async version => {
        const findDomain = vi.spyOn(Domain, "findById")

        await expect(new DomainService().build(String(domainId), version)).rejects.toMatchObject({ code: "DOMAIN_BUILD_VERSION_INVALID", statusCode: 400 })
        expect(findDomain).not.toHaveBeenCalled()
    })

    it.each([["release..1"], ["has space"], ["/main"], ["main.lock"], ["a:b"], [42]])("given the branch %j, when the domain is built, then it is refused before anything is read", async ref => {
        const findDomain = vi.spyOn(Domain, "findById")

        await expect(new DomainService().build(String(domainId), "1.4.0", ref)).rejects.toMatchObject({ code: "DOMAIN_BUILD_REF_INVALID", statusCode: 400 })
        expect(findDomain).not.toHaveBeenCalled()
    })

    it("given a domain with no member, when it is built, then it is refused as empty", async () => {
        withMembers([])

        await expect(new DomainService().build(String(domainId), "1.4.0")).rejects.toMatchObject({ code: "DOMAIN_BUILD_EMPTY", statusCode: 400 })
        expect(createTag).not.toHaveBeenCalled()
    })

    it("given members of which none has a linked repository, when the domain is built, then it is refused", async () => {
        withMembers([member("Legacy")], [member("Orders API")])

        await expect(new DomainService().build(String(domainId), "1.4.0")).rejects.toMatchObject({ code: "DOMAIN_BUILD_NO_REPOSITORIES", statusCode: 400 })
        expect(createTag).not.toHaveBeenCalled()
    })

    it("given an unknown domain, when it is built, then it is not found", async () => {
        vi.spyOn(Domain, "findById").mockResolvedValue(null)

        await expect(new DomainService().build(String(domainId), "1.4.0")).rejects.toBeInstanceOf(EntityNotFoundError)
        expect(createTag).not.toHaveBeenCalled()
    })

    it("given a viewer of the project, when the domain is built, then it is refused before its members are read or a provider is called", async () => {
        withRole("VIEWER")
        withMembers([member("Cart", link("cart-fe", "1"))])

        await expect(asUser().build(String(domainId), "1.4.0")).rejects.toMatchObject({ code: "DOMAIN_BUILD_FORBIDDEN", statusCode: 403 })
        expect(Frontend.find).not.toHaveBeenCalled()
        expect(getBranchCommitSha).not.toHaveBeenCalled()
        expect(createTag).not.toHaveBeenCalled()
    })

    it("given a member of the project, when the domain is built, then its repositories are tagged", async () => {
        withRole("MEMBER")
        withMembers([member("Cart", link("cart-fe", "1"))])

        await asUser().build(String(domainId), "1.4.0")

        expect(createTag).toHaveBeenCalledTimes(1)
    })

    describe("by a member assigned to some domains", () => {
        const scopedTo = (domains: Types.ObjectId[]) =>
            vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue(domains.map(String))

        beforeEach(() => {
            withRole("MEMBER")
        })

        it("given a domain outside their scope, when it is built, then it is refused before its members are read", async () => {
            scopedTo([new Types.ObjectId()])
            withMembers([member("Cart", link("cart-fe", "1"))])

            await expect(asUser().build(String(domainId), "1.4.0")).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN", statusCode: 403 })
            expect(Frontend.find).not.toHaveBeenCalled()
            expect(createTag).not.toHaveBeenCalled()
        })

        it("given their domain with a repository shared with a component of another domain, when it is built, then no repository is tagged", async () => {
            scopedTo([domainId])
            withMembers([member("Cart", link("cart-fe", "1")), member("Search", link("search-fe", "2"))])
            vi.spyOn(Frontend, "exists").mockImplementation(((query: { "codeRepository.codeRepositoryId": unknown; $or: Record<string, unknown>[] }) =>
                Promise.resolve(query.$or.some(condition => condition["codeRepository.name"] === "search-fe") ? { _id: new Types.ObjectId() } : null)) as never)
            vi.spyOn(Backend, "exists").mockResolvedValue(null as never)

            await expect(asUser().build(String(domainId), "1.4.0")).rejects.toMatchObject({
                code: "DOMAIN_BUILD_CHECK_FAILED",
                details: { repositories: [expect.objectContaining({ repository: "cart-fe", status: "ready" }), expect.objectContaining({ repository: "search-fe", reason: "DOMAIN_SCOPE_FORBIDDEN" })] }
            })
            expect(createTag).not.toHaveBeenCalled()
        })

        it("given their own domain, when it is built, then its repositories are tagged", async () => {
            scopedTo([domainId])
            withMembers([member("Cart", link("cart-fe", "1"))])
            vi.spyOn(Frontend, "exists").mockResolvedValue(null as never)
            vi.spyOn(Backend, "exists").mockResolvedValue(null as never)

            const result = await asUser().build(String(domainId), "1.4.0")

            expect(result.repositories).toEqual([expect.objectContaining({ repository: "cart-fe", status: "tagged" })])
        })
    })
})
