import axios, { AxiosError, AxiosHeaders, CreateAxiosDefaults } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_FAILED_JOB_LOG_BYTES, MAX_FAILED_JOBS } from "../types/BuildStatusDTO"
import GitlabClient from "./GitlabClient"

const answered = (status: number) =>
    new AxiosError("Request failed", String(status), undefined, undefined, {
        status,
        statusText: "",
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() }
    })

/** A failure with no answer at all: the server could not be reached */
const unreachable = () => new AxiosError("connect ECONNREFUSED 10.0.0.1:443", "ECONNREFUSED")

/** A client whose requests go to `get` */
const clientAnswering = (get: ReturnType<typeof vi.fn>) => {
    vi.spyOn(axios, "create").mockReturnValue({ get } as never)
    return new GitlabClient("https://gitlab.example", "token")
}

type Verb = "get" | "post" | "put" | "delete"

/** A client whose requests go to the mocks given, one per HTTP verb */
const clientWith = (api: Partial<Record<Verb, ReturnType<typeof vi.fn>>>) => {
    vi.spyOn(axios, "create").mockReturnValue(api as never)
    return new GitlabClient("https://gitlab.example", "token")
}

/** The `transformResponse` a request was sent with, to check that the body is kept as text */
const transformOf = (config: unknown) => (config as { transformResponse: ((data: unknown) => unknown)[] }).transformResponse

afterEach(() => {
    vi.restoreAllMocks()
})

describe("GitlabClient", () => {
    it("given a GitLab URL and a token, when it is created, then it talks to API v4 with the token as PRIVATE-TOKEN", () => {
        const create = vi.spyOn(axios, "create").mockReturnValue({} as never)

        new GitlabClient("https://gitlab.example", "glpat-secret")

        expect(create).toHaveBeenCalledWith({ baseURL: "https://gitlab.example/api/v4", headers: { "PRIVATE-TOKEN": "glpat-secret" } })
        expect((create.mock.calls[0][0] as CreateAxiosDefaults).headers).not.toHaveProperty("Authorization")
    })
})

describe("GitlabClient.tagExists", () => {
    it("given the tag, when it is looked up, then it exists, read by its encoded name", async () => {
        const get = vi.fn().mockResolvedValue({ data: { name: "release/1.2" } })

        await expect(clientAnswering(get).tagExists(42, "release/1.2")).resolves.toBe(true)
        expect(get).toHaveBeenCalledWith("/projects/42/repository/tags/release%2F1.2")
    })

    it("given GitLab answers 404, when the tag is looked up, then it does not exist", async () => {
        await expect(clientAnswering(vi.fn().mockRejectedValue(answered(404))).tagExists(42, "1.2.0")).resolves.toBe(false)
    })

    it("given any other failure, when the tag is looked up, then it is passed on", async () => {
        const failure = answered(401)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).tagExists(42, "1.2.0")).rejects.toBe(failure)
    })

    it("given GitLab cannot be reached, when the tag is looked up, then the network error is passed on, not read as a missing tag", async () => {
        const failure = unreachable()

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).tagExists(42, "1.2.0")).rejects.toBe(failure)
    })

    it("given a 404 that did not come from axios, when the tag is looked up, then it is passed on", async () => {
        const failure = Object.assign(new Error("boom"), { response: { status: 404 } })

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).tagExists(42, "1.2.0")).rejects.toBe(failure)
    })
})

describe("GitlabClient.getBranchCommitSha", () => {
    it("given a branch with a slash, when its commit is read, then the name is one encoded path segment", async () => {
        const get = vi.fn().mockResolvedValue({ data: { commit: { id: "abc" } } })

        await expect(clientAnswering(get).getBranchCommitSha(42, "release/1.4")).resolves.toBe("abc")
        expect(get).toHaveBeenCalledWith("/projects/42/repository/branches/release%2F1.4")
    })

    it("given no such branch, when its commit is read, then the 404 is passed on", async () => {
        const failure = answered(404)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).getBranchCommitSha(42, "gone")).rejects.toBe(failure)
    })
})

