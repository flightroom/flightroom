import { Types } from "mongoose"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { MaintenanceAgentKind } from "../../types/MaintenanceAgent"
import { APPLICATIONS_CHART_FOLDER, applicationImageRepository, CHART_FILES, isDeployable, MANAGED_VALUES_MARKER, PAUSED_SCHEDULE, renderApplicationValues, splitImage } from "./applicationManifests"

describe("splitImage", () => {
    it.each([
        ["ghcr.io/acme/x", { host: "ghcr.io", name: "acme/x" }],
        ["nginx", { host: "docker.io", name: "nginx" }],
        ["library/nginx", { host: "docker.io", name: "library/nginx" }],
        ["localhost:5000/x", { host: "localhost:5000", name: "x" }]
    ])("given the image %s, when it is split, then the registry and the name are told apart", (repository, expected) => {
        expect(splitImage(repository)).toEqual(expected)
    })
})

describe("applicationImageRepository", () => {
    it("given an image repository of its own, when the image is resolved, then it wins over the registry of the project", () => {
        expect(applicationImageRepository({ slug: "orders", image: { repository: "ghcr.io/acme/orders-api" } }, "registry.example.com")).toBe("ghcr.io/acme/orders-api")
    })

    it.each([
        ["no image", {}],
        ["a blank repository", { image: { repository: " " } }]
    ])("given %s and a registry in the project, when the image is resolved, then it is the slug in the registry", (_case, fields) => {
        expect(applicationImageRepository({ slug: "orders", ...fields }, "azimutmarketplace.azurecr.io")).toBe("azimutmarketplace.azurecr.io/orders")
    })

    it("given no image and no registry in the project, when the image is resolved, then there is none", () => {
        expect(applicationImageRepository({ slug: "orders" })).toBeUndefined()
    })
})

describe("isDeployable", () => {
    it("given a version and an image, when it is checked, then the application can be deployed", () => {
        expect(isDeployable({ slug: "orders", version: "1.0.0", image: { repository: "ghcr.io/acme/orders" } })).toBe(true)
    })

    it.each([
        ["no version", { slug: "orders", image: { repository: "ghcr.io/acme/orders" } }],
        ["no image", { slug: "orders", version: "1.0.0" }],
        ["an empty repository", { slug: "orders", version: "1.0.0", image: { repository: "" } }]
    ])("given %s, when it is checked, then the application is left out", (_case, application) => {
        expect(isDeployable(application)).toBe(false)
    })

    it("given a version and no image, when the project has a container registry, then the application can be deployed", () => {
        expect(isDeployable({ slug: "orders", version: "1.0.0" }, "ghcr.io/acme")).toBe(true)
    })

    it("given no version, when the project has a container registry, then the application is still left out", () => {
        expect(isDeployable({ slug: "orders" }, "ghcr.io/acme")).toBe(false)
    })
})

describe("renderApplicationValues", () => {
    const environment = { _id: new Types.ObjectId(), slug: "production" }
    const configMapId = new Types.ObjectId()
    const secretId = new Types.ObjectId()
    const mapNames = { configMaps: new Map([[String(configMapId), "logging"]]), secrets: new Map([[String(secretId), "database"]]) }
    const application = {
        slug: "orders",
        version: "1.2.3",
        image: { repository: "ghcr.io/acme/orders" },
        port: 3000,
        livenessPath: "/live",
        configMapIds: [configMapId, new Types.ObjectId()],
        secretIds: [secretId]
    }
    const render = (overrides = {}) => renderApplicationValues({ ...application, ...overrides }, environment, mapNames)

    it("given an application, when its values are rendered, then the first line is the managed marker", () => {
        expect(render().split("\n")[0]).toBe(MANAGED_VALUES_MARKER)
    })

    it("given an application, when its values are rendered, then the image has the registry, the name and the version as tag", () => {
        expect(parse(render()).image).toEqual({ host: "ghcr.io", name: "acme/orders", tag: "1.2.3" })
    })

    it("given no image of its own, when its values are rendered with the registry of the project, then the image is the slug in the registry", () => {
        const values = parse(renderApplicationValues({ ...application, image: undefined }, environment, mapNames, undefined, "azimutmarketplace.azurecr.io"))

        expect(values.image).toEqual({ host: "azimutmarketplace.azurecr.io", name: "orders", tag: "1.2.3" })
    })

    it("given no image and no registry in the project, when its values are rendered, then it is refused", () => {
        expect(() => renderApplicationValues({ ...application, image: undefined }, environment, mapNames)).toThrow()
    })

    it("given maps attached by id, when its values are rendered, then they go by name and an unknown id is left out", () => {
        const values = parse(render())

        expect(values.environmentMaps).toEqual(["logging"])
        expect(values.secrets).toEqual(["database"])
    })

    it("given an exposure path and a Gateway, when its values are rendered, then the route is on the Gateway with the path", () => {
        const values = parse(renderApplicationValues({ ...application, exposurePath: "/api/orders" }, environment, mapNames, { name: "mfe-shop-1a2b3c", listener: "https", hsts: true }))

        expect(values.route).toEqual({ gateway: "mfe-shop-1a2b3c", listener: "https", path: "/api/orders", hsts: true })
    })

    it.each([
        ["no exposure path", {}, { name: "mfe-shop-1a2b3c", listener: "https", hsts: true }],
        ["no Gateway in the environment", { exposurePath: "/api/orders" }, undefined]
    ])("given %s, when its values are rendered, then there is no route", (_case, overrides, gateway) => {
        expect(parse(renderApplicationValues({ ...application, ...overrides }, environment, mapNames, gateway)).route).toBeUndefined()
    })

    it("given a port and a liveness path, when its values are rendered, then the container port and the liveness probe follow them", () => {
        const values = parse(render())

        expect(values.containerPort).toBe(3000)
        expect(values.probes).toEqual({ liveness: { active: true, path: "/live" }, readiness: { active: false, path: "/" } })
    })
})

