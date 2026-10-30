import axios, { AxiosError, AxiosHeaders } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BusinessException } from "../errors/BusinessException"
import { MAX_FAILED_JOB_LOG_BYTES, MAX_FAILED_JOBS } from "../types/BuildStatusDTO"
import AzureDevOpsClient, { AZURE_DEVOPS_TAG_REFUSED, AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED, AzureBranchNotFoundError } from "./AzureDevOpsClient"

const answered = (status: number) =>
    new AxiosError("Request failed", String(status), undefined, undefined, {
        status,
        statusText: "",
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() }
    })

const params = { accessToken: "pat", organization: "org", projectId: "project", secretName: "SECRET", variableGroupName: "GROUP" }

/** The connection never reached Azure: an AxiosError without a response */
const unreachable = () => new AxiosError("connect ECONNREFUSED", "ECONNREFUSED")

/** What every JSON request of the client carries */
const jsonHeaders = { Authorization: "Bearer pat", "Content-Type": "application/json" }

afterEach(() => {
    vi.restoreAllMocks()
})

describe("AzureDevOpsClient variable groups", () => {
    /** The token lists the projects, so the connection test passed: only the variable groups refuse it. */
    it.each([401, 403])("given Azure answers %i, when the variable groups are read, then the missing scope is named", async status => {
        vi.spyOn(axios, "request").mockRejectedValue(answered(status))

        const read = new AzureDevOpsClient().checkOrganizationSecretExists(params)

        await expect(read).rejects.toBeInstanceOf(BusinessException)
        await expect(read).rejects.toMatchObject({ code: AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED, statusCode: 400 })
    })

    it("given any other failure, when the variable groups are read, then it is passed on unchanged", async () => {
        const failure = answered(500)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().checkOrganizationSecretExists(params)).rejects.toBe(failure)
    })

    it("given the group holds the secret, when it is checked, then it exists", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "GROUP", variables: { SECRET: {} } }] } })

        await expect(new AzureDevOpsClient().checkOrganizationSecretExists(params)).resolves.toBe(true)
    })

    it("given the group without the secret, when it is checked, then it does not exist", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "GROUP", variables: { OTHER: {} } }] } })

        await expect(new AzureDevOpsClient().checkOrganizationSecretExists(params)).resolves.toBe(false)
    })

    it("given only other groups, when the secret is checked, then it does not exist", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "OTHER", variables: { SECRET: {} } }] } })

        await expect(new AzureDevOpsClient().checkOrganizationSecretExists(params)).resolves.toBe(false)
    })

    it("given a project, when its variable groups are read, then the project's groups are asked for and returned as Azure lists them", async () => {
        const groups = { count: 1, value: [{ id: 3, name: "GROUP", type: "Vsts", variables: {} }] }
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: groups })

        await expect(new AzureDevOpsClient().getVariableGroups("pat", "org", "project-id")).resolves.toEqual(groups)
        expect(request).toHaveBeenCalledTimes(1)
        expect(request).toHaveBeenCalledWith({
            url: "https://dev.azure.com/org/project-id/_apis/distributedtask/variablegroups?api-version=7.1-preview.2",
            headers: jsonHeaders
        })
    })

    it("given the connection fails, when the variable groups are read, then the network error is passed on unchanged", async () => {
        const failure = unreachable()
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getVariableGroups("pat", "org", "project")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.upsertOrganizationSecret", () => {
    const upsert = { ...params, projectName: "Orders", value: "s3cr3t", variableGroupDescription: "Deploy keys" }
    const references = [{ name: "GROUP", projectReference: { id: "project", name: "Orders" } }]
    const providerData = { isShared: false, isAuthorizationRequired: false }

    it("given no such group, when the secret is saved, then the group is created holding only the secret, as a secret", async () => {
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { value: [{ id: 4, name: "OTHER", variables: {} }] } })
            .mockResolvedValueOnce({ data: { id: 5 } })

        await expect(new AzureDevOpsClient().upsertOrganizationSecret(upsert)).resolves.toBeUndefined()

        expect(request).toHaveBeenCalledTimes(2)
        expect(request).toHaveBeenNthCalledWith(2, {
            method: "POST",
            url: "https://dev.azure.com/org/project/_apis/distributedtask/variablegroups?api-version=7.1",
            headers: jsonHeaders,
            data: {
                name: "GROUP",
                description: "Deploy keys",
                type: "Vsts",
                variables: { SECRET: { value: "s3cr3t", isSecret: true } },
                variableGroupProjectReferences: references,
                providerData
            }
        })
    })

    it("given the group exists, when the secret is saved, then the group is replaced keeping its other variables", async () => {
        const existing = { id: 12, name: "GROUP", description: "Deploy keys", type: "Vsts", variables: { KEPT: { value: "plain" }, SECRET: { value: null, isSecret: true } } }
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { value: [existing] } })
            .mockResolvedValueOnce({ data: {} })

        await expect(new AzureDevOpsClient().upsertOrganizationSecret(upsert)).resolves.toBeUndefined()

        expect(request).toHaveBeenCalledTimes(2)
        expect(request).toHaveBeenNthCalledWith(2, {
            method: "PUT",
            url: "https://dev.azure.com/org/project/_apis/distributedtask/variablegroups/12?api-version=7.1-preview.2",
            headers: jsonHeaders,
            data: {
                id: 12,
                name: "GROUP",
                description: "Deploy keys",
                type: "Vsts",
                variables: { KEPT: { value: "plain" }, SECRET: { value: "s3cr3t", isSecret: true } },
                variableGroupProjectReferences: references,
                providerData
            }
        })
    })

    it.each([401, 403])("given Azure answers %i to the creation of the group, when the secret is saved, then the missing scope is named", async status => {
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { value: [] } })
            .mockRejectedValueOnce(answered(status))

        await expect(new AzureDevOpsClient().upsertOrganizationSecret(upsert)).rejects.toMatchObject({ code: AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED, statusCode: 400 })
    })

    it("given Azure answers 403 to the update of the group, when the secret is saved, then the missing scope is named", async () => {
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { value: [{ id: 12, name: "GROUP", variables: {} }] } })
            .mockRejectedValueOnce(answered(403))

        const save = new AzureDevOpsClient().upsertOrganizationSecret(upsert)

        await expect(save).rejects.toBeInstanceOf(BusinessException)
        await expect(save).rejects.toMatchObject({ code: AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED })
    })

    it("given Azure fails the update of the group with a 500, when the secret is saved, then the failure is passed on unchanged", async () => {
        const failure = answered(500)
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { value: [{ id: 12, name: "GROUP", variables: {} }] } })
            .mockRejectedValueOnce(failure)

        await expect(new AzureDevOpsClient().upsertOrganizationSecret(upsert)).rejects.toBe(failure)
    })

    it("given the groups cannot be read, when the secret is saved, then nothing is written", async () => {
        const request = vi.spyOn(axios, "request").mockRejectedValue(answered(401))

        await expect(new AzureDevOpsClient().upsertOrganizationSecret(upsert)).rejects.toMatchObject({ code: AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED })
        expect(request).toHaveBeenCalledTimes(1)
    })
})

