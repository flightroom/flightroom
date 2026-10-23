import { Types } from "mongoose"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import { CanaryDeploymentType, CanaryType, FrontendKind, HostedOn, IFrontend } from "../models/FrontendModel"
import Project, { IProject } from "../models/ProjectModel"
import ServeService from "./ServeService"

afterEach(() => {
    vi.restoreAllMocks()
})

const projectId = new Types.ObjectId()
const environment = { _id: new Types.ObjectId(), projectId, slug: "DEV", isProduction: false }

const cart = {
    _id: new Types.ObjectId(),
    projectId,
    name: "Cart",
    slug: "cart",
    version: "1.0.0",
    host: { type: HostedOn.MFE_ORCHESTRATOR_HUB, entryPoint: "remoteEntry.js" }
}
const shell = {
    _id: new Types.ObjectId(),
    projectId,
    name: "Shell",
    slug: "shell",
    version: "2.0.0",
    kind: FrontendKind.DOCKER,
    host: { type: HostedOn.MFE_ORCHESTRATOR_HUB },
    // Ignored: the orchestrator does not serve a DOCKER, so it has no version of ours to roll out
    canary: { enabled: true, percentage: 100, type: CanaryType.RANDOM, deploymentType: CanaryDeploymentType.BASED_ON_URL, url: "https://canary.acme.com" },
    exposurePath: "/shell"
}

const deployment = { _id: new Types.ObjectId(), environmentId: environment._id, frontends: [cart, shell], variables: [] }

describe("ServeService, FRONTEND", () => {
    it("given a deployment with a DOCKER, when the manifest is served, then only the frontends are in it", async () => {
        vi.spyOn(Deployment, "findOne").mockResolvedValue(deployment as never)
        vi.spyOn(Environment, "findById").mockResolvedValue(environment as never)

        const { microfrontends: frontends } = await new ServeService().getAllByEnvironmentId(String(environment._id))

        expect(frontends?.map(frontend => frontend.slug)).toEqual(["cart"])
    })

    it("given a DOCKER, when one of its files is asked for, then it is not found", async () => {
        await expect(new ServeService().getFrontendByDeployment({ _id: projectId, slug: "acme" } as unknown as IProject, deployment as never, "shell", "index.js")).rejects.toBeInstanceOf(
            EntityNotFoundError
        )
    })

    const serveShell = async (frontend: Partial<IFrontend>, exposure?: IProject["exposure"]) => {
        vi.spyOn(Deployment, "findOne").mockResolvedValue({ ...deployment, frontends: [frontend] } as never)
        vi.spyOn(Environment, "findById").mockResolvedValue(environment as never)
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, exposure } as never)
        return new ServeService().getFrontendConfigurationByEnvironmentIdAndMfeSlug(String(environment._id), "shell")
    }

    it("given a DOCKER, when its configuration is served, then its URL is its path on the host of that environment and its canary is ignored", async () => {
        const served = await serveShell(shell as never, { domain: "acme.com", certificateIssuer: "letsencrypt" })

        expect(served).toMatchObject({ slug: "shell", url: "https://dev.acme.com/shell", version: "2.0.0" })
    })

    it("given a project with no certificate issuer, when the configuration of a DOCKER is served, then its URL is over HTTP", async () => {
        expect(await serveShell(shell as never, { domain: "acme.com" })).toMatchObject({ url: "http://dev.acme.com/shell" })
    })

    it.each([
        ["/", "https://dev.acme.com"],
        ["/shell/", "https://dev.acme.com/shell"]
    ])("given a DOCKER exposed at %s, when its configuration is served, then its URL has no trailing slash", async (exposurePath, url) => {
        expect(await serveShell({ ...shell, exposurePath } as never, { domain: "acme.com", certificateIssuer: "letsencrypt" })).toMatchObject({ url })
    })

    /** It is a host asking for its own configuration: no address of its own must not make that fail */
    it("given a DOCKER that is not exposed, when its configuration is served, then it comes with an empty URL", async () => {
        expect(await serveShell({ ...shell, exposurePath: null } as never, { domain: "acme.com" })).toMatchObject({ slug: "shell", url: "" })
    })

    it("given a project exposed on no domain, when the configuration of a DOCKER is served, then it comes with an empty URL", async () => {
        expect(await serveShell(shell as never)).toMatchObject({ slug: "shell", url: "" })
    })
})
