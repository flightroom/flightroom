import { stringify } from "yaml"
import { CHART_REPLICAS_DEFAULT, CHART_RESOURCE_DEFAULTS, ContainerResources, ContainerResourcesByEnvironment, resourcesIn } from "../../types/ContainerResources"
import { ContinuousDeployment, EnvironmentVersion, hasEnvironmentVersion, isContinuouslyDeployedIn, versionIn } from "../../types/EnvironmentVersions"
import { MaintenanceAgentKind } from "../../types/MaintenanceAgent"
import { CHART_PROBE_DEFAULTS, effectiveProbes, ProbeSettings } from "../../types/Probes"
import { ApplicationLogging, EnvironmentLogging, runtimeVariables } from "../../types/RuntimeVariables"
import { serviceVariables } from "../../types/ServiceVariables"

/**
 * The applications repository of GitOps, laid out as an `applications-infra` repository: one branch per
 * environment, a Helm values file `<application>.yaml` at the root for each application, and the chart every
 * one of them is installed with in `microservice-chart/`. An Argo CD Application per application and
 * environment points at the chart, with the values file of the application, on the branch of the environment.
 */

export const APPLICATIONS_CHART_FOLDER = "microservice-chart"

/** In the first line of every values file the console writes: what tells it from one someone else put there */
export const MANAGED_VALUES_MARKER = "# app.kubernetes.io/managed-by: flightroom"

/** What a values file is made from: a backend, or a DOCKER, which runs as a container the same way */
export interface GitOpsApplication extends ContainerResourcesByEnvironment, ProbeSettings, ApplicationLogging, ContinuousDeployment {
    slug: string
    /** The latest version the CI registered, or the one set by hand: deployed only where an environment sets it */
    version?: string
    /** The version each environment runs, the tag of the image there: an environment with none does not get the application */
    environmentVersions?: EnvironmentVersion[] | null
    image?: { repository?: string }
    port?: number
    /** The path it is exposed at on the host of every environment */
    exposurePath?: string | null
    configMapIds?: unknown[]
    secretIds?: unknown[]
    /** A backend or a maintenance agent: each one is a Secret of its own in the configuration repository */
    resourceIds?: unknown[]
    /**
     * The variables it declares. A backend's each carry the value the deploy hands the container in every environment: a
     * plain one in `env`, a secret one in its Secret {@link backendEnvSecretName}. A frontend's or a maintenance agent's have
     * none: they are declared only.
     */
    env?: Array<{ name: string; secret?: boolean; value?: string }> | null
    /** A maintenance agent only: what its CronJob is made from */
    maintenance?: ApplicationMaintenance
}

/** What a maintenance agent adds to its values: a CronJob, and for a JOB a Deployment that runs nothing */
export interface ApplicationMaintenance {
    kind: MaintenanceAgentKind
    /** Null when it runs on Play only: the CronJob is then suspended */
    schedule?: string | null
    timeZone?: string | null
    runPath: string
    /** The backends and frontends it maintains, handed to the container as MAINTAINED_TARGETS */
    targets: MaintainedTarget[]
}

export interface MaintainedTarget {
    /** "service" for a backend: the name the containers of the agents already read in MAINTAINED_TARGETS */
    kind: "service" | "frontend"
    slug: string
    /** Inside the namespace of the environment, for those that run as a container */
    url?: string
}

/** A suspended CronJob still needs a schedule: one that is never reached as long as it is suspended */
export const PAUSED_SCHEDULE = "0 0 1 1 *"

/** The name of the environment variable that lists the targets of a maintenance agent, as JSON */
export const MAINTAINED_TARGETS_VARIABLE = "MAINTAINED_TARGETS"

/**
 * The Secret, in the configuration repository, with what the container of a maintenance agent calls the console
 * with to read the logs and the builds of its targets: the URL of the API and the token of the environment.
 */
export const maintenanceAgentSecretName = (slug: string) => `${slug}.flightroom`

/** The variables of that Secret, as the container reads them */
export const MAINTENANCE_AGENT_API_URL_VARIABLE = "FLIGHTROOM_API_URL"
export const MAINTENANCE_AGENT_TOKEN_VARIABLE = "FLIGHTROOM_AGENT_TOKEN"

/** The suffix of the Secret of the secret variables of a backend: a user's map has no dot in its name, so it is told apart */
export const BACKEND_ENV_SECRET_SUFFIX = ".env"

/** The Secret, in the configuration repository, with the values of the secret variables of a backend */
export const backendEnvSecretName = (slug: string) => `${slug}${BACKEND_ENV_SECRET_SUFFIX}`

/** The variables of `application` with a value, the secret or the plain ones, as the deploy hands them */
export const ownVariables = (application: Pick<GitOpsApplication, "env">, secret: boolean): Array<{ name: string; value: string }> =>
    (application.env ?? []).flatMap(variable => (Boolean(variable.secret) === secret && variable.value ? [{ name: variable.name, value: variable.value }] : []))

