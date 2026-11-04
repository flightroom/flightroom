import https from "node:https"
import axios, { AxiosInstance } from "axios"
import { BusinessException, createBusinessException } from "../errors/BusinessException"

/** What Node reports when the certificate of the server cannot be trusted: told apart from a server that does not answer */
const TLS_ERRORS = new Set([
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID"
])

export interface ArgoCdMetadata {
    name: string
    labels?: Record<string, string>
}

/** What Argo CD last saw of an Application: read to follow a deploy until its containers run */
export interface ArgoCdApplicationStatus {
    /** Synced, OutOfSync or Unknown, against `revision` */
    sync?: { status?: string; revision?: string }
    /** Healthy, Progressing, Degraded, Suspended, Missing or Unknown */
    health?: { status?: string; message?: string }
    /** When Argo CD last compared the Application with the repository */
    reconciledAt?: string
    /** The last sync: Running, Succeeded, Failed, Error or Terminating, and the revision it applied */
    operationState?: {
        phase?: string
        message?: string
        startedAt?: string
        finishedAt?: string
        operation?: { sync?: { revision?: string } }
        syncResult?: { revision?: string }
    }
}

/** An AppProject, an Application or an ApplicationSet: the console reads back the metadata, and the status of an Application */
export interface ArgoCdResource {
    apiVersion?: string
    kind?: string
    metadata: ArgoCdMetadata
    spec?: Record<string, unknown>
    status?: ArgoCdApplicationStatus
}

export interface ArgoCdRepository {
    repo: string
    username: string
    password: string
    /** The AppProject the credentials are scoped to, only its applications may use them; global when left out */
    project?: string
}

/** A repository as Argo CD answers: never the credentials */
export interface ArgoCdRegisteredRepository {
    repo: string
    project?: string
}

/** As Argo CD compares the URLs of repositories: case, a trailing slash and .git aside */
export const sameRepoUrl = (a: string, b: string) => {
    const normalize = (url: string) =>
        url
            .trim()
            .toLowerCase()
            .replace(/\/$/, "")
            .replace(/\.git$/, "")
    return normalize(a) === normalize(b)
}

/** How much of the message of an error of Argo CD goes into ours: the rest is not ours to show */
const MESSAGE_MAX_LENGTH = 200

export interface ArgoCdUserInfo {
    loggedIn: boolean
    username?: string
}

/** A pod an Application runs, as its resource tree describes it */
export interface ArgoCdPod {
    name: string
    namespace: string
    /** Healthy, Progressing, Degraded... as Argo CD judges it */
    health?: string
    /** What Kubernetes says of it: Running, Completed, CrashLoopBackOff... */
    status?: string
    /** Ready containers over all of them, as "1/1" */
    containers?: string
    restarts?: number
    createdAt?: string
    /** Read from the live manifest of the pod, when it could be: what each container may use and how it ran */
    containerDetails?: ArgoCdPodContainer[]
}

/** A container of a pod as Kubernetes holds it now: what it asks for and is held to, and why it stopped */
export interface ArgoCdPodContainer {
    name: string
    requests?: { cpu?: string; memory?: string }
    limits?: { cpu?: string; memory?: string }
    ready?: boolean
    restartCount?: number
    /** What it is doing now: running, or waiting or terminated with Kubernetes' reason (CrashLoopBackOff, ImagePullBackOff, OOMKilled...) */
    state?: { kind: "running" | "waiting" | "terminated"; reason?: string; message?: string; exitCode?: number; at?: string }
    /** How its previous run ended, the one before the last restart: OOMKilled, Error... with its exit code */
    lastTermination?: { reason?: string; message?: string; exitCode?: number; finishedAt?: string }
}

/** How an error names a live object it could not read */
const LIVE_OBJECT_NAMES = { Pod: "pod", ConfigMap: "config map", Secret: "secret" } as const

/** A message a container writes when it ends is its own text: only its start is kept */
const CONTAINER_MESSAGE_MAX_LENGTH = 500

interface KubernetesContainerState {
    running?: { startedAt?: string }
    waiting?: { reason?: string; message?: string }
    terminated?: { reason?: string; message?: string; exitCode?: number; finishedAt?: string }
}

interface KubernetesPod {
    spec?: { containers?: Array<{ name?: string; resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }> }
    status?: { containerStatuses?: Array<{ name?: string; ready?: boolean; restartCount?: number; state?: KubernetesContainerState; lastState?: KubernetesContainerState }> }
}