describe("AzureDevOpsClient.tagExists", () => {
    /** The refs filter is a prefix: asking for 1.2 lists 1.2.0 too */
    it("given only tags that start with the name, when the tag is looked up, then it does not exist", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { count: 1, value: [{ name: "refs/tags/1.2.0", objectId: "a" }] } })

        await expect(new AzureDevOpsClient().tagExists("pat", "org", "project", "repo", "1.2")).resolves.toBe(false)
    })

    it("given the tag among the refs, when it is looked up, then it exists", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { count: 2, value: [{ name: "refs/tags/1.2" }, { name: "refs/tags/1.2.0" }] } })

        await expect(new AzureDevOpsClient().tagExists("pat", "org", "project", "repo", "1.2")).resolves.toBe(true)
        expect(request.mock.calls[0][0]).toMatchObject({ params: { filter: "tags/1.2" } })
    })

    it("given a tag, when it is looked up, then the refs of the repository are filtered by its name", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { count: 0, value: [] } })

        await expect(new AzureDevOpsClient().tagExists("pat", "org", "project", "repo-id", "1.2")).resolves.toBe(false)
        expect(request).toHaveBeenCalledWith({
            url: "https://dev.azure.com/org/project/_apis/git/repositories/repo-id/refs",
            params: { filter: "tags/1.2", "api-version": "7.1-preview.1" },
            headers: jsonHeaders
        })
    })

    it("given Azure refuses the token, when a tag is looked up, then the failure is passed on rather than read as a missing tag", async () => {
        const failure = answered(401)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().tagExists("pat", "org", "project", "repo", "1.2")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.getTagCommitId", () => {
    it("given an annotated tag, when its commit is read, then the tag is peeled to the commit", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", objectId: "tag-object", peeledObjectId: "commit" }] } })

        await expect(new AzureDevOpsClient().getTagCommitId("pat", "org", "project", "repo-id", "1.2.0")).resolves.toBe("commit")
        expect(request).toHaveBeenCalledWith({
            url: "https://dev.azure.com/org/project/_apis/git/repositories/repo-id/refs",
            params: { filter: "tags/1.2.0", peelTags: true, "api-version": "7.1-preview.1" },
            headers: jsonHeaders
        })
    })

    it("given a lightweight tag, when its commit is read, then it is the object the tag points to", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", objectId: "commit" }] } })

        await expect(new AzureDevOpsClient().getTagCommitId("pat", "org", "project", "repo", "1.2.0")).resolves.toBe("commit")
    })

    /** The refs filter is a prefix: asking for 1.2 lists 1.2.0 too */
    it("given only tags that start with the name, when its commit is read, then there is none", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", objectId: "commit" }] } })

        await expect(new AzureDevOpsClient().getTagCommitId("pat", "org", "project", "repo", "1.2")).resolves.toBeUndefined()
    })
})