/** A container application of the environment answers on port 80 of the Service named after it */
export const inClusterUrl = (slug: string, path = "") => `http://${slug}${path}`

/** The ConfigMap of each environment with the in-cluster URL of every backend and DOCKER frontend deployed there: a user's map has no dot in its name */
export const SERVICES_CONFIG_MAP = "services.flightroom"

/**
 * The Secret of each environment switched on for the telemetry, with the variables of the provider the project picked
 * (telemetryVariablesOf). A user's map has no dot in its name, so it is told apart
 */
export const TELEMETRY_SECRET = "telemetry.flightroom"

/** The variable the URL of a backend or a frontend goes by in that ConfigMap: `orders-be` is ORDERS_BE_URL */
export const serviceUrlVariable = (slug: string) => `${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`

/**
 * What that ConfigMap holds in one environment: the URL each backend and DOCKER frontend deployed there answers on
 * inside the cluster, port 80 of its Service in the same namespace. One the environment runs no version of has no
 * Service: left out.
 */
export const serviceUrls = (applications: GitOpsApplication[], environmentId: unknown, containerRegistry?: string): Record<string, string> =>
    Object.fromEntries(
        applications
            .filter(application => isDeployable(application, containerRegistry, environmentId))
            .map(application => application.slug)
            .sort()
            .map(slug => [serviceUrlVariable(slug), inClusterUrl(slug)])
    )

/**
 * The values a maintenance agent adds. A CONTAINER keeps its Deployment, and its CronJob POSTs to its run path;
 * a JOB has a Deployment with no replicas, as the chart of a branch may be one written before the CronJob, and its
 * CronJob runs its image.
 */
const maintenanceValues = (application: GitOpsApplication, maintenance: ApplicationMaintenance) => {
    const isJob = maintenance.kind === MaintenanceAgentKind.JOB
    const schedule = maintenance.schedule?.trim()
    return {
        ...(isJob ? { replicas: 0, expose: { service: false } } : {}),
        maintenance: {
            schedule: schedule || PAUSED_SCHEDULE,
            suspend: !schedule,
            ...(maintenance.timeZone?.trim() ? { timeZone: maintenance.timeZone.trim() } : {}),
            ...(isJob ? {} : { trigger: { url: inClusterUrl(application.slug, maintenance.runPath) } })
        }
    }
}

/**
 * The resources the application sets, and only those: Helm merges them into the values of the chart, which fill in
 * the others. None set, the key is left out and the chart decides everything.
 */
const resourceValues = (application: ContainerResources) => {
    const pick = (entries: Array<[string, string | null | undefined]>) => Object.fromEntries(entries.filter(([, value]) => value?.trim()).map(([key, value]) => [key, value!.trim()]))
    const requests = pick([
        ["cpu", application.cpuRequest],
        ["memory", application.memoryRequest]
    ])
    const limits = pick([
        ["cpu", application.cpuLimit],
        ["memory", application.memoryLimit]
    ])
    const resources = { ...(Object.keys(requests).length > 0 ? { requests } : {}), ...(Object.keys(limits).length > 0 ? { limits } : {}) }
    return Object.keys(resources).length > 0 ? { resources } : {}
}

/** The values file of an application, at the root of the branch of each environment */
export const applicationValuesPath = (application: Pick<GitOpsApplication, "slug">) => `${application.slug}.yaml`

/**
 * The image an application runs, without tag: its own repository, otherwise `<containerRegistry>/<slug>` when the
 * project has a container registry, so that a CI that never registers its versions still gets deployed. None without either.
 * A bare name of its own (`bacheca-team-fe`, no `/`) is an image of that registry too: `<containerRegistry>/<name>`.
 */
export const applicationImageRepository = (application: Pick<GitOpsApplication, "slug" | "image">, containerRegistry?: string): string | undefined => {
    const own = application.image?.repository?.trim()
    if (own?.includes("/")) return own
    return containerRegistry ? `${containerRegistry}/${own || application.slug}` : own || undefined
}

/**
 * Only what has an image and a version in the environment can be installed there: the others are left out of its deploy.
 * Without an environment, whether it can be installed in some.
 */
export const isDeployable = (application: GitOpsApplication, containerRegistry?: string, environmentId?: unknown): boolean =>
    Boolean((environmentId === undefined ? hasEnvironmentVersion(application) : versionIn(application, environmentId)) && applicationImageRepository(application, containerRegistry))

/** `ghcr.io/acme/orders-api` as the chart takes it: the registry, then the rest. An image of Docker Hub has no registry in front */
export const splitImage = (repository: string): { host: string; name: string } => {
    const [first, ...rest] = repository.split("/")
    const isRegistry = rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost")
    return isRegistry ? { host: first, name: rest.join("/") } : { host: "docker.io", name: repository }
}

/** The public URL of a path on the origin of an environment, without a trailing slash; none without either */
export const exposedUrl = (origin: string | undefined, path: string | null | undefined): string | undefined => (origin && path ? `${origin}${path.replace(/\/+$/, "")}` : undefined)

