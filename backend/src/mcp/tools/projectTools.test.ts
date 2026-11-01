import { Types } from "mongoose"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { McpSession, McpToolContext } from "../toolDefinition"

const getAll = vi.fn()
const findProject = vi.fn()

// Hoisted with the mocks below, which build their service classes with it
const { serviceClass } = vi.hoisted(() => ({
    serviceClass: (methods: Record<string, unknown>) =>
        class {
            constructor() {
                Object.assign(this, methods)
            }
        }
}))

vi.mock("../../service/MarketService", () => ({ default: serviceClass({ getAll: (...args: unknown[]) => getAll(...args) }) }))
const getDesignSystemNpmrc = vi.fn()
vi.mock("../../service/ProjectService", () => ({
    default: serviceClass({ findById: (...args: unknown[]) => findProject(...args), getDesignSystemNpmrc: (...args: unknown[]) => getDesignSystemNpmrc(...args) })
}))
const environments = vi.fn()
const domainDeployments = vi.fn()
const backends = vi.fn()
const agents = vi.fn()
vi.mock("../../service/EnvironmentService", () => ({ default: serviceClass({ getByProjectId: (...args: unknown[]) => environments(...args) }) }))
vi.mock("../../service/DomainDeploymentService", () => ({ default: serviceClass({ getByProjectId: (...args: unknown[]) => domainDeployments(...args) }) }))
vi.mock("../../service/BackendService", () => ({ default: serviceClass({ getByProjectId: (...args: unknown[]) => backends(...args) }) }))
vi.mock("../../service/MaintenanceAgentService", () => ({ default: serviceClass({ getByProjectId: (...args: unknown[]) => agents(...args) }) }))

import { projectTools } from "./projectTools"

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"

const tool = (name: string) => projectTools.find(candidate => candidate.name === name)!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "MEMBER" }],
        scopes: ["mfe:read", "mfe:write"],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

const run = (name: string, args: Record<string, unknown>) => tool(name).run(tool(name).inputSchema.parse(args) as never, context())

describe("project tools", () => {
    beforeEach(() => {
        getAll.mockReset()
        findProject.mockReset()
        getAll.mockResolvedValue([
            { slug: "vite-remote-react", type: "remote", framework: "React" },
            { slug: "vite-remote-vue", type: "remote", framework: "Vue" },
            { slug: "service-node-fastify", type: "service", framework: "Node.js" },
            { slug: "service-spring-boot", type: "service", framework: "Spring Boot" }
        ])
    })

    it("given a project with default technologies, when the templates are listed, then only the ones built with them are marked", async () => {
        findProject.mockResolvedValue({ _id: new Types.ObjectId(), technologies: { frontend: "VUE", backend: "SPRING_BOOT" } })

        const templates = (await run("templates_list", {})) as { slug: string; matchesProjectTechnology?: boolean }[]

        expect(templates.filter(template => template.matchesProjectTechnology).map(template => template.slug)).toEqual(["vite-remote-vue", "service-spring-boot"])
    })

    it("given a project without technologies, when the templates are listed, then none is marked", async () => {
        findProject.mockResolvedValue({ _id: new Types.ObjectId() })

        const templates = (await run("templates_list", {})) as { matchesProjectTechnology?: boolean }[]

        expect(templates.some(template => template.matchesProjectTechnology)).toBe(false)
    })

    it("given technologies outside the known ones, when project_update is called, then the input is refused before the service", () => {
        expect(tool("project_update").inputSchema.safeParse({ technologies: { backend: "RUST" } }).success).toBe(false)
        expect(tool("project_update").inputSchema.safeParse({ technologies: { frontend: "VUE", backend: null } }).success).toBe(true)
        expect(tool("project_update").inputSchema.safeParse({ technologies: null }).success).toBe(true)
    })

    it("given a design system, when project_update is called, then it needs its npm package and null removes it", () => {
        expect(tool("project_update").inputSchema.safeParse({ designSystem: { packageName: "@acme/ui", npmrc: "@acme:registry=https://npm.acme.dev/" } }).success).toBe(true)
        expect(tool("project_update").inputSchema.safeParse({ designSystem: { notes: "Use its tokens." } }).success).toBe(false)
        expect(tool("project_update").inputSchema.safeParse({ designSystem: null }).success).toBe(true)
    })

    it("given a frontend, when design_system_npmrc_get is called, then the service reads the npmrc of that frontend's design system", async () => {
        const whole = { packageName: "@acme/ui", source: "project", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" }
        getDesignSystemNpmrc.mockResolvedValue(whole)
        const frontendId = "bbbbbbbbbbbbbbbbbbbbbbbb"

        expect(await run("design_system_npmrc_get", { frontendId })).toEqual(whole)
        expect(getDesignSystemNpmrc).toHaveBeenCalledWith(PROJECT, frontendId)
    })

    it("given a project with domains, when its overview is read, then each frontend and backend comes once with its version per environment slug", async () => {
        const [dev, prod, orders, checkout] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()]
        findProject.mockResolvedValue({ _id: PROJECT, name: "Shop", slug: "shop", context: "long notes", technologies: { backend: "NODE" } })
        environments.mockResolvedValue([
            { _id: dev, name: "Development", slug: "dev", isProduction: false, color: "#00f" },
            { _id: prod, name: "Production", slug: "prod", isProduction: true, color: "#f00" }
        ])
        const served = (slug: string, ordersVersion: string | null, checkoutVersion: string | null) => ({
            environment: { _id: slug, name: slug, slug, color: "#000", isProduction: false },
            deployment: null,
            frontends: [{ _id: checkout, slug: "checkout", name: "Checkout", kind: "DOCKER", version: checkoutVersion, canary: null }],
            backends: [{ _id: orders, slug: "orders", name: "Orders", version: ordersVersion, deployedAt: null }]
        })
        domainDeployments.mockResolvedValue([{ domain: null, environments: [served("dev", "1.1.0", "2.0.0"), served("prod", "1.0.0", null)] }])
        backends.mockResolvedValue([{ _id: orders, version: "1.2.0" }])
        agents.mockResolvedValue([{ _id: "agent", name: "Doctor", slug: "doctor", kind: "CRON", schedule: "0 * * * *", version: "0.1.0", env: [] }])

        const overview = await run("project_overview", {})

        expect(overview).toEqual({
            project: { _id: PROJECT, name: "Shop", slug: "shop", description: null, technologies: { backend: "NODE" } },
            environments: [
                { _id: String(dev), name: "Development", slug: "dev", isProduction: false },
                { _id: String(prod), name: "Production", slug: "prod", isProduction: true }
            ],
            domains: [
                {
                    domain: null,
                    frontends: [{ _id: String(checkout), name: "Checkout", slug: "checkout", kind: "DOCKER", versions: { dev: "2.0.0", prod: null } }],
                    backends: [{ _id: String(orders), name: "Orders", slug: "orders", latestVersion: "1.2.0", versions: { dev: "1.1.0", prod: "1.0.0" } }]
                }
            ],
            maintenanceAgents: [{ _id: "agent", name: "Doctor", slug: "doctor", kind: "CRON", schedule: "0 * * * *", version: "0.1.0", domainId: null }]
        })
        expect(domainDeployments).toHaveBeenCalledWith(PROJECT)
    })
})