describe("GitlabClient.getGroups", () => {
    it("given owned, when the groups are listed, then only the owned ones are asked for and returned as GitLab answers", async () => {
        const groups = [{ id: 7, name: "platform", full_path: "acme/platform" }]
        const get = vi.fn().mockResolvedValue({ data: groups })

        await expect(clientAnswering(get).getGroups(true)).resolves.toBe(groups)
        expect(get).toHaveBeenCalledWith("/groups", { params: { owned: true } })
    })

    it("given no filter, when the groups are listed, then owned is left out of the query", async () => {
        const get = vi.fn().mockResolvedValue({ data: [] })

        await clientAnswering(get).getGroups()

        expect(get).toHaveBeenCalledWith("/groups", { params: { owned: undefined } })
    })
})

describe("GitlabClient.getRepositoriesByGroupId", () => {
    const projects = (from: number, count: number) =>
        Array.from({ length: count }, (_, index) => ({ id: from + index, name: `repo-${from + index}`, path_with_namespace: `acme/repo-${from + index}` }))

    it("given fewer projects than a page, when they are listed, then one page of 100 is read", async () => {
        const get = vi.fn().mockResolvedValue({ data: projects(1, 3) })

        await expect(clientAnswering(get).getRepositoriesByGroupId(7)).resolves.toEqual(projects(1, 3))
        expect(get).toHaveBeenCalledTimes(1)
        expect(get).toHaveBeenCalledWith("/groups/7/projects", { params: { per_page: 100, page: 1 } })
    })

    it("given a full page, when the projects are listed, then the next page is read and the pages come back in order", async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({ data: projects(1, 100) })
            .mockResolvedValueOnce({ data: projects(101, 20) })

        const listed = await clientAnswering(get).getRepositoriesByGroupId(7)

        expect(listed.map(project => project.id)).toEqual(projects(1, 120).map(project => project.id))
        expect(get).toHaveBeenNthCalledWith(1, "/groups/7/projects", { params: { per_page: 100, page: 1 } })
        expect(get).toHaveBeenNthCalledWith(2, "/groups/7/projects", { params: { per_page: 100, page: 2 } })
        expect(get).toHaveBeenCalledTimes(2)
    })

    it("given exactly a page of projects, when they are listed, then the empty page after it ends the walk", async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({ data: projects(1, 100) })
            .mockResolvedValueOnce({ data: [] })

        await expect(clientAnswering(get).getRepositoriesByGroupId(7)).resolves.toHaveLength(100)
        expect(get).toHaveBeenCalledTimes(2)
    })

    it("given a cursor that never ends, when the projects are listed, then the walk stops after 50 pages", async () => {
        const get = vi.fn().mockImplementation((_url: string, config: { params: { page: number } }) => Promise.resolve({ data: projects(config.params.page * 1000, 100) }))

        await expect(clientAnswering(get).getRepositoriesByGroupId(7)).resolves.toHaveLength(5000)
        expect(get).toHaveBeenCalledTimes(50)
        expect(get).toHaveBeenLastCalledWith("/groups/7/projects", { params: { per_page: 100, page: 50 } })
    })

    it("given a group path already encoded, when its projects are listed, then it goes into the URL as is", async () => {
        const get = vi.fn().mockResolvedValue({ data: [] })

        await clientAnswering(get).getRepositoriesByGroupId("acme%2Fplatform")

        expect(get).toHaveBeenCalledWith("/groups/acme%2Fplatform/projects", { params: { per_page: 100, page: 1 } })
    })

    it("given a page that fails, when the projects are listed, then the failure is passed on, not a partial list", async () => {
        const failure = answered(500)
        const get = vi
            .fn()
            .mockResolvedValueOnce({ data: projects(1, 100) })
            .mockRejectedValueOnce(failure)

        await expect(clientAnswering(get).getRepositoriesByGroupId(7)).rejects.toBe(failure)
    })
})

describe("GitlabClient.getRepositoryPathsByGroupId", () => {
    it("given projects with repeated or missing paths, when the paths are listed, then each path comes back once", async () => {
        const get = vi.fn().mockResolvedValue({
            data: [
                { id: 1, name: "a", path_with_namespace: "acme/a" },
                { id: 2, name: "b", path_with_namespace: "acme/b" },
                { id: 3, name: "a-again", path_with_namespace: "acme/a" },
                { id: 4, name: "broken", path_with_namespace: null }
            ]
        })

        await expect(clientAnswering(get).getRepositoryPathsByGroupId(7)).resolves.toEqual(["acme/a", "acme/b"])
        expect(get).toHaveBeenCalledWith("/groups/7/projects", { params: { per_page: 100, page: 1 } })
    })
})

