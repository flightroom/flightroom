import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import FrontendDeployment from "../models/FrontendDeploymentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import Service from "../models/ServiceModel"
import DomainDeploymentService from "./DomainDeploymentService"
import DomainService from "./DomainService"

/** A find whose query is sorted before it is awaited, as the service does */
const sortedFind = (rows: unknown[]) => ({ sort: () => Promise.resolve(rows) }) as never

afterEach(() => {
    vi.restoreAllMocks()
})

describe("DomainDeploymentService, FRONTEND", () => {
    it("given a DOCKER, when the deployments of its domain are read, then its version per environment is the latest its deploy pipeline reported", async () => {
        const projectId = new Types.ObjectId()
        const domain = { _id: new Types.ObjectId(), projectId, name: "Shop", slug: "shop" }
        const dev = { _id: new Types.ObjectId(), name: "Development", slug: "DEV", color: "#00f", isProduction: false }
        const prod = { _id: new Types.ObjectId(), name: "Production", slug: "PROD", color: "#f00", isProduction: true }
        const shell = { _id: new Types.ObjectId(), slug: "shell", name: "Shell", domainId: domain._id, kind: FrontendKind.DOCKER }
        vi.spyOn(DomainService.prototype, "getById").mockResolvedValue(domain as never)
        vi.spyOn(Environment, "find").mockReturnValue(sortedFind([dev, prod]))
        vi.spyOn(Frontend, "find").mockReturnValue(sortedFind([shell]))
        vi.spyOn(Service, "find").mockReturnValue(sortedFind([]))
        vi.spyOn(Deployment, "aggregate").mockResolvedValue([] as never)
        const frontendDeployments = vi.spyOn(FrontendDeployment, "aggregate").mockResolvedValue([{ _id: { frontendId: shell._id, environmentId: dev._id }, version: "1.4.0" }] as never)

        const result = await new DomainDeploymentService().getByDomainId(String(domain._id))

        expect(result.environments.map(entry => entry.frontends)).toEqual([
            [{ _id: shell._id, slug: "shell", name: "Shell", kind: FrontendKind.DOCKER, version: "1.4.0", canary: null }],
            [{ _id: shell._id, slug: "shell", name: "Shell", kind: FrontendKind.DOCKER, version: null, canary: null }]
        ])
        expect(frontendDeployments).toHaveBeenCalledTimes(1)
    })
})