describe("AzureDevOpsClient.createTag", () => {
    /** Azure DevOps answers 200 to an update of the refs it refused */
    it("given Azure refuses the ref, when the tag is created, then the refusal is told", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", success: false, updateStatus: "createTagPermissionRequired" }] } })

        const tag = new AzureDevOpsClient().createTag("pat", "org", "project", "repo", "1.2.0", "abc")

        await expect(tag).rejects.toMatchObject({ code: AZURE_DEVOPS_TAG_REFUSED, message: expect.stringContaining("createTagPermissionRequired") })
    })

    it("given Azure creates the ref, when the tag is created, then it resolves", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", success: true, updateStatus: "succeeded" }] } })

        await expect(new AzureDevOpsClient().createTag("pat", "org", "project", "repo", "1.2.0", "abc")).resolves.toBeUndefined()
    })

    it("given a tag, when it is created, then a new ref is posted from the all-zero object to the commit", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", success: true }] } })

        await new AzureDevOpsClient().createTag("pat", "org", "project", "repo-id", "1.2.0", "abc")

        expect(request).toHaveBeenCalledWith({
            method: "POST",
            url: "https://dev.azure.com/org/project/_apis/git/repositories/repo-id/refs?api-version=7.1-preview.1",
            headers: jsonHeaders,
            data: [{ name: "refs/tags/1.2.0", oldObjectId: "0000000000000000000000000000000000000000", newObjectId: "abc" }]
        })
    })

    it("given Azure refuses the ref with a message, when the tag is created, then its message is told over the status", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", success: false, updateStatus: "rejectedByPolicy", customMessage: "Tags are locked" }] } })

        const tag = new AzureDevOpsClient().createTag("pat", "org", "project", "repo", "1.2.0", "abc")

        await expect(tag).rejects.toBeInstanceOf(BusinessException)
        await expect(tag).rejects.toThrow("Azure DevOps refused the tag 1.2.0: Tags are locked")
    })

    it("given Azure refuses the ref without a reason, when the tag is created, then the refusal still is told", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/tags/1.2.0", success: false }] } })

        await expect(new AzureDevOpsClient().createTag("pat", "org", "project", "repo", "1.2.0", "abc")).rejects.toThrow("Azure DevOps refused the tag 1.2.0: no reason given")
    })

    it("given Azure fails the request, when the tag is created, then the failure is passed on unchanged", async () => {
        const failure = answered(409)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().createTag("pat", "org", "project", "repo", "1.2.0", "abc")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.getBranchCommitId", () => {
    /** The heads filter is a prefix: asking for release lists release-2 too */
    it("given only branches that start with the name, when its commit is read, then the branch is not found", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({
            data: {
                count: 2,
                value: [
                    { name: "refs/heads/release-2", objectId: "a" },
                    { name: "refs/heads/main-old", objectId: "b" }
                ]
            }
        })

        const read = new AzureDevOpsClient().getBranchCommitId("pat", "org", "project", "repo", "release")

        await expect(read).rejects.toBeInstanceOf(AzureBranchNotFoundError)
        await expect(read).rejects.toThrow("Branch release not found")
    })

    it("given the branch among those that start with its name, when its commit is read, then it is the exact one", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({
            data: {
                count: 2,
                value: [
                    { name: "refs/heads/main-old", objectId: "b" },
                    { name: "refs/heads/main", objectId: "c" }
                ]
            }
        })

        await expect(new AzureDevOpsClient().getBranchCommitId("pat", "org", "project", "repo", "main")).resolves.toBe("c")
        expect(request.mock.calls[0][0]).toMatchObject({ params: { filter: "heads/main" } })
    })

    it("given a branch, when its commit is read, then the heads of the repository are filtered by its name", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ name: "refs/heads/feature/login", objectId: "c" }] } })

        await expect(new AzureDevOpsClient().getBranchCommitId("pat", "org", "project", "orders", "feature/login")).resolves.toBe("c")
        expect(request).toHaveBeenCalledWith({
            url: "https://dev.azure.com/org/project/_apis/git/repositories/orders/refs",
            params: { filter: "heads/feature/login", "api-version": "7.1-preview.1" },
            headers: jsonHeaders
        })
    })

    it("given Azure answers 404 for the repository, when a branch commit is read, then it is not mistaken for a missing branch", async () => {
        const failure = answered(404)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getBranchCommitId("pat", "org", "project", "repo", "main")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.authorizePipelineVariableGroup", () => {
    it("given the group exists, when a pipeline is authorized, then only that pipeline is permitted on it", async () => {
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({
                data: {
                    value: [
                        { id: 4, name: "OTHER" },
                        { id: 12, name: "GROUP" }
                    ]
                }
            })
            .mockResolvedValueOnce({ data: {} })

        await expect(new AzureDevOpsClient().authorizePipelineVariableGroup("pat", "org", "project", "GROUP", 9)).resolves.toBe(true)

        expect(request.mock.calls[1][0]).toMatchObject({
            method: "PATCH",
            url: "https://dev.azure.com/org/project/_apis/pipelines/pipelinePermissions/variablegroup/12?api-version=7.1-preview.1",
            data: { pipelines: [{ id: 9, authorized: true }] }
        })
    })

    it("given no such group, when a pipeline is authorized, then nothing is permitted", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { value: [{ id: 4, name: "OTHER" }] } })

        await expect(new AzureDevOpsClient().authorizePipelineVariableGroup("pat", "org", "project", "GROUP", 9)).resolves.toBe(false)
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("given the group exists, when a pipeline is authorized, then the groups are read and the permission is patched with the token", async () => {
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { value: [{ id: 12, name: "GROUP" }] } })
            .mockResolvedValueOnce({ data: {} })

        await new AzureDevOpsClient().authorizePipelineVariableGroup("pat", "org", "project", "GROUP", 9)

        expect(request).toHaveBeenNthCalledWith(1, {
            url: "https://dev.azure.com/org/project/_apis/distributedtask/variablegroups?api-version=7.1-preview.2",
            headers: jsonHeaders
        })
        expect(request).toHaveBeenNthCalledWith(2, {
            method: "PATCH",
            url: "https://dev.azure.com/org/project/_apis/pipelines/pipelinePermissions/variablegroup/12?api-version=7.1-preview.1",
            headers: jsonHeaders,
            data: { pipelines: [{ id: 9, authorized: true }] }
        })
    })

    it("given the token cannot read the variable groups, when a pipeline is authorized, then the missing scope is named", async () => {
        const request = vi.spyOn(axios, "request").mockRejectedValue(answered(403))

        await expect(new AzureDevOpsClient().authorizePipelineVariableGroup("pat", "org", "project", "GROUP", 9)).rejects.toMatchObject({ code: AZURE_DEVOPS_VARIABLE_GROUPS_UNAUTHORIZED })
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("given Azure fails the permission, when a pipeline is authorized, then the failure is passed on unchanged", async () => {
        const failure = answered(500)
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { value: [{ id: 12, name: "GROUP" }] } })
            .mockRejectedValueOnce(failure)

        await expect(new AzureDevOpsClient().authorizePipelineVariableGroup("pat", "org", "project", "GROUP", 9)).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient failed job logs", () => {
    it("given a build of another repository of the Azure DevOps project, when its logs are read, then they are refused before its timeline is read", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { repository: { id: "other-repository" } } })

        await expect(new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41")).rejects.toThrow("Build 41 is not a build of this repository")
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("given a build of the repository, when its logs are read, then the log of each failed task comes back", async () => {
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { repository: { id: "orders-repository" } } })
            .mockResolvedValueOnce({
                data: {
                    records: [
                        { name: "Build", type: "Task", result: "failed", log: { id: 7 } },
                        { name: "Test", type: "Task", result: "succeeded", log: { id: 8 } }
                    ]
                }
            })
            .mockResolvedValueOnce({ data: "error TS2322" })

        expect(await new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41")).toEqual([{ name: "Build", log: "error TS2322" }])
    })

    it("given a build, when its logs are read, then the build, its timeline and each failed log are asked for under the encoded build id", async () => {
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { repository: { id: "orders-repository" } } })
            .mockResolvedValueOnce({ data: { records: [{ name: "Build", type: "Task", result: "failed", log: { id: 7 } }] } })
            .mockResolvedValueOnce({ data: "error" })
        const base = "https://dev.azure.com/org/project/_apis/build/builds/41%2F2"

        await new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41/2")

        expect(request).toHaveBeenCalledTimes(3)
        expect(request).toHaveBeenNthCalledWith(1, { url: `${base}?api-version=7.1`, headers: { Authorization: "Bearer pat" } })
        expect(request).toHaveBeenNthCalledWith(2, { url: `${base}/timeline?api-version=7.1`, headers: { Authorization: "Bearer pat" } })
        expect(request).toHaveBeenNthCalledWith(3, {
            url: `${base}/logs/7?api-version=7.1`,
            headers: { Authorization: "Bearer pat", Accept: "text/plain" },
            responseType: "text",
            maxContentLength: MAX_FAILED_JOB_LOG_BYTES
        })
    })

    it("given failed records that are not tasks or wrote no log, when the logs are read, then only failed tasks with a log are fetched", async () => {
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { repository: { id: "orders-repository" } } })
            .mockResolvedValueOnce({
                data: {
                    records: [
                        { name: "Job", type: "Job", result: "failed", log: { id: 1 } },
                        { name: "Checkout", type: "Task", result: "failed" },
                        { name: "Lint", type: "Task", result: "canceled", log: { id: 2 } },
                        { name: "Test", type: "Task", result: "failed", log: { id: 3 } }
                    ]
                }
            })
            .mockResolvedValueOnce({ data: "1 test failed" })

        expect(await new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41")).toEqual([{ name: "Test", log: "1 test failed" }])
        expect(request).toHaveBeenCalledTimes(3)
        expect(request.mock.calls[2][0]).toMatchObject({ url: expect.stringContaining("/logs/3?") })
    })

    it("given more failed tasks than are kept, when the logs are read, then only the first ones are fetched", async () => {
        const records = Array.from({ length: MAX_FAILED_JOBS + 2 }, (_, index) => ({ name: `Task ${index}`, type: "Task", result: "failed", log: { id: index } }))
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { repository: { id: "orders-repository" } } })
            .mockResolvedValueOnce({ data: { records } })
            .mockResolvedValue({ data: "failed" })

        const logs = await new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41")

        expect(logs.map(log => log.name)).toEqual(records.slice(0, MAX_FAILED_JOBS).map(record => record.name))
        expect(request).toHaveBeenCalledTimes(2 + MAX_FAILED_JOBS)
    })

    it("given a build without a repository, when its logs are read, then they are refused", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: {} })

        await expect(new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41")).rejects.toThrow("Build 41 is not a build of this repository")
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("given a timeline without records, when the logs are read, then there are none", async () => {
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { repository: { id: "orders-repository" } } })
            .mockResolvedValueOnce({ data: {} })

        await expect(new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41")).resolves.toEqual([])
    })

    it("given a log Azure fails to send, when the logs are read, then the failure is passed on", async () => {
        const failure = answered(500)
        vi.spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { repository: { id: "orders-repository" } } })
            .mockResolvedValueOnce({ data: { records: [{ name: "Build", type: "Task", result: "failed", log: { id: 7 } }] } })
            .mockRejectedValueOnce(failure)

        await expect(new AzureDevOpsClient().getFailedJobLogs("pat", "org", "project", "orders-repository", "41")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient profile and organizations", () => {
    it("given a token, when the user id is read, then the profile of the token's owner is asked for", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { id: "user-1", displayName: "Ada" } })

        await expect(new AzureDevOpsClient().getUserId("pat")).resolves.toBe("user-1")
        expect(request).toHaveBeenCalledWith({ url: "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.3", headers: jsonHeaders })
    })

    it("given a token, when the organizations are listed, then the accounts its owner is a member of come back", async () => {
        const accounts = [{ accountId: "a1", accountName: "org", accountUri: "https://org.vssps.visualstudio.com/", properties: {} }]
        const request = vi
            .spyOn(axios, "request")
            .mockResolvedValueOnce({ data: { id: "user-1" } })
            .mockResolvedValueOnce({ data: { count: 1, value: accounts } })

        await expect(new AzureDevOpsClient().getOrganizations("pat")).resolves.toEqual(accounts)
        expect(request).toHaveBeenCalledTimes(2)
        expect(request).toHaveBeenNthCalledWith(2, { url: "https://app.vssps.visualstudio.com/_apis/accounts?memberId=user-1&api-version=7.1-preview.1", headers: jsonHeaders })
    })

    it("given the profile cannot be read, when the organizations are listed, then the accounts are not asked for", async () => {
        const failure = answered(401)
        const request = vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getOrganizations("pat")).rejects.toBe(failure)
        expect(request).toHaveBeenCalledTimes(1)
    })
})