describe("GitlabClient.createRepository", () => {
    it("given the settings of a repository, when it is created, then they are posted as they are and the project comes back", async () => {
        const created = { id: 99, name: "orders-be", path_with_namespace: "acme/orders-be" }
        const post = vi.fn().mockResolvedValue({ data: created })
        const settings = { name: "orders-be", namespace_id: 7, visibility: "private" as const, initialize_with_readme: false }

        await expect(clientWith({ post }).createRepository(settings)).resolves.toBe(created)
        expect(post).toHaveBeenCalledWith("/projects", settings)
    })

    it("given GitLab refuses a name already taken, when the repository is created, then the error is passed on", async () => {
        const failure = answered(400)

        await expect(clientWith({ post: vi.fn().mockRejectedValue(failure) }).createRepository({ name: "orders-be" })).rejects.toBe(failure)
    })
})

describe("GitlabClient.checkGroupSecretExists", () => {
    it("given the variable, when it is looked up in the group, then it exists", async () => {
        const get = vi.fn().mockResolvedValue({ data: { key: "FLIGHTROOM_DEPLOY_KEY" } })

        await expect(clientAnswering(get).checkGroupSecretExists({ groupId: 7, secretName: "FLIGHTROOM_DEPLOY_KEY" })).resolves.toBe(true)
        expect(get).toHaveBeenCalledWith("/groups/7/variables/FLIGHTROOM_DEPLOY_KEY")
    })

    it("given GitLab answers 404, when the variable is looked up, then it does not exist", async () => {
        await expect(clientAnswering(vi.fn().mockRejectedValue(answered(404))).checkGroupSecretExists({ groupId: 7, secretName: "KEY" })).resolves.toBe(false)
    })

    it("given the token may not read variables, when one is looked up, then the 403 is passed on, not read as a missing variable", async () => {
        const failure = answered(403)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).checkGroupSecretExists({ groupId: 7, secretName: "KEY" })).rejects.toBe(failure)
    })

    it("given GitLab cannot be reached, when a variable is looked up, then the network error is passed on", async () => {
        const failure = unreachable()

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).checkGroupSecretExists({ groupId: 7, secretName: "KEY" })).rejects.toBe(failure)
    })
})

describe("GitlabClient.addGroupSecret", () => {
    it("given a secret, when it is added to the group, then it is posted as a masked, hidden, unprotected variable", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ post }).addGroupSecret({ groupId: 7, secretName: "FLIGHTROOM_DEPLOY_KEY", secretValue: "s3cr3t-value" })).resolves.toBeUndefined()
        expect(post).toHaveBeenCalledWith("/groups/7/variables", { key: "FLIGHTROOM_DEPLOY_KEY", value: "s3cr3t-value", protected: false, masked: true, hidden: true, raw: false })
    })

    it("given the variable exists already, when it is added, then GitLab's 400 is passed on", async () => {
        const failure = answered(400)

        await expect(clientWith({ post: vi.fn().mockRejectedValue(failure) }).addGroupSecret({ groupId: 7, secretName: "KEY", secretValue: "v" })).rejects.toBe(failure)
    })
})

describe("GitlabClient.getPipelines", () => {
    it("given a project, when its pipelines are read, then the newest come first, as many as asked", async () => {
        const pipelines = [{ id: 12, project_id: 42, sha: "abc", ref: "main", status: "success", web_url: "https://gitlab.example/p/12", created_at: "c", updated_at: "u" }]
        const get = vi.fn().mockResolvedValue({ data: pipelines })

        await expect(clientAnswering(get).getPipelines(42, 5)).resolves.toBe(pipelines)
        expect(get).toHaveBeenCalledWith("/projects/42/pipelines", { params: { per_page: 5, order_by: "id", sort: "desc" } })
    })

    it("given GitLab answers no body, when the pipelines are read, then none come back", async () => {
        await expect(clientAnswering(vi.fn().mockResolvedValue({ data: null })).getPipelines(42, 5)).resolves.toEqual([])
    })
})