const shortMessage = (message?: string) => (message ? message.slice(0, CONTAINER_MESSAGE_MAX_LENGTH) : undefined)

/** The CPU and memory of a requests or limits block, none when it sets neither */
const quantities = (block?: Record<string, string>) => {
    const picked = { ...(block?.cpu ? { cpu: block.cpu } : {}), ...(block?.memory ? { memory: block.memory } : {}) }
    return Object.keys(picked).length ? picked : undefined
}

const stateOf = (state?: KubernetesContainerState): ArgoCdPodContainer["state"] => {
    if (state?.running) return { kind: "running", at: state.running.startedAt }
    if (state?.waiting) return { kind: "waiting", reason: state.waiting.reason, message: shortMessage(state.waiting.message) }
    if (state?.terminated) {
        const { reason, message, exitCode, finishedAt } = state.terminated
        return { kind: "terminated", reason, message: shortMessage(message), exitCode, at: finishedAt }
    }
    return undefined
}

/**
 * The containers of a live Pod manifest: the requests and limits of its spec, with the restarts, the state and the
 * last termination of its status. A container the status does not mention yet has its resources only.
 */
export const podContainers = (manifest: unknown): ArgoCdPodContainer[] => {
    const pod = (manifest ?? {}) as KubernetesPod
    const statuses = pod.status?.containerStatuses ?? []
    return (pod.spec?.containers ?? []).flatMap(container => {
        if (!container.name) return []
        const status = statuses.find(candidate => candidate.name === container.name)
        const last = status?.lastState?.terminated
        const requests = quantities(container.resources?.requests)
        const limits = quantities(container.resources?.limits)
        const state = stateOf(status?.state)
        return [
            {
                name: container.name,
                ...(requests ? { requests } : {}),
                ...(limits ? { limits } : {}),
                ...(status?.ready !== undefined ? { ready: status.ready } : {}),
                ...(status?.restartCount !== undefined ? { restartCount: status.restartCount } : {}),
                ...(state ? { state } : {}),
                ...(last ? { lastTermination: { reason: last.reason, message: shortMessage(last.message), exitCode: last.exitCode, finishedAt: last.finishedAt } } : {})
            }
        ]
    })
}

export interface ArgoCdLogLine {
    content: string
    timestamp?: string
}

export interface ArgoCdLogsQuery {
    namespace: string
    podName: string
    tailLines: number
    sinceSeconds?: number
    /** The logs of the container before its last restart: what a crash left */
    previous?: boolean
    /** Only the lines holding this text, filtered by Argo CD */
    filter?: string
}

interface ArgoCdTreeNode {
    kind?: string
    name?: string
    namespace?: string
    health?: { status?: string }
    info?: Array<{ name?: string; value?: string }> | null
    createdAt?: string
}

/** One line of the stream of logs: a result, or the error that cut it */
interface ArgoCdLogEntry {
    result?: { content?: string; timeStamp?: string; last?: boolean }
    error?: { message?: string }
}

export interface ArgoCdClientOptions {
    /** Accepts any certificate, a self-signed one included, as `argocd --insecure`: the TLS of the connection is not verified */
    insecure?: boolean
}

/**
 * The REST API of an Argo CD instance, `<url>/api/v1`, with the bearer token of the account the console acts
 * as. Argo CD runs on another cluster: the API is the only way in. Every failure comes back as a business
 * error saying what to check, the URL, the network, the certificate, the token or its RBAC policy.
 */
class ArgoCdClient {
    private api: AxiosInstance

    constructor(
        private readonly url: string,
        token: string,
        { insecure = false }: ArgoCdClientOptions = {}
    ) {
        this.api = axios.create({
            baseURL: `${url}/api/v1`,
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30_000,
            // A redirect would take the token to wherever Argo CD, or whoever answers in its place, points
            maxRedirects: 0,
            ...(insecure ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {})
        })
    }

    /** The account behind the token: one Argo CD does not recognise is refused before anything is written */
    async getUserInfo(): Promise<ArgoCdUserInfo> {
        const info = await this.call("read the session of the token", () => this.api.get<ArgoCdUserInfo>("/session/userinfo"))
        if (!info?.loggedIn) throw this.unauthorized()
        return info
    }