/** Where browsers reach an environment through its Gateway: none when the project is exposed on no domain */
export const gatewayOrigin = (gateway?: { host: string; certificateIssuer?: string }): string | undefined => (gateway ? `${gateway.certificateIssuer ? "https" : "http"}://${gateway.host}` : undefined)

/** What runs as a container: what PUBLIC_URL points at depends on it */
export type ContainerKind = "backend" | "frontend" | "maintenanceAgent"

/** PUBLIC_URL of a container: the public URL it is exposed at, a frontend's and a backend's alike; none for a maintenance agent */
export const containerPublicUrl = (kind: ContainerKind, application: { exposurePath?: string | null }, origin: string | undefined): string | undefined =>
    kind === "maintenanceAgent" ? undefined : exposedUrl(origin, application.exposurePath)

export const HTTP_PORT_VARIABLE = "HTTP_PORT"

/** The port the container listens on: the chart hands it to the container as HTTP_PORT, before every other variable */
export const containerPortOf = (application: Pick<GitOpsApplication, "port">): number => application.port ?? 8080

/**
 * The variables the values hand the chart as `env`, after HTTP_PORT: the targets of a maintenance agent, the
 * LOG_LEVEL of the application else of the environment, the LOG_JSON of the environment, its slug as ENVIRONMENT, PUBLIC_URL when given, and the OpenTelemetry
 * name, environment and version of the application. The deploy writes them, `containerEnvironment` reads them: the two never differ.
 */
export const containerVariables = (application: GitOpsApplication, environment: { slug: string } & EnvironmentLogging, version: string, publicUrl?: string): Array<{ name: string; value: string }> => [
    ...(application.maintenance ? [{ name: MAINTAINED_TARGETS_VARIABLE, value: JSON.stringify(application.maintenance.targets) }] : []),
    ...runtimeVariables(environment, publicUrl, application.logLevel),
    ...serviceVariables(application, environment, version)
]

/** The names of the config maps, the secrets and the Secrets of the resources of the project, by id */
export interface ContainerMapNames {
    configMaps: Map<string, string>
    secrets: Map<string, string>
    resources?: Map<string, string>
    /** The environment gets the variables of the telemetry: its containers read the platform's Secret {@link TELEMETRY_SECRET} */
    telemetry?: boolean
}

/**
 * What a container takes whole through `envFrom`: the platform's ConfigMap of the URLs of the applications, a config map,
 * the platform's Secret of the telemetry, a secret, the Secret of a resource, the platform's Secret of a maintenance agent,
 * or the Secret of the secret variables of a backend
 */
export interface ContainerEnvSource {
    kind: "services" | "configMap" | "telemetry" | "secret" | "resource" | "platform" | "backendEnv"
    /** The id of the config map, the secret or the resource; none for the platform's */
    id?: string
    /** The ConfigMap or the Secret, as Kubernetes names it */
    name: string
}

/**
 * The `envFrom` of the container, in the order the chart lists it: the URLs of the backends and frontends first, so that a config
 * map of the team can point one elsewhere, then the config maps, in an environment switched on for the telemetry the platform's
 * Secret of the telemetry, first of the Secrets so that a secret of the team or a resource setting the same variable wins
 * over it, then the secrets, the Secrets of the resources, for a maintenance agent its own and, last so that it wins over
 * all of them, the Secret of the secret variables of a backend that gives any a value. An id with no name is a map deleted since: left out.
 */
export const containerEnvSources = (application: GitOpsApplication, mapNames: ContainerMapNames): ContainerEnvSource[] => {
    const named = (kind: "configMap" | "secret" | "resource", ids: unknown[] | undefined, byId: Map<string, string>): ContainerEnvSource[] =>
        (ids ?? []).flatMap(id => {
            const name = byId.get(String(id))
            return name ? [{ kind, id: String(id), name }] : []
        })
    return [
        { kind: "services", name: SERVICES_CONFIG_MAP },
        ...named("configMap", application.configMapIds, mapNames.configMaps),
        // The chart lists every config map before the Secrets: the first of these is as early as a Secret goes
        ...(mapNames.telemetry ? [{ kind: "telemetry" as const, name: TELEMETRY_SECRET }] : []),
        ...named("secret", application.secretIds, mapNames.secrets),
        ...named("resource", application.resourceIds, mapNames.resources ?? new Map()),
        ...(application.maintenance ? [{ kind: "platform" as const, name: maintenanceAgentSecretName(application.slug) }] : []),
        ...(ownVariables(application, true).length > 0 ? [{ kind: "backendEnv" as const, name: backendEnvSecretName(application.slug) }] : [])
    ]
}

/**
 * The `env` of the values: the plain variables of a backend first, then the platform's of {@link containerVariables}, so that
 * of a name set twice Kubernetes keeps the platform's, the last one. HTTP_PORT, which the chart writes before the whole
 * list, is left out of the backend's for the same reason.
 */
