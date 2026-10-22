import { Types } from "mongoose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, config: {} }
}))

import { ApiKeyRole } from "../models/ApiKeyModel"
import BuiltFrontend from "../models/BuiltFrontendModel"
import Environment from "../models/EnvironmentModel"
import FrontendDeployment from "../models/FrontendDeploymentModel"
import Frontend, { FrontendKind, HostedOn } from "../models/FrontendModel"
import Project from "../models/ProjectModel"
import FrontendDTO from "../types/FrontendDTO"
import FrontendDeploymentService from "./FrontendDeploymentService"
import FrontendService from "./FrontendService"

const projectId = new Types.ObjectId()

afterEach(() => {
    vi.restoreAllMocks()
})

const codeOf = async (promise: Promise<unknown>) => {
    try {
        await promise
    } catch (error) {
        return (error as { code?: string }).code
    }
    throw new Error("expected a refusal")
}

describe("FrontendService.create, kind", () => {
    const create = async (dto: Partial<FrontendDTO>) => {
        const service = new FrontendService()
        vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()
        vi.spyOn(Frontend, "exists").mockResolvedValue(null as never)
        const write = vi.spyOn(Frontend, "create").mockImplementation((async (doc: unknown) => doc) as never)
        await service.create({ name: "Shell", slug: "shell", version: "1.0.0", host: { type: HostedOn.MFE_ORCHESTRATOR_HUB }, ...dto } as unknown as FrontendDTO, String(projectId))
        return write
    }

    it("given a DOCKER with parents, when it is created, then it is refused before anything is written", async () => {
        const exists = vi.spyOn(Frontend, "exists")
        const write = vi.spyOn(Frontend, "create")
        const service = new FrontendService()
        vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()

        const code = await codeOf(
            service.create({ name: "Shell", slug: "shell", version: "1.0.0", kind: FrontendKind.DOCKER, parentIds: [String(new Types.ObjectId())] } as FrontendDTO, String(projectId))
        )

        expect(code).toBe("DOCKER_FRONTEND_CANNOT_HAVE_PARENTS")
        expect(exists).not.toHaveBeenCalled()
        expect(write).not.toHaveBeenCalled()
    })

    it("given a DOCKER without parents, when it is created, then it gets the service defaults it was not given", async () => {
        const write = await create({ kind: FrontendKind.DOCKER, exposurePath: "/shell", parentIds: [], readinessPath: "/ready" })

        expect(write.mock.calls[0][0]).toMatchObject({ kind: FrontendKind.DOCKER, port: 8080, livenessPath: "/health/live", readinessPath: "/ready" })
    })

    it("given a BUNDLE with parents, when it is created, then it is written without container fields", async () => {
        const parentId = String(new Types.ObjectId())
        const write = await create({ parentIds: [parentId] })

        const written = write.mock.calls[0][0] as Record<string, unknown>
        expect(written.parentIds).toEqual([parentId])
        expect(written).not.toHaveProperty("port")
        expect(written).not.toHaveProperty("livenessPath")
    })

    it("given a DOCKER without an exposure path, when it is created, then it is written not exposed", async () => {
        const write = await create({ kind: FrontendKind.DOCKER, exposurePath: null })

        expect(write.mock.calls[0][0]).toMatchObject({ kind: FrontendKind.DOCKER, exposurePath: null })
    })

    it("given a DOCKER without a version, when it is created, then it is written without one", async () => {
        const write = await create({ kind: FrontendKind.DOCKER, exposurePath: "/shell", version: undefined })

        expect((write.mock.calls[0][0] as Record<string, unknown>).version).toBeUndefined()
    })

    it("given a BUNDLE without a version, when it is created, then it is refused", async () => {
        const service = new FrontendService()
        vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()

        expect(await codeOf(service.create({ name: "Cart", slug: "cart" } as FrontendDTO, String(projectId)))).toBe("BUNDLE_VERSION_REQUIRED")
    })

    it("given an update operator, when a frontend is created, then it is refused as a frontend", async () => {
        const service = new FrontendService()
        vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()

        await expect(service.create({ name: "Cart", slug: "cart", version: "1.0.0", $set: { secretIds: [] } } as unknown as FrontendDTO, String(projectId))).rejects.toMatchObject({
            code: "FRONTEND_INVALID",
            message: expect.not.stringContaining("service")
        })
    })

    it("given a kind that does not exist, when it is created, then it is refused", async () => {
        const service = new FrontendService()
        vi.spyOn(service as unknown as { ensureAccessToProject: () => Promise<void> }, "ensureAccessToProject").mockResolvedValue()

        expect(await codeOf(service.create({ name: "Shell", slug: "shell", version: "1.0.0", kind: "STATIC" } as unknown as FrontendDTO, String(projectId)))).toBe("FRONTEND_KIND_INVALID")
    })
})

