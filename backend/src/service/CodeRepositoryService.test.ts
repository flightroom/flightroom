import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

/** Every GitLab client built, with the URL and the token it would send there. */
const gitlabClients: { url: string; token: string }[] = []
vi.mock("../client/GitlabClient", () => ({
    default: class {
        constructor(url: string, token: string) {
            gitlabClients.push({ url, token })
        }
        getGroups = vi.fn().mockResolvedValue([])
    }
}))

const azureGetProjects = vi.fn()
vi.mock("../client/AzureDevOpsClient", () => ({
    default: class {
        getProjects = azureGetProjects
        getVariableGroups = vi.fn()
    }
}))

import CodeRepository, { CodeRepositoryProvider } from "../models/CodeRepositoryModel"
import Project from "../models/ProjectModel"
import { IUser } from "../models/UserModel"
import UserProject from "../models/UserProjectModel"
import BaseAuthorizedService, { domainScopeForbidden } from "./BaseAuthorizedService"
import CodeRepositoryImportService from "./CodeRepositoryImportService"
import CodeRepositoryService from "./CodeRepositoryService"
import GitOpsService from "./GitOpsService"

type Guards = { ensureAccessToProject: () => Promise<void>; ensureWholeProject: () => Promise<void> }
const guards = BaseAuthorizedService.prototype as unknown as Guards

const STORED_TOKEN = "glpat-stored"
const connectionId = String(new Types.ObjectId())

const connection = (fields: Record<string, unknown>) => ({ _id: connectionId, projectId: new Types.ObjectId(), accessToken: STORED_TOKEN, save: vi.fn(), ...fields })
const gitlabConnection = () => connection({ provider: CodeRepositoryProvider.GITLAB, gitlabData: { url: "https://gitlab.acme.dev", groupId: 7, groupPath: "acme" } })

const service = () => new CodeRepositoryService({ _id: new Types.ObjectId() } as unknown as IUser)
const storedTokenRequired = { code: "ACCESS_TOKEN_REQUIRED", statusCode: 400 }

let stored: ReturnType<typeof connection>