export const valuesEnv = (application: GitOpsApplication, environment: { slug: string } & EnvironmentLogging, version: string, publicUrl?: string): Array<{ name: string; value: string }> => [
    ...ownVariables(application, false).filter(variable => variable.name !== HTTP_PORT_VARIABLE),
    ...containerVariables(application, environment, version, publicUrl)
]

/** A variable of a container as its pod gets it, and where it comes from */
export interface ContainerVariable {
    name: string
    /** `platform`, `backend` for a variable of the backend itself, or the source it comes from: `configMap logging`, `secret database`, `resource orders-db.resource` */
    source: string
    /** In clear for the platform's variables, a config map's and a plain variable of the backend */
    value?: string
    /** A Secret's, never its value: that it is set and, when known, how long it is */
    masked?: { set: true; length?: number }
    /** The source whose value the container gets instead: `env` wins over `envFrom`, a later `envFrom` over an earlier one */
    overriddenBy?: string
}

/** What each `envFrom` source holds in the environment, by id, as the deploy commits it: a key with no value there is left out */
export interface ContainerSourceValues {
    /** What the ConfigMap of the URLs of the backends and frontends holds in the environment: {@link serviceUrls} */
    services: Record<string, string>
    configMaps: Map<string, Record<string, string>>
    secrets: Map<string, Record<string, string>>
    resources: Map<string, Record<string, string>>
    /** What the platform's Secret of the telemetry holds in the environment, when it gets one */
    telemetry?: Record<string, string>
}

/** The source of a variable the backend sets itself, a plain one in `env` as a secret one in its Secret */
export const BACKEND_SOURCE = "backend"

/** The keys of the platform's Secret of a maintenance agent: its token is never read to describe it */
const PLATFORM_SECRET_KEYS = [MAINTENANCE_AGENT_API_URL_VARIABLE, MAINTENANCE_AGENT_TOKEN_VARIABLE]

/**
 * The variables of a container in the order Kubernetes reads them, `env` then each `envFrom` source, with the one it
 * drops of a name set twice marked by the source that wins: `env` over `envFrom`, and within each the later one.
 */
export const withOverrides = (variables: Array<ContainerVariable & { fromEnv: boolean }>): ContainerVariable[] => {
    const winners = new Map<string, number>()
    variables.forEach((variable, index) => {
        const current = winners.get(variable.name)
        if (current === undefined || variable.fromEnv || !variables[current].fromEnv) winners.set(variable.name, index)
    })
    return variables.map(({ fromEnv: _fromEnv, ...variable }, index) => {
        const winner = winners.get(variable.name) ?? index
        return winner === index ? variable : { ...variable, overriddenBy: variables[winner].source }
    })
}

/**
 * Every variable the container of `application` gets in `environment`, in the order the chart lists them: `env`, then
 * each `envFrom` source. The plain variables of a backend come first, before HTTP_PORT too, as one of theirs named so
 * never reaches the values (see {@link valuesEnv}). A name set twice is there twice, the one Kubernetes drops marked with
 * the source that wins: `env` over `envFrom`, and within each the later one. Values of Secrets, a resource's and the
 * secret variables of a backend included, are masked.
 */
export const containerEnvironment = (
    application: GitOpsApplication,
    environment: { slug: string } & EnvironmentLogging,
    mapNames: ContainerMapNames,
    values: ContainerSourceValues,
    version: string,
    publicUrl?: string
): ContainerVariable[] => {
    const variables: Array<ContainerVariable & { fromEnv: boolean }> = [
        ...ownVariables(application, false).map(({ name, value }) => ({ name, source: BACKEND_SOURCE, value, fromEnv: true })),
        ...[
            // The Deployment hands it, not the CronJob: the container of a JOB agent, which only the CronJob runs, has none
            ...(application.maintenance?.kind === MaintenanceAgentKind.JOB ? [] : [{ name: HTTP_PORT_VARIABLE, value: String(containerPortOf(application)) }]),
            ...containerVariables(application, environment, version, publicUrl)
        ].map(({ name, value }) => ({ name, source: "platform", value, fromEnv: true }))
    ]
    for (const source of containerEnvSources(application, mapNames)) {
        if (source.kind === "platform") {
            for (const name of PLATFORM_SECRET_KEYS) variables.push({ name, source: "platform", masked: { set: true }, fromEnv: false })
            continue
        }
        if (source.kind === "backendEnv") {
            for (const { name, value } of ownVariables(application, true)) variables.push({ name, source: BACKEND_SOURCE, masked: { set: true, length: value.length }, fromEnv: false })
            continue
        }
        if (source.kind === "telemetry") {
            for (const [name, value] of Object.entries(values.telemetry ?? {})) variables.push({ name, source: `secret ${source.name}`, masked: { set: true, length: value.length }, fromEnv: false })
            continue
        }
        if (source.kind === "services") {
            for (const [name, value] of Object.entries(values.services)) variables.push({ name, source: `configMap ${source.name}`, value, fromEnv: false })
            continue
        }
        const held = { configMap: values.configMaps, secret: values.secrets, resource: values.resources }[source.kind].get(source.id ?? "") ?? {}
        for (const [name, value] of Object.entries(held)) {
            variables.push({ name, source: `${source.kind} ${source.name}`, ...(source.kind === "configMap" ? { value } : { masked: { set: true, length: value.length } }), fromEnv: false })
        }
    }
    return withOverrides(variables)
}