describe("FrontendService.update, kind", () => {
    const existing = (fields: Record<string, unknown>) => ({ _id: new Types.ObjectId(), projectId, slug: "shell", kind: FrontendKind.BUNDLE, ...fields })

    const serviceFor = (frontend: Record<string, unknown>) => {
        const service = new FrontendService()
        vi.spyOn(service, "getById").mockResolvedValue(frontend as never)
        vi.spyOn(service, "ensureAccessToFrontend").mockResolvedValue()
        return service
    }

    it("given a DOCKER, when parents are given to it, then it is refused before anything is written", async () => {
        const write = vi.spyOn(Frontend, "findByIdAndUpdate")
        const frontend = existing({ kind: FrontendKind.DOCKER })

        const code = await codeOf(serviceFor(frontend).update(String(frontend._id), { parentIds: [String(new Types.ObjectId())] } as FrontendDTO))

        expect(code).toBe("DOCKER_FRONTEND_CANNOT_HAVE_PARENTS")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a frontend with parents, when it is made a DOCKER, then it is refused", async () => {
        const write = vi.spyOn(Frontend, "findByIdAndUpdate")
        const frontend = existing({ parentIds: [new Types.ObjectId()] })

        const code = await codeOf(serviceFor(frontend).update(String(frontend._id), { kind: FrontendKind.DOCKER } as FrontendDTO))

        expect(code).toBe("DOCKER_FRONTEND_CANNOT_HAVE_PARENTS")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a frontend with parents, when it is made a DOCKER and its parents are removed together, then it is written with the defaults and validated", async () => {
        const write = vi.spyOn(Frontend, "findByIdAndUpdate").mockImplementation((async (_id: unknown, update: unknown) => update) as never)
        const frontend = existing({ parentIds: [new Types.ObjectId()] })

        await serviceFor(frontend).update(String(frontend._id), { kind: FrontendKind.DOCKER, exposurePath: "/shell", parentIds: [] } as unknown as FrontendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ kind: FrontendKind.DOCKER, parentIds: [], port: 8080, livenessPath: "/health/live", readinessPath: "/health/ready" })
        expect(write.mock.calls[0][2]).toMatchObject({ new: true, runValidators: true })
    })

    it("given a BUNDLE, when it is updated, then the update runs the validators", async () => {
        const write = vi.spyOn(Frontend, "findByIdAndUpdate").mockImplementation((async (_id: unknown, update: unknown) => update) as never)
        const frontend = existing({})

        await serviceFor(frontend).update(String(frontend._id), { name: "Cart" } as FrontendDTO)

        expect(write.mock.calls[0][2]).toMatchObject({ new: true, runValidators: true })
    })

    it("given a frontend with no parents, when it is made a DOCKER, then the write requires no parents stored and its canary is turned off", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate").mockImplementation((async (_filter: unknown, update: unknown) => update) as never)
        const frontend = existing({ canary: { enabled: true, percentage: 10 }, exposurePath: "/shell" })

        await serviceFor(frontend).update(String(frontend._id), { kind: FrontendKind.DOCKER } as FrontendDTO)

        const [filter, update] = write.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>]
        expect(filter).toEqual({ _id: frontend._id, $or: [{ parentIds: { $exists: false } }, { parentIds: { $size: 0 } }] })
        expect(update).toMatchObject({ kind: FrontendKind.DOCKER, "canary.enabled": false })
    })

    it("given a BUNDLE without an exposure path, when it is made a DOCKER, then it is written not exposed", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate").mockImplementation((async (_filter: unknown, update: unknown) => update) as never)
        const frontend = existing({})

        await serviceFor(frontend).update(String(frontend._id), { kind: FrontendKind.DOCKER } as FrontendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ kind: FrontendKind.DOCKER })
    })

    it("given a DOCKER, when its exposure path is cleared, then it is written not exposed", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate").mockImplementation((async (_filter: unknown, update: unknown) => update) as never)
        const frontend = existing({ kind: FrontendKind.DOCKER, exposurePath: "/shell" })

        await serviceFor(frontend).update(String(frontend._id), { exposurePath: null } as FrontendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ exposurePath: null })
    })

    it("given a DOCKER, when its version is set by hand, then it is written trimmed", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate").mockImplementation((async (_filter: unknown, update: unknown) => update) as never)
        const frontend = existing({ kind: FrontendKind.DOCKER, exposurePath: "/shell" })

        await serviceFor(frontend).update(String(frontend._id), { version: " 2.1.0 " } as FrontendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ version: "2.1.0" })
    })

    it("given a DOCKER, when it is given a version an image tag cannot be, then it is refused before anything is written", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate")
        const frontend = existing({ kind: FrontendKind.DOCKER, exposurePath: "/shell" })

        expect(await codeOf(serviceFor(frontend).update(String(frontend._id), { version: "2.1.0 beta" } as FrontendDTO))).toBe("SERVICE_VERSION_INVALID")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a BUNDLE, when its version is updated, then it is written as before, without the rule of an image tag", async () => {
        const write = vi.spyOn(Frontend, "findByIdAndUpdate").mockImplementation((async (_id: unknown, update: unknown) => update) as never)
        const frontend = existing({})

        await serviceFor(frontend).update(String(frontend._id), { version: "1.0.0+build.5" } as FrontendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ version: "1.0.0+build.5" })
    })

    it("given a DOCKER stored without an exposure path, when another field is updated, then it is written", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate").mockImplementation((async (_filter: unknown, update: unknown) => update) as never)
        const frontend = existing({ kind: FrontendKind.DOCKER })

        await serviceFor(frontend).update(String(frontend._id), { name: "Shell" } as FrontendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ name: "Shell" })
    })

    it("given a DOCKER, when a canary is sent enabled, then it is stored disabled", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate").mockImplementation((async (_filter: unknown, update: unknown) => update) as never)
        const frontend = existing({ kind: FrontendKind.DOCKER })

        await serviceFor(frontend).update(String(frontend._id), { canary: { enabled: true, percentage: 50 } } as unknown as FrontendDTO)

        expect(write.mock.calls[0][1]).toMatchObject({ canary: { enabled: false, percentage: 50 } })
    })

    /** A relation set between the check and the write: the conditional write misses */
    it("given a parent set since it was read, when it is made a DOCKER, then it is refused", async () => {
        vi.spyOn(Frontend, "findOneAndUpdate").mockResolvedValue(null as never)
        const frontend = existing({ exposurePath: "/shell" })

        expect(await codeOf(serviceFor(frontend).update(String(frontend._id), { kind: FrontendKind.DOCKER } as FrontendDTO))).toBe("DOCKER_FRONTEND_CANNOT_HAVE_PARENTS")
    })

    it("given an update operator, when a frontend is updated, then it is refused as a frontend", async () => {
        const write = vi.spyOn(Frontend, "findByIdAndUpdate")
        const frontend = existing({})

        expect(await codeOf(serviceFor(frontend).update(String(frontend._id), { "canary.enabled": true } as unknown as FrontendDTO))).toBe("FRONTEND_INVALID")
        expect(write).not.toHaveBeenCalled()
    })
})