describe("renderApplicationValues, maintenance agent", () => {
    const environment = { _id: new Types.ObjectId(), slug: "production" }
    const mapNames = { configMaps: new Map<string, string>(), secrets: new Map<string, string>() }
    const targets = [{ kind: "service" as const, slug: "orders", url: "http://orders" }]
    const agent = (maintenance: Partial<{ kind: MaintenanceAgentKind; schedule: string | null; timeZone: string | null; runPath: string }>) =>
        parse(
            renderApplicationValues(
                { slug: "cleaner", version: "1.0.0", image: { repository: "ghcr.io/acme/cleaner" }, maintenance: { kind: MaintenanceAgentKind.JOB, runPath: "/run", targets, ...maintenance } },
                environment,
                mapNames
            )
        )

    it("given a job with a schedule, when its values are rendered, then the CronJob runs on it and the Deployment runs nothing", () => {
        const values = agent({ schedule: "0 3 * * *", timeZone: "Europe/Rome" })

        expect(values.maintenance).toEqual({ schedule: "0 3 * * *", suspend: false, timeZone: "Europe/Rome" })
        expect(values.replicas).toBe(0)
        expect(values.expose).toEqual({ service: false })
    })

    it("given no schedule, when its values are rendered, then the CronJob is suspended until Play starts it", () => {
        expect(agent({ schedule: null }).maintenance).toEqual({ schedule: PAUSED_SCHEDULE, suspend: true })
    })

    it("given a container, when its values are rendered, then it keeps its Deployment and the CronJob calls its run path inside the environment", () => {
        const values = agent({ kind: MaintenanceAgentKind.CONTAINER, schedule: "@hourly", runPath: "/jobs/clean" })

        expect(values.replicas).toBe(1)
        expect(values.maintenance.trigger).toEqual({ url: "http://cleaner/jobs/clean" })
    })

    it("given targets, when its values are rendered, then the container receives them as JSON", () => {
        expect(agent({}).env).toEqual([{ name: "MAINTAINED_TARGETS", value: JSON.stringify(targets) }])
    })

    it("given a backend, when its values are rendered, then there is no CronJob", () => {
        const values = parse(renderApplicationValues({ slug: "orders", version: "1.0.0", image: { repository: "ghcr.io/acme/orders" } }, environment, mapNames))

        expect(values.maintenance).toBeUndefined()
        expect(values.env).toBeUndefined()
    })
})

describe("CHART_FILES", () => {
    it("given the chart, when its files are listed, then the CronJob template is a file of its own", () => {
        expect(CHART_FILES.map(file => file.path)).toContain(`${APPLICATIONS_CHART_FOLDER}/templates/cronjob.yaml`)
    })

    it("given the chart, when its files are listed, then they all sit in the chart folder and include Chart.yaml", () => {
        expect(CHART_FILES.every(file => file.path.startsWith(`${APPLICATIONS_CHART_FOLDER}/`))).toBe(true)
        expect(CHART_FILES.map(file => file.path)).toContain(`${APPLICATIONS_CHART_FOLDER}/Chart.yaml`)
        expect(CHART_FILES.map(file => file.path)).toContain(`${APPLICATIONS_CHART_FOLDER}/templates/httproute.yaml`)
    })
})