/** The timings a probe sets: those it leaves out are the chart's */
const probeTimingValues = (initialDelaySeconds?: number | null, periodSeconds?: number | null) => ({
    ...(initialDelaySeconds != null ? { initialDelaySeconds } : {}),
    ...(periodSeconds != null ? { periodSeconds } : {})
})

/** The Gateway of the environment the HTTPRoute of an application attaches to, and the listener it attaches to */
export interface ApplicationGateway {
    name: string
    listener: string
    /** HTTPS: every answer tells the browser to stay on it */
    hsts: boolean
    /** The Middleware of the environment that lets some addresses only through, when it has one */
    ipAllowList?: string
}

/**
 * The values of one application in one environment. The config maps, the secrets and the resources go by
 * name: the configuration repository holds them, as manifests in the namespace of the environment. A
 * resource is a Secret, so it goes with the secrets, after them: the chart needs no change for it. With a Gateway in
 * the environment, an application with an exposure path gets a route on it. Its CPU, memory and replicas are those of
 * the environment where it sets some apart. Its version is the one of the environment. Without an image repository of
 * its own, the image is the one in the container registry of the project. Every container gets the variables of
 * {@link containerVariables} as `env`, after the plain variables of a backend ({@link valuesEnv}): Kubernetes puts them before
 * what a config map of the same name says. The secret variables of a backend go by the name of their Secret, the last of
 * `secrets`. Its probes are its own, else those of `probeTemplate`, the template of its project for its kind. Deployed
 * continuously in the environment, its image is pulled at every start and its pods carry {@link UPDATED_AT_LABEL}, the
 * time of the deploy: the values change at every deploy, so Argo CD syncs and the pods roll out, pulling the image again
 * even when its tag is the same.
 */
export const renderApplicationValues = (
    application: GitOpsApplication,
    environment: { _id: unknown; slug: string } & EnvironmentLogging,
    mapNames: ContainerMapNames,
    gateway?: ApplicationGateway,
    containerRegistry?: string,
    publicUrl?: string,
    probeTemplate?: ProbeSettings,
    deployedAt: Date = new Date()
): string => {
    const repository = applicationImageRepository(application, containerRegistry)
    const version = versionIn(application, environment._id)
    // isDeployable lets through only what has both: values without them would be a Deployment that never starts
    if (!repository) throw new Error(`${application.slug} has no image repository and the project no container registry`)
    if (!version) throw new Error(`${application.slug} has no version in ${environment.slug}`)
    const sources = containerEnvSources(application, mapNames)
    const route =
        gateway && application.exposurePath
            ? { gateway: gateway.name, listener: gateway.listener, path: application.exposurePath, hsts: gateway.hsts, ...(gateway.ipAllowList ? { ipAllowList: gateway.ipAllowList } : {}) }
            : undefined
    // What the environment sets apart, else what the application sets
    const resources = resourcesIn(application, environment._id)
    const probes = effectiveProbes(application, probeTemplate)
    // A maintenance agent's CronJob pulls as it always did: continuous deployment is a backend's or a DOCKER frontend's
    const continuous = !application.maintenance && isContinuouslyDeployedIn(application, environment._id)
    const values = {
        replicas: resources.replicas ?? CHART_REPLICAS_DEFAULT,
        image: { ...splitImage(repository), tag: version, ...(continuous ? { pullPolicy: "Always" } : {}) },
        ...(continuous ? { podLabels: { [UPDATED_AT_LABEL]: String(deployedAt.getTime()) } } : {}),
        containerPort: containerPortOf(application),
        ...resourceValues(resources),
        probes: {
            liveness: { active: true, path: probes.livenessPath, ...probeTimingValues(probes.livenessInitialDelaySeconds, probes.livenessPeriodSeconds) },
            readiness: { active: true, path: probes.readinessPath, ...probeTimingValues(probes.readinessInitialDelaySeconds, probes.readinessPeriodSeconds) }
        },
        environmentMaps: sources.filter(source => source.kind === "services" || source.kind === "configMap").map(source => source.name),
        // The chart lists the secrets after the config maps: a resource's Secret, the platform's and the backend's own are secrets too
        secrets: sources.filter(source => source.kind !== "services" && source.kind !== "configMap").map(source => source.name),
        env: valuesEnv(application, environment, version, publicUrl),
        ...(route ? { route } : {}),
        ...(application.maintenance ? maintenanceValues(application, application.maintenance) : {})
    }
    return `${MANAGED_VALUES_MARKER}\n# Written by every deploy of ${environment.slug}: a change made here is overwritten.\n${stringify(values)}`
}

/** The label of the pods of a container deployed continuously: the time of the deploy, in milliseconds */
export const UPDATED_AT_LABEL = "updatedAt"