describe("GitlabClient.getFailedJobLogs", () => {
    it("given failed jobs, when their logs are read, then the failed jobs of the encoded pipeline are listed and each trace comes back by job name", async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({
                data: [
                    { id: 1, name: "build" },
                    { id: 2, name: "test" }
                ]
            })
            .mockImplementation((url: string) => Promise.resolve({ data: `trace of ${url}` }))

        const logs = await clientAnswering(get).getFailedJobLogs(42, "pipe/7")

        expect(get).toHaveBeenNthCalledWith(1, "/projects/42/pipelines/pipe%2F7/jobs", { params: { "scope[]": "failed", per_page: 100 } })
        expect(get).toHaveBeenCalledWith("/projects/42/jobs/1/trace", { maxContentLength: MAX_FAILED_JOB_LOG_BYTES, transformResponse: [expect.any(Function)] })
        expect(get).toHaveBeenCalledWith("/projects/42/jobs/2/trace", { maxContentLength: MAX_FAILED_JOB_LOG_BYTES, transformResponse: [expect.any(Function)] })
        expect(logs).toEqual([
            { name: "build", log: "trace of /projects/42/jobs/1/trace" },
            { name: "test", log: "trace of /projects/42/jobs/2/trace" }
        ])
    })

    it("given a trace that looks like JSON, when it is read, then it is kept as raw text", async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({ data: [{ id: 1, name: "build" }] })
            .mockResolvedValueOnce({ data: "" })

        await clientAnswering(get).getFailedJobLogs(42, "7")

        const [transform] = transformOf(get.mock.calls[1][1])
        expect(transform('{"status":"failed"}')).toBe('{"status":"failed"}')
    })

    it("given more failed jobs than the cap, when their logs are read, then only the first ones are fetched", async () => {
        const jobs = Array.from({ length: MAX_FAILED_JOBS + 3 }, (_, index) => ({ id: index + 1, name: `job-${index + 1}` }))
        const get = vi.fn().mockResolvedValueOnce({ data: jobs }).mockResolvedValue({ data: "log" })

        const logs = await clientAnswering(get).getFailedJobLogs(42, "7")

        expect(logs.map(log => log.name)).toEqual(jobs.slice(0, MAX_FAILED_JOBS).map(job => job.name))
        expect(get).toHaveBeenCalledTimes(1 + MAX_FAILED_JOBS)
    })

    it("given GitLab answers no jobs body, when the logs are read, then none come back and no trace is fetched", async () => {
        const get = vi.fn().mockResolvedValueOnce({ data: null })

        await expect(clientAnswering(get).getFailedJobLogs(42, "7")).resolves.toEqual([])
        expect(get).toHaveBeenCalledTimes(1)
    })

    it("given the jobs cannot be listed, when the logs are read, then the failure is passed on", async () => {
        const failure = answered(404)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).getFailedJobLogs(42, "7")).rejects.toBe(failure)
    })
})

describe("GitlabClient.getBranches", () => {
    it("given a project, when its branches are read, then up to 100 are asked for and returned as GitLab answers", async () => {
        const branches = [{ name: "main" }, { name: "develop" }]
        const get = vi.fn().mockResolvedValue({ data: branches })

        await expect(clientAnswering(get).getBranches("acme%2Forders-be")).resolves.toBe(branches)
        expect(get).toHaveBeenCalledWith("/projects/acme%2Forders-be/repository/branches", { params: { per_page: 100 } })
    })
})

describe("GitlabClient.getTagCommitSha", () => {
    it("given the tag, when its commit is read, then the commit id comes back, read by the encoded name", async () => {
        const get = vi.fn().mockResolvedValue({ data: { name: "release/1.2", commit: { id: "def456" } } })

        await expect(clientAnswering(get).getTagCommitSha(42, "release/1.2")).resolves.toBe("def456")
        expect(get).toHaveBeenCalledWith("/projects/42/repository/tags/release%2F1.2")
    })

    it("given a tag GitLab answers without a commit, when its commit is read, then there is none", async () => {
        await expect(clientAnswering(vi.fn().mockResolvedValue({ data: { name: "1.2.0" } })).getTagCommitSha(42, "1.2.0")).resolves.toBeUndefined()
    })

    it("given GitLab answers 404, when the commit of the tag is read, then there is none", async () => {
        await expect(clientAnswering(vi.fn().mockRejectedValue(answered(404))).getTagCommitSha(42, "1.2.0")).resolves.toBeUndefined()
    })

    it("given any other failure, when the commit of the tag is read, then it is passed on", async () => {
        const failure = answered(500)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).getTagCommitSha(42, "1.2.0")).rejects.toBe(failure)
    })
})