describe("FrontendService.setRelation, kind", () => {
    const frontendOf = (kind: FrontendKind) => ({ _id: new Types.ObjectId(), projectId, slug: kind.toLowerCase(), kind })

    const serviceFor = (host: ReturnType<typeof frontendOf>, remote: ReturnType<typeof frontendOf>) => {
        const service = new FrontendService()
        vi.spyOn(service, "getById").mockImplementation((async (id: string) => (id === String(host._id) ? host : remote)) as never)
        vi.spyOn(service, "ensureAccessToFrontend").mockResolvedValue()
        return service
    }

    it("given a DOCKER as the remote, when it is linked to a host, then it is refused and nothing is written", async () => {
        const write = vi.spyOn(Frontend, "findOneAndUpdate")
        const host = frontendOf(FrontendKind.BUNDLE)
        const remote = frontendOf(FrontendKind.DOCKER)

        expect(await codeOf(serviceFor(host, remote).setRelation(String(host._id), String(remote._id)))).toBe("DOCKER_FRONTEND_CANNOT_HAVE_PARENTS")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a DOCKER frontend as the host, when a frontend is linked to it, then the parent is added only to a remote that is not a DOCKER frontend", async () => {
        const host = frontendOf(FrontendKind.DOCKER)
        const remote = frontendOf(FrontendKind.BUNDLE)
        const write = vi.spyOn(Frontend, "findOneAndUpdate").mockResolvedValue({ ...remote, parentIds: [host._id] } as never)

        const saved = await serviceFor(host, remote).setRelation(String(host._id), String(remote._id))

        expect(write).toHaveBeenCalledWith({ _id: remote._id, kind: { $ne: FrontendKind.DOCKER } }, { $addToSet: { parentIds: host._id } }, { new: true })
        expect(saved.parentIds?.map(String)).toEqual([String(host._id)])
    })

    /** Made a DOCKER between the check and the write: the conditional write misses */
    it("given a remote made a DOCKER since it was read, when it is linked, then it is refused", async () => {
        vi.spyOn(Frontend, "findOneAndUpdate").mockResolvedValue(null as never)
        const host = frontendOf(FrontendKind.BUNDLE)
        const remote = frontendOf(FrontendKind.BUNDLE)

        expect(await codeOf(serviceFor(host, remote).setRelation(String(host._id), String(remote._id)))).toBe("DOCKER_FRONTEND_CANNOT_HAVE_PARENTS")
    })
})

