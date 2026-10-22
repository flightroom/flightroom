import axios, { AxiosError, AxiosHeaders } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import GitlabClient from "./GitlabClient"

const answered = (status: number) =>
    new AxiosError("Request failed", String(status), undefined, undefined, {
        status,
        statusText: "",
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() }
    })

/** A client whose requests go to `get` */
const clientAnswering = (get: ReturnType<typeof vi.fn>) => {
    vi.spyOn(axios, "create").mockReturnValue({ get } as never)
    return new GitlabClient("https://gitlab.example", "token")
}

afterEach(() => {
    vi.restoreAllMocks()
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
})

describe("GitlabClient.getBranchCommitSha", () => {
    it("given a branch with a slash, when its commit is read, then the name is one encoded path segment", async () => {
        const get = vi.fn().mockResolvedValue({ data: { commit: { id: "abc" } } })

        await expect(clientAnswering(get).getBranchCommitSha(42, "release/1.4")).resolves.toBe("abc")
        expect(get).toHaveBeenCalledWith("/projects/42/repository/branches/release%2F1.4")
    })
})
