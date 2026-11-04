import { Types } from "mongoose"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { MaintenanceAgentKind } from "../../types/MaintenanceAgent"
import {
    APPLICATIONS_CHART_FOLDER,
    applicationImageRepository,
    backendEnvSecretName,
    CHART_FILES,
    containerEnvironment,
    containerPublicUrl,
    exposedUrl,
    gatewayOrigin,
    isDeployable,
    MANAGED_VALUES_MARKER,
    PAUSED_SCHEDULE,
    renderApplicationValues,
    serviceUrls,
    serviceUrlVariable,
    splitImage,
    UPDATED_AT_LABEL
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

    it("given an environment on Application Insights, when its values are rendered, then the platform's Secret of the telemetry is the first of the secrets", () => {
        const values = parse(renderApplicationValues(application, environment, { ...mapNames, telemetry: true }))

        expect(values.environmentMaps).toEqual(["services.flightroom", "logging"])
        expect(values.secrets).toEqual(["telemetry.flightroom", "database"])
    })

    it("given an environment not on Application Insights, when its values are rendered, then no Secret of the telemetry is named", () => {
        expect(parse(render()).secrets).toEqual(["database"])
    })

    it("given an application deployed continuously in the environment, when its values are rendered, then the image is always pulled and the pods carry the time of the deploy", () => {
        const deployedAt = new Date("2026-11-04T10:00:00Z")
        const values = parse(
            renderApplicationValues({ ...application, continuousDeploymentEnvironmentIds: [environment._id] }, environment, mapNames, undefined, undefined, undefined, undefined, deployedAt)
        )

        expect(values.image).toEqual({ host: "ghcr.io", name: "acme/orders", tag: "1.2.3", pullPolicy: "Always" })
        expect(values.podLabels).toEqual({ [UPDATED_AT_LABEL]: String(deployedAt.getTime()) })
    })

    it("given an application deployed continuously in another environment only, when its values are rendered, then the pull policy and the labels of the chart stay", () => {
        const values = parse(render({ continuousDeploymentEnvironmentIds: [new Types.ObjectId()] }))

        expect(values.image.pullPolicy).toBeUndefined()
        expect(values.podLabels).toBeUndefined()
    })

    it("given a maintenance agent deployed continuously, when its values are rendered, then its CronJob pulls as it always did", () => {
        const maintenance = { kind: MaintenanceAgentKind.JOB, schedule: "0 3 * * *", runPath: "/run", targets: [] }
        const values = parse(render({ continuousDeploymentEnvironmentIds: [environment._id], maintenance }))

        expect(values.image.pullPolicy).toBeUndefined()
        expect(values.podLabels).toBeUndefined()
    })

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

        expect(values.environmentMaps).toEqual(["services.flightroom", "logging"])
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
        expect(values.probes).toEqual({ liveness: { active: true, path: "/live" }, readiness: { active: true, path: "/health/ready" } })
    })

    it("given a probe template of the project, when its values are rendered, then what the application sets wins and the template fills in the rest", () => {
        const template = { livenessPath: "/healthz", readinessPath: "/readyz", livenessInitialDelaySeconds: 60, readinessPeriodSeconds: 5 }
        const values = parse(renderApplicationValues({ ...application, livenessInitialDelaySeconds: 90 }, environment, mapNames, undefined, undefined, undefined, template))

        expect(values.probes).toEqual({
            liveness: { active: true, path: "/live", initialDelaySeconds: 90 },
            readiness: { active: true, path: "/readyz", periodSeconds: 5 }
        })
    })

    it("given the timings of its probes, when its values are rendered, then each probe gets its own and leaves the others to the chart", () => {
        const values = parse(render({ readinessPath: "/ready", livenessInitialDelaySeconds: 120, livenessPeriodSeconds: 10, readinessInitialDelaySeconds: 0, readinessPeriodSeconds: null }))

        expect(values.probes).toEqual({
            liveness: { active: true, path: "/live", initialDelaySeconds: 120, periodSeconds: 10 },
            readiness: { active: true, path: "/ready", initialDelaySeconds: 0 }
        })
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

    it("given an environment that never set its logging, when its values are rendered, then the container logs at info in JSON and gets no PUBLIC_URL", () => {
        expect(parse(render()).env).toEqual([
            { name: "LOG_LEVEL", value: "info" },
            { name: "LOG_JSON", value: "true" },
            { name: "ENVIRONMENT", value: "production" },
            { name: "OTEL_SERVICE_NAME", value: "orders" },
            { name: "OTEL_RESOURCE_ATTRIBUTES", value: "deployment.environment=production,service.version=1.2.3" }
        ])
    })

    it("given an environment that logs at debug in JSON and a frontend URL, when its values are rendered, then the container gets all three", () => {
        const values = parse(renderApplicationValues(application, { ...environment, logLevel: "debug", logJson: true }, mapNames, undefined, undefined, "https://dev.example.com/shop"))

        expect(values.env).toEqual([
            { name: "LOG_LEVEL", value: "debug" },
            { name: "LOG_JSON", value: "true" },
            { name: "ENVIRONMENT", value: "production" },
            { name: "PUBLIC_URL", value: "https://dev.example.com/shop" },
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

    it("given an application with a log level of its own, when its values are rendered, then it wins over the environment's", () => {
        expect(parse(renderApplicationValues({ ...application, logLevel: "trace" }, { ...environment, logLevel: "warn" }, mapNames)).env[0]).toEqual({ name: "LOG_LEVEL", value: "trace" })
    })

    it.each([
        ["none", null],
        ["one that is not a level", "verbose"]
    ])("given an application that sets %s as its log level, when its values are rendered, then the environment's applies", (_case, logLevel) => {
        expect(parse(renderApplicationValues({ ...application, logLevel }, { ...environment, logLevel: "warn" }, mapNames)).env[0]).toEqual({ name: "LOG_LEVEL", value: "warn" })
    })

    it("given a version with characters that split the attribute list, when its values are rendered, then the version is percent-encoded", () => {
        const values = parse(render({ environmentVersions: [{ environmentId: environment._id, version: "1.2.3+build,7" }] }))

        expect(values.env).toContainEqual({ name: "OTEL_RESOURCE_ATTRIBUTES", value: "deployment.environment=production,service.version=1.2.3%2Bbuild%2C7" })
    })
})

describe("renderApplicationValues, variables of the backend", () => {
    const environment = { _id: new Types.ObjectId(), slug: "production" }
    const configMapId = new Types.ObjectId()
    const secretId = new Types.ObjectId()
    const resourceId = new Types.ObjectId()
    const mapNames = {
        configMaps: new Map([[String(configMapId), "logging"]]),
        secrets: new Map([[String(secretId), "database"]]),
        resources: new Map([[String(resourceId), "orders-db.resource"]])
    }
    const backend = {
        slug: "orders",
        environmentVersions: [{ environmentId: environment._id, version: "1.2.3" }],
        image: { repository: "ghcr.io/acme/orders" },
        configMapIds: [configMapId],
        secretIds: [secretId],
        resourceIds: [resourceId],
        env: [
            { name: "FEATURE_FLAGS", secret: false, value: "beta" },
            { name: "LOG_LEVEL", secret: false, value: "trace" },
            { name: "HTTP_PORT", secret: false, value: "9999" },
            { name: "API_TOKEN", secret: true, value: "hunter2" },
            { name: "DECLARED_ONLY", secret: false },
            { name: "EMPTY_SECRET", secret: true, value: "" }
        ]
    }
    const values = (application: typeof backend = backend) => parse(renderApplicationValues(application, environment, mapNames))

    it("given plain variables with a value, when its values are rendered, then they come first of env and the platform's after, so the platform wins a name set twice", () => {
        const env: Array<{ name: string; value: string }> = values().env

        expect(env.slice(0, 2)).toEqual([
            { name: "FEATURE_FLAGS", value: "beta" },
            { name: "LOG_LEVEL", value: "trace" }
        ])
        expect(env.filter(variable => variable.name === "LOG_LEVEL").at(-1)).toEqual({ name: "LOG_LEVEL", value: "info" })
    })

    it("given a plain HTTP_PORT, when its values are rendered, then it is left out: the chart writes HTTP_PORT before the whole list", () => {
        expect(values().env.map((variable: { name: string }) => variable.name)).not.toContain("HTTP_PORT")
    })

    it("given variables with no value, when its values are rendered, then they are not injected", () => {
        const rendered = renderApplicationValues(backend, environment, mapNames)

        expect(rendered).not.toContain("DECLARED_ONLY")
        expect(rendered).not.toContain("EMPTY_SECRET")
    })

    it("given a secret variable with a value, when its values are rendered, then its value is not in them and its Secret is the last of the secrets", () => {
        const rendered = renderApplicationValues(backend, environment, mapNames)

        expect(rendered).not.toContain("hunter2")
        expect(parse(rendered).secrets).toEqual(["database", "orders-db.resource", backendEnvSecretName("orders")])
        expect(backendEnvSecretName("orders")).toBe("orders.env")
    })

    it("given no secret variable with a value, when its values are rendered, then no Secret of the backend is listed", () => {
        expect(values({ ...backend, env: backend.env.filter(variable => variable.name !== "API_TOKEN") }).secrets).toEqual(["database", "orders-db.resource"])
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

    it.each(["values.yaml", "templates/deployment.yaml"])("given %s, when it is listed, then the period of each probe comes from the values and it replaces the version with a fixed one", file => {
        const chartFile = CHART_FILES.find(candidate => candidate.path === `${APPLICATIONS_CHART_FOLDER}/${file}`)!

        expect(chartFile.content).toMatch(/periodSeconds: (30|\{\{ \.Values\.probes\.liveness\.periodSeconds \| default 30 \}\})/)
        expect(chartFile.content).not.toContain("periodSeconds: 30\n          {{- end }}")
        expect(chartFile.replaces!.length).toBeGreaterThanOrEqual(1)
        expect(chartFile.replaces).not.toContain(chartFile.content)
    })

    it("given the Deployment template, when it is listed, then it takes the pull policy and the labels of the pods from the values, and replaces the version without them", () => {
        const deployment = CHART_FILES.find(file => file.path === `${APPLICATIONS_CHART_FOLDER}/templates/deployment.yaml`)!

        expect(deployment.content).toContain("{{- with .Values.image.pullPolicy }}\n          imagePullPolicy: {{ . }}")
        expect(deployment.content).toContain("{{- with .Values.podLabels }}\n        {{- toYaml . | nindent 8 }}")
        expect(deployment.replaces).toHaveLength(2)
        expect(deployment.replaces!.every(previous => !previous.includes("imagePullPolicy") && !previous.includes("podLabels"))).toBe(true)
    })
})

describe("containerEnvironment", () => {
    const environment = { _id: "e1", slug: "production", logLevel: "debug", logJson: false }
    const mapNames = {
        configMaps: new Map([
            ["c1", "logging"],
            ["c2", "features"]
        ]),
        secrets: new Map([["s1", "database"]]),
        resources: new Map([["r1", "orders-db.resource"]])
    }
    const backend = {
        _id: "b1",
        slug: "orders",
        environmentVersions: [{ environmentId: "e1", version: "1.2.3" }],
        image: { repository: "ghcr.io/acme/orders" },
        port: 3000,
        exposurePath: "/api/orders",
        livenessPath: "/live",
        memoryLimit: "1Gi",
        configMapIds: ["c1", "missing", "c2"],
        secretIds: ["s1"],
        resourceIds: ["r1"]
    }
    const agent = {
        slug: "cleaner",
        environmentVersions: [{ environmentId: "e1", version: "1.0.0" }],
        image: { repository: "ghcr.io/acme/cleaner" },
        configMapIds: ["c2"],
        secretIds: ["s1"],
        maintenance: { kind: MaintenanceAgentKind.CONTAINER, schedule: "@hourly", runPath: "/run", targets: [{ kind: "service" as const, slug: "orders", url: "http://orders" }] }
    }
    const values = {
        services: { ORDERS_URL: "http://orders", PAYMENTS_BE_URL: "http://payments-be" },
        configMaps: new Map<string, Record<string, string>>([
            ["c1", { LOG_LEVEL: "warn", LOG_FORMAT: "pretty", FEATURE_X: "off", PAYMENTS_BE_URL: "https://payments.example.com" }],
            ["c2", { FEATURE_X: "on" }]
        ]),
        secrets: new Map([["s1", { DB_PASSWORD: "hunter2-very-secret", FEATURE_X: "secret-on" }]]),
        resources: new Map([["r1", { DB_ORDERS_HOST: "db.internal", DB_ORDERS_PASSWORD: "p4ss" }]])
    }
    const variables = () => containerEnvironment(backend, environment, mapNames, values, "1.2.3", "https://shop.example.com/shop")
    const named = (name: string) => variables().filter(variable => variable.name === name)

    it("given a backend, when its values are rendered, then they are byte for byte what the deploy wrote before the environment was extracted", () => {
        expect(renderApplicationValues(backend, environment, mapNames, { name: "shop-gw", listener: "https", hsts: true }, undefined, "https://shop.example.com/shop")).toBe(
            `# app.kubernetes.io/managed-by: flightroom
# Written by every deploy of production: a change made here is overwritten.
replicas: 1
image:
  host: ghcr.io
  name: acme/orders
  tag: 1.2.3
containerPort: 3000
resources:
  limits:
    memory: 1Gi
probes:
  liveness:
    active: true
    path: /live
  readiness:
    active: true
    path: /health/ready
environmentMaps:
  - services.flightroom
  - logging
  - features
secrets:
  - database
  - orders-db.resource
env:
  - name: LOG_LEVEL
    value: debug
  - name: LOG_JSON
    value: "false"
  - name: ENVIRONMENT
    value: production
  - name: PUBLIC_URL
    value: https://shop.example.com/shop
  - name: OTEL_SERVICE_NAME
    value: orders
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: deployment.environment=production,service.version=1.2.3
route:
  gateway: shop-gw
  listener: https
  path: /api/orders
  hsts: true
`
        )
    })

    it("given a maintenance agent, when its values are rendered, then they are byte for byte what the deploy wrote before the environment was extracted", () => {
        expect(renderApplicationValues(agent, environment, mapNames)).toBe(
            `# app.kubernetes.io/managed-by: flightroom
# Written by every deploy of production: a change made here is overwritten.
replicas: 1
image:
  host: ghcr.io
  name: acme/cleaner
  tag: 1.0.0
containerPort: 8080
probes:
  liveness:
    active: true
    path: /health/live
  readiness:
    active: true
    path: /health/ready
environmentMaps:
  - services.flightroom
  - features
secrets:
  - database
  - cleaner.flightroom
env:
  - name: MAINTAINED_TARGETS
    value: '[{"kind":"service","slug":"orders","url":"http://orders"}]'
  - name: LOG_LEVEL
    value: debug
  - name: LOG_JSON
    value: "false"
  - name: ENVIRONMENT
    value: production
  - name: OTEL_SERVICE_NAME
    value: cleaner
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: deployment.environment=production,service.version=1.0.0
maintenance:
  schedule: "@hourly"
  suspend: false
  trigger:
    url: http://cleaner/run
`
        )
    })

    it("given a backend, when its environment is built, then the platform's variables come first, in clear, HTTP_PORT from its port", () => {
        expect(variables().slice(0, 7)).toEqual([
            { name: "HTTP_PORT", source: "platform", value: "3000" },
            { name: "LOG_LEVEL", source: "platform", value: "debug" },
            { name: "LOG_JSON", source: "platform", value: "false" },
            { name: "ENVIRONMENT", source: "platform", value: "production" },
            { name: "PUBLIC_URL", source: "platform", value: "https://shop.example.com/shop" },
            { name: "OTEL_SERVICE_NAME", source: "platform", value: "orders" },
            { name: "OTEL_RESOURCE_ATTRIBUTES", source: "platform", value: "deployment.environment=production,service.version=1.2.3" }
        ])
    })

    it("given a name a config map sets too, when the environment is built, then env wins over envFrom", () => {
        expect(named("LOG_LEVEL")).toEqual([
            { name: "LOG_LEVEL", source: "platform", value: "debug" },
            { name: "LOG_LEVEL", source: "configMap logging", value: "warn", overriddenBy: "platform" }
        ])
    })

    it("given a name several envFrom sources set, when the environment is built, then the last one in the chart's order wins", () => {
        expect(named("FEATURE_X")).toEqual([
            { name: "FEATURE_X", source: "configMap logging", value: "off", overriddenBy: "secret database" },
            { name: "FEATURE_X", source: "configMap features", value: "on", overriddenBy: "secret database" },
            { name: "FEATURE_X", source: "secret database", masked: { set: true, length: 9 } }
        ])
    })

    it("given secrets and resources, when the environment is built, then their values are masked with their length and a config map's are shown", () => {
        const json = JSON.stringify(variables())
        expect(named("DB_PASSWORD")).toEqual([{ name: "DB_PASSWORD", source: "secret database", masked: { set: true, length: 19 } }])
        expect(named("DB_ORDERS_HOST")).toEqual([{ name: "DB_ORDERS_HOST", source: "resource orders-db.resource", masked: { set: true, length: 11 } }])
        expect(named("LOG_FORMAT")).toEqual([{ name: "LOG_FORMAT", source: "configMap logging", value: "pretty" }])
        expect(json).not.toContain("hunter2")
        expect(json).not.toContain("p4ss")
        expect(json).not.toContain("db.internal")
    })

    it("given the URLs of the backends, when the environment is built, then they come first of the envFrom, and a config map of the team setting one wins", () => {
        expect(named("ORDERS_URL")).toEqual([{ name: "ORDERS_URL", source: "configMap services.flightroom", value: "http://orders" }])
        expect(named("PAYMENTS_BE_URL")).toEqual([
            { name: "PAYMENTS_BE_URL", source: "configMap services.flightroom", value: "http://payments-be", overriddenBy: "configMap logging" },
            { name: "PAYMENTS_BE_URL", source: "configMap logging", value: "https://payments.example.com" }
        ])
    })

    it("given a config map deleted since, when the environment is built, then it is left out as the deploy leaves it out", () => {
        expect(new Set(variables().map(variable => variable.source))).toEqual(
            new Set(["platform", "configMap services.flightroom", "configMap logging", "configMap features", "secret database", "resource orders-db.resource"])
        )
    })

    it("given an environment on Application Insights, when the environment is built, then the connection string comes from the platform's Secret masked, a resource setting it wins", () => {
        const connectionString = "InstrumentationKey=abc;IngestionEndpoint=https://example.in.applicationinsights.azure.com/"
        const telemetryValues = {
            ...values,
            resources: new Map([["r1", { APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=own" }]]),
            telemetry: { APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString }
        }

        const found = containerEnvironment(backend, environment, { ...mapNames, telemetry: true }, telemetryValues, "1.2.3").filter(
            variable => variable.name === "APPLICATIONINSIGHTS_CONNECTION_STRING"
        )

        expect(found).toEqual([
            {
                name: "APPLICATIONINSIGHTS_CONNECTION_STRING",
                source: "secret telemetry.flightroom",
                masked: { set: true, length: connectionString.length },
                overriddenBy: "resource orders-db.resource"
            },
            { name: "APPLICATIONINSIGHTS_CONNECTION_STRING", source: "resource orders-db.resource", masked: { set: true, length: "InstrumentationKey=own".length } }
        ])
    })

    it("given an environment not on Application Insights, when the environment is built, then no variable comes from the Secret of the telemetry", () => {
        expect(variables().map(variable => variable.source)).not.toContain("secret telemetry.flightroom")
    })

    it("given a CONTAINER maintenance agent, whose Deployment runs it, when its environment is built, then it gets HTTP_PORT, its targets and the platform's Secret masked, without the token read", () => {
        const agentVariables = containerEnvironment(agent, environment, mapNames, values, "1.0.0")

        expect(agentVariables).toContainEqual({ name: "MAINTAINED_TARGETS", source: "platform", value: JSON.stringify(agent.maintenance.targets) })
        expect(agentVariables).toContainEqual({ name: "HTTP_PORT", source: "platform", value: "8080" })
        expect(agentVariables.slice(-2)).toEqual([
            { name: "FLIGHTROOM_API_URL", source: "platform", masked: { set: true } },
            { name: "FLIGHTROOM_AGENT_TOKEN", source: "platform", masked: { set: true } }
        ])
        expect(agentVariables.map(variable => variable.name)).not.toContain("PUBLIC_URL")
    })

    it("given a JOB maintenance agent, which only its CronJob runs, when its environment is built, then there is no HTTP_PORT: the CronJob does not set it", () => {
        const job = { ...agent, maintenance: { ...agent.maintenance, kind: MaintenanceAgentKind.JOB } }

        const names = containerEnvironment(job, environment, mapNames, values, "1.0.0").map(variable => variable.name)

        expect(names).not.toContain("HTTP_PORT")
        expect(names).toContain("MAINTAINED_TARGETS")
    })
})

describe("containerEnvironment, variables of the backend", () => {
    const environment = { _id: "e1", slug: "production" }
    const mapNames = { configMaps: new Map([["c1", "logging"]]), secrets: new Map([["s1", "database"]]) }
    const backend = {
        slug: "orders",
        environmentVersions: [{ environmentId: "e1", version: "1.2.3" }],
        image: { repository: "ghcr.io/acme/orders" },
        configMapIds: ["c1"],
        secretIds: ["s1"],
        env: [
            { name: "FEATURE_X", secret: false, value: "beta" },
            { name: "LOG_LEVEL", secret: false, value: "trace" },
            { name: "HTTP_PORT", secret: false, value: "9999" },
            { name: "DB_PASSWORD", secret: true, value: "hunter2" },
            { name: "DECLARED_ONLY", secret: false }
        ]
    }
    const values = {
        services: {},
        configMaps: new Map([["c1", { FEATURE_X: "off" }]]),
        secrets: new Map([["s1", { DB_PASSWORD: "from-the-map" }]]),
        resources: new Map()
    }
    const variables = () => containerEnvironment(backend, environment, mapNames, values, "1.2.3")
    const named = (name: string) => variables().filter(variable => variable.name === name)

    it("given a plain variable a config map sets too, when the environment is built, then the backend's wins, in clear", () => {
        expect(named("FEATURE_X")).toEqual([
            { name: "FEATURE_X", source: "backend", value: "beta" },
            { name: "FEATURE_X", source: "configMap logging", value: "off", overriddenBy: "backend" }
        ])
    })

    it("given a plain variable the platform sets too, HTTP_PORT included, when the environment is built, then the platform's wins", () => {
        expect(named("LOG_LEVEL")).toEqual([
            { name: "LOG_LEVEL", source: "backend", value: "trace", overriddenBy: "platform" },
            { name: "LOG_LEVEL", source: "platform", value: "info" }
        ])
        expect(named("HTTP_PORT")).toEqual([
            { name: "HTTP_PORT", source: "backend", value: "9999", overriddenBy: "platform" },
            { name: "HTTP_PORT", source: "platform", value: "8080" }
        ])
    })

    it("given a secret variable a secret sets too, when the environment is built, then the backend's wins, masked with its length", () => {
        expect(named("DB_PASSWORD")).toEqual([
            { name: "DB_PASSWORD", source: "secret database", masked: { set: true, length: 12 }, overriddenBy: "backend" },
            { name: "DB_PASSWORD", source: "backend", masked: { set: true, length: 7 } }
        ])
        expect(JSON.stringify(variables())).not.toContain("hunter2")
    })

    it("given a variable with no value, when the environment is built, then it is not there", () => {
        expect(named("DECLARED_ONLY")).toEqual([])
    })
})

describe("serviceUrls", () => {
    it.each([
        ["orders-be", "ORDERS_BE_URL"],
        ["payments", "PAYMENTS_URL"],
        ["v2-api", "V2_API_URL"]
    ])("given the backend %s, when its variable is named, then it is %s", (slug, name) => {
        expect(serviceUrlVariable(slug)).toBe(name)
    })

    it("given backends with and without a version in the environment, when the URLs are listed, then only those it runs are there, by slug, on port 80 of their Service", () => {
        const backends = [
            { slug: "orders-be", environmentVersions: [{ environmentId: "e1", version: "1.0.0" }], image: { repository: "ghcr.io/acme/orders-be" } },
            { slug: "billing-be", environmentVersions: [{ environmentId: "e2", version: "1.0.0" }], image: { repository: "ghcr.io/acme/billing-be" } },
            { slug: "audit-be", environmentVersions: [{ environmentId: "e1", version: "1.0.0" }] }
        ]

        expect(serviceUrls(backends, "e1")).toEqual({ ORDERS_BE_URL: "http://orders-be" })
        expect(serviceUrls(backends, "e1", "registry.example.com")).toEqual({ AUDIT_BE_URL: "http://audit-be", ORDERS_BE_URL: "http://orders-be" })
    })
})

describe("containerPublicUrl", () => {
    it("given a frontend, a backend and a maintenance agent, when PUBLIC_URL is resolved, then it is where each container is exposed, and none for the agent", () => {
        const origin = gatewayOrigin({ host: "dev.example.com", certificateIssuer: "letsencrypt" })

        expect(containerPublicUrl("frontend", { exposurePath: "/checkout/" }, origin)).toBe("https://dev.example.com/checkout")
        expect(containerPublicUrl("backend", { exposurePath: "/products-database/" }, origin)).toBe("https://dev.example.com/products-database")
        expect(containerPublicUrl("backend", {}, origin)).toBeUndefined()
        expect(containerPublicUrl("maintenanceAgent", { exposurePath: "/agent" }, origin)).toBeUndefined()
    })

    it("given a Gateway without a certificate issuer, or none, when its origin is read, then it is plain HTTP, or nothing", () => {
        expect(gatewayOrigin({ host: "dev.example.com" })).toBe("http://dev.example.com")
        expect(gatewayOrigin(undefined)).toBeUndefined()
    })
})