beforeEach(() => {
    gitlabClients.length = 0
    azureGetProjects.mockReset().mockResolvedValue({ value: [] })
    stored = gitlabConnection()
    vi.spyOn(CodeRepository, "findOne").mockImplementation((() => Promise.resolve(stored)) as never)
    vi.spyOn(guards, "ensureAccessToProject").mockResolvedValue()
    vi.spyOn(guards, "ensureWholeProject").mockResolvedValue()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("connection test with the stored token", () => {
    it("Given a GitLab connection, when a test names another host without a token, then it is refused and the token goes nowhere", async () => {
        await expect(service().testConnectionGitlab("https://attacker.example", "", connectionId)).rejects.toMatchObject(storedTokenRequired)
        expect(gitlabClients).toEqual([])
    })

    it("Given a GitLab connection, when a test names its own URL, then the stored token is used there", async () => {
        await service().testConnectionGitlab("https://gitlab.acme.dev/", "", connectionId)

        expect(gitlabClients).toEqual([{ url: "https://gitlab.acme.dev/", token: STORED_TOKEN }])
    })

    it("Given a GitHub connection, when a GitLab test takes its stored token, then it is refused and the token goes nowhere", async () => {
        stored = connection({ provider: CodeRepositoryProvider.GITHUB })

        await expect(service().testConnectionGitlab("https://gitlab.acme.dev", "", connectionId)).rejects.toMatchObject(storedTokenRequired)
        expect(gitlabClients).toEqual([])
    })

    it("Given a member who does not manage the connections, when a test takes the stored token, then it is refused and the token goes nowhere", async () => {
        vi.mocked(guards.ensureWholeProject).mockRejectedValue(domainScopeForbidden())

        await expect(service().testConnectionGitlab("https://gitlab.acme.dev", "", connectionId)).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        await expect(service().testConnectionAzure("acme", "", connectionId)).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        expect(gitlabClients).toEqual([])
        expect(azureGetProjects).not.toHaveBeenCalled()
    })

    it("Given a token typed in, when a test names any host, then that token is used and no connection is read", async () => {
        await service().testConnectionGitlab("https://gitlab.other.dev", "glpat-typed", connectionId)

        expect(gitlabClients).toEqual([{ url: "https://gitlab.other.dev", token: "glpat-typed" }])
        expect(CodeRepository.findOne).not.toHaveBeenCalled()
    })

    it("Given an Azure DevOps connection, when a test takes its stored token, then it is used against Azure DevOps", async () => {
        stored = connection({ provider: CodeRepositoryProvider.AZURE_DEV_OPS, azureData: { organization: "acme" } })

        await service().testConnectionAzure("acme", "", connectionId)

        expect(azureGetProjects).toHaveBeenCalledWith(STORED_TOKEN, "acme")
    })

    it("Given a GitLab connection, when an Azure DevOps test takes its stored token, then it is refused", async () => {
        await expect(service().testConnectionAzure("acme", "", connectionId)).rejects.toMatchObject(storedTokenRequired)
        expect(azureGetProjects).not.toHaveBeenCalled()
    })
})

describe("GitLab connection edited with the stored token", () => {
    beforeEach(() => {
        vi.spyOn(CodeRepositoryService.prototype, "injectSecretsToDeployOnGitlabRaw").mockResolvedValue(undefined as never)
    })

    it("Given a GitLab connection, when it is saved with another URL and the token not typed again, then it is refused and nothing is written", async () => {
        const saved = service().editRepositoryGitlabRaw({ name: "acme", url: "https://attacker.example", pat: "", groupId: 7, groupPath: "acme" } as never, connectionId)

        await expect(saved).rejects.toMatchObject(storedTokenRequired)
        expect(stored.save).not.toHaveBeenCalled()
        expect(CodeRepositoryService.prototype.injectSecretsToDeployOnGitlabRaw).not.toHaveBeenCalled()
    })

    it("Given a GitLab connection, when it is saved with another URL and a new token, then it is written", async () => {
        await service().editRepositoryGitlabRaw({ name: "acme", url: "https://gitlab.other.dev", pat: "glpat-new", groupId: 7, groupPath: "acme" } as never, connectionId)

        expect(stored.save).toHaveBeenCalledTimes(1)
        expect(stored).toMatchObject({ accessToken: "glpat-new", gitlabData: { url: "https://gitlab.other.dev" } })
    })

    it("Given a GitLab connection, when it is saved with its URL and the token not typed again, then the stored token is kept", async () => {
        await service().editRepositoryGitlabRaw({ name: "renamed", url: "https://gitlab.acme.dev", pat: "", groupId: 7, groupPath: "acme" } as never, connectionId)

        expect(stored.save).toHaveBeenCalledTimes(1)
        expect(stored).toMatchObject({ name: "renamed", accessToken: STORED_TOKEN })
    })
})

describe("pipeline templates of a connection", () => {
    const templatesId = String(new Types.ObjectId())
    const repository = { repositoryId: "7", name: "acme-pipelines", cloneUrlHttps: "https://github.com/acme/acme-pipelines.git" }
    let written: Record<string, unknown> | undefined
    let templates: Record<string, unknown> | null
    let findTemplates: ReturnType<typeof vi.fn<(filter: Record<string, unknown>) => Promise<unknown>>>

    beforeEach(() => {
        written = undefined
        templates = { _id: templatesId, projectId: stored.projectId, name: "GitHub" }
        // The connection being configured by its id, the one of the templates among the active ones of its project
        findTemplates = vi.fn((_filter: Record<string, unknown>) => Promise.resolve(templates))
        vi.mocked(CodeRepository.findOne).mockImplementation(((filter: Record<string, unknown>) => (filter.isActive ? findTemplates(filter) : Promise.resolve(stored))) as never)
        vi.spyOn(CodeRepository, "findOneAndUpdate").mockImplementation(((_filter: unknown, update: Record<string, unknown>) => {
            written = update
            return Promise.resolve(stored)
        }) as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: stored.projectId, organizationId: new Types.ObjectId() } as never)
        // An owner of the project
        vi.spyOn(UserProject, "findOne").mockResolvedValue({ role: "OWNER" } as never)
        vi.spyOn(CodeRepositoryImportService.prototype, "fetchRepositories").mockResolvedValue([repository])
    })

    const set = (pipelines: unknown) => service().setPipelines(connectionId, pipelines as never)

    it("Given a repository a connection of the project reaches, when it is set, then it is linked with its ref", async () => {
        await set({ codeRepositoryId: templatesId, repositoryId: "7", ref: " release/v2 " })

        const filter = findTemplates.mock.calls[0][0] as Record<string, unknown>
        expect({ ...filter, _id: String(filter._id), projectId: String(filter.projectId) }).toEqual({ _id: templatesId, projectId: String(stored.projectId), isActive: true })
        expect(written).toEqual({
            pipelines: { codeRepository: expect.objectContaining({ enabled: true, codeRepositoryId: templatesId, repositoryId: "7", name: "acme-pipelines" }), ref: "release/v2" }
        })
    })

    it("Given no ref, when it is set, then none is stored: the default branch is read", async () => {
        await set({ codeRepositoryId: templatesId, repositoryId: "7", ref: "" })

        expect(written).toEqual({ pipelines: expect.not.objectContaining({ ref: expect.anything() }) })
    })

    it("Given a folder with slashes around it, when it is set, then it is stored without them", async () => {
        await set({ codeRepositoryId: templatesId, repositoryId: "7", path: " /ci/templates/ " })

        expect(written).toEqual({ pipelines: expect.objectContaining({ path: "ci/templates" }) })
    })

    it("Given no folder, when it is set, then none is stored: the root is read", async () => {
        await set({ codeRepositoryId: templatesId, repositoryId: "7", path: "/" })

        expect(written).toEqual({ pipelines: expect.not.objectContaining({ path: expect.anything() }) })
    })

    it.each([
        ["stepping out", "ci/../.."],
        ["made of ..", ".."],
        ["with a .", "ci/./templates"],
        ["with a backslash", "ci\\templates"],
        ["with a space", "ci templates"],
        ["with an empty segment", "ci//templates"]
    ])("Given a folder %s, when it is set, then it is refused with a 400 and nothing is written", async (_case, path) => {
        await expect(set({ codeRepositoryId: templatesId, repositoryId: "7", path })).rejects.toMatchObject({ code: "PIPELINES_PATH_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it("Given null, when it is set, then the official pipeline templates are used again", async () => {
        await set(null)

        expect(written).toEqual({ $unset: { pipelines: 1 } })
    })

    /** A connection of another project would lend this one its access token */
    it("Given a connection of another project, when it is set, then it is refused and nothing is written", async () => {
        templates = null

        await expect(set({ codeRepositoryId: String(new Types.ObjectId()), repositoryId: "7" })).rejects.toMatchObject({ code: "PIPELINES_REPOSITORY_INVALID" })
        expect(written).toBeUndefined()
    })

    it("Given a repository the connection cannot reach, when it is set, then it is refused", async () => {
        await expect(set({ codeRepositoryId: templatesId, repositoryId: "999" })).rejects.toMatchObject({ code: "PIPELINES_REPOSITORY_INVALID" })
        expect(written).toBeUndefined()
    })

    it.each([
        ["no connection", { repositoryId: "7" }],
        ["a connection id that is not one", { codeRepositoryId: "c0ffee", repositoryId: "7" }],
        ["no repository", { codeRepositoryId: "aaaaaaaaaaaaaaaaaaaaaaaa" }]
    ])("Given %s, when it is set, then it is refused with a 400 and nothing is written", async (_case, pipelines) => {
        await expect(set(pipelines)).rejects.toMatchObject({ code: "PIPELINES_REPOSITORY_REQUIRED", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it.each([
        ["with ..", "release/../main"],
        ["starting with a dash", "-x"],
        ["with a space", "my branch"],
        ["ending with .lock", "main.lock"],
        ["that is not a string", 42]
    ])("Given a ref %s, when it is set, then it is refused with a 400 and nothing is written", async (_case, ref) => {
        await expect(set({ codeRepositoryId: templatesId, repositoryId: "7", ref })).rejects.toMatchObject({ code: "PIPELINES_REF_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it("Given a member who is not an owner, when the pipeline templates are changed or cleared, then it is refused as for GitOps", async () => {
        vi.mocked(UserProject.findOne).mockResolvedValue({ role: "MEMBER" } as never)
        vi.spyOn(GitOpsService.prototype as unknown as { isOrganizationAdmin: () => Promise<boolean> }, "isOrganizationAdmin").mockResolvedValue(false)

        await expect(set({ codeRepositoryId: templatesId, repositoryId: "7" })).rejects.toMatchObject({ code: "PIPELINES_OWNER_REQUIRED", statusCode: 403 })
        await expect(set(null)).rejects.toMatchObject({ code: "PIPELINES_OWNER_REQUIRED", statusCode: 403 })
        expect(written).toBeUndefined()
    })

    it("Given a member who does not manage the connections, when the pipeline templates are set, then it is refused and nothing is written", async () => {
        vi.mocked(guards.ensureWholeProject).mockRejectedValue(domainScopeForbidden())

        await expect(set(null)).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        expect(written).toBeUndefined()
    })
})