const CHART_YAML = `apiVersion: v2
name: microservice-chart
description: Helm chart the applications deployed by Flightroom are installed with
version: 0.1.0
type: application
`

const CHART_VALUES = `replicas: 1

resources:
  requests:
    cpu: ${CHART_RESOURCE_DEFAULTS.cpuRequest}
    memory: ${CHART_RESOURCE_DEFAULTS.memoryRequest}
  limits:
    cpu: ${CHART_RESOURCE_DEFAULTS.cpuLimit}
    memory: ${CHART_RESOURCE_DEFAULTS.memoryLimit}

image:
  host: docker.io

probes:
  liveness:
    active: true
    path: /health/live
    initialDelaySeconds: ${CHART_PROBE_DEFAULTS.initialDelaySeconds}
    periodSeconds: ${CHART_PROBE_DEFAULTS.periodSeconds}
  readiness:
    active: true
    path: /health/ready
    initialDelaySeconds: ${CHART_PROBE_DEFAULTS.initialDelaySeconds}
    periodSeconds: ${CHART_PROBE_DEFAULTS.periodSeconds}

containerPort: 8080

expose:
  service: true

# ingress:
#   className: nginx
#   host: orders.example.com
#   path: /
#   annotations: {}

# An HTTPRoute on the Gateway of the environment, which owns the host: the prefix is stripped
# route:
#   gateway: shop-1a2b3c
#   listener: https
#   path: /api/orders
#   hsts: true
#   ipAllowList: shop-1a2b3c-ip-allowlist   # the Traefik Middleware of the environment, when it allows some addresses only
`

/** The values before the probes had a period of their own: a branch still holding them as written gets the current ones */
const CHART_VALUES_V1 = `replicas: 1

resources:
  requests:
    cpu: ${CHART_RESOURCE_DEFAULTS.cpuRequest}
    memory: ${CHART_RESOURCE_DEFAULTS.memoryRequest}
  limits:
    cpu: ${CHART_RESOURCE_DEFAULTS.cpuLimit}
    memory: ${CHART_RESOURCE_DEFAULTS.memoryLimit}

image:
  host: docker.io

probes:
  liveness:
    active: true
    path: /health/live
    initialDelaySeconds: 30
  readiness:
    active: true
    path: /health/ready
    initialDelaySeconds: 30

containerPort: 8080

expose:
  service: true

# ingress:
#   className: nginx
#   host: orders.example.com
#   path: /
#   annotations: {}

# An HTTPRoute on the Gateway of the environment, which owns the host: the prefix is stripped
# route:
#   gateway: shop-1a2b3c
#   listener: https
#   path: /api/orders
#   hsts: true
#   ipAllowList: shop-1a2b3c-ip-allowlist   # the Traefik Middleware of the environment, when it allows some addresses only
`

const DEPLOYMENT_TEMPLATE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}
    app.kubernetes.io/component: app
    app.kubernetes.io/name: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 25%
      maxSurge: 25%
  revisionHistoryLimit: 1
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      containers:
        - name: {{ .Release.Name }}
          image: {{ .Values.image.host }}/{{ .Values.image.name }}:{{ .Values.image.tag }}
          {{- with .Values.image.pullPolicy }}
          imagePullPolicy: {{ . }}
          {{- end }}
          {{- if .Values.probes.liveness.active }}
          livenessProbe:
            httpGet:
              path: {{ .Values.probes.liveness.path }}
              port: http
            initialDelaySeconds: {{ .Values.probes.liveness.initialDelaySeconds }}
            periodSeconds: {{ .Values.probes.liveness.periodSeconds | default ${CHART_PROBE_DEFAULTS.periodSeconds} }}
          {{- end }}
          {{- if .Values.probes.readiness.active }}
          readinessProbe:
            httpGet:
              path: {{ .Values.probes.readiness.path }}
              port: http
            initialDelaySeconds: {{ .Values.probes.readiness.initialDelaySeconds }}
            periodSeconds: {{ .Values.probes.readiness.periodSeconds | default ${CHART_PROBE_DEFAULTS.periodSeconds} }}
          {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPort }}
              protocol: TCP
          env:
            - name: HTTP_PORT
              value: "{{ .Values.containerPort }}"
            {{- range .Values.env }}
            - name: {{ .name }}
              value: {{ .value | quote }}
            {{- end }}
          envFrom:
            {{- range .Values.environmentMaps }}
            - configMapRef:
                name: {{ . }}
            {{- end }}
            {{- range .Values.secrets }}
            - secretRef:
                name: {{ . }}
            {{- end }}
          volumeMounts:
            {{- range .Values.configMapVolumes }}
            - name: {{ .name }}
              mountPath: {{ .mountPath }}
              {{- if .subPath }}
              subPath: {{ .subPath }}
              {{- end }}
              readOnly: true
            {{- end }}
      volumes:
        {{- range .Values.configMapVolumes }}
        - name: {{ .name }}
          configMap:
            name: {{ .name }}
        {{- end }}