describe("AzureDevOpsClient.getProjects", () => {
    it("given an organization, when its projects are listed, then Azure's answer comes back as is", async () => {
        const projects = { count: 1, value: [{ id: "p1", name: "Orders", url: "u", state: "wellFormed", revision: 1, visibility: "private", lastUpdateTime: "t" }] }
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: projects })

        await expect(new AzureDevOpsClient().getProjects("pat", "org")).resolves.toEqual(projects)
        expect(request).toHaveBeenCalledWith({ url: "https://dev.azure.com/org/_apis/projects?api-version=7.1-preview.4", headers: jsonHeaders })
    })

    it("given Azure cannot be reached, when the projects are listed, then the network error is passed on unchanged", async () => {
        const failure = unreachable()
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getProjects("pat", "org")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient repositories", () => {
    const repository = { id: "repo-id", name: "orders", defaultBranch: "refs/heads/main" }

    it("given a project, when its repositories are listed, then Azure's answer comes back as is", async () => {
        const repositories = { count: 1, value: [repository] }
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: repositories })

        await expect(new AzureDevOpsClient().getRepositories("pat", "org", "project-id")).resolves.toEqual(repositories)
        expect(request).toHaveBeenCalledWith({ url: "https://dev.azure.com/org/project-id/_apis/git/repositories?api-version=7.1-preview.1", headers: jsonHeaders })
    })

    it("given a name, when a repository is created, then it is posted into the project and the created repository comes back", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: repository })

        await expect(new AzureDevOpsClient().createRepository("pat", "org", "project-id", "orders")).resolves.toEqual(repository)
        expect(request).toHaveBeenCalledWith({
            method: "POST",
            url: "https://dev.azure.com/org/project-id/_apis/git/repositories?api-version=7.1-preview.1",
            headers: jsonHeaders,
            data: { name: "orders", project: { id: "project-id" } }
        })
    })

    it("given a repository name, when the repository is read, then it is asked for by that name", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: repository })

        await expect(new AzureDevOpsClient().getRepository("pat", "org", "project-id", "orders")).resolves.toEqual(repository)
        expect(request).toHaveBeenCalledWith({ url: "https://dev.azure.com/org/project-id/_apis/git/repositories/orders?api-version=7.1-preview.1", headers: jsonHeaders })
    })

    /** Callers tell a missing repository from a refused token by the status */
    it("given Azure answers 404, when a repository is read, then the error keeps its status", async () => {
        const failure = answered(404)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        const read = new AzureDevOpsClient().getRepository("pat", "org", "project-id", "missing")

        await expect(read).rejects.toBe(failure)
        await expect(read).rejects.toMatchObject({ response: { status: 404 } })
    })

    it("given a new name, when a repository is renamed, then only the name is patched on the repository id", async () => {
        const renamed = { ...repository, name: "orders-be" }
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: renamed })

        await expect(new AzureDevOpsClient().renameRepository("pat", "org", "project-id", "repo-id", "orders-be")).resolves.toEqual(renamed)
        expect(request).toHaveBeenCalledWith({
            method: "PATCH",
            url: "https://dev.azure.com/org/project-id/_apis/git/repositories/repo-id?api-version=7.1-preview.1",
            headers: jsonHeaders,
            data: { name: "orders-be" }
        })
    })

    it("given Azure refuses the new name, when a repository is renamed, then the failure is passed on unchanged", async () => {
        const failure = answered(409)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().renameRepository("pat", "org", "project-id", "repo-id", "taken")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.getBranches", () => {
    it("given a repository, when its branches are listed, then only the heads are asked for and Azure's answer comes back as is", async () => {
        const branches = { count: 1, value: [{ name: "refs/heads/main", objectId: "c" }] }
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: branches })

        await expect(new AzureDevOpsClient().getBranches("pat", "org", "project-id", "orders")).resolves.toEqual(branches)
        expect(request).toHaveBeenCalledWith({ url: "https://dev.azure.com/org/project-id/_apis/git/repositories/orders/refs?filter=heads/&api-version=7.1-preview.1", headers: jsonHeaders })
    })

    it("given Azure answers 404, when the branches are listed, then the failure is passed on unchanged", async () => {
        const failure = answered(404)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getBranches("pat", "org", "project-id", "missing")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.getBuilds", () => {
    it("given a repository, when its builds are read, then the newest Azure Repos builds of that repository come back, capped at the given number", async () => {
        const builds = [{ id: 2, status: "completed", result: "succeeded" }, { id: 1 }]
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { count: 2, value: builds } })

        await expect(new AzureDevOpsClient().getBuilds("pat", "org", "project-id", "repo id/1", 10)).resolves.toEqual(builds)
        expect(request).toHaveBeenCalledWith({
            url: "https://dev.azure.com/org/project-id/_apis/build/builds?repositoryId=repo%20id%2F1&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=10&api-version=7.1",
            headers: jsonHeaders
        })
    })

    it("given an answer without builds, when the builds are read, then there are none", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { count: 0 } })

        await expect(new AzureDevOpsClient().getBuilds("pat", "org", "project-id", "repo-id", 10)).resolves.toEqual([])
    })

    it("given Azure fails, when the builds are read, then the failure is passed on unchanged", async () => {
        const failure = answered(503)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getBuilds("pat", "org", "project-id", "repo-id", 10)).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.createPipeline", () => {
    const pipeline = { id: 9, name: "orders-ci", folder: "\\", revision: 1 }

    it("given no YAML path nor folder, when a pipeline is created, then it runs azure-pipelines.yml from the root folder", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: pipeline })

        await expect(new AzureDevOpsClient().createPipeline("pat", "org", "project-id", "repo-id", "orders-ci")).resolves.toEqual(pipeline)
        expect(request).toHaveBeenCalledWith({
            method: "POST",
            url: "https://dev.azure.com/org/project-id/_apis/pipelines?api-version=7.1-preview.1",
            headers: jsonHeaders,
            data: {
                name: "orders-ci",
                folder: "/",
                configuration: { type: "yaml", path: "azure-pipelines.yml", repository: { id: "repo-id", type: "azureReposGit" } }
            }
        })
    })

    it("given a YAML path and a folder, when a pipeline is created, then it runs that file and is kept in that folder", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: pipeline })

        await new AzureDevOpsClient().createPipeline("pat", "org", "project-id", "repo-id", "orders-ci", ".pipelines/build.yml", "/orders")

        expect(request.mock.calls[0][0]).toMatchObject({ data: { folder: "/orders", configuration: { path: ".pipelines/build.yml" } } })
    })

    it("given Azure refuses the pipeline, when it is created, then the failure is passed on unchanged", async () => {
        const failure = answered(400)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().createPipeline("pat", "org", "project-id", "repo-id", "orders-ci")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.getFileContent", () => {
    it("given a relative path, when a file is read, then its content on the branch is asked for from the repository root", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { objectId: "o", path: "/src/index.ts", content: "export {}" } })

        await expect(new AzureDevOpsClient().getFileContent("pat", "org", "project-id", "repo-id", "src/index.ts", "main")).resolves.toBe("export {}")
        expect(request).toHaveBeenCalledWith({
            url: "https://dev.azure.com/org/project-id/_apis/git/repositories/repo-id/items?api-version=7.1-preview.1",
            params: {
                path: "/src/index.ts",
                includeContent: true,
                "versionDescriptor.version": "main",
                "versionDescriptor.versionType": "branch",
                $format: "json"
            },
            headers: { Authorization: "Bearer pat", Accept: "application/json" }
        })
    })

    it("given an absolute path, when a file is read, then the path is kept as is", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { content: "" } })

        await expect(new AzureDevOpsClient().getFileContent("pat", "org", "project-id", "repo-id", "/package.json", "main")).resolves.toBe("")
        expect(request.mock.calls[0][0]).toMatchObject({ params: { path: "/package.json" } })
    })

    it("given an item without content, when a file is read, then there is none", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { objectId: "o", path: "/src" } })

        await expect(new AzureDevOpsClient().getFileContent("pat", "org", "project-id", "repo-id", "src", "main")).resolves.toBeNull()
    })

    /** Azure answers 400 when the branch of the version descriptor does not exist */
    it.each([404, 400])("given Azure answers %i, when a file is read, then the file does not exist", async status => {
        vi.spyOn(axios, "request").mockRejectedValue(answered(status))

        await expect(new AzureDevOpsClient().getFileContent("pat", "org", "project-id", "repo-id", "missing.ts", "main")).resolves.toBeNull()
    })

    it.each([401, 500])("given Azure answers %i, when a file is read, then the failure is passed on rather than read as a missing file", async status => {
        const failure = answered(status)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getFileContent("pat", "org", "project-id", "repo-id", "src/index.ts", "main")).rejects.toBe(failure)
    })

    it("given Azure cannot be reached, when a file is read, then the network error is passed on rather than read as a missing file", async () => {
        const failure = unreachable()
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getFileContent("pat", "org", "project-id", "repo-id", "src/index.ts", "main")).rejects.toBe(failure)
    })

    it("given a failure that is not an HTTP one, when a file is read, then it is passed on unchanged", async () => {
        const failure = new TypeError("boom")
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().getFileContent("pat", "org", "project-id", "repo-id", "src/index.ts", "main")).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.createPullRequest", () => {
    const pullRequest = { sourceBranch: "flightroom/fix", targetBranch: "main", title: "Fix the build", description: "Bumps the compiler" }

    it("given two branches, when a pull request is opened, then it is posted between their heads", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { pullRequestId: 7, repository: { name: "orders", project: { name: "Shop" } } } })

        await new AzureDevOpsClient().createPullRequest("pat", "org", "project-id", "orders", pullRequest)

        expect(request).toHaveBeenCalledWith({
            method: "POST",
            url: "https://dev.azure.com/org/project-id/_apis/git/repositories/orders/pullrequests?api-version=7.1",
            headers: jsonHeaders,
            data: { sourceRefName: "refs/heads/flightroom/fix", targetRefName: "refs/heads/main", title: "Fix the build", description: "Bumps the compiler" }
        })
    })

    it("given the pull request is opened, when its link is built, then the project and repository names Azure answered are encoded into it", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: { pullRequestId: 7, repository: { name: "orders api", project: { name: "Shop & Co" } } } })

        await expect(new AzureDevOpsClient().createPullRequest("pat", "org", "project-id", "repo-id", pullRequest)).resolves.toBe(
            "https://dev.azure.com/org/Shop%20%26%20Co/_git/orders%20api/pullrequest/7"
        )
    })

    it("given a description longer than Azure accepts, when a pull request is opened, then it is cut at 4000 characters", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { pullRequestId: 7, repository: { name: "orders", project: { name: "Shop" } } } })

        await new AzureDevOpsClient().createPullRequest("pat", "org", "project-id", "orders", { ...pullRequest, description: "a".repeat(4001) })

        expect(request.mock.calls[0][0]).toMatchObject({ data: { description: "a".repeat(4000) } })
    })

    it("given Azure refuses the pull request, when it is opened, then the failure is passed on unchanged", async () => {
        const failure = answered(409)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().createPullRequest("pat", "org", "project-id", "orders", pullRequest)).rejects.toBe(failure)
    })
})

