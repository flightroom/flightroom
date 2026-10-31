import { Types } from "mongoose"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { MaintenanceAgentKind } from "../../types/MaintenanceAgent"
import {
    APPLICATIONS_CHART_FOLDER,
    applicationImageRepository,
    backendFrontendPath,
    CHART_FILES,
    exposedUrl,
    isDeployable,
    MANAGED_VALUES_MARKER,
    PAUSED_SCHEDULE,
    renderApplicationValues,
    splitImage
} from "./applicationManifests"

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

    it("given a bare name as image repository and a registry in the project, when the image is resolved, then it is the name in the registry", () => {
        expect(applicationImageRepository({ slug: "orders", image: { repository: " bacheca-team-fe " } }, "azimutmarketplace.azurecr.io")).toBe("azimutmarketplace.azurecr.io/bacheca-team-fe")
    })

    it("given a bare name as image repository and no registry in the project, when the image is resolved, then it is the name as written", () => {
        expect(applicationImageRepository({ slug: "orders", image: { repository: "nginx" } })).toBe("nginx")
    })

    it("given no image and no registry in the project, when the image is resolved, then there is none", () => {
        expect(applicationImageRepository({ slug: "orders" })).toBeUndefined()
    })
})

describe("isDeployable", () => {
    const environmentId = new Types.ObjectId()
    const inEnvironment = { environmentVersions: [{ environmentId, version: "1.0.0" }] }

    it("given a version and an image, when it is checked, then the application can be deployed", () => {
        expect(isDeployable({ slug: "orders", ...inEnvironment, image: { repository: "ghcr.io/acme/orders" } })).toBe(true)
    })

    it("given a version in another environment only, when it is checked for this one, then the application is left out", () => {
        const application = { slug: "orders", ...inEnvironment, image: { repository: "ghcr.io/acme/orders" } }

        expect(isDeployable(application, undefined, environmentId)).toBe(true)
        expect(isDeployable(application, undefined, new Types.ObjectId())).toBe(false)
    })

    it("given only the version the CI registered, when it is checked, then the application is left out", () => {
        expect(isDeployable({ slug: "orders", version: "1.0.0", image: { repository: "ghcr.io/acme/orders" } })).toBe(false)
    })

    it.each([
        ["no version", { slug: "orders", image: { repository: "ghcr.io/acme/orders" } }],
        ["no image", { slug: "orders", ...inEnvironment }],
        ["an empty repository", { slug: "orders", ...inEnvironment, image: { repository: "" } }]
    ])("given %s, when it is checked, then the application is left out", (_case, application) => {
        expect(isDeployable(application)).toBe(false)
    })

    it("given a version and no image, when the project has a container registry, then the application can be deployed", () => {
        expect(isDeployable({ slug: "orders", ...inEnvironment }, "ghcr.io/acme")).toBe(true)
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
        environmentVersions: [{ environmentId: environment._id, version: "1.2.3" }],
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

    it("given an environment with an IP allow list, when its values are rendered, then the route goes through its Middleware", () => {
        const gateway = { name: "mfe-shop-1a2b3c", listener: "https", hsts: true, ipAllowList: "mfe-shop-1a2b3c-ip-allowlist" }
        const values = parse(renderApplicationValues({ ...application, exposurePath: "/api/orders" }, environment, mapNames, gateway))

        expect(values.route.ipAllowList).toBe("mfe-shop-1a2b3c-ip-allowlist")
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

    it("given some of its CPU and memory, when its values are rendered, then only those are written, for the chart to fill in the others", () => {
        const values = parse(render({ cpuRequest: "250m", memoryLimit: "1Gi", cpuLimit: null, memoryRequest: " " }))

        expect(values.resources).toEqual({ requests: { cpu: "250m" }, limits: { memory: "1Gi" } })
    })

    it.each([
        ["none of them", {}],
        ["all of them blank or null", { cpuRequest: "", cpuLimit: null, memoryRequest: " ", memoryLimit: null }]
    ])("given %s, when its values are rendered, then there are no resources and the chart decides", (_case, overrides) => {
        expect(parse(render(overrides))).not.toHaveProperty("resources")
    })

    it("given CPU and memory set apart in this environment, when its values are rendered, then they win over the application's, which fill in the others", () => {
        const environmentResources = [{ environmentId: environment._id, cpuLimit: "2", memoryLimit: "2Gi", memoryRequest: " " }]
        const values = parse(render({ cpuRequest: "250m", cpuLimit: "500m", memoryRequest: "256Mi", environmentResources }))

        expect(values.resources).toEqual({ requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "2", memory: "2Gi" } })
    })

    it("given CPU and memory set apart in another environment, when its values are rendered, then the application's are written", () => {
        const values = parse(render({ cpuRequest: "250m", environmentResources: [{ environmentId: new Types.ObjectId(), cpuRequest: "1" }] }))

        expect(values.resources).toEqual({ requests: { cpu: "250m" } })
    })

    it.each([
        ["none set", {}, 1],
        ["the application's", { replicas: 2 }, 2],
        ["this environment's over the application's", { replicas: 2, environmentResources: [{ environmentId: environment._id, replicas: 4 }] }, 4],
        ["the application's where another environment sets its own", { replicas: 2, environmentResources: [{ environmentId: new Types.ObjectId(), replicas: 4 }] }, 2],
        ["zero in this environment over the application's, not taken for unset", { replicas: 2, environmentResources: [{ environmentId: environment._id, replicas: 0 }] }, 0]
    ])("given replicas %s, when its values are rendered, then the Deployment runs that many", (_case, overrides, replicas) => {
        expect(parse(render(overrides)).replicas).toBe(replicas)
    })

    it("given this environment runs a version of its own, when its values are rendered, then the image is tagged with it", () => {
        expect(parse(render({ environmentVersions: [{ environmentId: environment._id, version: "1.1.0" }] })).image.tag).toBe("1.1.0")
    })

    it.each([
        ["only another environment runs a version", [{ environmentId: new Types.ObjectId(), version: "1.1.0" }]],
        ["this environment leaves its version blank", [{ environmentId: environment._id, version: " " }]],
        ["no environment runs a version", []]
    ])("given %s, when its values are rendered, then it is refused whatever version the CI registered", (_case, environmentVersions) => {
        expect(() => render({ environmentVersions })).toThrow()
    })

    it("given an environment that never set its logging, when its values are rendered, then the container logs at info in JSON and gets no FRONTEND_URL", () => {
        expect(parse(render()).env).toEqual([
            { name: "LOG_LEVEL", value: "info" },
            { name: "LOG_JSON", value: "true" },
            { name: "OTEL_SERVICE_NAME", value: "orders" },
            { name: "OTEL_RESOURCE_ATTRIBUTES", value: "deployment.environment=production,service.version=1.2.3" }
        ])
    })

    it("given an environment that logs at debug in JSON and a frontend URL, when its values are rendered, then the container gets all three", () => {
        const values = parse(renderApplicationValues(application, { ...environment, logLevel: "debug", logJson: true }, mapNames, undefined, undefined, "https://dev.example.com/shop"))

        expect(values.env).toEqual([
            { name: "LOG_LEVEL", value: "debug" },
            { name: "LOG_JSON", value: "true" },
            { name: "FRONTEND_URL", value: "https://dev.example.com/shop" },
            { name: "OTEL_SERVICE_NAME", value: "orders" },
            { name: "OTEL_RESOURCE_ATTRIBUTES", value: "deployment.environment=production,service.version=1.2.3" }
        ])
    })

    it("given an environment that turned JSON logs off, when its values are rendered, then the container logs plain text", () => {
        expect(parse(renderApplicationValues(application, { ...environment, logJson: false }, mapNames)).env[1]).toEqual({ name: "LOG_JSON", value: "false" })
    })

    it("given a log level that is not one, when its values are rendered, then the container logs at info", () => {
        expect(parse(renderApplicationValues(application, { ...environment, logLevel: "verbose" }, mapNames)).env[0]).toEqual({ name: "LOG_LEVEL", value: "info" })
    })

    it("given a version with characters that split the attribute list, when its values are rendered, then the version is percent-encoded", () => {
        const values = parse(render({ environmentVersions: [{ environmentId: environment._id, version: "1.2.3+build,7" }] }))

        expect(values.env).toContainEqual({ name: "OTEL_RESOURCE_ATTRIBUTES", value: "deployment.environment=production,service.version=1.2.3%2Bbuild%2C7" })
    })
})

describe("backendFrontendPath", () => {
    const backendId = new Types.ObjectId()

    it("given one exposed frontend calling the backend, when its path is read, then it is that frontend's", () => {
        const frontends = [
            { exposurePath: "/shop/", backendIds: [backendId] },
            { exposurePath: "/admin", backendIds: [new Types.ObjectId()] }
        ]

        expect(backendFrontendPath(String(backendId), frontends)).toBe("/shop/")
    })

    it.each([
        ["no frontend calls it", [{ exposurePath: "/shop", backendIds: [] }]],
        [
            "several frontends call it",
            [
                { exposurePath: "/shop", backendIds: [backendId] },
                { exposurePath: "/admin", backendIds: [backendId] }
            ]
        ],
        ["the frontend calling it is not exposed", [{ exposurePath: null, backendIds: [backendId] }]]
    ])("given %s, when its path is read, then it is the root of the environment", (_case, frontends) => {
        expect(backendFrontendPath(backendId, frontends)).toBe("/")
    })
})

describe("exposedUrl", () => {
    it.each([
        ["https://dev.example.com", "/shop/", "https://dev.example.com/shop"],
        ["https://example.com", "/", "https://example.com"],
        [undefined, "/shop", undefined],
        ["https://example.com", null, undefined]
    ])("given the origin %s and the path %s, when the URL is built, then it is %s", (origin, path, url) => {
        expect(exposedUrl(origin, path)).toBe(url)
    })
})

describe("renderApplicationValues, maintenance agent", () => {
    const environment = { _id: new Types.ObjectId(), slug: "production" }
    const mapNames = { configMaps: new Map<string, string>(), secrets: new Map<string, string>() }
    const targets = [{ kind: "service" as const, slug: "orders", url: "http://orders" }]
    const agent = (maintenance: Partial<{ kind: MaintenanceAgentKind; schedule: string | null; timeZone: string | null; runPath: string }>) =>
        parse(
            renderApplicationValues(
                {
                    slug: "cleaner",
                    environmentVersions: [{ environmentId: environment._id, version: "1.0.0" }],
                    image: { repository: "ghcr.io/acme/cleaner" },
                    maintenance: { kind: MaintenanceAgentKind.JOB, runPath: "/run", targets, ...maintenance }
                },
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
        expect(agent({}).env).toContainEqual({ name: "MAINTAINED_TARGETS", value: JSON.stringify(targets) })
    })

    it("given an agent, when its values are rendered, then its container reads the Secret with the URL of the console and its token, after its own secrets", () => {
        const values = parse(
            renderApplicationValues(
                {
                    slug: "cleaner",
                    environmentVersions: [{ environmentId: environment._id, version: "1.0.0" }],
                    image: { repository: "ghcr.io/acme/cleaner" },
                    secretIds: ["s1"],
                    maintenance: { kind: MaintenanceAgentKind.JOB, runPath: "/run", targets }
                },
                environment,
                { ...mapNames, secrets: new Map([["s1", "smtp"]]) }
            )
        )

        expect(values.secrets).toEqual(["smtp", "cleaner.flightroom"])
    })

    it("given a backend, when its values are rendered, then there is no CronJob", () => {
        const values = parse(
            renderApplicationValues(
                { slug: "orders", environmentVersions: [{ environmentId: environment._id, version: "1.0.0" }], image: { repository: "ghcr.io/acme/orders" } },
                environment,
                mapNames
            )
        )

        expect(values.maintenance).toBeUndefined()
        expect(values.env.map((variable: { name: string }) => variable.name)).not.toContain("MAINTAINED_TARGETS")
        expect(values.secrets).toEqual([])
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

    it("given the HTTPRoute template, when it is listed, then it applies the Middleware of the environment and replaces the version written before it", () => {
        const route = CHART_FILES.find(file => file.path === `${APPLICATIONS_CHART_FOLDER}/templates/httproute.yaml`)!

        expect(route.content).toContain("type: ExtensionRef")
        expect(route.content).toContain("name: {{ . }}")
        expect(route.replaces).toHaveLength(1)
        expect(route.replaces![0]).not.toContain("ipAllowList")
        expect(route.replaces![0]).toContain("kind: HTTPRoute")
    })
})