`

/** The template before continuous deployment, with no pull policy nor labels of the pods: a branch still holding it as written gets the current one */
const DEPLOYMENT_TEMPLATE_V2 = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}
    app.kubernetes.io/component: app
    app.kubernetes.io/name: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 25%
      maxSurge: 25%
  revisionHistoryLimit: 1
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Release.Name }}
          image: {{ .Values.image.host }}/{{ .Values.image.name }}:{{ .Values.image.tag }}
          {{- if .Values.probes.liveness.active }}
          livenessProbe:
            httpGet:
              path: {{ .Values.probes.liveness.path }}
              port: http
            initialDelaySeconds: {{ .Values.probes.liveness.initialDelaySeconds }}
            periodSeconds: {{ .Values.probes.liveness.periodSeconds | default ${CHART_PROBE_DEFAULTS.periodSeconds} }}
          {{- end }}
          {{- if .Values.probes.readiness.active }}
          readinessProbe:
            httpGet:
              path: {{ .Values.probes.readiness.path }}
              port: http
            initialDelaySeconds: {{ .Values.probes.readiness.initialDelaySeconds }}
            periodSeconds: {{ .Values.probes.readiness.periodSeconds | default ${CHART_PROBE_DEFAULTS.periodSeconds} }}
          {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPort }}
              protocol: TCP
          env:
            - name: HTTP_PORT
              value: "{{ .Values.containerPort }}"
            {{- range .Values.env }}
            - name: {{ .name }}
              value: {{ .value | quote }}
            {{- end }}
          envFrom:
            {{- range .Values.environmentMaps }}
            - configMapRef:
                name: {{ . }}
            {{- end }}
            {{- range .Values.secrets }}
            - secretRef:
                name: {{ . }}
            {{- end }}
          volumeMounts:
            {{- range .Values.configMapVolumes }}
            - name: {{ .name }}
              mountPath: {{ .mountPath }}
              {{- if .subPath }}
              subPath: {{ .subPath }}
              {{- end }}
              readOnly: true
            {{- end }}
      volumes:
        {{- range .Values.configMapVolumes }}
        - name: {{ .name }}
          configMap:
            name: {{ .name }}
        {{- end }}
`

/** The template before the period of the probes came from the values: a branch still holding it as written gets the current one */
const DEPLOYMENT_TEMPLATE_V1 = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
  labels:
    app: {{ .Release.Name }}
    app.kubernetes.io/component: app
    app.kubernetes.io/name: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 25%
      maxSurge: 25%
  revisionHistoryLimit: 1
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Release.Name }}
          image: {{ .Values.image.host }}/{{ .Values.image.name }}:{{ .Values.image.tag }}
          {{- if .Values.probes.liveness.active }}
          livenessProbe:
            httpGet:
              path: {{ .Values.probes.liveness.path }}
              port: http
            initialDelaySeconds: {{ .Values.probes.liveness.initialDelaySeconds }}
            periodSeconds: 30
          {{- end }}
          {{- if .Values.probes.readiness.active }}
          readinessProbe:
            httpGet:
              path: {{ .Values.probes.readiness.path }}
              port: http
            initialDelaySeconds: {{ .Values.probes.readiness.initialDelaySeconds }}
            periodSeconds: 30
          {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPort }}
              protocol: TCP
          env:
            - name: HTTP_PORT
              value: "{{ .Values.containerPort }}"
            {{- range .Values.env }}
            - name: {{ .name }}
              value: {{ .value | quote }}
            {{- end }}
          envFrom:
            {{- range .Values.environmentMaps }}
            - configMapRef:
                name: {{ . }}
            {{- end }}
            {{- range .Values.secrets }}
            - secretRef:
                name: {{ . }}
            {{- end }}
          volumeMounts:
            {{- range .Values.configMapVolumes }}
            - name: {{ .name }}
              mountPath: {{ .mountPath }}
              {{- if .subPath }}
              subPath: {{ .subPath }}
              {{- end }}
              readOnly: true
            {{- end }}
      volumes:
        {{- range .Values.configMapVolumes }}
        - name: {{ .name }}
          configMap:
            name: {{ .name }}
        {{- end }}
