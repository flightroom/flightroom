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
import BaseAuthorizedService from "../BaseAuthorizedService"
import DomainDraftService, { sanitizeDraftTurn } from "./DomainDraftService"

withNoMaintenanceAgents()

type WithGates = { ensureAccessToProject: () => Promise<void>; isOrganizationAdmin: () => Promise<boolean> }

const user = { _id: new Types.ObjectId(), email: "ada@example.com" } as unknown as IUser
const projectId = new Types.ObjectId().toString()
const shellId = new Types.ObjectId()

const templates = [
    { slug: "vite-host-react", type: "host", framework: "React", compiler: "vite", description: "React host on Vite" },
    { slug: "vite-remote-react", type: "remote", framework: "React", compiler: "vite", description: "React remote on Vite" },
    { slug: "service-node-fastify", type: "service", framework: "Node.js", compiler: "docker", description: "Fastify backend" }
]

const component = (slug: string, template: string, repositoryName: string) => ({ name: slug, slug, template, repositoryName, reason: `${slug} reason` })

const answer = (draft: Record<string, unknown> = {}, turn: Record<string, unknown> = {}) => ({
    reply: "Where will it be exposed?",
    options: ["Inside Shell", "On its own"],
    ready: false,
    ...turn,
    draft: {
        name: "Orders",
        description: "Customers place and follow their orders",
        context: "- Customers place orders",
        request: "Let customers place an order and follow it",
        exposure: { kind: "remote", host: "shell" },
        frontends: [component("orders", "vite-remote-react", "orders-fe")],
        backends: [{ ...component("orders", "service-node-fastify", "orders-be"), exposurePath: "/api/orders" }],
        ...draft
    }
})

const hosts = [{ id: String(shellId), name: "Shell", slug: "shell" }]
const brief = () => ({ templates, taken: { frontend: new Set<string>(), backend: new Set<string>() } })

describe("sanitizeDraftTurn", () => {
    it("given a remote of a host of the project, when the turn is sanitized, then the host is resolved to its id and the components are kept", () => {
        const turn = sanitizeDraftTurn(answer(), brief(), hosts)

        expect(turn?.draft.exposure).toEqual({ kind: "remote", hostId: String(shellId), hostName: "Shell" })
        expect(turn?.draft.frontends).toEqual([component("orders", "vite-remote-react", "orders-fe")])
        expect(turn?.draft.backends).toEqual([{ ...component("orders", "service-node-fastify", "orders-be"), exposurePath: "/api/orders" }])
        expect(turn?.options).toEqual(["Inside Shell", "On its own"])
    })

    it("given a host that is not one of the project, when the turn is sanitized, then the application is one of its own", () => {
        const turn = sanitizeDraftTurn(answer({ exposure: { kind: "remote", host: "nope" } }), brief(), hosts)

        expect(turn?.draft.exposure).toEqual({ kind: "standalone" })
    })

    it("given no user interface, when the turn is sanitized, then no frontend is kept", () => {
        const turn = sanitizeDraftTurn(answer({ exposure: { kind: "none", host: "" } }), brief(), hosts)

        expect(turn?.draft.exposure).toEqual({ kind: "none" })
        expect(turn?.draft.frontends).toEqual([])
        expect(turn?.draft.backends).toHaveLength(1)
    })

    it.each([
        ["", null],
        ["api/orders", "/api/orders"],
        ["/api/../x", null],
        ["/", null],
        ["/api/catalog/", null],
        ["/api/orders?x=1", null]
    ])("given the exposure path %j, when the turn is sanitized, then the backend is exposed at %j", (exposurePath, expected) => {
        const turn = sanitizeDraftTurn(answer({ backends: [{ ...component("orders", "service-node-fastify", "orders-be"), exposurePath }] }), brief(), hosts, ["/api/catalog"])

        expect(turn?.draft.backends[0].exposurePath).toBe(expected)
    })

    it("given two backends at the same path, when the turn is sanitized, then only the first one keeps it", () => {
        const backend = (slug: string) => ({ ...component(slug, "service-node-fastify", `${slug}-be`), exposurePath: "/api/orders" })
        const turn = sanitizeDraftTurn(answer({ backends: [backend("orders"), backend("billing")] }), brief(), hosts)

        expect(turn?.draft.backends.map(item => item.exposurePath)).toEqual(["/api/orders", null])
    })

    it("given an application of its own with a remote template, when the turn is sanitized, then it gets a host template", () => {
        const turn = sanitizeDraftTurn(answer({ exposure: { kind: "standalone", host: "" } }), brief(), hosts)

        expect(turn?.draft.frontends[0].template).toBe("vite-host-react")
    })

    it("given a ready turn without a name, when it is sanitized, then it is not ready", () => {
        expect(sanitizeDraftTurn(answer({ name: "  " }, { ready: true }), brief(), hosts)?.ready).toBe(false)
        expect(sanitizeDraftTurn(answer({}, { ready: true }), brief(), hosts)?.ready).toBe(true)
    })

    it("given more options than can be shown, or blank ones, when the turn is sanitized, then four distinct non-blank ones are kept", () => {
        const turn = sanitizeDraftTurn(answer({}, { options: ["a", " ", "a", "b", 3, "c", "d", "e"] }), brief(), hosts)

        expect(turn?.options).toEqual(["a", "b", "c", "d"])
    })

    it.each([null, "text", { reply: 1, draft: {} }, { reply: "hi" }, { reply: "  ", draft: {} }])("given the answer %j, when it is sanitized, then there is no turn", value => {
        expect(sanitizeDraftTurn(value, brief(), hosts)).toBeNull()
    })
})

