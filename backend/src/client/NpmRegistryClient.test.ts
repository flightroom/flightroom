import axios from "axios"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type NpmRegistryClient from "./NpmRegistryClient"

/**
 * The client caches every answer in a map of its module for an hour: each test loads the module afresh,
 * so no answer of one test is served to another. TypeScript types the dynamic import of a CommonJS build,
 * where the class would sit one `default` deeper; vitest loads the source, where it does not.
 */
const loadClient = async () => {
    vi.resetModules()
    return ((await import("./NpmRegistryClient.js")) as unknown as { default: typeof NpmRegistryClient }).default
}

/** What axios answers to every request the client sends */
const registryAnswering = (data: unknown) => vi.spyOn(axios, "request").mockResolvedValue({ data })

/** The URL of the n-th request the client sent */
const urlOf = (request: ReturnType<typeof registryAnswering>, n = 0) => (request.mock.calls[n][0] as { url: string }).url

const httpError = (status: number) => Object.assign(new axios.AxiosError(`Request failed with status code ${status}`), { response: { status } })

beforeEach(() => {
    vi.stubEnv("NPM_REGISTRY_URL", "")
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.useRealTimers()
})

describe("NpmRegistryClient registry URL", () => {
    it("given no registry, when a package is looked up, then the public registry is asked for its abbreviated metadata", async () => {
        const Client = await loadClient()
        const request = registryAnswering({ name: "react" })

        await new Client().getPackageInfo("react")

        expect(request).toHaveBeenCalledWith({
            url: "https://registry.npmjs.org/react",
            timeout: 10_000,
            headers: { Accept: "application/vnd.npm.install-v1+json", "User-Agent": "Flightroom" }
        })
    })

    it("given a scoped package, when it is looked up, then the slash is escaped and the leading @ kept", async () => {
        const Client = await loadClient()
        const request = registryAnswering({ name: "@scope/name" })

        await new Client().getPackageInfo("@scope/name")

        expect(urlOf(request)).toBe("https://registry.npmjs.org/@scope%2Fname")
    })

    /** Otherwise the name could climb out of the package path, or add a query to it */
    it("given a name holding path and query characters, when it is looked up, then they stay inside one path segment", async () => {
        const Client = await loadClient()
        const request = registryAnswering({})

        await new Client().getPackageInfo("@scope/../../-/whoami?x=1#y")

        expect(urlOf(request)).toBe("https://registry.npmjs.org/@scope%2F..%2F..%2F-%2Fwhoami%3Fx%3D1%23y")
    })

    it("given a registry with trailing slashes, when a package is looked up, then that registry is asked without a double slash", async () => {
        const Client = await loadClient()
        const request = registryAnswering({ name: "react" })

        await new Client("https://npm.example.com/repository/npm-group//").getPackageInfo("react")

        expect(urlOf(request)).toBe("https://npm.example.com/repository/npm-group/react")
    })

    it("given NPM_REGISTRY_URL and no registry, when a package is looked up, then the registry of the environment is asked", async () => {
        vi.stubEnv("NPM_REGISTRY_URL", "https://mirror.example.com/")
        const Client = await loadClient()
        const request = registryAnswering({ name: "react" })

        await new Client().getPackageInfo("react")

        expect(urlOf(request)).toBe("https://mirror.example.com/react")
    })

    it("given both NPM_REGISTRY_URL and a registry, when a package is looked up, then the registry given wins", async () => {
        vi.stubEnv("NPM_REGISTRY_URL", "https://mirror.example.com")
        const Client = await loadClient()
        const request = registryAnswering({ name: "react" })

        await new Client("https://npm.example.com").getPackageInfo("react")

        expect(urlOf(request)).toBe("https://npm.example.com/react")
    })
})