describe("AzureDevOpsClient.pushFileEdit", () => {
    const edit = { branchName: "flightroom/fix", baseCommitId: "base", filePath: "src/index.ts", content: "export {}", comment: "Fix the build" }

    it("given a file change, when it is pushed, then one commit editing the file is pushed onto the branch from its base commit", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: {} })

        await expect(new AzureDevOpsClient().pushFileEdit("pat", "org", "project-id", "repo-id", edit)).resolves.toBeUndefined()
        expect(request).toHaveBeenCalledWith({
            method: "POST",
            url: "https://dev.azure.com/org/project-id/_apis/git/repositories/repo-id/pushes?api-version=7.1-preview.2",
            headers: jsonHeaders,
            data: {
                refUpdates: [{ name: "refs/heads/flightroom/fix", oldObjectId: "base" }],
                commits: [
                    {
                        comment: "Fix the build",
                        changes: [{ changeType: "edit", item: { path: "/src/index.ts" }, newContent: { content: "export {}", contentType: "rawtext" } }]
                    }
                ]
            }
        })
    })

    it("given a new file at an absolute path, when it is pushed, then it is added at that path", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: {} })

        await new AzureDevOpsClient().pushFileEdit("pat", "org", "project-id", "repo-id", { ...edit, filePath: "/docs/README.md", changeType: "add" })

        expect(request.mock.calls[0][0]).toMatchObject({ data: { commits: [{ changes: [{ changeType: "add", item: { path: "/docs/README.md" } }] }] } })
    })

    /** Azure answers 409 when the branch moved past the base commit */
    it("given Azure refuses the push, when it is pushed, then the failure is passed on unchanged", async () => {
        const failure = answered(409)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new AzureDevOpsClient().pushFileEdit("pat", "org", "project-id", "repo-id", edit)).rejects.toBe(failure)
    })
})