describe("GitlabClient.createTag", () => {
    it("given a tag name and a ref, when the tag is created, then they are posted to the tags of the project", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ post }).createTag(42, "release/1.2", "main")).resolves.toBeUndefined()
        expect(post).toHaveBeenCalledWith("/projects/42/repository/tags", { tag_name: "release/1.2", ref: "main" })
    })

    it("given the tag exists already, when it is created, then GitLab's 409 is passed on", async () => {
        const failure = answered(409)

        await expect(clientWith({ post: vi.fn().mockRejectedValue(failure) }).createTag(42, "1.2.0", "main")).rejects.toBe(failure)
    })
})

describe("GitlabClient.getProject", () => {
    it("given a project path already encoded, when the project is read, then it goes into the URL as is, not encoded twice", async () => {
        const project = { id: 42, name: "repo", path_with_namespace: "group/sub/repo" }
        const get = vi.fn().mockResolvedValue({ data: project })

        await expect(clientAnswering(get).getProject("group%2Fsub%2Frepo")).resolves.toBe(project)
        expect(get).toHaveBeenCalledWith("/projects/group%2Fsub%2Frepo")
    })

    it("given no such project, when it is read, then the 404 is passed on", async () => {
        const failure = answered(404)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).getProject(42)).rejects.toBe(failure)
    })
})

describe("GitlabClient.renameProject", () => {
    it("given a new name, when the project is renamed, then its path moves with it and the renamed project comes back", async () => {
        const renamed = { id: 42, name: "billing-be", path_with_namespace: "acme/billing-be" }
        const put = vi.fn().mockResolvedValue({ data: renamed })

        await expect(clientWith({ put }).renameProject(42, "billing-be")).resolves.toBe(renamed)
        expect(put).toHaveBeenCalledWith("/projects/42", { name: "billing-be", path: "billing-be" })
    })

    it("given a path already taken, when the project is renamed, then GitLab's 400 is passed on", async () => {
        const failure = answered(400)

        await expect(clientWith({ put: vi.fn().mockRejectedValue(failure) }).renameProject(42, "taken")).rejects.toBe(failure)
    })
})

describe("GitlabClient.createMergeRequest", () => {
    it("given the branches and the text, when the merge request is opened, then it removes the source branch on merge and its web URL comes back", async () => {
        const post = vi.fn().mockResolvedValue({ data: { iid: 3, web_url: "https://gitlab.example/acme/repo/-/merge_requests/3" } })

        const url = await clientWith({ post }).createMergeRequest(42, { sourceBranch: "ai/change-1", targetBranch: "main", title: "Fix the header", description: "Done by the agent" })

        expect(url).toBe("https://gitlab.example/acme/repo/-/merge_requests/3")
        expect(post).toHaveBeenCalledWith("/projects/42/merge_requests", {
            source_branch: "ai/change-1",
            target_branch: "main",
            title: "Fix the header",
            description: "Done by the agent",
            remove_source_branch: true
        })
    })

    it("given an open merge request for the same branches, when another is opened, then GitLab's 409 is passed on", async () => {
        const failure = answered(409)

        await expect(clientWith({ post: vi.fn().mockRejectedValue(failure) }).createMergeRequest(42, { sourceBranch: "a", targetBranch: "main", title: "t", description: "d" })).rejects.toBe(failure)
    })
})

describe("GitlabClient.getFileContent", () => {
    it("given a file in a folder, when it is read, then its path is one encoded segment, the ref is a query param and the raw text comes back", async () => {
        const get = vi.fn().mockResolvedValue({ data: "export const x = 1\n" })

        await expect(clientAnswering(get).getFileContent("group%2Fsub%2Frepo", "src/app/main.ts", "feature/x")).resolves.toBe("export const x = 1\n")
        expect(get).toHaveBeenCalledWith("/projects/group%2Fsub%2Frepo/repository/files/src%2Fapp%2Fmain.ts/raw", { params: { ref: "feature/x" }, transformResponse: [expect.any(Function)] })
    })

    it("given a JSON file, when it is read, then it is kept as text and not parsed", async () => {
        const get = vi.fn().mockResolvedValue({ data: "" })

        await clientAnswering(get).getFileContent(42, "package.json", "main")

        const [transform] = transformOf(get.mock.calls[0][1])
        expect(transform('{"name":"orders"}')).toBe('{"name":"orders"}')
    })

    it("given GitLab answers 404, when the file is read, then there is none", async () => {
        await expect(clientAnswering(vi.fn().mockRejectedValue(answered(404))).getFileContent(42, "missing.txt", "main")).resolves.toBeNull()
    })

    it("given any other failure, when the file is read, then it is passed on", async () => {
        const failure = answered(500)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).getFileContent(42, "a.txt", "main")).rejects.toBe(failure)
    })
})