describe("NpmRegistryClient.getPackageInfo", () => {
    it("given a package with a latest tag, when it is looked up, then its name, latest version and modification date come back", async () => {
        const Client = await loadClient()
        registryAnswering({
            name: "react",
            "dist-tags": { latest: "19.2.0", next: "19.3.0-canary" },
            modified: "2026-10-01T12:00:00.000Z",
            versions: { "19.2.0": {}, "19.3.0-canary": {} }
        })

        expect(await new Client().getPackageInfo("react")).toEqual({ name: "react", latest: "19.2.0", deprecated: false, modifiedAt: "2026-10-01T12:00:00.000Z" })
    })

    it("given a latest version that is deprecated, when the package is looked up, then it comes back deprecated", async () => {
        const Client = await loadClient()
        registryAnswering({ name: "request", "dist-tags": { latest: "2.88.2" }, versions: { "2.88.2": { deprecated: "request has been deprecated" } } })

        expect(await new Client().getPackageInfo("request")).toMatchObject({ latest: "2.88.2", deprecated: true })
    })

    it("given only an older version deprecated, when the package is looked up, then it does not come back deprecated", async () => {
        const Client = await loadClient()
        registryAnswering({ name: "lodash", "dist-tags": { latest: "4.17.21" }, versions: { "4.17.20": { deprecated: "upgrade" }, "4.17.21": {} } })

        expect(await new Client().getPackageInfo("lodash")).toMatchObject({ latest: "4.17.21", deprecated: false })
    })

    it("given a latest tag pointing at a version missing from the list, when the package is looked up, then it does not come back deprecated", async () => {
        const Client = await loadClient()
        registryAnswering({ name: "odd", "dist-tags": { latest: "1.0.0" } })

        expect(await new Client().getPackageInfo("odd")).toMatchObject({ latest: "1.0.0", deprecated: false })
    })

    it("given a package with no dist-tags, when it is looked up, then it has no latest version and is not deprecated", async () => {
        const Client = await loadClient()
        registryAnswering({ name: "unpublished", versions: { "1.0.0": { deprecated: "gone" } } })

        expect(await new Client().getPackageInfo("unpublished")).toEqual({ name: "unpublished", latest: undefined, deprecated: false, modifiedAt: undefined })
    })

    it("given an answer without a name, when the package is looked up, then the name asked for comes back", async () => {
        const Client = await loadClient()
        registryAnswering({ "dist-tags": { latest: "1.0.0" } })

        expect(await new Client().getPackageInfo("@scope/name")).toMatchObject({ name: "@scope/name", latest: "1.0.0" })
    })

    it.each([
        ["a package the registry does not know (404)", httpError(404)],
        ["a registry failing (500)", httpError(500)],
        ["a private package without a token (401)", httpError(401)],
        ["no network", Object.assign(new axios.AxiosError("getaddrinfo ENOTFOUND registry.npmjs.org"), { code: "ENOTFOUND" })],
        ["a request that times out", Object.assign(new axios.AxiosError("timeout of 10000ms exceeded"), { code: "ECONNABORTED" })]
    ])("given %s, when the package is looked up, then null comes back instead of an error", async (_case, error) => {
        const Client = await loadClient()
        vi.spyOn(axios, "request").mockRejectedValue(error)

        await expect(new Client().getPackageInfo("react")).resolves.toBeNull()
    })
})

