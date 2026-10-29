import { ObjectId, Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The service reaches the application instance for its logger; importing the real one would boot
// Fastify, connect to the configured database and run the migrations.
vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Backend from "../models/BackendModel"
import Domain from "../models/DomainModel"
import Frontend from "../models/FrontendModel"
import Organization from "../models/OrganizationModel"
import Project from "../models/ProjectModel"
import { IUser } from "../models/UserModel"
import UserOrganization, { RoleInOrganization } from "../models/UserOrganizationModel"
import UserProject from "../models/UserProjectModel"
import ProjectService from "./ProjectService"
import UserProjectService from "./UserProjectService"

/**
 * The id flavour the service signatures speak: mongoose's schema type, not the runtime one the driver
 * hands back. Spelled out once here so the tests read as scenarios instead of as casts.
 */
const newId = () => new Types.ObjectId() as unknown as ObjectId

interface FakeProject {
    _id: ObjectId
    name: string
    organizationId: ObjectId
}

const aUser = (): IUser => ({ _id: newId(), email: "someone@example.com" }) as unknown as IUser

let projects: FakeProject[]
let projectMemberships: { userId: ObjectId; projectId: ObjectId; invitationToken?: string; role?: string }[]
let organizationMemberships: { userId: ObjectId; organizationId: ObjectId; role: RoleInOrganization }[]

const sameId = (left: unknown, right: unknown) => String(left) === String(right)

/** Applies the filter the service builds, so the tests can assert on projects instead of on query shapes. */
// biome-ignore lint/suspicious/noExplicitAny: a mongo filter is an arbitrarily nested plain object
const matches = (project: FakeProject, clause: Record<string, any>): boolean =>
    Object.entries(clause).every(([field, condition]) => {
        if (field === "$or") {
            return (condition as Record<string, unknown>[]).some(alternative => matches(project, alternative))
        }
        const value = project[field as keyof FakeProject]
        if (condition && typeof condition === "object" && "$in" in condition) {
            return (condition.$in as unknown[]).some(candidate => sameId(candidate, value))
        }
        return sameId(condition, value)
    })

describe("findMine", () => {
    beforeEach(() => {
        projects = []
        projectMemberships = []
        organizationMemberships = []

        vi.spyOn(Project, "find").mockImplementation(((filter: Record<string, unknown>) => ({
            sort: () => Promise.resolve(projects.filter(project => matches(project, filter as Record<string, unknown>)))
        })) as never)

        vi.spyOn(UserProject, "find").mockImplementation(((filter: Record<string, unknown>) => {
            const { userId, invitationToken } = filter as Record<string, unknown>
            return {
                lean: () => Promise.resolve(projectMemberships.filter(membership => sameId(membership.userId, userId) && (invitationToken === null ? !membership.invitationToken : true)))
            }
        }) as never)

        vi.spyOn(UserOrganization, "find").mockImplementation(((filter: Record<string, unknown>) => {
            const { userId, role } = filter as Record<string, unknown>
            const wantedRoles = (role as { $in?: RoleInOrganization[] })?.$in
            return {
                session: () => ({
                    lean: () => Promise.resolve(organizationMemberships.filter(membership => sameId(membership.userId, userId) && (wantedRoles === undefined || wantedRoles.includes(membership.role))))
                })
            }
        }) as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const aProject = (name: string, organizationId: ObjectId): FakeProject => {
        const project = { _id: newId(), name, organizationId }
        projects.push(project)
        return project
    }

    const namesOf = async (user: IUser, organizationId?: ObjectId) => (await new ProjectService(user).findMine(user._id, organizationId as never)).map(project => project.name)

    it("Given a project they were invited to and one they administer, when the list is read, then both are returned", async () => {
        const user = aUser()
        const otherOrganization = newId()
        const ownOrganization = newId()
        const shared = aProject("shared", otherOrganization)
        aProject("own", ownOrganization)
        projectMemberships.push({ userId: user._id, projectId: shared._id })
        organizationMemberships.push({ userId: user._id, organizationId: ownOrganization, role: RoleInOrganization.OWNER })

        expect(await namesOf(user)).toEqual(["shared", "own"])
    })

    /** Both ways in point at the same project: it must show up once, not twice. */
    it("Given a project reachable both as a member and as an administrator, when the list is read, then it appears once", async () => {
        const user = aUser()
        const organizationId = newId()
        const project = aProject("checkout", organizationId)
        projectMemberships.push({ userId: user._id, projectId: project._id })
        organizationMemberships.push({ userId: user._id, organizationId, role: RoleInOrganization.ADMIN })

        expect(await namesOf(user)).toEqual(["checkout"])
    })

    it("Given projects in two organizations, when the list is narrowed to one, then only its projects are returned", async () => {
        const user = aUser()
        const first = newId()
        const second = newId()
        aProject("in-first", first)
        aProject("in-second", second)
        const userId = user._id
        organizationMemberships.push({ userId, organizationId: first, role: RoleInOrganization.OWNER }, { userId, organizationId: second, role: RoleInOrganization.OWNER })

        expect(await namesOf(user, first)).toEqual(["in-first"])
    })

    /** The console hides what a viewer cannot do: it reads the role here */
    it("Given a viewer membership and an administered organization, when the list is read, then each project carries the role they act with", async () => {
        const user = aUser()
        const administeredOrganization = newId()
        const viewed = aProject("viewed", newId())
        const administered = aProject("administered", administeredOrganization)
        projectMemberships.push({ userId: user._id, projectId: viewed._id, role: "VIEWER" }, { userId: user._id, projectId: administered._id, role: "VIEWER" })
        organizationMemberships.push({ userId: user._id, organizationId: administeredOrganization, role: RoleInOrganization.ADMIN })

        const roles = (await new ProjectService(user).findMine(user._id)).map(project => [project.name, project.role])

        expect(roles).toEqual([
            ["viewed", "VIEWER"],
            ["administered", "OWNER"]
        ])
    })

    it("Given a pending invitation to a project, when the list is read, then the project is not one of theirs yet", async () => {
        const user = aUser()
        const project = aProject("checkout", newId())
        projectMemberships.push({ userId: user._id, projectId: project._id, invitationToken: "pending" })

        expect(await namesOf(user)).toEqual([])
    })

    it("Given a plain member of an organization with projects they were never invited to, when the list is read, then it is empty", async () => {
        const user = aUser()
        const organizationId = newId()
        aProject("someone-elses", organizationId)
        organizationMemberships.push({ userId: user._id, organizationId, role: RoleInOrganization.MEMBER })

        expect(await namesOf(user)).toEqual([])
    })
})

/** The protected gate the update goes through, surfaced so the spy has something to type against. */
interface WithAuthorizationGate {
    ensureAccessToProject: () => Promise<void>
    getDomainScope: () => Promise<string[] | undefined>
}

describe("update", () => {
    /** What the service actually asks mongo to write, which is the whole point of these tests. */
    let written: Record<string, unknown> | undefined

    beforeEach(() => {
        written = undefined
        // The route carries no body schema, so authorization is the only gate before the write: stub
        // it open and watch what comes out the other side.
        vi.spyOn(ProjectService.prototype as unknown as WithAuthorizationGate, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(ProjectService.prototype as unknown as WithAuthorizationGate, "getDomainScope").mockResolvedValue(undefined)
        vi.spyOn(Project, "findByIdAndUpdate").mockImplementation(((_id: unknown, update: Record<string, unknown>) => {
            written = update
            return Promise.resolve({ name: "whatever" })
        }) as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const update = (input: Record<string, unknown>) => new ProjectService(aUser()).update(String(newId()), input as never)

    it("Given a new name, when the project is updated, then the name is written", async () => {
        await update({ name: "Checkout" })

        expect(written).toEqual({ name: "Checkout" })
    })

    /**
     * The slug is part of the path already uploaded bundles live under, so it must survive a rename
     * even when the caller explicitly asks for a new one.
     */
    it("Given a slug in the request body, when the project is updated, then the slug is not written", async () => {
        await update({ name: "Checkout", slug: "something-else" })

        expect(written).toEqual({ name: "Checkout" })
    })

    it("Given an organization in the request body, when the project is updated, then the project is not moved to it", async () => {
        await update({ name: "Checkout", organizationId: String(newId()) })

        expect(written).toEqual({ name: "Checkout" })
    })

    it("Given a null description, when the project is updated, then the description is unset", async () => {
        await update({ description: null })

        expect(written).toEqual({ $unset: { description: 1 } })
    })

    it("Given an exposure in mixed case with a blank issuer, when the project is updated, then the domain is written trimmed in lowercase without the issuer", async () => {
        await update({ exposure: { domain: " Example.COM ", certificateIssuer: " " } })

        expect(written).toEqual({ exposure: { domain: "example.com" } })
    })

    it("Given the ports of the listeners, when the project is updated, then they are written with the exposure", async () => {
        await update({ exposure: { domain: "example.com", httpPort: 8000, httpsPort: 8443 } })

        expect(written).toEqual({ exposure: { domain: "example.com", httpPort: 8000, httpsPort: 8443 } })
    })

    it("Given a null exposure, when the project is updated, then the exposure is unset", async () => {
        await update({ exposure: null })

        expect(written).toEqual({ $unset: { exposure: 1 } })
    })

    it.each([
        ["no domain", {}],
        ["a domain of one label", { domain: "localhost" }],
        ["an issuer that is not a string", { domain: "example.com", certificateIssuer: 42 }],
        ["an issuer that is not a resource name", { domain: "example.com", certificateIssuer: "Lets_Encrypt" }],
        ["an HTTP port out of range", { domain: "example.com", httpPort: 0 }],
        ["an HTTPS port that is not an integer", { domain: "example.com", httpsPort: "443" }]
    ])("Given an exposure with %s, when the project is updated, then it is refused with a 400 and nothing is written", async (_case, exposure) => {
        await expect(update({ exposure })).rejects.toMatchObject({ code: "PROJECT_EXPOSURE_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it("Given a container registry with spaces and a trailing slash, when the project is updated, then it is written trimmed without the slash", async () => {
        await update({ containerRegistry: " ghcr.io/acme/ " })

        expect(written).toEqual({ containerRegistry: "ghcr.io/acme" })
    })

    it("Given a registry with a port, when the project is updated, then it is written as it is", async () => {
        await update({ containerRegistry: "registry.example.com:5000" })

        expect(written).toEqual({ containerRegistry: "registry.example.com:5000" })
    })

    it.each([null, "  "])("Given the container registry %j, when the project is updated, then it is unset", async containerRegistry => {
        await update({ containerRegistry })

        expect(written).toEqual({ $unset: { containerRegistry: 1 } })
    })

    it.each([
        ["a scheme", "https://ghcr.io/acme"],
        ["a space inside", "ghcr.io/ac me"],
        ["an image tag", "ghcr.io/acme:latest"],
        ["something that is not a string", 42]
    ])("Given a container registry with %s, when the project is updated, then it is refused with a 400 and nothing is written", async (_case, containerRegistry) => {
        await expect(update({ containerRegistry })).rejects.toMatchObject({ code: "PROJECT_CONTAINER_REGISTRY_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it("Given only a description, when the project is updated, then the name is left alone", async () => {
        await update({ description: "the checkout flow" })

        expect(written).toEqual({ description: "the checkout flow" })
    })

    it("Given a context, when the project is updated, then the context is written", async () => {
        await update({ context: "## Conventions\n- strict TypeScript" })

        expect(written).toEqual({ context: "## Conventions\n- strict TypeScript" })
    })

    it("Given a null description and a null context, when the project is updated, then both are unset", async () => {
        await update({ description: null, context: null })

        expect(written).toEqual({ $unset: { description: 1, context: 1 } })
    })

    it("Given both technologies, when the project is updated, then each is written on its own path", async () => {
        await update({ technologies: { frontend: "VUE", backend: "MICRONAUT" } })

        expect(written).toEqual({ "technologies.frontend": "VUE", "technologies.backend": "MICRONAUT" })
    })

    /** A side left out keeps what the project had: the screen may send only the one the user changed. */
    it("Given only the backend technology, when the project is updated, then the frontend one is left alone", async () => {
        await update({ technologies: { backend: "SPRING_BOOT" } })

        expect(written).toEqual({ "technologies.backend": "SPRING_BOOT" })
    })

    it("Given a null side, when the project is updated, then that side only is unset", async () => {
        await update({ technologies: { frontend: null, backend: "GO" } })

        expect(written).toEqual({ "technologies.backend": "GO", $unset: { "technologies.frontend": 1 } })
    })

    it("Given null technologies, when the project is updated, then both are unset", async () => {
        await update({ technologies: null })

        expect(written).toEqual({ $unset: { technologies: 1 } })
    })

    it.each([
        ["an unknown frontend", { frontend: "SVELTE" }],
        ["a backend spelled freely", { backend: "Spring Boot" }],
        ["a side that is not a string", { frontend: 42 }],
        ["something that is not an object", "REACT"]
    ])("Given technologies with %s, when the project is updated, then it is refused with a 400 and nothing is written", async (_case, technologies) => {
        await expect(update({ technologies })).rejects.toMatchObject({ code: "PROJECT_TECHNOLOGIES_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it("Given a design system, when the project is updated, then it is written whole, trimmed, its npmrc as pasted", async () => {
        await update({ designSystem: { packageName: " @acme/ui ", version: "^3.2.0", docsUrl: "", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" } })

        expect(written).toEqual({ designSystem: { packageName: "@acme/ui", version: "^3.2.0", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" } })
    })

    it("Given a null design system, when the project is updated, then it is unset", async () => {
        await update({ designSystem: null })

        expect(written).toEqual({ $unset: { designSystem: 1 } })
    })

    it("Given a design system without its package, when the project is updated, then it is refused with a 400 and nothing is written", async () => {
        await expect(update({ designSystem: { notes: "Use its tokens." } })).rejects.toMatchObject({ code: "DESIGN_SYSTEM_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })
})

describe("getContext", () => {
    const projectId = String(newId())
    const domainId = newId()
    const frontendId = newId()
    const backendId = newId()
    let filters: Record<"domain" | "frontend" | "backend", Record<string, unknown> | undefined>

    /** A find that records its filter and answers with one item carrying a context */
    const recordFind = (model: unknown, key: keyof typeof filters, item: Record<string, unknown>) =>
        vi.spyOn(model as { find: (filter: Record<string, unknown>) => unknown }, "find").mockImplementation(((filter: Record<string, unknown>) => {
            filters[key] = filter
            return { sort: () => Promise.resolve([item]) }
        }) as never)

    beforeEach(() => {
        filters = { domain: undefined, frontend: undefined, backend: undefined }
        vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", context: "shared rules" } as never)
        // An organization without a design system: the inheritance has tests of its own
        vi.spyOn(Organization, "findById").mockResolvedValue(null as never)
        // A member of the whole project: the domain scope has tests of its own
        vi.spyOn(ProjectService.prototype as unknown as WithAuthorizationGate, "getDomainScope").mockResolvedValue(undefined)
        recordFind(Domain, "domain", { _id: domainId, slug: "payments", name: "Payments", context: "payments rules" })
        recordFind(Frontend, "frontend", { _id: frontendId, slug: "catalog", name: "Catalog", context: "catalog rules" })
        recordFind(Backend, "backend", { _id: backendId, slug: "orders", name: "Orders", context: "orders rules" })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("Given no focus, when the context is read, then the project and every domain, frontend and backend with a context come back", async () => {
        const context = await new ProjectService(aUser()).getContext(projectId)

        expect(context.project).toMatchObject({ name: "Portal", context: "shared rules" })
        expect(context.domains).toEqual([expect.objectContaining({ slug: "payments", context: "payments rules" })])
        expect(context.frontends).toEqual([expect.objectContaining({ slug: "catalog", context: "catalog rules" })])
        expect(context.backends).toEqual([expect.objectContaining({ slug: "orders", context: "orders rules" })])
        // The ones without a context are left out by the query
        for (const filter of Object.values(filters)) {
            expect(filter).toMatchObject({ context: { $nin: [null, ""] } })
        }
    })

    it("Given a project with default technologies, when the context is read, then they come back with it, a side left unpicked left out", async () => {
        vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", technologies: { backend: "QUARKUS" } } as never)

        const context = await new ProjectService(aUser()).getContext(projectId)

        expect(context.project.technologies).toEqual({ backend: "QUARKUS" })
    })

    it("Given a project with a design system, when the context is read, then it comes back with its npmrc whole", async () => {
        const designSystem = { packageName: "@acme/ui", npmrc: "@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=npm_abc123" }
        vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", designSystem } as never)

        const context = await new ProjectService(aUser()).getContext(projectId)

        expect(context.project.designSystem).toEqual(designSystem)
        expect(context.project.designSystemSource).toBe("project")
        // No frontend focus, no frontend to resolve one for
        expect(context.designSystem).toBeUndefined()
        expect(context.designSystemSource).toBeUndefined()
    })

    it.each([
        ["its own", { packageName: "@acme/legacy-ui" }, "@acme/legacy-ui", "frontend"],
        ["none, the project's", undefined, "@acme/ui", "project"]
    ])("Given a frontend with %s design system and no context, when its context is read, then the design system it builds with comes back", async (_case, own, expected, source) => {
        vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", designSystem: { packageName: "@acme/ui" } } as never)
        vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, domainId: null, designSystem: own } as never)
        vi.spyOn(Frontend, "find").mockImplementation((() => ({ sort: () => Promise.resolve([]) })) as never)

        const context = await new ProjectService(aUser()).getContext(projectId, { frontendId: String(frontendId) })

        expect(context.frontends).toEqual([])
        expect(context.designSystem).toEqual({ packageName: expected })
        expect(context.designSystemSource).toBe(source)
    })

    describe("with a design system set by the organization", () => {
        const organizationId = newId()

        beforeEach(() => {
            vi.spyOn(Organization, "findById").mockResolvedValue({
                _id: organizationId,
                designSystem: { packageName: "@acme/brand", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" }
            } as never)
        })

        it("Given a project without its own, when the context is read, then the organization's comes back as the project's, whole", async () => {
            vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", organizationId } as never)

            const context = await new ProjectService(aUser()).getContext(projectId)

            expect(context.project.designSystem).toEqual({ packageName: "@acme/brand", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" })
            expect(context.project.designSystemSource).toBe("organization")
        })

        it("Given a frontend and a project without their own, when the context of the frontend is read, then it builds with the organization's", async () => {
            vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", organizationId } as never)
            vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, domainId: null } as never)

            const context = await new ProjectService(aUser()).getContext(projectId, { frontendId: String(frontendId) })

            expect(context.designSystem).toEqual({ packageName: "@acme/brand", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" })
            expect(context.designSystemSource).toBe("organization")
        })

        it("Given a project with its own, when the context of a frontend without one is read, then the project's wins and the organization is not read", async () => {
            vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", organizationId, designSystem: { packageName: "@acme/ui" } } as never)
            vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, domainId: null } as never)

            const context = await new ProjectService(aUser()).getContext(projectId, { frontendId: String(frontendId) })

            expect(context.project).toMatchObject({ designSystem: { packageName: "@acme/ui" }, designSystemSource: "project" })
            expect(context).toMatchObject({ designSystem: { packageName: "@acme/ui" }, designSystemSource: "project" })
            expect(Organization.findById).not.toHaveBeenCalled()
        })
    })

    it("Given a project without technologies, when the context is read, then none come back", async () => {
        const context = await new ProjectService(aUser()).getContext(projectId)

        expect(context.project.technologies).toBeUndefined()
    })

    it("Given a frontend in a domain, when its context is read, then only its own and its domain's come back with the project's", async () => {
        vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, domainId } as never)

        const context = await new ProjectService(aUser()).getContext(projectId, { frontendId: String(frontendId) })

        expect(context.project).toMatchObject({ context: "shared rules" })
        expect(filters.frontend).toMatchObject({ _id: frontendId })
        expect(filters.domain).toMatchObject({ _id: domainId })
        expect(filters.backend).toBeUndefined()
        expect(context.backends).toEqual([])
    })

    it("Given a backend in no domain, when its context is read, then no domain is read", async () => {
        vi.spyOn(Backend, "findOne").mockResolvedValue({ _id: backendId, domainId: null } as never)

        const context = await new ProjectService(aUser()).getContext(projectId, { backendId: String(backendId) })

        expect(filters.backend).toMatchObject({ _id: backendId })
        expect(filters.domain).toBeUndefined()
        expect(filters.frontend).toBeUndefined()
        expect(context.domains).toEqual([])
    })

    it("Given a domain, when its context is read, then its own and the ones of its frontends and backends come back", async () => {
        vi.spyOn(Domain, "findOne").mockResolvedValue({ _id: domainId } as never)

        await new ProjectService(aUser()).getContext(projectId, { domainId: String(domainId) })

        expect(filters.domain).toMatchObject({ _id: domainId })
        expect(filters.frontend).toMatchObject({ domainId })
        expect(filters.backend).toMatchObject({ domainId })
    })

    it("Given a frontend of another project, when its context is read, then it is not found", async () => {
        vi.spyOn(Frontend, "findOne").mockResolvedValue(null as never)

        await expect(new ProjectService(aUser()).getContext(projectId, { frontendId: String(frontendId) })).rejects.toBeInstanceOf(EntityNotFoundError)
    })
})

describe("getDesignSystemNpmrc", () => {
    const projectId = String(newId())
    const frontendId = newId()
    const npmrc = "@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=npm_abc123"
    const read = (frontend?: string) => new ProjectService(aUser()).getDesignSystemNpmrc(projectId, frontend)

    beforeEach(() => {
        vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", designSystem: { packageName: "@acme/ui", npmrc } } as never)
        vi.spyOn(Organization, "findById").mockResolvedValue(null as never)
        vi.spyOn(ProjectService.prototype as unknown as WithAuthorizationGate, "getDomainScope").mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("Given a project with a design system, when its npmrc is read, then it comes back whole, credentials included", async () => {
        expect(await read()).toEqual({ packageName: "@acme/ui", source: "project", npmrc })
    })

    it("Given a frontend with its own design system, when its npmrc is read, then the frontend's comes back", async () => {
        vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, domainId: null, designSystem: { packageName: "@acme/legacy-ui", npmrc: "//legacy/:_auth=secret" } } as never)

        expect(await read(String(frontendId))).toEqual({ packageName: "@acme/legacy-ui", source: "frontend", npmrc: "//legacy/:_auth=secret" })
    })

    it("Given a frontend without its own, when its npmrc is read, then the project's comes back", async () => {
        vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, domainId: null } as never)

        expect(await read(String(frontendId))).toEqual({ packageName: "@acme/ui", source: "project", npmrc })
    })

    it("Given a design system without an npmrc, when its npmrc is read, then it is refused", async () => {
        vi.spyOn(ProjectService.prototype, "findById").mockResolvedValue({ _id: newId(), name: "Portal", designSystem: { packageName: "@acme/ui" } } as never)

        await expect(read()).rejects.toMatchObject({ code: "DESIGN_SYSTEM_NPMRC_MISSING", statusCode: 404 })
    })

    it("Given a frontend of another project, when its npmrc is read, then it is not found", async () => {
        vi.spyOn(Frontend, "findOne").mockResolvedValue(null as never)

        await expect(read(String(frontendId))).rejects.toBeInstanceOf(EntityNotFoundError)
    })
})

/**
 * The slug a project is created with, which is the one thing about it that cannot be corrected
 * afterwards: it is part of the `<slug>-<id>/` path the uploaded bundles live under, so the console
 * shows it read-only and the update route refuses it on purpose.
 */
describe("createRaw", () => {
    let saved: { name?: string; slug?: string }

    const create = async (name: string, slug?: string) => {
        await new ProjectService(aUser()).createRaw({ organizationId: newId().toString(), name, slug }, newId())
        return saved
    }

    beforeEach(() => {
        saved = {}
        // `new Project(...)` builds a real document without touching a database; intercepting save
        // is what lets the test read the slug the service decided on.
        vi.spyOn(Project.prototype, "save").mockImplementation(async function (this: { name?: string; slug?: string; _id: ObjectId }) {
            saved = { name: this.name, slug: this.slug }
            return this
        } as never)
        vi.spyOn(UserProjectService.prototype, "addUserToProject").mockResolvedValue(undefined as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("given no slug, when a project is created, then it is derived from the name with the shared helper", async () => {
        // Derived by `slugify`, not by hand: three `replace` calls on literals used to leave
        // "my-cool storefront app" here, spaces included.
        expect(await create("My Cool Storefront App")).toMatchObject({ slug: "my-cool-storefront-app" })
    })

    it("given a name with consecutive separators, when a project is created, then the hyphens collapse", async () => {
        expect(await create("Acme  Storefront")).toMatchObject({ slug: "acme-storefront" })
        expect(await create("v1.2.3_rc")).toMatchObject({ slug: "v1-2-3-rc" })
    })

    it("given a slug of its own, when a project is created, then that one is kept", async () => {
        expect(await create("Acme Storefront", "legacy-path")).toMatchObject({ slug: "legacy-path" })
    })

    it("given a blank slug, when a project is created, then it falls back to the name", async () => {
        expect(await create("Acme Storefront", "   ")).toMatchObject({ slug: "acme-storefront" })
    })
})
