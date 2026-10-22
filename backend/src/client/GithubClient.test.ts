import axios, { AxiosError, AxiosHeaders } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import GithubClient from "./GithubClient"

const answered = (status: number) =>
    new AxiosError("Request failed", String(status), undefined, undefined, {
        status,
        statusText: "",
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() }
    })

afterEach(() => {
    vi.restoreAllMocks()
})

describe("GithubClient.tagExists", () => {
    it("given the tag, when it is looked up, then it exists, read by its exact ref", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { ref: "refs/tags/1.2.0", object: { sha: "a" } } })

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2.0", undefined, "acme")).resolves.toBe(true)
        expect(request.mock.calls[0][0]).toMatchObject({ url: "https://api.github.com/repos/acme/cart-fe/git/ref/tags/1.2.0" })
    })

    /** An answer in a list holds the refs that only start with the name */
    it("given GitHub answers a list of refs, when the tag is looked up, then it does not exist", async () => {
        vi.spyOn(axios, "request").mockResolvedValue({ data: [{ ref: "refs/tags/1.2.0" }, { ref: "refs/tags/1.2.0-rc" }] })

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2", undefined, "acme")).resolves.toBe(false)
    })

    it("given GitHub answers 404, when the tag is looked up, then it does not exist", async () => {
        vi.spyOn(axios, "request").mockRejectedValue(answered(404))

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2.0", "acme")).resolves.toBe(false)
    })

    it("given any other failure, when the tag is looked up, then it is passed on", async () => {
        const failure = answered(401)
        vi.spyOn(axios, "request").mockRejectedValue(failure)

        await expect(new GithubClient().tagExists("token", "cart-fe", "1.2.0", "acme")).rejects.toBe(failure)
    })
})

describe("GithubClient.getBranchCommitSha", () => {
    it("given a branch with a slash, when its commit is read, then the name is one encoded path segment", async () => {
        const request = vi.spyOn(axios, "request").mockResolvedValue({ data: { commit: { sha: "abc" } } })

        await expect(new GithubClient().getBranchCommitSha("token", "cart-fe", "release/1.4", undefined, "acme")).resolves.toBe("abc")
        expect(request.mock.calls[0][0]).toMatchObject({ url: "https://api.github.com/repos/acme/cart-fe/branches/release%2F1.4" })
    })
})