`

const SERVICE_TEMPLATE = `{{- if .Values.expose.service }}
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
spec:
  type: ClusterIP
  selector:
    app: {{ .Release.Name }}
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: {{ .Values.containerPort }}
{{- end }}
`

const INGRESS_TEMPLATE = `{{- if and .Values.ingress (gt (int .Values.replicas) 0) }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .Values.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  rules:
    - http:
        paths:
          - path: {{ .Values.ingress.path | default "/" }}
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}
                port:
                  number: 80
      {{- with .Values.ingress.host }}
      host: {{ . }}
      {{- end }}
{{- end }}
`

/**
 * The application on the Gateway of the environment, under its path. The path is stripped, so that the
 * container answers at its root whatever it is exposed at; `/` leaves it as it is. An environment open to some
 * addresses only sends each request through its Traefik Middleware first.
 */
const HTTPROUTE_TEMPLATE = `{{- if and .Values.route (gt (int .Values.replicas) 0) }}
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ .Release.Name }}
spec:
  parentRefs:
    - name: {{ .Values.route.gateway }}
      {{- with .Values.route.listener }}
      sectionName: {{ . }}
      {{- end }}
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: {{ .Values.route.path | quote }}
      {{- if or (ne .Values.route.path "/") .Values.route.hsts .Values.route.ipAllowList }}
      filters:
        {{- with .Values.route.ipAllowList }}
        - type: ExtensionRef
          extensionRef:
            group: traefik.io
            kind: Middleware
            name: {{ . }}
        {{- end }}
        {{- if ne .Values.route.path "/" }}
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
        {{- end }}
        {{- if .Values.route.hsts }}
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: Strict-Transport-Security
                value: "max-age=31536000"
        {{- end }}
      {{- end }}
      backendRefs:
        - name: {{ .Release.Name }}
          port: 80
{{- end }}
`

/** The template before the IP allow list: a branch still holding it as written gets the current one */
const HTTPROUTE_TEMPLATE_V1 = `{{- if and .Values.route (gt (int .Values.replicas) 0) }}
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ .Release.Name }}
spec:
  parentRefs:
    - name: {{ .Values.route.gateway }}
      {{- with .Values.route.listener }}
      sectionName: {{ . }}
      {{- end }}
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: {{ .Values.route.path | quote }}
      {{- if or (ne .Values.route.path "/") .Values.route.hsts }}
      filters:
        {{- if ne .Values.route.path "/" }}
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
        {{- end }}
        {{- if .Values.route.hsts }}
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: Strict-Transport-Security
                value: "max-age=31536000"
        {{- end }}
      {{- end }}
      backendRefs:
        - name: {{ .Release.Name }}
          port: 80
{{- end }}
`

/**
 * The CronJob of a maintenance agent: on its schedule, or suspended when it runs on Play only, which starts it
 * through Argo CD. It runs the image of a JOB, or calls the run path of a CONTAINER. Its pods are labelled apart,
 * so the Service of the application never sends them requests.
 */
const CRONJOB_TEMPLATE = `{{- if .Values.maintenance }}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/component: maintenance
    app.kubernetes.io/name: {{ .Release.Name }}
spec:
  schedule: {{ .Values.maintenance.schedule | quote }}
  {{- with .Values.maintenance.timeZone }}
  timeZone: {{ . | quote }}
  {{- end }}
  suspend: {{ .Values.maintenance.suspend }}
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      ttlSecondsAfterFinished: 86400
      template:
        metadata:
          labels:
            app: {{ .Release.Name }}-run
        spec:
          restartPolicy: Never
          containers:
            {{- if .Values.maintenance.trigger }}
            - name: trigger
              image: {{ .Values.maintenance.trigger.image | default "curlimages/curl:8.10.1" }}
              args: ["--fail", "--silent", "--show-error", "--max-time", "3600", "-X", "POST", {{ .Values.maintenance.trigger.url | quote }}]
              resources:
                requests:
                  cpu: 10m
                  memory: 16Mi
                limits:
                  cpu: 100m
                  memory: 64Mi
            {{- else }}
            - name: {{ .Release.Name }}
              image: {{ .Values.image.host }}/{{ .Values.image.name }}:{{ .Values.image.tag }}
              resources:
                {{- toYaml .Values.resources | nindent 16 }}
              env:
                {{- range .Values.env }}
                - name: {{ .name }}
                  value: {{ .value | quote }}
                {{- end }}
              envFrom:
                {{- range .Values.environmentMaps }}
                - configMapRef:
                    name: {{ . }}
                {{- end }}
                {{- range .Values.secrets }}
                - secretRef:
                    name: {{ . }}
                {{- end }}
            {{- end }}
{{- end }}
`

/** Written on a branch only when it is not there yet: the chart is the team's to change afterwards */
/**
 * The chart is written once, then left to the team. `replaces` lists what Flightroom wrote there before: a file
 * still exactly like one of them was never touched, and takes the current version.
 */
export const CHART_FILES: Array<{ path: string; content: string; replaces?: string[] }> = [
    { path: `${APPLICATIONS_CHART_FOLDER}/Chart.yaml`, content: CHART_YAML },
    { path: `${APPLICATIONS_CHART_FOLDER}/values.yaml`, content: CHART_VALUES, replaces: [CHART_VALUES_V1] },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/deployment.yaml`, content: DEPLOYMENT_TEMPLATE, replaces: [DEPLOYMENT_TEMPLATE_V1, DEPLOYMENT_TEMPLATE_V2] },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/service.yaml`, content: SERVICE_TEMPLATE },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/ingress.yaml`, content: INGRESS_TEMPLATE },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/httproute.yaml`, content: HTTPROUTE_TEMPLATE, replaces: [HTTPROUTE_TEMPLATE_V1] },
    // A file of its own, so the branches whose chart was written before maintenance agents get it too
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/cronjob.yaml`, content: CRONJOB_TEMPLATE }
]
