import https from "node:https"
import axios, { CreateAxiosDefaults } from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import ArgoCdClient from "./ArgoCdClient"

/** The configuration the client created its axios instance with */
const configOf = (...options: ConstructorParameters<typeof ArgoCdClient>[2][]) => {
    const create = vi.spyOn(axios, "create").mockReturnValue({} as never)
    new ArgoCdClient("https://argocd.example.com", "token", ...options)
    return create.mock.calls[0][0] as CreateAxiosDefaults
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("ArgoCdClient", () => {
    it("given no option, when it is created, then the certificate is verified by Node", () => {
        expect(configOf().httpsAgent).toBeUndefined()
    })

    it("given insecure, when it is created, then any certificate is accepted, a self-signed one included", () => {
        const agent = configOf({ insecure: true }).httpsAgent

        expect(agent).toBeInstanceOf(https.Agent)
        expect((agent as https.Agent).options.rejectUnauthorized).toBe(false)
    })
})

/** A client whose axios instance answers every GET with `get` */
const clientAnswering = (get: ReturnType<typeof vi.fn>) => {
    vi.spyOn(axios, "create").mockReturnValue({ get } as never)
    return new ArgoCdClient("https://argocd.example.com", "token")
}

describe("ArgoCdClient.listPods", () => {
    it("given a resource tree, when the pods are listed, then only the pods come back with their state", async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                nodes: [
                    { kind: "Deployment", name: "orders", namespace: "dev" },
                    {
                        kind: "Pod",
                        name: "orders-7d9f-abcde",
                        namespace: "dev",
                        health: { status: "Healthy" },
                        info: [
                            { name: "Status Reason", value: "Running" },
                            { name: "Containers", value: "1/1" },
                            { name: "Restart Count", value: "2" }
                        ],
                        createdAt: "2026-10-27T10:00:00Z"
                    }
                ]
            }
        })

        const pods = await clientAnswering(get).listPods("mfe-app", "mfe-project")

        expect(get).toHaveBeenCalledWith("/applications/mfe-app/resource-tree", { params: { project: "mfe-project" } })
        expect(pods).toEqual([{ name: "orders-7d9f-abcde", namespace: "dev", health: "Healthy", status: "Running", containers: "1/1", restarts: 2, createdAt: "2026-10-27T10:00:00Z" }])
    })

    it("given an Application not there yet, when the pods are listed, then none come back", async () => {
        const get = vi.fn().mockRejectedValue(Object.assign(new axios.AxiosError("not found"), { response: { status: 404 } }))

        await expect(clientAnswering(get).listPods("mfe-app", "mfe-project")).resolves.toEqual([])
    })
})

describe("ArgoCdClient.getPodLogs", () => {
    const query = { namespace: "dev", podName: "orders-7d9f-abcde", tailLines: 100 }

    it("given a stream of JSON lines, when the logs are read, then every line but the last marker comes back in order", async () => {
        const get = vi.fn().mockResolvedValue({
            data: [
                JSON.stringify({ result: { content: "started", timeStamp: "2026-10-27T10:00:00Z" } }),
                JSON.stringify({ result: { content: "listening on 8080" } }),
                JSON.stringify({ result: { content: "", last: true } }),
                ""
            ].join("\n")
        })

        const lines = await clientAnswering(get).getPodLogs("mfe-app", "mfe-project", query)

        expect(get).toHaveBeenCalledWith("/applications/mfe-app/logs", { params: { ...query, project: "mfe-project", follow: false }, responseType: "text" })
        expect(lines).toEqual([{ content: "started", timestamp: "2026-10-27T10:00:00Z" }, { content: "listening on 8080" }])
    })

    it("given an error in the stream, when the logs are read, then it fails with what Argo CD said", async () => {
        const get = vi.fn().mockResolvedValue({ data: JSON.stringify({ error: { message: "previous terminated container not found" } }) })

        await expect(clientAnswering(get).getPodLogs("mfe-app", "mfe-project", { ...query, previous: true })).rejects.toMatchObject({
            code: "ARGOCD_REQUEST_FAILED",
            message: expect.stringContaining("previous terminated container not found")
        })
    })
})