    /** Registers the credentials of a repository, or replaces them */
    async upsertRepository(repository: ArgoCdRepository): Promise<void> {
        await this.call(`register the repository ${repository.repo}`, () => this.api.post("/repositories", { type: "git", ...repository }, { params: { upsert: true, credsOnly: false } }))
    }

    /**
     * The repository registered with that URL, globally or in any AppProject; null when the account sees none.
     * Read from the list: Argo CD answers 403, not 404, for a URL it has no repository of, not to tell which exist
     */
    async getRepository(repo: string): Promise<ArgoCdRegisteredRepository | null> {
        return (await this.listRepositories()).find(registered => sameRepoUrl(registered.repo, repo)) ?? null
    }

    /** One already gone is not an error: looked for in the list first, as Argo CD answers 403 for it. An empty `project` is no project, as Argo CD answers a global one */
    async deleteRepository(repo: string, project?: string): Promise<void> {
        const appProject = project || undefined
        const registered = await this.listRepositories()
        if (!registered.some(registration => sameRepoUrl(registration.repo, repo) && (registration.project || undefined) === appProject)) return
        await this.find(`delete the repository ${repo}`, () => this.api.delete(`/repositories/${encodeURIComponent(repo)}`, { params: { appProject } }))
    }

    private async listRepositories(): Promise<ArgoCdRegisteredRepository[]> {
        const list = await this.call("list the repositories", () => this.api.get<{ items?: ArgoCdRegisteredRepository[] | null }>("/repositories"))
        return list?.items ?? []
    }

    /** The AppProject of that name, null when there is none */
    async getProject(name: string): Promise<ArgoCdResource | null> {
        return this.find(`read the AppProject ${name}`, () => this.api.get<ArgoCdResource>(`/projects/${encodeURIComponent(name)}`))
    }

    /** The Application of that name in `project`, null when there is none */
    async getApplication(name: string, project: string): Promise<ArgoCdResource | null> {
        return this.find(`read the Application ${name}`, () => this.api.get<ArgoCdResource>(`/applications/${encodeURIComponent(name)}`, { params: { project } }))
    }

    async getApplicationSet(name: string): Promise<ArgoCdResource | null> {
        return this.find(`read the ApplicationSet ${name}`, () => this.api.get<ArgoCdResource>(`/applicationsets/${encodeURIComponent(name)}`))
    }

    async upsertProject(project: ArgoCdResource): Promise<void> {
        await this.call(`save the AppProject ${project.metadata.name}`, () => this.api.post("/projects", { project, upsert: true }))
    }

    /** One already gone is not an error. Argo CD refuses it while an Application still belongs to it */
    async deleteProject(name: string): Promise<void> {
        await this.find(`delete the AppProject ${name}`, () => this.api.delete(`/projects/${encodeURIComponent(name)}`))
    }

    /** The Applications of `project` with the labels of `selector` */
    async listApplications(selector: string, project: string): Promise<ArgoCdResource[]> {
        const list = await this.call("list the Applications", () => this.api.get<{ items?: ArgoCdResource[] | null }>("/applications", { params: { selector, projects: project } }))
        return list?.items ?? []
    }

    /** Has Argo CD read the repository of the Application now, not at its next poll: with automated sync it syncs what it finds. One gone is not an error */
    async refreshApplication(name: string, project: string): Promise<void> {
        await this.find(`refresh the Application ${name}`, () => this.api.get<ArgoCdResource>(`/applications/${encodeURIComponent(name)}`, { params: { project, refresh: "normal" } }))
    }

    /**
     * Syncs the Application now, its whole manifest applied, the fields it ignores in the diff included: what a refresh
     * alone leaves out when they are the only change. One gone is not an error, nor one already syncing: that sync
     * applies the whole manifest too.
     */
    async syncApplication(name: string, project: string): Promise<void> {
        try {
            await this.api.post(`/applications/${encodeURIComponent(name)}/sync`, { project, prune: true })
        } catch (error) {
            if (axios.isAxiosError(error)) {
                if (error.response?.status === 404) return
                const message = (error.response?.data as { message?: unknown } | undefined)?.message
                if (typeof message === "string" && message.includes("already in progress")) return
            }
            throw this.failure(`sync the Application ${name}`, error)
        }
    }

    async upsertApplicationSet(applicationSet: ArgoCdResource): Promise<void> {
        await this.call(`save the ApplicationSet ${applicationSet.metadata.name}`, () => this.api.post("/applicationsets", applicationSet, { params: { upsert: true } }))
    }