describe("GitlabClient.commitFiles", () => {
    const actions = [
        { action: "create" as const, file_path: "src/new.ts", content: "new" },
        { action: "move" as const, file_path: "src/b.ts", previous_path: "src/a.ts" }
    ]

    it("given a branch to start from, when the files are committed, then GitLab is asked to create the branch from it in the same call", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })

        await expect(clientWith({ post }).commitFiles(42, { branch: "ai/change-1", startBranch: "main", commitMessage: "feat: add new", actions })).resolves.toBeUndefined()
        expect(post).toHaveBeenCalledWith("/projects/42/repository/commits", { branch: "ai/change-1", start_branch: "main", commit_message: "feat: add new", actions })
    })

    it("given no branch to start from, when the files are committed, then they go onto the branch as it is", async () => {
        const post = vi.fn().mockResolvedValue({ data: {} })

        await clientWith({ post }).commitFiles(42, { branch: "main", commitMessage: "fix", actions })

        expect(post).toHaveBeenCalledWith("/projects/42/repository/commits", { branch: "main", start_branch: undefined, commit_message: "fix", actions })
    })

    it("given GitLab refuses the commit, when the files are committed, then the error is passed on", async () => {
        const failure = answered(400)

        await expect(clientWith({ post: vi.fn().mockRejectedValue(failure) }).commitFiles(42, { branch: "main", commitMessage: "fix", actions })).rejects.toBe(failure)
    })
})

describe("GitlabClient.createDeployToken", () => {
    it("given a name and scopes, when the deploy token is created, then they are posted and the token comes back", async () => {
        const token = { id: 9, username: "gitlab+deploy-token-9", token: "gldt-xyz" }
        const post = vi.fn().mockResolvedValue({ data: token })

        await expect(clientWith({ post }).createDeployToken(42, { name: "argocd", scopes: ["read_repository"] })).resolves.toBe(token)
        expect(post).toHaveBeenCalledWith("/projects/42/deploy_tokens", { name: "argocd", scopes: ["read_repository"] })
    })

    it("given the token is not a Maintainer, when the deploy token is created, then the 403 is passed on", async () => {
        const failure = answered(403)

        await expect(clientWith({ post: vi.fn().mockRejectedValue(failure) }).createDeployToken(42, { name: "argocd", scopes: [] })).rejects.toBe(failure)
    })
})

describe("GitlabClient.revokeDeployToken", () => {
    it("given a deploy token, when it is revoked, then it is deleted from the project", async () => {
        const remove = vi.fn().mockResolvedValue({ data: "" })

        await expect(clientWith({ delete: remove }).revokeDeployToken(42, 9)).resolves.toBeUndefined()
        expect(remove).toHaveBeenCalledWith("/projects/42/deploy_tokens/9")
    })

    it("given the token is gone already, when it is revoked, then it is not an error", async () => {
        await expect(clientWith({ delete: vi.fn().mockRejectedValue(answered(404)) }).revokeDeployToken(42, 9)).resolves.toBeUndefined()
    })

    it("given any other failure, when the token is revoked, then it is passed on", async () => {
        const failure = answered(403)

        await expect(clientWith({ delete: vi.fn().mockRejectedValue(failure) }).revokeDeployToken(42, 9)).rejects.toBe(failure)
    })
})

describe("GitlabClient.branchExists", () => {
    it("given the branch, when it is looked up, then it exists, read by its encoded name", async () => {
        const get = vi.fn().mockResolvedValue({ data: { name: "ai/change-1" } })

        await expect(clientAnswering(get).branchExists(42, "ai/change-1")).resolves.toBe(true)
        expect(get).toHaveBeenCalledWith("/projects/42/repository/branches/ai%2Fchange-1")
    })

    it("given GitLab answers 404, when the branch is looked up, then it does not exist", async () => {
        await expect(clientAnswering(vi.fn().mockRejectedValue(answered(404))).branchExists(42, "gone")).resolves.toBe(false)
    })

    it("given any other failure, when the branch is looked up, then it is passed on", async () => {
        const failure = answered(500)

        await expect(clientAnswering(vi.fn().mockRejectedValue(failure)).branchExists(42, "main")).rejects.toBe(failure)
    })
})
