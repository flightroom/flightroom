import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

const getSingle = vi.fn()
vi.mock("./MarketService", () => ({
    default: class {
        getSingle = getSingle
    }
}))

const createRepository = vi.fn()
vi.mock("./TemplateScaffoldService", () => ({
    placeholderDomain: () => "https://console.example.com",
    default: class {
        createRepository = createRepository
    }
}))

import Backend from "../models/BackendModel"
import CodeRepository from "../models/CodeRepositoryModel"
import Project from "../models/ProjectModel"
import { IUser } from "../models/UserModel"
import UserProject, { RoleInProject } from "../models/UserProjectModel"
import { withNoMaintenanceAgents } from "../testing/noMaintenanceAgents"
import BackendDTO from "../types/BackendDTO"
import BackendService from "./BackendService"

withNoMaintenanceAgents()

type WithGates = { ensureAccessToProject: () => Promise<void>; isOrganizationAdmin: () => Promise<boolean>; findRoleInOrganization: () => Promise<string | undefined> }

const projectId = new Types.ObjectId().toString()
const codeRepositoryId = new Types.ObjectId().toString()
const user = { _id: new Types.ObjectId(), email: "ada@example.com" } as unknown as IUser

describe("BackendService.create with a new repository", () => {
    let role: RoleInProject
    let organizationAdmin: boolean

    beforeEach(() => {
        role = RoleInProject.VIEWER
        organizationAdmin = false
        vi.spyOn(UserProject, "findOne").mockImplementation((() => Promise.resolve({ role })) as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, organizationId: new Types.ObjectId() } as never)
        vi.spyOn(CodeRepository, "findById").mockResolvedValue({ _id: codeRepositoryId, projectId } as never)
        vi.spyOn(Backend, "exists").mockResolvedValue(null as never)
        vi.spyOn(Backend, "create").mockImplementation((async (doc: unknown) => doc) as never)
        getSingle.mockResolvedValue({ slug: "service-node-fastify", type: "service", compiler: "docker", framework: "Node.js" })
    })

    afterEach(() => {
        vi.restoreAllMocks()
        getSingle.mockReset()
        createRepository.mockReset()
    })

    const create = () => {
        const backend = new BackendService(user)
        const gates = backend as unknown as WithGates
        vi.spyOn(gates, "ensureAccessToProject").mockResolvedValue()
        vi.spyOn(gates, "isOrganizationAdmin").mockImplementation(async () => organizationAdmin)
        vi.spyOn(gates, "findRoleInOrganization").mockImplementation(async () => (organizationAdmin ? "ADMIN" : undefined))
        return backend.create(
            {
                name: "Orders API",
                slug: "orders",
                codeRepository: { enabled: true, codeRepositoryId, repositoryId: "", createData: { name: "orders-be", template: "service-node-fastify" } }
            } as BackendDTO,
            projectId
        )
    }

    it("given a viewer, when a backend is created with a new repository, then it is refused before the repository is created", async () => {
        await expect(create()).rejects.toMatchObject({ code: "REPOSITORY_CREATE_FORBIDDEN", statusCode: 403 })
        expect(createRepository).not.toHaveBeenCalled()
    })

    it("given a viewer administering the organization, when a backend is created with a new repository, then the repository is created", async () => {
        organizationAdmin = true

        await create()

        expect(createRepository).toHaveBeenCalledTimes(1)
    })
})
