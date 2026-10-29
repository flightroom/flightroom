import { beforeEach, describe, expect, it, vi } from "vitest"
import { EntityNotFoundError } from "../../errors/EntityNotFoundError"
import { McpSession, McpToolContext, requiresConfirmation } from "../toolDefinition"
import { scaffoldTools } from "./scaffoldTools"

const createFrontend = vi.fn()
const createBackend = vi.fn()
const getTemplate = vi.fn()
const findCodeRepository = vi.fn()
const getDomain = vi.fn()

// Hoisted with the mocks below, which build their service classes with it
const { serviceClass } = vi.hoisted(() => ({
    serviceClass: (methods: Record<string, unknown>) =>
        class {
            constructor() {
                Object.assign(this, methods)
            }
        }
}))

vi.mock("../../service/FrontendService", () => ({ default: serviceClass({ create: (...args: unknown[]) => createFrontend(...args) }) }))
vi.mock("../../service/BackendService", () => ({ default: serviceClass({ create: (...args: unknown[]) => createBackend(...args) }) }))
vi.mock("../../service/MarketService", () => ({ default: serviceClass({ getSingle: (...args: unknown[]) => getTemplate(...args) }) }))
vi.mock("../../service/CodeRepositoryService", () => ({ default: serviceClass({ findById: (...args: unknown[]) => findCodeRepository(...args) }) }))
vi.mock("../../service/DomainService", () => ({ default: serviceClass({ getById: (...args: unknown[]) => getDomain(...args) }) }))

const PROJECT = "aaaaaaaaaaaaaaaaaaaaaaaa"
const DOMAIN = "bbbbbbbbbbbbbbbbbbbbbbbb"
const FRONTEND = "cccccccccccccccccccccccc"
const CODE_REPOSITORY = "dddddddddddddddddddddddd"
const BACKEND = "eeeeeeeeeeeeeeeeeeeeeeee"

const tool = (name: string) => scaffoldTools.find(candidate => candidate.name === name)!

const context = (): McpToolContext => {
    const session: McpSession = {
        principal: { _id: "user-1", email: "user@example.com" } as never,
        projects: [{ projectId: PROJECT, role: "MEMBER" }],
        scopes: ["mfe:read", "mfe:write"],
        credential: { kind: "console", userId: "user-1" }
    }
    return { principal: { ...session.principal, restrictedToProjectIds: [PROJECT] }, projectId: PROJECT, scopes: session.scopes, credential: session.credential, session }
}

/** Runs the tool on its parsed input, as the MCP server and the assistant do. */
const run = (name: string, args: Record<string, unknown>) => tool(name).run(tool(name).inputSchema.parse(args) as never, context())

