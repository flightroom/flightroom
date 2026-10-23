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
