import axios, { AxiosError, AxiosHeaders } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BusinessException } from "../errors/BusinessException"
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
})