describe("DomainDraftService.draft", () => {
    beforeEach(() => {
        const gates = BaseAuthorizedService.prototype as unknown as WithGates
        vi.spyOn(gates, "ensureAccessToProject").mockResolvedValue(undefined)
        vi.spyOn(gates, "isOrganizationAdmin").mockResolvedValue(false)
        vi.spyOn(UserProject, "findOne").mockImplementation((() => Promise.resolve({ role: RoleInProject.MEMBER })) as never)
        vi.spyOn(Project, "findById").mockResolvedValue({
            _id: projectId,
            organizationId: new Types.ObjectId(),
            name: "Shop",
            context: "Shop context",
            exposure: { domain: "shop.example.com" }
        } as never)
        vi.spyOn(Organization, "findById").mockResolvedValue(null as never)
        vi.spyOn(AiModel, "find").mockResolvedValue([] as never)
        vi.spyOn(Domain, "find").mockResolvedValue([{ name: "Catalog", description: "Products and prices" }] as never)
        vi.spyOn(Frontend, "find").mockImplementation(((filter: Record<string, unknown>) =>
            Promise.resolve(filter.$or ? [{ _id: shellId, name: "Shell", slug: "shell" }] : filter.exposurePath ? [] : [{ slug: "catalog" }])) as never)
        vi.spyOn(Backend, "find").mockImplementation(((filter: Record<string, unknown>) => Promise.resolve(filter.exposurePath ? [{ exposurePath: "/api/catalog" }] : [])) as never)
        vi.spyOn(Resource, "find").mockResolvedValue([] as never)
        getAll.mockResolvedValue(templates)
        json.mockResolvedValue(answer())
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    const draft = () =>
        new DomainDraftService(user, { ANTHROPIC_API_KEY: "sk-test" }).draft(projectId, {
            messages: [
                { role: "assistant", content: "What is the application called?" },
                { role: "user", content: "Orders" }
            ],
            locale: "it"
        })

    it("given a conversation, when the next turn is asked, then the model reads it with the project, its domains, its hosts and its gateway", async () => {
        const turn = await draft()

        expect(turn.draft.exposure).toEqual({ kind: "remote", hostId: String(shellId), hostName: "Shell" })
        const request = json.mock.calls[0][0] as { user: string; system: string }
        for (const expected of [
            "locale: it",
            "user: Orders",
            "Shop context",
            "- Catalog: Products and prices",
            "- shell: Shell",
            "https://shop.example.com",
            "vite-remote-react (default)",
            "frontends: catalog",
            "<taken_exposure_paths>\n/api/catalog\n</taken_exposure_paths>"
        ]) {
            expect(request.user).toContain(expected)
        }
        expect(request.system).toContain("where it is exposed")
    })

    it("given a project without hosts nor gateway, when the next turn is asked, then the model is told the application cannot be loaded by one", async () => {
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId(), name: "Shop" } as never)
        vi.spyOn(Frontend, "find").mockResolvedValue([] as never)

        await draft()

        const request = json.mock.calls[0][0] as { user: string }
        expect(request.user).toContain("<host_frontends>\nnone")
        expect(request.user).not.toContain("<gateway>")
    })

    it("given a member scoped to some domains, when the next turn is asked, then it is refused without calling the model, as creating a domain is", async () => {
        vi.spyOn(BaseAuthorizedService.prototype as unknown as { getDomainScope: () => Promise<string[]> }, "getDomainScope").mockResolvedValue([new Types.ObjectId().toString()])

        await expect(draft()).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        expect(json).not.toHaveBeenCalled()
    })

    it("given an answer without the shape asked for, when the next turn is asked, then it is refused", async () => {
        json.mockResolvedValue(null)

        await expect(draft()).rejects.toMatchObject({ code: "AI_DOMAIN_DRAFT_FAILED" } satisfies Partial<BusinessException>)
    })
})