describe("scaffold tools", () => {
    beforeEach(() => {
        for (const mock of [createFrontend, createBackend, getTemplate, findCodeRepository, getDomain]) {
            mock.mockReset()
        }
    })

    it("given their definitions, when read, then MCP clients get them and the console assistant asks before creating a repository", () => {
        expect(scaffoldTools.map(definition => definition.name).sort()).toEqual(["backend_scaffold", "frontend_scaffold"])
        expect(tool("frontend_scaffold").inputSchema.shape.repositoryName.description).toContain("-fe")
        expect(tool("backend_scaffold").inputSchema.shape.repositoryName.description).toContain("-be")
        for (const definition of scaffoldTools) {
            expect(definition.consoleOnly, definition.name).toBeFalsy()
            expect(definition.scope, definition.name).toBe("mfe:write")
            expect(definition.annotations.openWorldHint, definition.name).toBe(true)
            expect(requiresConfirmation(definition), definition.name).toBe(true)
        }
    })

    describe("frontend_scaffold", () => {
        const input = { name: "Cart", version: "1.0.0", template: "react-vite", codeRepositoryId: CODE_REPOSITORY, repositoryName: "cart-fe", private: true }

        it("given a template and a connection of the project, when scaffolded, then the frontend is created with the repository to create", async () => {
            findCodeRepository.mockResolvedValue({ _id: CODE_REPOSITORY })
            getTemplate.mockResolvedValue({ slug: "react-vite" })
            createFrontend.mockResolvedValue({ _id: FRONTEND, slug: "cart-fe" })

            expect(await run("frontend_scaffold", input)).toEqual({ _id: FRONTEND, slug: "cart-fe" })
            expect(findCodeRepository).toHaveBeenCalledWith(CODE_REPOSITORY)
            expect(createFrontend).toHaveBeenCalledWith(
                {
                    name: "Cart",
                    slug: "cart-fe",
                    version: "1.0.0",
                    codeRepository: {
                        enabled: true,
                        codeRepositoryId: CODE_REPOSITORY,
                        repositoryId: "",
                        gitlab: undefined,
                        createData: { name: "cart-fe", private: true, template: "react-vite" }
                    }
                },
                PROJECT
            )
        })

        it("given a connection of another project, when scaffolded, then it is refused before anything is created", async () => {
            findCodeRepository.mockRejectedValue(new EntityNotFoundError(CODE_REPOSITORY))

            await expect(run("frontend_scaffold", input)).rejects.toBeInstanceOf(EntityNotFoundError)
            expect(createFrontend).not.toHaveBeenCalled()
        })

        it("given an unknown template, when scaffolded, then it is refused before any repository is created", async () => {
            findCodeRepository.mockResolvedValue({ _id: CODE_REPOSITORY })
            getTemplate.mockResolvedValue(null)

            await expect(run("frontend_scaffold", input)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" })
            expect(createFrontend).not.toHaveBeenCalled()
        })
    })

    describe("backend_scaffold", () => {
        const input = { name: "Orders API", domainId: DOMAIN, template: "node-fastify", codeRepositoryId: CODE_REPOSITORY, repositoryName: "orders-be" }

        it("given a template, a connection and a domain of the project, when scaffolded, then the backend is created in the domain with the repository to create", async () => {
            findCodeRepository.mockResolvedValue({ _id: CODE_REPOSITORY })
            getDomain.mockResolvedValue({ _id: DOMAIN })
            getTemplate.mockResolvedValue({ slug: "node-fastify" })
            createBackend.mockResolvedValue({ _id: BACKEND, slug: "orders-be" })

            expect(await run("backend_scaffold", input)).toEqual({ _id: BACKEND, slug: "orders-be" })
            expect(createBackend).toHaveBeenCalledWith(
                {
                    name: "Orders API",
                    slug: "orders-be",
                    domainId: DOMAIN,
                    codeRepository: {
                        enabled: true,
                        codeRepositoryId: CODE_REPOSITORY,
                        repositoryId: "",
                        gitlab: undefined,
                        createData: { name: "orders-be", private: undefined, template: "node-fastify" }
                    }
                },
                PROJECT
            )
        })

        it("given a domain of another project, when scaffolded, then it is refused before any repository is created", async () => {
            findCodeRepository.mockResolvedValue({ _id: CODE_REPOSITORY })
            getDomain.mockResolvedValue(null)

            await expect(run("backend_scaffold", input)).rejects.toBeInstanceOf(EntityNotFoundError)
            expect(createBackend).not.toHaveBeenCalled()
        })

        it("given an unknown template, when scaffolded, then it is refused before any repository is created", async () => {
            findCodeRepository.mockResolvedValue({ _id: CODE_REPOSITORY })
            getDomain.mockResolvedValue({ _id: DOMAIN })
            getTemplate.mockResolvedValue(null)

            await expect(run("backend_scaffold", input)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" })
            expect(createBackend).not.toHaveBeenCalled()
        })

        it("given a repository name the providers refuse, when parsed, then it is refused", () => {
            expect(tool("backend_scaffold").inputSchema.safeParse({ ...input, repositoryName: "orders be" }).success).toBe(false)
            expect(tool("backend_scaffold").inputSchema.safeParse({ ...input, repositoryName: "orders-be.git" }).success).toBe(false)
        })

        it("given a repository name that is not a slug or lacks the suffix of its kind, when parsed, then it is refused: it is also the slug", () => {
            expect(tool("backend_scaffold").inputSchema.safeParse({ ...input, repositoryName: "Orders-be" }).success).toBe(false)
            expect(tool("backend_scaffold").inputSchema.safeParse({ ...input, repositoryName: "orders" }).success).toBe(false)
            expect(tool("backend_scaffold").inputSchema.safeParse({ ...input, repositoryName: "orders-fe" }).success).toBe(false)
            expect(tool("frontend_scaffold").inputSchema.safeParse({ ...input, version: "1.0.0", repositoryName: "orders-be" }).success).toBe(false)
        })

        it("given a slug other than the repository name, when scaffolded, then the slug is the repository name", async () => {
            findCodeRepository.mockResolvedValue({ _id: CODE_REPOSITORY })
            getDomain.mockResolvedValue({ _id: DOMAIN })
            getTemplate.mockResolvedValue({ slug: "node-fastify" })

            await run("backend_scaffold", { ...input, slug: "orders-api" })

            expect(createBackend).toHaveBeenCalledWith(expect.objectContaining({ slug: "orders-be" }), PROJECT)
        })

        it("given an existing repository to link instead, when parsed, then it is not taken: backend_create links one", () => {
            const parsed = tool("backend_scaffold").inputSchema.parse({ ...input, codeRepository: { enabled: true, codeRepositoryId: CODE_REPOSITORY, repositoryId: "42" } })

            expect(parsed).not.toHaveProperty("codeRepository")
        })
    })
})
