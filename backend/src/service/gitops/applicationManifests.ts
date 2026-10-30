import { stringify } from "yaml"
import { CHART_RESOURCE_DEFAULTS, ContainerResources, ContainerResourcesByEnvironment, resourcesIn } from "../../types/ContainerResources"
import { EnvironmentVersion, hasEnvironmentVersion, versionIn } from "../../types/EnvironmentVersions"
import { MaintenanceAgentKind } from "../../types/MaintenanceAgent"

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
export interface GitOpsApplication extends ContainerResourcesByEnvironment {
    slug: string
    /** The latest version the CI registered, or the one set by hand: deployed only where an environment sets it */
    version?: string
    /** The version each environment runs, the tag of the image there: an environment with none does not get the application */
    environmentVersions?: EnvironmentVersion[] | null
    image?: { repository?: string }
    port?: number
    /** The path it is exposed at on the host of every environment */
    exposurePath?: string | null
    livenessPath?: string
    readinessPath?: string
    configMapIds?: unknown[]
    secretIds?: unknown[]
    /** A backend or a maintenance agent: each one is a Secret of its own in the configuration repository */
    resourceIds?: unknown[]
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

/** A container application of the environment answers on port 80 of the Service named after it */
export const inClusterUrl = (slug: string, path = "") => `http://${slug}${path}`

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
        env: [{ name: MAINTAINED_TARGETS_VARIABLE, value: JSON.stringify(maintenance.targets) }],
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
 * the environment, an application with an exposure path gets a route on it. Its CPU and memory are those of the
 * environment where it sets some apart. Its version is the one of the environment. Without an image repository of
 * its own, the image is the one in the container registry of the project.
 */
export const renderApplicationValues = (
    application: GitOpsApplication,
    environment: { _id: unknown; slug: string },
    mapNames: { configMaps: Map<string, string>; secrets: Map<string, string>; resources?: Map<string, string> },
    gateway?: ApplicationGateway,
    containerRegistry?: string
): string => {
    const repository = applicationImageRepository(application, containerRegistry)
    const version = versionIn(application, environment._id)
    // isDeployable lets through only what has both: values without them would be a Deployment that never starts
    if (!repository) throw new Error(`${application.slug} has no image repository and the project no container registry`)
    if (!version) throw new Error(`${application.slug} has no version in ${environment.slug}`)
    const names = (ids: unknown[] | undefined, byId: Map<string, string>) => (ids ?? []).map(id => byId.get(String(id))).filter((name): name is string => Boolean(name))
    const route =
        gateway && application.exposurePath
            ? { gateway: gateway.name, listener: gateway.listener, path: application.exposurePath, hsts: gateway.hsts, ...(gateway.ipAllowList ? { ipAllowList: gateway.ipAllowList } : {}) }
            : undefined
    const values = {
        replicas: 1,
        image: { ...splitImage(repository), tag: version },
        containerPort: application.port ?? 8080,
        // What the environment sets apart, else what the application sets
        ...resourceValues(resourcesIn(application, environment._id)),
        probes: {
            liveness: { active: Boolean(application.livenessPath), path: application.livenessPath ?? "/" },
            readiness: { active: Boolean(application.readinessPath), path: application.readinessPath ?? "/" }
        },
        environmentMaps: names(application.configMapIds, mapNames.configMaps),
        secrets: [
            ...names(application.secretIds, mapNames.secrets),
            ...names(application.resourceIds, mapNames.resources ?? new Map()),
            ...(application.maintenance ? [maintenanceAgentSecretName(application.slug)] : [])
        ],
        ...(route ? { route } : {}),
        ...(application.maintenance ? maintenanceValues(application, application.maintenance) : {})
    }
    return `${MANAGED_VALUES_MARKER}\n# Written by every deploy of ${environment.slug}: a change made here is overwritten.\n${stringify(values)}`
}

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
    { path: `${APPLICATIONS_CHART_FOLDER}/values.yaml`, content: CHART_VALUES },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/deployment.yaml`, content: DEPLOYMENT_TEMPLATE },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/service.yaml`, content: SERVICE_TEMPLATE },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/ingress.yaml`, content: INGRESS_TEMPLATE },
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/httproute.yaml`, content: HTTPROUTE_TEMPLATE, replaces: [HTTPROUTE_TEMPLATE_V1] },
    // A file of its own, so the branches whose chart was written before maintenance agents get it too
    { path: `${APPLICATIONS_CHART_FOLDER}/templates/cronjob.yaml`, content: CRONJOB_TEMPLATE }
]
