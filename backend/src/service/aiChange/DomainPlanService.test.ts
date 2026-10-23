import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../..", () => ({ fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} } }))

const { json } = vi.hoisted(() => ({ json: vi.fn() }))
vi.mock("../llm", async importOriginal => ({ ...(await importOriginal<typeof import("../llm")>()), getLlmClient: () => ({ json }) }))

const { getAll } = vi.hoisted(() => ({ getAll: vi.fn() }))
vi.mock("../MarketService", () => ({
    default: class {
        getAll = getAll
    }
}))

import { BusinessException } from "../../errors/BusinessException"
import AiModel from "../../models/AiModelModel"
import Backend from "../../models/BackendModel"
import Domain from "../../models/DomainModel"
import Frontend from "../../models/FrontendModel"
import Organization from "../../models/OrganizationModel"
import Project from "../../models/ProjectModel"
import Resource from "../../models/ResourceModel"
import { IUser } from "../../models/UserModel"
import UserProject, { RoleInProject } from "../../models/UserProjectModel"
import { withNoMaintenanceAgents } from "../../testing/noMaintenanceAgents"
import { FrontendFramework } from "../../types/FrontendStack"
import { BackendTechnology } from "../../types/ProjectTechnology"
import BaseAuthorizedService from "../BaseAuthorizedService"
import DomainPlanService, { sanitizePlan } from "./DomainPlanService"

withNoMaintenanceAgents()

type WithGates = { ensureAccessToProject: () => Promise<void>; isOrganizationAdmin: () => Promise<boolean> }

const user = { _id: new Types.ObjectId(), email: "ada@example.com" } as unknown as IUser
const projectId = new Types.ObjectId().toString()
const domain = { _id: new Types.ObjectId(), projectId, name: "Orders", description: "Ordering and checkout", context: "Prices are in cents" }

const templates = [
    { slug: "vite-host-react", type: "host", framework: "React", compiler: "vite", description: "React host on Vite" },
    { slug: "vite-remote-react", type: "remote", framework: "React", compiler: "vite", description: "React remote on Vite" },
    { slug: "vite-remote-vue", type: "remote", framework: "Vue", compiler: "vite", description: "Vue remote on Vite" },
    { slug: "soon-remote", type: "remote", framework: "Svelte", compiler: "vite", description: "Svelte remote on Vite", comingSoon: true },
    { slug: "service-node-fastify", type: "service", framework: "Node.js", compiler: "docker", description: "Fastify backend" },
    { slug: "service-python-fastapi", type: "service", framework: "Python", compiler: "docker", description: "FastAPI backend" }
]

const planned = (slug: string, template: string, repositoryName: string) => ({ name: slug, slug, template, repositoryName, reason: `${slug} reason` })

describe("sanitizePlan", () => {
    const none = () => ({ frontend: new Set<string>(), backend: new Set<string>() })

    it("given templates of the wrong kind or unknown, when the plan is sanitized, then each becomes the default of its kind", () => {
        const plan = sanitizePlan(
            { frontends: [planned("orders", "service-node-fastify", "orders-fe"), planned("cart", "soon-remote", "cart-fe")], backends: [planned("orders", "nope", "orders-be")] },
            templates,
            none()
        )

        expect(plan.frontends.map(item => item.template)).toEqual(["vite-remote-react", "vite-remote-react"])
        expect(plan.backends[0].template).toBe("service-node-fastify")
    })

    it("given an unknown template in a project with default technologies, when the plan is sanitized, then it becomes the template of the kind built with them", () => {
        const plan = sanitizePlan({ frontends: [planned("orders", "nope", "orders-fe")], backends: [planned("orders", "nope", "orders-be")] }, templates, none(), {
            frontend: FrontendFramework.VUE,
            backend: BackendTechnology.PYTHON
        })

        expect(plan.frontends[0].template).toBe("vite-remote-vue")
        expect(plan.backends[0].template).toBe("service-python-fastapi")
    })

    it("given a technology no template is built with, when the plan is sanitized, then the default of the kind is used", () => {
        const plan = sanitizePlan({ frontends: [], backends: [planned("orders", "nope", "orders-be")] }, templates, none(), { backend: BackendTechnology.MICRONAUT })

        expect(plan.backends[0].template).toBe("service-node-fastify")
    })

    it("given a slug taken in the project, when the plan is sanitized, then it gets a number and the repository is named after the new slug", () => {
        const plan = sanitizePlan({ frontends: [planned("orders", "vite-remote-vue", "orders-fe")], backends: [] }, templates, {
            frontend: new Set(["orders"]),
            backend: new Set()
        })

        expect(plan.frontends[0]).toMatchObject({ slug: "orders-2", repositoryName: "orders-2-fe", template: "vite-remote-vue" })
    })

    it("given names the platform refuses, when the plan is sanitized, then the slug is made kebab case and the repository ends with the suffix of its kind", () => {
        const plan = sanitizePlan(
            { frontends: [], backends: [{ name: "Order API", slug: "Order API!", template: "service-python-fastapi", repositoryName: "order api", reason: "" }] },
            templates,
            none()
        )

        expect(plan.backends[0]).toMatchObject({ name: "Order API", slug: "order-api", repositoryName: "order-api-be", template: "service-python-fastapi" })
    })

    it("given more components than allowed, when the plan is sanitized, then only the first three of each kind are kept", () => {
        const plan = sanitizePlan({ frontends: ["a1", "b2", "c3", "d4"].map(slug => planned(slug, "vite-remote-react", `${slug}-fe`)), backends: [] }, templates, none())

        expect(plan.frontends.map(item => item.slug)).toEqual(["a1", "b2", "c3"])
    })

    it("given two components of a kind with the same slug, when the plan is sanitized, then neither their slugs nor their repositories clash", () => {
        const plan = sanitizePlan({ frontends: [], backends: [planned("orders", "service-node-fastify", "orders-be"), planned("orders", "service-node-fastify", "orders-be")] }, templates, none())

        expect(plan.backends.map(item => [item.slug, item.repositoryName])).toEqual([
            ["orders", "orders-be"],
            ["orders-2", "orders-2-be"]
        ])
    })
})