    /** The ApplicationSets of `project` with the labels of `selector` */
    async listApplicationSets(selector: string, project: string): Promise<ArgoCdResource[]> {
        const list = await this.call("list the ApplicationSets", () => this.api.get<{ items?: ArgoCdResource[] | null }>("/applicationsets", { params: { selector, projects: project } }))
        return list?.items ?? []
    }

    /** One already gone is not an error */
    async deleteApplicationSet(name: string): Promise<void> {
        await this.find(`delete the ApplicationSet ${name}`, () => this.api.delete(`/applicationsets/${encodeURIComponent(name)}`))
    }

    /**
     * Creates a Job from the CronJob `name` the Application deployed, with the `create-job` action Argo CD ships
     * for CronJobs: the run goes through Argo CD, which reaches the cluster, as everything else the console does.
     */
    async createJobFromCronJob(application: string, project: string, namespace: string, name: string): Promise<void> {
        await this.call(`start a run of the CronJob ${name}`, () =>
            this.api.post(`/applications/${encodeURIComponent(application)}/resource/actions`, JSON.stringify("create-job"), {
                params: { namespace, resourceName: name, group: "batch", version: "v1", kind: "CronJob", project },
                headers: { "Content-Type": "application/json" }
            })
        )
    }

    /**
     * Restarts the pods of the Deployment `name` the Application deployed, with the `restart` action Argo CD ships for
     * Deployments: a rollout, as `kubectl rollout restart` does. With imagePullPolicy Always, it pulls the image again.
     */
    async restartDeployment(application: string, project: string, namespace: string, name: string): Promise<void> {
        await this.call(`restart the Deployment ${name}`, () =>
            this.api.post(`/applications/${encodeURIComponent(application)}/resource/actions`, JSON.stringify("restart"), {
                params: { namespace, resourceName: name, group: "apps", version: "v1", kind: "Deployment", project },
                headers: { "Content-Type": "application/json" }
            })
        )
    }

    /** The pods the Application runs now, from its resource tree; none when it is not there yet */
    async listPods(application: string, project: string): Promise<ArgoCdPod[]> {
        const tree = await this.find(`read the resources of the Application ${application}`, () =>
            this.api.get<{ nodes?: ArgoCdTreeNode[] | null }>(`/applications/${encodeURIComponent(application)}/resource-tree`, { params: { project } })
        )
        return (tree?.nodes ?? [])
            .filter(node => node.kind === "Pod" && node.name && node.namespace)
            .map(node => {
                const info = (name: string) => node.info?.find(entry => entry.name === name)?.value
                const restarts = Number(info("Restart Count"))
                return {
                    name: node.name!,
                    namespace: node.namespace!,
                    health: node.health?.status,
                    status: info("Status Reason"),
                    containers: info("Containers"),
                    restarts: Number.isFinite(restarts) ? restarts : undefined,
                    createdAt: node.createdAt
                }
            })
    }

    /**
     * The containers of a pod the Application runs, from its live manifest: the resource tree has neither the
     * requests and limits nor why a container last stopped. Null when the pod is gone or its manifest unreadable.
     */
    async getPodContainers(application: string, project: string, pod: Pick<ArgoCdPod, "name" | "namespace">): Promise<ArgoCdPodContainer[] | null> {
        const manifest = await this.getLiveManifest(application, project, { kind: "Pod", ...pod })
        return manifest ? podContainers(manifest) : null
    }

    /**
     * The live manifest of a core (v1) object the Application manages, as Kubernetes holds it now: none when the
     * Application does not manage it or it is gone. Argo CD hides the values of a Secret's data, its keys stay.
     */
    async getLiveManifest(application: string, project: string, object: { kind: "Pod" | "ConfigMap" | "Secret"; name: string; namespace: string }): Promise<unknown> {
        const resource = await this.find(`read the ${LIVE_OBJECT_NAMES[object.kind]} ${object.name}`, () =>
            this.api.get<{ manifest?: string }>(`/applications/${encodeURIComponent(application)}/resource`, {
                params: { namespace: object.namespace, resourceName: object.name, group: "", version: "v1", kind: object.kind, project }
            })
        )
        if (!resource?.manifest) return null
        try {
            return JSON.parse(resource.manifest)
        } catch {
            return null
        }
    }

