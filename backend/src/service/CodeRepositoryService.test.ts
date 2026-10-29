import fs from "node:fs/promises"
import path from "node:path"
import * as git from "isomorphic-git"
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
import MarketService from "./MarketService"
import { RepositoryFileService } from "./RepositoryFileService"
import { GitWorkingCopy } from "./workspace/GitWorkingCopy"
import RepositoryWorkspaceService from "./workspace/RepositoryWorkspaceService"

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
    const repository = { repositoryId: "7", name: "acme-pipelines", cloneUrlHttps: "https://github.com/acme/acme-pipelines.git" }
    let written: Record<string, unknown> | undefined

    beforeEach(() => {
        written = undefined
        vi.mocked(CodeRepository.findOne).mockResolvedValue(stored as never)
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

    it("Given a repository the connection reaches, when it is set, then it is linked through the connection with its ref", async () => {
        await set({ repositoryId: "7", ref: " release/v2 " })

        expect(CodeRepositoryImportService.prototype.fetchRepositories).toHaveBeenCalledWith(expect.anything(), stored)
        expect(written).toEqual({
            pipelines: { codeRepository: expect.objectContaining({ enabled: true, codeRepositoryId: stored._id, repositoryId: "7", name: "acme-pipelines" }), ref: "release/v2" }
        })
    })

    it("Given no ref, when it is set, then none is stored: the default branch is read", async () => {
        await set({ repositoryId: "7", ref: "" })

        expect(written).toEqual({ pipelines: expect.not.objectContaining({ ref: expect.anything() }) })
    })

    it("Given a folder with slashes around it, when it is set, then it is stored without them", async () => {
        await set({ repositoryId: "7", path: " /ci/templates/ " })

        expect(written).toEqual({ pipelines: expect.objectContaining({ path: "ci/templates" }) })
    })

    it("Given no folder, when it is set, then none is stored: the root is read", async () => {
        await set({ repositoryId: "7", path: "/" })

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
        await expect(set({ repositoryId: "7", path })).rejects.toMatchObject({ code: "PIPELINES_PATH_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it("Given null, when it is set, then the official pipeline templates are used again", async () => {
        await set(null)

        expect(written).toEqual({ $unset: { pipelines: 1 } })
    })

    it("Given a repository the connection cannot reach, when it is set, then it is refused", async () => {
        await expect(set({ repositoryId: "999" })).rejects.toMatchObject({ code: "PIPELINES_REPOSITORY_INVALID" })
        expect(written).toBeUndefined()
    })

    it.each([
        ["no repository", {}],
        ["an empty repository", { repositoryId: "" }],
        ["a repository that is not a string", { repositoryId: 7 }]
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
        await expect(set({ repositoryId: "7", ref })).rejects.toMatchObject({ code: "PIPELINES_REF_INVALID", statusCode: 400 })
        expect(written).toBeUndefined()
    })

    it("Given a member who is not an owner, when the pipeline templates are changed or cleared, then it is refused as for GitOps", async () => {
        vi.mocked(UserProject.findOne).mockResolvedValue({ role: "MEMBER" } as never)
        vi.spyOn(GitOpsService.prototype as unknown as { isOrganizationAdmin: () => Promise<boolean> }, "isOrganizationAdmin").mockResolvedValue(false)

        await expect(set({ repositoryId: "7" })).rejects.toMatchObject({ code: "PIPELINES_OWNER_REQUIRED", statusCode: 403 })
        await expect(set(null)).rejects.toMatchObject({ code: "PIPELINES_OWNER_REQUIRED", statusCode: 403 })
        expect(written).toBeUndefined()
    })

    it("Given a member who does not manage the connections, when the pipeline templates are set, then it is refused and nothing is written", async () => {
        vi.mocked(guards.ensureWholeProject).mockRejectedValue(domainScopeForbidden())

        await expect(set(null)).rejects.toMatchObject({ code: "DOMAIN_SCOPE_FORBIDDEN" })
        expect(written).toBeUndefined()
    })
})

describe("pipeline templates initialized in the repository of a connection", () => {
    const catalog = [
        { slug: "docker-service", type: "service", compiler: "docker" },
        { slug: "spring-service", type: "service", compiler: "docker" },
        { slug: "react-host", type: "host", compiler: "vite" },
        { slug: "angular-remote", type: "remote", compiler: "webpack", comingSoon: true },
        { slug: "evil", type: "..", compiler: "vite" }
    ]
    /** What a scaffold of the catalog looks in, slugs aside: the remote is coming soon, `..` is no folder */
    const folders = ["host/javascript", "host/vite", "service/docker", "service/dotnet", "service/go", "service/java", "service/javascript", "service/python"]
    /** The files the remote branch already holds, written in the clone */
    let onRemote: string[]
    let branches: string[]
    let pushed: { pushTo?: string; message: string; files: { path: string; content?: string; action: string }[] }[]
    let initialized: { branch: string; files: { path: string; content: string }[] }[]

    const reachable = (cloneUrlHttps: string) => vi.spyOn(CodeRepositoryImportService.prototype, "fetchRepositories").mockResolvedValue([{ repositoryId: "7", name: "acme-pipelines", cloneUrlHttps }])

    beforeEach(() => {
        onRemote = []
        branches = ["main"]
        pushed = []
        initialized = []
        vi.spyOn(CodeRepository, "findOneAndUpdate")
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: stored.projectId, organizationId: new Types.ObjectId() } as never)
        vi.spyOn(UserProject, "findOne").mockResolvedValue({ role: "OWNER" } as never)
        reachable("https://gitlab.acme.dev/acme/acme-pipelines.git")
        vi.spyOn(MarketService.prototype, "getAll").mockResolvedValue(catalog as never)
        vi.spyOn(RepositoryWorkspaceService.prototype, "providerSizeBytes").mockResolvedValue(undefined)
        vi.spyOn(RepositoryFileService.prototype, "getDefaultBranch").mockResolvedValue("main")
        vi.spyOn(GitWorkingCopy.prototype, "hasRemoteBranch").mockImplementation(async branch => branches.includes(branch))
        vi.spyOn(GitWorkingCopy.prototype, "prepare").mockImplementation(async function (this: GitWorkingCopy) {
            for (const file of onRemote) {
                await fs.mkdir(path.dirname(path.join(this.dir, file)), { recursive: true })
                await fs.writeFile(path.join(this.dir, file), "steps: []\n")
            }
            return "head"
        })
        vi.spyOn(GitWorkingCopy.prototype, "commitAndPush").mockImplementation(async options => {
            pushed.push(options)
            return "commit"
        })
        vi.spyOn(GitWorkingCopy.prototype, "initialize").mockImplementation(async options => {
            initialized.push(options)
            return "commit"
        })
    })

    const initialize = (input: unknown) => service().initializePipelines(connectionId, input as never)

    it("Given a GitLab connection, when its repository is initialized, then one empty .gitlab-ci.yml per folder is pushed onto the default branch and nothing is saved", async () => {
        const result = await initialize({ repositoryId: "7" })

        expect(result).toEqual({ created: folders.map(folder => `${folder}/.gitlab-ci.yml`), skipped: 0 })
        expect(pushed).toEqual([
            expect.objectContaining({
                pushTo: "main",
                message: "chore: initialize the pipeline templates",
                files: folders.map(folder => ({ path: `${folder}/.gitlab-ci.yml`, content: `# Pipeline for ${folder}: to be completed\n`, action: "create" }))
            })
        ])
        expect(CodeRepository.findOneAndUpdate).not.toHaveBeenCalled()
    })

    it("Given an Azure DevOps connection, when its repository is initialized, then the empty pipelines are azure-pipelines.yml", async () => {
        stored = connection({ provider: CodeRepositoryProvider.AZURE_DEV_OPS, azureData: { organization: "acme", projectId: "p1" } })
        reachable("https://dev.azure.com/acme/p1/_git/acme-pipelines")

        const result = await initialize({ repositoryId: "7" })

        expect(result.created).toEqual(folders.map(folder => `${folder}/azure-pipelines.yml`))
        expect(pushed[0].pushTo).toBe("main")
    })

    it("Given a GitHub connection, when its repository is initialized, then each folder gets a workflow, except one that already has any", async () => {
        stored = connection({ provider: CodeRepositoryProvider.GITHUB, githubData: { organizationId: "acme" } })
        reachable("https://github.com/acme/acme-pipelines.git")
        onRemote = ["service/docker/.github/workflows/release.yml"]

        const result = await initialize({ repositoryId: "7" })

        expect(result).toEqual({ created: folders.filter(folder => folder !== "service/docker").map(folder => `${folder}/.github/workflows/build.yml`), skipped: 1 })
    })

    it("Given a folder and pipelines already there, when the repository is initialized, then only the missing ones are written under that folder", async () => {
        onRemote = ["ci/templates/service/docker/.gitlab-ci.yml", "service/go/.gitlab-ci.yml"]
        branches = ["main", "release"]

        const result = await initialize({ repositoryId: "7", ref: "release", path: "/ci/templates/" })

        expect(result.skipped).toBe(1)
        expect(result.created).toEqual(folders.filter(folder => folder !== "service/docker").map(folder => `ci/templates/${folder}/.gitlab-ci.yml`))
        expect(pushed[0]).toMatchObject({ pushTo: "release" })
        expect(pushed[0].files[0].content).toBe("# Pipeline for host/javascript: to be completed\n")
    })

    it("Given every pipeline already there, when the repository is initialized, then nothing is committed nor pushed", async () => {
        onRemote = folders.map(folder => `${folder}/.gitlab-ci.yml`)

        expect(await initialize({ repositoryId: "7" })).toEqual({ created: [], skipped: folders.length })
        expect(pushed).toEqual([])
        expect(initialized).toEqual([])
    })

    it("Given a repository without commits, when it is initialized, then its first commit holds the empty pipelines", async () => {
        branches = []

        const result = await initialize({ repositoryId: "7" })

        expect(GitWorkingCopy.prototype.prepare).not.toHaveBeenCalled()
        expect(initialized).toEqual([expect.objectContaining({ branch: "main", message: "chore: initialize the pipeline templates" })])
        expect(initialized[0].files.map(file => file.path)).toEqual(result.created)
        expect(pushed).toEqual([])
    })

    it("Given a ref that is not a branch, when the repository is initialized, then it is refused with a 502 and nothing is pushed", async () => {
        await expect(initialize({ repositoryId: "7", ref: "v1.0.0" })).rejects.toMatchObject({ code: "PIPELINES_INITIALIZE_FAILED", statusCode: 502 })
        expect(pushed).toEqual([])
        expect(initialized).toEqual([])
    })

    it("Given a push the remote refuses, when the repository is initialized, then it fails with the reason", async () => {
        vi.mocked(GitWorkingCopy.prototype.commitAndPush).mockRejectedValue(new git.Errors.PushRejectedError("not-fast-forward"))

        await expect(initialize({ repositoryId: "7" })).rejects.toMatchObject({ code: "PIPELINES_INITIALIZE_FAILED", statusCode: 502, details: { reason: expect.stringContaining("refused") } })
    })

    it("Given a member who is not an owner, when the repository is initialized, then it is refused and nothing is cloned", async () => {
        vi.mocked(UserProject.findOne).mockResolvedValue({ role: "MEMBER" } as never)
        vi.spyOn(GitOpsService.prototype as unknown as { isOrganizationAdmin: () => Promise<boolean> }, "isOrganizationAdmin").mockResolvedValue(false)

        await expect(initialize({ repositoryId: "7" })).rejects.toMatchObject({ code: "PIPELINES_OWNER_REQUIRED", statusCode: 403 })
        expect(GitWorkingCopy.prototype.prepare).not.toHaveBeenCalled()
        expect(pushed).toEqual([])
    })

    it("Given an invalid folder, when the repository is initialized, then it is refused as when it is set", async () => {
        await expect(initialize({ repositoryId: "7", path: "../x" })).rejects.toMatchObject({ code: "PIPELINES_PATH_INVALID", statusCode: 400 })
        expect(pushed).toEqual([])
    })
})