describe("sanitizePlan with long repository names", () => {
    it("given two components asking for the same 100 character repository name, when the plan is sanitized, then the numbered one still fits 100 characters", () => {
        const long = `${"a".repeat(97)}-fe`
        const plan = sanitizePlan({ frontends: [planned("one", "vite-remote-react", long), planned("two", "vite-remote-react", long)], backends: [] }, templates, {
            frontend: new Set(),
            backend: new Set()
        })

        expect(plan.frontends[0].repositoryName).toBe(long)
        expect(plan.frontends[1].repositoryName).toHaveLength(100)
        expect(plan.frontends[1].repositoryName).toMatch(/^a+-2-fe$/)
    })
})

describe("DomainPlanService.plan", () => {
    let role: RoleInProject
    let members: { frontend: boolean; backend: boolean }

    beforeEach(() => {
        role = RoleInProject.MEMBER
        members = { frontend: false, backend: false }
        const gates = BaseAuthorizedService.prototype as unknown as WithGates
        vi.spyOn(gates, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(gates, "isOrganizationAdmin").mockResolvedValue(false)
        vi.spyOn(UserProject, "findOne").mockImplementation((() => Promise.resolve({ role })) as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId(), name: "Shop", context: "Shop context" } as never)
        // Nor a design system
        vi.spyOn(Organization, "findById").mockResolvedValue(null as never)
        // The organization defines no AI: the system one, from the configuration the service is given, answers
        vi.spyOn(AiModel, "find").mockResolvedValue([] as never)
        vi.spyOn(Domain, "findOne").mockResolvedValue(domain as never)
        vi.spyOn(Frontend, "exists").mockImplementation((() => Promise.resolve(members.frontend ? { _id: new Types.ObjectId() } : null)) as never)
        vi.spyOn(Backend, "exists").mockImplementation((() => Promise.resolve(members.backend ? { _id: new Types.ObjectId() } : null)) as never)
        vi.spyOn(Frontend, "find").mockResolvedValue([{ slug: "catalog" }] as never)
        vi.spyOn(Backend, "find").mockResolvedValue([] as never)
        vi.spyOn(Resource, "find").mockResolvedValue([] as never)
        getAll.mockResolvedValue(templates)
        json.mockResolvedValue({ frontends: [planned("checkout", "vite-remote-react", "checkout-fe")], backends: [planned("orders", "service-node-fastify", "orders-be")] })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    const plan = () => new DomainPlanService(user, { ANTHROPIC_API_KEY: "sk-test" }).plan(projectId, { domainId: String(domain._id), prompt: "Let customers place an order" })

    it("given a domain without members, when a plan is asked, then the model reads the request, the contexts and the templates and its plan comes back", async () => {
        const result = await plan()

        expect(result.frontends).toEqual([planned("checkout", "vite-remote-react", "checkout-fe")])
        expect(result.backends).toEqual([planned("orders", "service-node-fastify", "orders-be")])
        const request = json.mock.calls[0][0] as { user: string }
        for (const expected of [
            "Let customers place an order",
            "Shop context",
            "Ordering and checkout",
            "Prices are in cents",
            "vite-remote-react (default)",
            "service-node-fastify (default)",
            "frontends: catalog"
        ]) {
            expect(request.user).toContain(expected)
        }
        // A backend template is never offered as a frontend, nor one coming soon
        expect(request.user.split("<backend_templates>")[0]).not.toContain("service-python-fastapi")
        expect(request.user).not.toContain("soon-remote")
    })

    it("given a project with default technologies, when a plan is asked, then the model is told them and the templates built with them are marked and default", async () => {
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId(), name: "Shop", technologies: { frontend: "VUE", backend: "PYTHON" } } as never)

        await plan()

        const request = json.mock.calls[0][0] as { user: string; system: string }
        expect(request.user).toContain("<project_technologies>\nfrontend: Vue\nbackend: Python\n")
        expect(request.user).toContain("- vite-remote-vue (default) (project technology)")
        expect(request.user).toContain("- service-python-fastapi (default) (project technology)")
        expect(request.user).toContain("- vite-remote-react: ")
        expect(request.system).toContain("project technology")
    })

    it("given a project without a design system in an organization with one, when a plan is asked, then the model is told the organization's by name only", async () => {
        vi.spyOn(Organization, "findById").mockResolvedValue({ designSystem: { packageName: "@acme/brand", version: "^2.0.0", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" } } as never)

        await plan()

        const request = json.mock.calls[0][0] as { user: string }
        expect(request.user).toContain("<project_design_system>\npackage: @acme/brand\nversion: ^2.0.0\n")
        expect(request.user).not.toContain("npm_abc123")
    })

    it("given a project without a design system in an organization without one, when a plan is asked, then the model is told none", async () => {
        await plan()

        expect((json.mock.calls[0][0] as { user: string }).user).not.toContain("<project_design_system>")
    })

    it("given resources in the project, when a plan is asked, then the model is told them by name and type and not to plan a component for one", async () => {
        vi.spyOn(Resource, "find").mockResolvedValue([
            { name: "orders", type: "database", description: "Main Postgres" },
            { name: "mailer", type: "smtp" }
        ] as never)

        await plan()

        const request = json.mock.calls[0][0] as { user: string; system: string }
        expect(request.user).toContain("<project_resources>\n- orders (database): Main Postgres\n- mailer (smtp)\n</project_resources>")
        expect(request.system).toContain("do not plan a component that only provides one of them")
        expect(Resource.find).toHaveBeenCalledWith({ projectId: expect.anything() }, { name: 1, type: 1, description: 1 })
    })

    it("given a member scoped to the domain, when a plan is asked, then only the resources they may read are listed", async () => {
        const own = new Types.ObjectId()
        const shared = new Types.ObjectId()
        vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([String(domain._id)])
        vi.spyOn(Backend, "find").mockImplementation(((filter: Record<string, unknown>) =>
            Promise.resolve(
                filter.resourceIds
                    ? [
                          { domainId: domain._id, resourceIds: [own, shared] },
                          { domainId: new Types.ObjectId(), resourceIds: [shared] }
                      ]
                    : []
            )) as never)

        await plan()

        const [filter] = vi.mocked(Resource.find).mock.calls[0] as unknown as [{ projectId: unknown; _id: { $in: unknown[] } }]
        expect(filter._id.$in.map(String)).toEqual([String(own)])
    })

    it("given no resource in the project, when a plan is asked, then no resources block is sent", async () => {
        await plan()

        expect((json.mock.calls[0][0] as { user: string }).user).not.toContain("<project_resources>")
    })

    it("given a project without technologies, when a plan is asked, then no technologies block is sent", async () => {
        await plan()

        expect((json.mock.calls[0][0] as { user: string }).user).not.toContain("<project_technologies>")
    })

    it.each(["frontend", "backend"] as const)("given a domain with a %s, when a plan is asked, then it is refused without calling the model", async kind => {
        members[kind] = true

        await expect(plan()).rejects.toMatchObject({ code: "AI_DOMAIN_PLAN_HAS_MEMBERS", statusCode: 422 })
        expect(json).not.toHaveBeenCalled()
    })

    it("given a viewer, when a plan is asked, then it is refused", async () => {
        role = RoleInProject.VIEWER

        await expect(plan()).rejects.toMatchObject({ code: "AI_CHANGE_FORBIDDEN", statusCode: 403 })
        expect(json).not.toHaveBeenCalled()
    })

    it("given a model that refuses or is cut off, when a plan is asked, then it fails with a code of its own", async () => {
        json.mockResolvedValue(null)

        const error = await plan().catch(caught => caught)
        expect(error).toBeInstanceOf(BusinessException)
        expect(error).toMatchObject({ code: "AI_DOMAIN_PLAN_FAILED" })
    })

    it("given a provider that fails, when a plan is asked, then the user gets a generic error, a rate limit its own code, never the provider's message", async () => {
        json.mockRejectedValueOnce(Object.assign(new Error("404 <html>internal admin console</html>"), { status: 404 }))
        const failed = await plan().catch(caught => caught)
        json.mockRejectedValueOnce(Object.assign(new Error("Too many requests"), { status: 429 }))
        const limited = await plan().catch(caught => caught)

        expect(failed).toMatchObject({ code: "AI_PROVIDER_ERROR", statusCode: 502 })
        expect(failed.message).not.toContain("internal")
        expect(limited).toMatchObject({ code: "RATE_LIMITED", statusCode: 429 })
    })
})
