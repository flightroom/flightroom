import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../..", () => ({ fastify: { log: { error: vi.fn(), warn: vi.fn() }, config: { REPOSITORIES_FOLDER: "/repositories" } } }))

import { fastify } from "../.."
import ArgoCdClient from "../../client/ArgoCdClient"
import Environment from "../../models/EnvironmentModel"
import Project from "../../models/ProjectModel"
import { applicationName, appProjectName } from "../gitops/argoCdManifests"
import { restartContinuouslyDeployed } from "./argoCdContinuousDeployment"

const projectId = new Types.ObjectId()
const development = { _id: new Types.ObjectId(), slug: "development", namespace: "shop-dev" }
const production = { _id: new Types.ObjectId(), slug: "production" }
const argoCdProject = {
    _id: projectId,
    slug: "shop",
    gitOps: { enabled: true, applicationsCodeRepository: { enabled: true } },
    argoCd: { initializedAt: new Date(), url: "https://argocd.example.com", token: "token" }
}
/** Runs the moving tag `dev` in development and 1.2.0 in production, deployed continuously in both */
const backend = {
    slug: "orders-be",
    environmentVersions: [
        { environmentId: development._id, version: "dev" },
        { environmentId: production._id, version: "1.2.0" }
    ],
    continuousDeploymentEnvironmentIds: [development._id, production._id]
}

describe("restartContinuouslyDeployed", () => {
    beforeEach(() => {
        vi.spyOn(Project, "findById").mockResolvedValue(argoCdProject as never)
        vi.spyOn(Environment, "find").mockResolvedValue([development, production] as never)
        vi.spyOn(ArgoCdClient.prototype, "refreshApplication").mockResolvedValue(undefined)
        vi.spyOn(ArgoCdClient.prototype, "restartDeployment").mockResolvedValue(undefined)
    })

    afterEach(() => vi.restoreAllMocks())

    it("given the tag an environment deployed continuously runs is registered again, when the restart runs, then its Deployment restarts through its Application there only", async () => {
        const restarted = await restartContinuouslyDeployed(projectId as never, backend, "dev")

        expect(restarted).toEqual(["development"])
        expect(vi.mocked(ArgoCdClient.prototype.refreshApplication).mock.calls).toEqual([
            [applicationName(String(projectId), "shop", "orders-be", "development"), appProjectName(String(projectId), "shop")]
        ])
        expect(vi.mocked(ArgoCdClient.prototype.restartDeployment).mock.calls).toEqual([
            [applicationName(String(projectId), "shop", "orders-be", "development"), appProjectName(String(projectId), "shop"), "shop-dev", "orders-be"]
        ])
    })

    it("given a version no environment runs, when the restart runs, then nothing restarts: changing the tag takes a deploy", async () => {
        expect(await restartContinuouslyDeployed(projectId as never, backend, "1.3.0")).toEqual([])
        expect(ArgoCdClient.prototype.restartDeployment).not.toHaveBeenCalled()
    })

    it("given an environment not deployed continuously, when its tag is registered again, then nothing restarts and Argo CD is not even read", async () => {
        expect(await restartContinuouslyDeployed(projectId as never, { ...backend, continuousDeploymentEnvironmentIds: [] }, "dev")).toEqual([])
        expect(Project.findById).not.toHaveBeenCalled()
    })

    it("given a project without Argo CD, when the restart runs, then nothing restarts", async () => {
        vi.mocked(Project.findById).mockResolvedValue({ ...argoCdProject, argoCd: undefined } as never)

        expect(await restartContinuouslyDeployed(projectId as never, backend, "dev")).toEqual([])
        expect(ArgoCdClient.prototype.restartDeployment).not.toHaveBeenCalled()
    })

    it("given Argo CD refuses the restart, when it runs, then the failure is logged and not thrown: the registration went through", async () => {
        vi.mocked(ArgoCdClient.prototype.restartDeployment).mockRejectedValue(new Error("forbidden"))

        expect(await restartContinuouslyDeployed(projectId as never, backend, "dev")).toEqual([])
        expect(fastify.log.warn).toHaveBeenCalled()
    })
})