    /**
     * The last lines a pod of the Application wrote, from its default container. Argo CD answers a stream of
     * JSON lines even without follow, and refuses a pod the Application does not run. An error entry in the
     * stream is a failure as an HTTP one is; Kubernetes' own refusals, such as no previous container to read or a
     * pod of several containers, may instead come as a line of content, and are shown as such.
     */
    async getPodLogs(application: string, project: string, query: ArgoCdLogsQuery): Promise<ArgoCdLogLine[]> {
        const action = `read the logs of the pod ${query.podName}`
        const body = await this.call(action, () =>
            this.api.get<string>(`/applications/${encodeURIComponent(application)}/logs`, {
                params: { ...query, project, follow: false },
                responseType: "text"
            })
        )
        const lines: ArgoCdLogLine[] = []
        for (const raw of String(body ?? "").split("\n")) {
            if (!raw.trim()) continue
            let entry: ArgoCdLogEntry
            try {
                entry = JSON.parse(raw)
            } catch {
                continue
            }
            if (entry.error) throw this.failure(action, new Error(String(entry.error.message ?? "the stream of logs failed").slice(0, MESSAGE_MAX_LENGTH)))
            if (!entry.result || entry.result.last) continue
            lines.push({ content: entry.result.content ?? "", ...(entry.result.timeStamp ? { timestamp: entry.result.timeStamp } : {}) })
        }
        return lines
    }

    /** What `request` answers, null when Argo CD has no such object */
    private async find<T>(action: string, request: () => Promise<{ data: T }>): Promise<T | null> {
        try {
            return (await request()).data
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) return null
            throw this.failure(action, error)
        }
    }

    private async call<T>(action: string, request: () => Promise<{ data: T }>): Promise<T> {
        try {
            return (await request()).data
        } catch (error) {
            throw this.failure(action, error)
        }
    }

    private unauthorized(): BusinessException {
        // 422 and not 401: the session of the user with the console is fine, the token of Argo CD is not
        return createBusinessException({
            code: "ARGOCD_UNAUTHORIZED",
            message: `Argo CD at ${this.url} does not accept the token: check that it is an API token of the orchestrator account (argocd account generate-token --account orchestrator) and that it has not expired or been revoked`,
            statusCode: 422,
            details: { url: this.url }
        })
    }

    private failure(action: string, error: unknown): BusinessException {
        if (!axios.isAxiosError(error)) {
            const reason = error instanceof Error ? error.message : String(error)
            return createBusinessException({ code: "ARGOCD_REQUEST_FAILED", message: `Argo CD did not ${action}: ${reason}`, statusCode: 502, details: { url: this.url, reason } })
        }
        if (!error.response) {
            const reason = error.code || error.message
            if (TLS_ERRORS.has(error.code ?? "")) {
                return createBusinessException({
                    code: "ARGOCD_TLS_UNTRUSTED",
                    message: `The certificate of Argo CD at ${this.url} is not trusted (${reason}): serve the API with a certificate of a trusted authority, add its CA to NODE_EXTRA_CA_CERTS of the orchestrator, or, for a self-signed one, accept it in the Argo CD settings of the project`,
                    statusCode: 502,
                    details: { url: this.url, reason }
                })
            }
            return createBusinessException({
                code: "ARGOCD_UNREACHABLE",
                message: `Argo CD cannot be reached at ${this.url} (${reason}): check the URL, and that the cluster of the orchestrator can open connections to the Argo CD API`,
                statusCode: 502,
                details: { url: this.url, reason }
            })
        }
        const status = error.response.status
        if (status === 401) return this.unauthorized()
        if (status === 403) {
            return createBusinessException({
                code: "ARGOCD_FORBIDDEN",
                message: `The Argo CD account of the token may not ${action}: grant it role:orchestrator in argocd-rbac-cm, as docs/ARGOCD.md shows`,
                statusCode: 422,
                details: { url: this.url, reason: action }
            })
        }
        // Only the message of an error Argo CD shaped: a proxy in front of it may answer with a whole page
        const data = error.response.data as { message?: unknown } | undefined
        const message = data && typeof data === "object" && typeof data.message === "string" ? data.message.slice(0, MESSAGE_MAX_LENGTH) : undefined
        const reason = message ? `${status} ${message}` : String(status)
        return createBusinessException({ code: "ARGOCD_REQUEST_FAILED", message: `Argo CD did not ${action} (${reason})`, statusCode: 502, details: { url: this.url, reason } })
    }
}

export default ArgoCdClient
