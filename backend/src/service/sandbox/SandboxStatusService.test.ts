import { describe, expect, it, vi } from "vitest"
import { probeGateway, sandboxGatewayStatus } from "./SandboxStatusService"

describe("probeGateway", () => {
    it("given a healthy gateway, when it is probed, then it is online with its version", async () => {
        await expect(probeGateway(async () => ({ status: "healthy", version: "0.4.1" }))).resolves.toMatchObject({ status: "online", version: "0.4.1" })
    })

    it("given a gateway that says it is degraded or unhealthy, when it is probed, then it is degraded or offline", async () => {
        await expect(probeGateway(async () => ({ status: "degraded", version: "" }))).resolves.toMatchObject({ status: "degraded", version: undefined })
        await expect(probeGateway(async () => ({ status: "unhealthy", version: "0.4.1" }))).resolves.toMatchObject({ status: "offline" })
    })

    it("given a gateway that refuses the call, when it is probed, then it is offline and the error is handed over", async () => {
        const onError = vi.fn()
        const refused = new Error("connect ECONNREFUSED")

        await expect(
            probeGateway(async () => {
                throw refused
            }, onError)
        ).resolves.toMatchObject({ status: "offline" })
        expect(onError).toHaveBeenCalledWith(refused)
    })

    it("given a gateway that never answers, when it is probed, then it is offline once the timeout passes", async () => {
        const onError = vi.fn()
        const never = () => new Promise<never>(() => undefined)

        await expect(probeGateway(never, onError, 10)).resolves.toMatchObject({ status: "offline" })
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("10 ms") }))
    })
})

describe("sandboxGatewayStatus", () => {
    it("given no gateway URL, when the status is asked, then it is not configured and nothing is called", async () => {
        await expect(sandboxGatewayStatus({})).resolves.toMatchObject({ status: "notConfigured" })
    })
})
