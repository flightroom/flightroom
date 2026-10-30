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
const sameRepoUrl = (a: string, b: string) => {
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

    /** One already gone is not an error: looked for in the list first, as Argo CD answers 403 for it */
    async deleteRepository(repo: string, project?: string): Promise<void> {
        const registered = await this.listRepositories()
        if (!registered.some(registration => sameRepoUrl(registration.repo, repo) && (registration.project || undefined) === project)) return
        await this.find(`delete the repository ${repo}`, () => this.api.delete(`/repositories/${encodeURIComponent(repo)}`, { params: { appProject: project } }))
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

    /** Without cascade: what the application deployed stays in the cluster. One already gone is not an error */
    async deleteApplication(name: string): Promise<void> {
        await this.find(`delete the Application ${name}`, () => this.api.delete(`/applications/${encodeURIComponent(name)}`, { params: { cascade: false } }))
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