describe("FrontendService.getVersionsById, kind", () => {
    it.each([
        [FrontendKind.BUNDLE, false],
        [FrontendKind.DOCKER, true]
    ])("given a %s, when its versions are read, then only the builds of that kind count", async (kind, withImage) => {
        const frontend = { _id: new Types.ObjectId(), projectId, kind }
        const service = new FrontendService()
        vi.spyOn(service, "getById").mockResolvedValue(frontend as never)
        const distinct = vi.fn().mockResolvedValue(["1.0.0"])
        const find = vi.spyOn(BuiltFrontend, "find").mockReturnValue({ select: () => ({ distinct }) } as never)

        expect(await service.getVersionsById(String(frontend._id))).toEqual(["1.0.0"])
        expect(find).toHaveBeenCalledWith({ frontendId: frontend._id, image: { $exists: withImage } })
    })
})

describe("FrontendService.uploadWithPermissionCheck, kind", () => {
    it("given a DOCKER, when a bundle is uploaded, then it is refused before the file is read", async () => {
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId, slug: "acme" } as never)
        vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: new Types.ObjectId(), slug: "shell", kind: FrontendKind.DOCKER, host: { type: HostedOn.MFE_ORCHESTRATOR_HUB } } as never)
        const built = vi.spyOn(BuiltFrontend, "create")
        const file = { mimetype: "application/zip", filename: "shell.zip", toBuffer: vi.fn() }

        const code = await codeOf(new FrontendService().uploadWithPermissionCheck("shell", "1.0.0", String(projectId), file as never))

        expect(code).toBe("DOCKER_FRONTEND_UPLOAD_NOT_ALLOWED")
        expect(file.toBuffer).not.toHaveBeenCalled()
        expect(built).not.toHaveBeenCalled()
    })
})

