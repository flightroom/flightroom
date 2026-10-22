import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import BuiltFrontend from "../models/BuiltFrontendModel"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import FrontendDeployment from "../models/FrontendDeploymentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import Service from "../models/ServiceModel"
import { ProjectBuildStatusDTO } from "../types/BuildStatusDTO"
import BuildStatusService from "./BuildStatusService"

/** A find whose query is sorted before it is awaited, as the service does */
const sortedFind = (rows: unknown[]) => ({ sort: () => Promise.resolve(rows) }) as never

afterEach(() => {
    vi.restoreAllMocks()
})

describe("BuildStatusService, FRONTEND", () => {
    it("given a DOCKER and a BUNDLE, when the build status is read, then the DOCKER runs what its pipeline reported and the BUNDLE what the deployment froze", async () => {
        const projectId = new Types.ObjectId()
        const dev = { _id: new Types.ObjectId(), name: "Development", slug: "DEV", color: "#00f", isProduction: false }
        const shell = { _id: new Types.ObjectId(), projectId, name: "Shell", slug: "shell", kind: FrontendKind.DOCKER, version: "1.4.0" }
        const cart = { _id: new Types.ObjectId(), projectId, name: "Cart", slug: "cart", version: "2.0.0" }
        vi.spyOn(Frontend, "find").mockReturnValue(sortedFind([shell, cart]))
        vi.spyOn(Service, "find").mockReturnValue(sortedFind([]))
        vi.spyOn(Environment, "find").mockReturnValue(sortedFind([dev]))
        // Even a DOCKER sits in the snapshot: what it holds there is not what runs
        vi.spyOn(Deployment, "find").mockResolvedValue([{ environmentId: dev._id, frontends: [{ ...shell, version: "0.1.0" }, cart] }] as never)
        const reported = vi.spyOn(FrontendDeployment, "aggregate").mockResolvedValue([{ _id: { frontendId: shell._id, environmentId: dev._id }, version: "1.3.0" }] as never)
        vi.spyOn(BuiltFrontend, "findOne").mockReturnValue({ sort: () => ({ select: () => Promise.resolve(null) }) } as never)

        const snapshot = await (new BuildStatusService() as unknown as { fetchSnapshot: (projectId: string) => Promise<ProjectBuildStatusDTO> }).fetchSnapshot(String(projectId))

        expect(snapshot.frontends.map(row => [row.slug, row.versionByEnvironmentId])).toEqual([
            ["shell", { [String(dev._id)]: "1.3.0" }],
            ["cart", { [String(dev._id)]: "2.0.0" }]
        ])
        expect(reported.mock.calls[0][0][0]).toEqual({ $match: { frontendId: { $in: [shell._id] }, environmentId: { $in: [dev._id] } } })
    })
})
