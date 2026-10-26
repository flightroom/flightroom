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
})