describe("FrontendService.registerVersionWithPermissionCheck", () => {
    const frontendId = new Types.ObjectId()
    let findOne: ReturnType<typeof vi.fn>
    let upsert: ReturnType<typeof vi.fn>
    let updateOne: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.spyOn(Project, "findById").mockResolvedValue({ _id: projectId } as never)
        findOne = vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, slug: "shell", kind: FrontendKind.DOCKER, version: "1.1.0" } as never) as unknown as ReturnType<typeof vi.fn>
        upsert = vi
            .spyOn(BuiltFrontend, "findOneAndUpdate")
            .mockImplementation((async (_filter: unknown, update: { $set: Record<string, unknown> }) => ({ frontendId, ...update.$set })) as never) as unknown as ReturnType<typeof vi.fn>
        updateOne = vi.spyOn(Frontend, "updateOne").mockResolvedValue({ matchedCount: 1 } as never) as unknown as ReturnType<typeof vi.fn>
    })

    const register = (body: unknown, role?: ApiKeyRole) => new FrontendService().registerVersionWithPermissionCheck("shell", "1.2.0", String(projectId), body, role)

    it.each([[ApiKeyRole.VIEWER], [undefined]])("given a %s key, when a version is registered, then it is forbidden before anything is read", async role => {
        await expect(register({ image: "ghcr.io/acme/shell:1.2.0" }, role)).rejects.toMatchObject({ statusCode: 403, code: "FRONTEND_VERSION_FORBIDDEN" })
        expect(findOne).not.toHaveBeenCalled()
    })

    it("given a BUNDLE, when a version is registered, then it is refused and nothing is stored", async () => {
        findOne.mockResolvedValue({ _id: frontendId, slug: "cart", kind: FrontendKind.BUNDLE })

        expect(await codeOf(register({ image: "ghcr.io/acme/cart:1.2.0" }, ApiKeyRole.MANAGER))).toBe("BUNDLE_VERSION_REGISTRATION_NOT_ALLOWED")
        expect(upsert).not.toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })

    it("given no image, when a version is registered, then it is refused", async () => {
        expect(await codeOf(register({}, ApiKeyRole.MANAGER))).toBe("SERVICE_VERSION_IMAGE_REQUIRED")
    })

    it("given a DOCKER and a newer version, when it is registered, then it is upserted, becomes the version and teaches the image repository", async () => {
        const built = await register({ image: "ghcr.io/acme/shell:1.2.0", digest: "sha256:abc", commitSha: "deadbeef" }, ApiKeyRole.MANAGER)

        expect(upsert).toHaveBeenCalledWith(
            { frontendId, version: "1.2.0" },
            { $set: { image: "ghcr.io/acme/shell:1.2.0", digest: "sha256:abc", commitSha: "deadbeef" } },
            expect.objectContaining({ upsert: true })
        )
        expect(built).toMatchObject({ image: "ghcr.io/acme/shell:1.2.0", digest: "sha256:abc", commitSha: "deadbeef" })
        expect(updateOne).toHaveBeenCalledWith({ _id: frontendId, version: "1.1.0" }, { $set: { version: "1.2.0", "image.repository": "ghcr.io/acme/shell" } })
    })

    it("given a DOCKER created without a version, when a first one is registered, then it becomes its version", async () => {
        findOne.mockResolvedValue({ _id: frontendId, slug: "shell", kind: FrontendKind.DOCKER, image: { repository: "ghcr.io/acme/shell" } })

        await register({ image: "ghcr.io/acme/shell:nightly" }, ApiKeyRole.MANAGER)

        expect(updateOne).toHaveBeenCalledWith({ _id: frontendId, version: null }, { $set: { version: "1.2.0" } })
    })

    it("given an older version, when it is registered, then it is stored but the DOCKER keeps its version", async () => {
        findOne.mockResolvedValue({ _id: frontendId, slug: "shell", kind: FrontendKind.DOCKER, version: "2.0.0", image: { repository: "ghcr.io/acme/shell" } })

        await register({ image: "ghcr.io/acme/shell:1.2.0" }, ApiKeyRole.MANAGER)

        expect(upsert).toHaveBeenCalled()
        expect(updateOne).not.toHaveBeenCalled()
    })
})

describe("FrontendDeploymentService.registerWithPermissionCheck", () => {
    const environment = { _id: new Types.ObjectId(), slug: "PROD" }

    beforeEach(() => {
        vi.spyOn(Environment, "find").mockResolvedValue([environment] as never)
    })

    it("given a BUNDLE, when a deploy is reported, then it is refused and nothing is stored", async () => {
        vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: new Types.ObjectId(), slug: "cart", kind: FrontendKind.BUNDLE } as never)
        const write = vi.spyOn(FrontendDeployment, "create")

        const code = await codeOf(new FrontendDeploymentService().registerWithPermissionCheck("cart", "prod", String(projectId), { version: "1.0.0" }, ApiKeyRole.MANAGER))

        expect(code).toBe("BUNDLE_DEPLOYMENT_REGISTRATION_NOT_ALLOWED")
        expect(write).not.toHaveBeenCalled()
    })

    it("given a DOCKER, when a deploy is reported, then it is stored against the environment matched without regard to case", async () => {
        const frontendId = new Types.ObjectId()
        vi.spyOn(Frontend, "findOne").mockResolvedValue({ _id: frontendId, slug: "shell", kind: FrontendKind.DOCKER } as never)
        const write = vi.spyOn(FrontendDeployment, "create").mockImplementation((async (doc: unknown) => doc) as never)

        await new FrontendDeploymentService().registerWithPermissionCheck("shell", "prod", String(projectId), { version: "1.2.0", image: "ghcr.io/acme/shell:1.2.0" }, ApiKeyRole.MANAGER)

        expect(write).toHaveBeenCalledWith({ frontendId, environmentId: environment._id, version: "1.2.0", image: "ghcr.io/acme/shell:1.2.0" })
    })

    it("given a VIEWER key, when a deploy is reported, then it is forbidden", async () => {
        await expect(new FrontendDeploymentService().registerWithPermissionCheck("shell", "prod", String(projectId), { version: "1.2.0" }, ApiKeyRole.VIEWER)).rejects.toMatchObject({
            statusCode: 403,
            code: "FRONTEND_DEPLOYMENT_FORBIDDEN"
        })
    })
})