describe("NpmRegistryClient cache", () => {
    it("given a package looked up once, when it is looked up again within the hour, then the registry is not asked twice", async () => {
        const Client = await loadClient()
        const request = registryAnswering({ name: "react", "dist-tags": { latest: "19.2.0" } })

        await new Client().getPackageInfo("react")
        const again = await new Client().getPackageInfo("react")

        expect(request).toHaveBeenCalledTimes(1)
        expect(again).toMatchObject({ latest: "19.2.0" })
    })

    it("given a package the registry did not know, when it is looked up again within the hour, then null comes back without asking again", async () => {
        const Client = await loadClient()
        const request = vi.spyOn(axios, "request").mockRejectedValue(httpError(404))

        await new Client().getPackageInfo("ghost")

        await expect(new Client().getPackageInfo("ghost")).resolves.toBeNull()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it("given a package looked up an hour ago, when it is looked up again, then the registry is asked again", async () => {
        vi.useFakeTimers()
        const Client = await loadClient()
        const request = registryAnswering({ name: "react", "dist-tags": { latest: "19.2.0" } })
        const client = new Client()

        await client.getPackageInfo("react")
        vi.advanceTimersByTime(60 * 60 * 1000 - 1)
        await client.getPackageInfo("react")
        expect(request).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(1)
        request.mockResolvedValue({ data: { name: "react", "dist-tags": { latest: "19.3.0" } } })

        expect(await client.getPackageInfo("react")).toMatchObject({ latest: "19.3.0" })
        expect(request).toHaveBeenCalledTimes(2)
    })

    it("given a package looked up on one registry, when it is looked up on another, then the other registry is asked", async () => {
        const Client = await loadClient()
        const request = registryAnswering({ name: "react" })

        await new Client("https://registry.npmjs.org").getPackageInfo("react")
        await new Client("https://npm.example.com").getPackageInfo("react")

        expect(request).toHaveBeenCalledTimes(2)
        expect(urlOf(request, 1)).toBe("https://npm.example.com/react")
    })
})

/** Lets every request that can start, start */
const settle = () => new Promise(resolve => setImmediate(resolve))

/** A registry that answers each request only when the test says so */
const heldRegistry = () => {
    const held: (() => void)[] = []
    const request = vi.spyOn(axios, "request").mockImplementation(
        config =>
            new Promise(resolve => {
                const name = decodeURIComponent((config.url as string).split("/").pop() as string)
                held.push(() => resolve({ data: { name, "dist-tags": { latest: "1.0.0" } } }))
            })
    )
    return { request, answerNext: () => held.shift()?.() }
}

describe("NpmRegistryClient.getPackagesInfo", () => {
    it("given names with duplicates and unknown packages, when they are resolved, then each name is asked once and only the known ones come back", async () => {
        const Client = await loadClient()
        const request = vi.spyOn(axios, "request").mockImplementation(async config => {
            if ((config.url as string).endsWith("/ghost")) throw httpError(404)
            return { data: { name: (config.url as string).split("/").pop(), "dist-tags": { latest: "1.0.0" } } }
        })

        const result = await new Client().getPackagesInfo(["react", "ghost", "react", "vite"])

        expect(request).toHaveBeenCalledTimes(3)
        expect([...result.keys()].sort()).toEqual(["react", "vite"])
        expect(result.get("vite")).toEqual({ name: "vite", latest: "1.0.0", deprecated: false, modifiedAt: undefined })
    })

    it("given no names, when they are resolved, then the registry is not asked", async () => {
        const Client = await loadClient()
        const request = registryAnswering({})

        expect((await new Client().getPackagesInfo([])).size).toBe(0)
        expect(request).not.toHaveBeenCalled()
    })

    it("given more names than the concurrency, when they are resolved, then no more requests than the concurrency are in flight", async () => {
        const Client = await loadClient()
        const { request, answerNext } = heldRegistry()

        const resolving = new Client().getPackagesInfo(["a", "b", "c", "d", "e"], 2)
        await settle()
        expect(request).toHaveBeenCalledTimes(2)

        answerNext()
        await settle()
        expect(request).toHaveBeenCalledTimes(3)

        for (let answered = 0; answered < 4; answered++) {
            answerNext()
            await settle()
        }

        expect([...(await resolving).keys()].sort()).toEqual(["a", "b", "c", "d", "e"])
        expect(request).toHaveBeenCalledTimes(5)
    })

    it("given no concurrency, when many names are resolved, then eight requests at most are in flight", async () => {
        const Client = await loadClient()
        const { request, answerNext } = heldRegistry()
        const names = Array.from({ length: 10 }, (_, i) => `pkg-${i}`)

        const resolving = new Client().getPackagesInfo(names)
        await settle()
        expect(request).toHaveBeenCalledTimes(8)

        for (let answered = 0; answered < names.length; answered++) {
            answerNext()
            await settle()
        }

        expect((await resolving).size).toBe(10)
    })
})
