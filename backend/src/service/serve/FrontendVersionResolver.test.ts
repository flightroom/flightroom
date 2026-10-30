import { FastifyRequest } from "fastify"
import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import { CanaryDeploymentType, CanaryType, HostedOn, IFrontend } from "../../models/FrontendModel"
import FrontendVersionResolver from "./FrontendVersionResolver"

afterEach(() => {
    vi.restoreAllMocks()
})

const FIRST_FRONTEND = "64b000000000000000000001"
const SECOND_FRONTEND = "64b000000000000000000002"

const canaryFrontend = (frontendId: string, percentage: number) =>
    ({
        _id: new Types.ObjectId(frontendId),
        slug: "cart",
        version: "1.0.0",
        host: { type: HostedOn.MFE_ORCHESTRATOR_HUB },
        canary: { enabled: true, version: "2.0.0", percentage, type: CanaryType.ON_SESSION, deploymentType: CanaryDeploymentType.BASED_ON_VERSION }
    }) as unknown as IFrontend

const resolverFor = (query: Record<string, string>) => new FrontendVersionResolver({ query } as unknown as FastifyRequest)

const versionOf = (deviceId: string, frontendId: string, percentage: number) => resolverFor({ mfeDeviceId: deviceId }).getFrontendVersion(canaryFrontend(frontendId, percentage))

/**
 * Buckets of FNV-1a over `${mfeDeviceId}:${frontendId}`, modulo 100, as the code computes them now: a browser keeps its
 * version only while these stay put, so any change to the hash, the key or the comparison has to fail here.
 */
const VECTORS: Array<[deviceId: string, frontendId: string, bucket: number]> = [
    ["device-a", FIRST_FRONTEND, 78],
    ["device-b", FIRST_FRONTEND, 81],
    ["device-a", SECOND_FRONTEND, 59],
    ["7f3c2a10-9b1e-4c5d-8e2f-0a1b2c3d4e5f", FIRST_FRONTEND, 97]
]

describe("FrontendVersionResolver, ON_SESSION canary bucket", () => {
    it.each(VECTORS)("given device %s on frontend %s, when the percentage is its bucket %i, then it gets the stable version", async (deviceId, frontendId, bucket) => {
        expect(await versionOf(deviceId, frontendId, bucket)).toBe("1.0.0")
    })

    it.each(VECTORS)("given device %s on frontend %s, when the percentage is one above its bucket %i, then it gets the canary version", async (deviceId, frontendId, bucket) => {
        expect(await versionOf(deviceId, frontendId, bucket + 1)).toBe("2.0.0")
    })

    it.each(VECTORS)("given device %s on frontend %s, when the canary is at 0%%, then it never gets the canary version", async (deviceId, frontendId) => {
        expect(await versionOf(deviceId, frontendId, 0)).toBe("1.0.0")
    })

    it.each(VECTORS)("given device %s on frontend %s, when the canary is at 100%%, then it always gets the canary version", async (deviceId, frontendId) => {
        expect(await versionOf(deviceId, frontendId, 100)).toBe("2.0.0")
    })

    it("given the same device on two frontends, when the canary is drawn, then each frontend buckets it on its own", async () => {
        expect(await versionOf("device-a", FIRST_FRONTEND, 60)).toBe("1.0.0")
        expect(await versionOf("device-a", SECOND_FRONTEND, 60)).toBe("2.0.0")
    })
})

describe("FrontendVersionResolver, mfeVersion", () => {
    it("given the canary version in mfeVersion, when the version is drawn at 0%, then the canary version is served", async () => {
        expect(await resolverFor({ mfeVersion: "2.0.0", mfeDeviceId: "device-a" }).getFrontendVersion(canaryFrontend(FIRST_FRONTEND, 0))).toBe("2.0.0")
    })

    it("given the stable version in mfeVersion, when the version is drawn at 100%, then the stable version is served", async () => {
        expect(await resolverFor({ mfeVersion: "1.0.0", mfeDeviceId: "device-a" }).getFrontendVersion(canaryFrontend(FIRST_FRONTEND, 100))).toBe("1.0.0")
    })

    it("given a version the deployment does not serve in mfeVersion, when the version is drawn, then it is ignored", async () => {
        expect(await resolverFor({ mfeVersion: "9.9.9", mfeDeviceId: "device-a" }).getFrontendVersion(canaryFrontend(FIRST_FRONTEND, 0))).toBe("1.0.0")
    })

    it("given the canary version in mfeVersion, when a file without a version in its URL is served, then it comes from the canary version", () => {
        expect(resolverFor({ mfeVersion: "2.0.0" }).getVersionToServe(canaryFrontend(FIRST_FRONTEND, 0))).toBe("2.0.0")
    })
})
