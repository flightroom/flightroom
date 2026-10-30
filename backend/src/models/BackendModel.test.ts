import { Types } from "mongoose"
import { describe, expect, it } from "vitest"
import Backend from "./BackendModel"
import BuiltBackend from "./BuiltBackendModel"

const aBackend = () => new Backend({ projectId: new Types.ObjectId(), slug: "  Orders-API ", name: "Orders API" })

describe("Backend model", () => {
    it("given a backend with only the required fields, when it is built, then port, probes and env take their defaults and it has no API docs", async () => {
        const backend = aBackend()

        expect(backend.port).toBe(8080)
        expect(backend.livenessPath).toBe("/health/live")
        expect(backend.readinessPath).toBe("/health/ready")
        expect(backend.docsPath).toBeUndefined()
        expect(backend.openApiPath).toBeUndefined()
        expect(backend.env).toEqual([])
        await expect(backend.validate()).resolves.toBeUndefined()
    })

    it("given every path of a Spring Boot backend, when it is validated, then it is accepted", async () => {
        const backend = new Backend({
            projectId: new Types.ObjectId(),
            slug: "orders",
            name: "Orders",
            livenessPath: "/actuator/health/liveness",
            readinessPath: "/actuator/health/readiness",
            docsPath: "/swagger-ui.html",
            openApiPath: "/v3/api-docs"
        })

        await expect(backend.validate()).resolves.toBeUndefined()
    })

    it("given blank docs and OpenAPI paths, when it is built, then the backend has none", () => {
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders", docsPath: "  ", openApiPath: "" })

        expect(backend.docsPath).toBeNull()
        expect(backend.openApiPath).toBeNull()
    })

    it.each([
        ["livenessPath", "health/live"],
        ["livenessPath", ""],
        ["readinessPath", "/health ready"],
        ["readinessPath", `/${"x".repeat(256)}`],
        ["docsPath", "docs"],
        ["docsPath", "/my\tdocs"],
        ["openApiPath", "https://example.com/openapi.json"]
    ])("given the %s %j, when it is validated, then it is refused", async (field, value) => {
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders", [field]: value })

        await expect(backend.validate()).rejects.toMatchObject({ errors: { [field]: expect.anything() } })
    })

    it("given blank CPU and memory, when it is built, then they are stored as null for the defaults of the chart", () => {
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders", cpuRequest: " ", cpuLimit: "", memoryRequest: "  ", memoryLimit: "" })

        expect([backend.cpuRequest, backend.cpuLimit, backend.memoryRequest, backend.memoryLimit]).toEqual([null, null, null, null])
    })

    it("given CPU and memory as Kubernetes quantities, when it is validated, then they are accepted, trimmed", async () => {
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders", cpuRequest: " 250m ", cpuLimit: "1.5", memoryRequest: "128Mi", memoryLimit: "1000000" })

        await expect(backend.validate()).resolves.toBeUndefined()
        expect(backend.cpuRequest).toBe("250m")
    })

    it.each([
        ["cpuRequest", "250Mi"],
        ["cpuLimit", "0"],
        ["cpuLimit", "one"],
        ["memoryRequest", "128mb"],
        ["memoryLimit", "-1Gi"]
    ])("given the %s %j, when it is validated, then it is refused", async (field, value) => {
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders", [field]: value })

        await expect(backend.validate()).rejects.toMatchObject({ errors: { [field]: expect.anything() } })
    })

    it("given a path of 256 characters, when it is validated, then it is accepted", async () => {
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders", livenessPath: `/${"x".repeat(255)}` })

        await expect(backend.validate()).resolves.toBeUndefined()
    })

    it("given a slug with capitals and spaces, when it is built, then it is stored trimmed and lowercase", () => {
        expect(aBackend().slug).toBe("orders-api")
    })

    it("given an env variable with only a name, when it is built, then it is neither required nor secret", () => {
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders", env: [{ name: "DATABASE_URL" }] })

        expect(backend.env[0]).toMatchObject({ name: "DATABASE_URL", required: false, secret: false })
    })

    it("given no project, when it is validated, then it is refused", async () => {
        const backend = new Backend({ slug: "orders", name: "Orders" })

        await expect(backend.validate()).rejects.toMatchObject({ errors: { projectId: expect.anything() } })
    })

    it("given a backend with no map attached, when it is built, then it receives no config map nor secret", () => {
        expect(aBackend().configMapIds).toEqual([])
        expect(aBackend().secretIds).toEqual([])
    })

    it("declares the slug unique inside its project", () => {
        expect(Backend.schema.indexes()).toContainEqual([{ slug: 1, projectId: 1 }, expect.objectContaining({ unique: true })])
    })
})

describe("BuiltBackend model", () => {
    it("declares one entry per version of a backend", () => {
        expect(BuiltBackend.schema.indexes()).toContainEqual([{ backendId: 1, version: 1 }, expect.objectContaining({ unique: true })])
    })

    it("given no image, when it is validated, then it is refused", async () => {
        const built = new BuiltBackend({ backendId: new Types.ObjectId(), version: "1.0.0" })

        await expect(built.validate()).rejects.toMatchObject({ errors: { image: expect.anything() } })
    })
})
