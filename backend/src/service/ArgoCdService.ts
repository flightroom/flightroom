import { isValidObjectId, Schema } from "mongoose"
import { fastify } from ".."
import ArgoCdClient, { ArgoCdLogLine, ArgoCdPod } from "../client/ArgoCdClient"
import { BusinessException } from "../errors/BusinessException"
import { EntityNotFoundError } from "../errors/EntityNotFoundError"
import { ProjectNotFoundError } from "../errors/ProjectNotFoundError"
import Backend from "../models/BackendModel"
import CodeRepository, { CodeRepositoryProvider } from "../models/CodeRepositoryModel"
import Deployment from "../models/DeploymentModel"
import Environment from "../models/EnvironmentModel"
import Frontend, { FrontendKind } from "../models/FrontendModel"
import MaintenanceAgent from "../models/MaintenanceAgentModel"
import Project, { IArgoCdRepositoryCredential, IArgoCdRepositoryRegistration, IProjectArgoCd, IProjectGitOps } from "../models/ProjectModel"
import { allInOrder } from "../utils/allInOrder"
import { toObjectId } from "../utils/mongooseUtils"
import { deleteRegistration, newCredential, retire, revoke, storedRepositoryToken } from "./argoCd/argoCdCredentials"
import {
    branchesFailed,
    environmentsWithoutBranch,
    errorOf,
    gitOpsRequired,
    nameClash,
    nameConflict,
    namespacesNotInProject,
    notConfigured,
    reinitializeRequired,
    tokenRequired
} from "./argoCd/argoCdErrors"
import { deleteLeftovers, earlierAppProjects, ensureNamesFree, repositoryTargets, sharedRepositories } from "./argoCd/argoCdInitialization"
import { acquire, LEASE_MS, Lease, release, save } from "./argoCd/argoCdLease"
import {
    committedSecretData,
    LivePod,
    LiveSource,
    liveContainerOf,
    liveContainerVariables,
    liveData,
    liveSourcesOf,
    liveStartedAt,
    RESOURCE_SECRET_SUFFIX,
    RunningContainerEnvironmentDTO
} from "./argoCd/argoCdLiveEnvironment"
import {
    DEFAULT_SEARCH_MAX_LINES,
    DEFAULT_SEARCH_TAIL_LINES,
    inBatches,
    isTroubled,
    keptLines,
    LogSearchDTO,
    LogSearchInput,
    LogSearchSource,
    LogStream,
    MAX_LINE_LENGTH,
    MAX_SEARCH_TARGETS,
    MAX_SEARCHED_PODS,
    mergedLines,
    SEARCH_CONCURRENCY
} from "./argoCd/argoCdLogSearch"
import { podLogsQuery, podOf } from "./argoCd/argoCdLogs"
import { argoCdInUse, clientOf, deployableSlugs, environmentsOf, linksOf, normalizeUrl, projectOf, repoUrlOf, retyped } from "./argoCd/argoCdProject"
import { DEPLOYED_VERSIONS, followRollout } from "./argoCd/argoCdRollout"
import { ArgoCdInitializeInput, ArgoCdLogsInput, ArgoCdRepositories, ArgoCdStatusDTO, EnvironmentStatusDTO, PendingDeployToken, RepositoryTarget, RolloutPodLogs } from "./argoCd/argoCdTypes"
import BaseAuthorizedService, { domainScopeForbidden, secretRevealForbidden } from "./BaseAuthorizedService"
import CodeRepositoryService from "./CodeRepositoryService"
import GitOpsService, { backendEnvFilePath, environmentNamespace, environmentSlug, gitOpsFilePath, resourceFilePath } from "./GitOpsService"
import { BACKEND_ENV_SECRET_SUFFIX, isDeployable } from "./gitops/applicationManifests"
import {
    ArgoCdEnvironment,
    applicationName,
    appProjectName,
    branchOf,
    buildApplicationSets,
    buildArgoCdState,
    clashingName,
    ENVIRONMENT_LABEL,
    environmentApplicationName,
    PROJECT_ID_LABEL,
    projectIdOf
} from "./gitops/argoCdManifests"
import { RolloutApplication, RolloutDTO } from "./gitops/rollout"
import RepositoryFileService, { repositoryNameFor, toErrorMessage } from "./RepositoryFileService"

/** The pods whose live manifest is read when they are listed with details, one call each: as many as a Deployment may run */
const MAX_DETAILED_PODS = 20
/** The live manifests read at once */
const POD_DETAIL_CONCURRENCY = 5
/** Lines read from the end of a pod a rollout left crashing or not ready */
const ROLLOUT_LOG_LINES = 40
/** Pods of one application, and of a whole rollout, whose lines are read once it is left broken */
const ROLLOUT_LOG_PODS_PER_APPLICATION = 2
const MAX_ROLLOUT_LOG_PODS = 6

const LOGS_FORBIDDEN = { code: "ARGOCD_LOGS_FORBIDDEN", message: "A viewer cannot read the logs of the applications" }

/**
 * Hands the GitOps repositories of a project to an Argo CD instance that runs on another cluster, through its
 * API: the credentials to read them, an AppProject confining the project to them and to the namespaces of its
 * environments, the ApplicationSet Argo CD makes the Application of each environment from, and per backend and
 * frontend the ApplicationSet of its applications. Running it again re-aligns Argo CD with the project: the
 * environments added since get theirs, those deleted lose theirs, the deploy tokens of GitLab are rotated and
 * the credentials of a repository no longer linked are withdrawn. Between two initializations, every deploy
 * aligns the ApplicationSets of the backends and frontends.
 *
 * The console owns the credentials: the token of Argo CD and those of the repositories are stored encrypted,
 * and none of them goes back to a client. The configuration repository, which holds the secrets in plaintext,
 * is registered for the AppProject of the project only; the applications one, which holds Helm values, is
 * registered globally, as the git generator of an ApplicationSet reads it outside of any AppProject.
 */
class ArgoCdService extends BaseAuthorizedService {
    /**
     * Starts the CronJob of the application `slug` in `environment` now, through the Application the ApplicationSet
     * of `slug` generated there. The CronJob is named after the Helm release, which is the slug. Whoever calls it
     * checks who may.
     */
    async createJobFromCronJob(projectId: Schema.Types.ObjectId, slug: string, environment: { slug: string; namespace?: string }): Promise<void> {
        const { client, application, appProject } = await this.deployedApplication(projectId, slug, environment)
        await client.createJobFromCronJob(application, appProject, environmentNamespace(environment), slug)
    }

    /**
     * The pods the backend, frontend or maintenance agent `slug` runs in the environment now, read through Argo CD.
     * With `details`, each of the first {@link MAX_DETAILED_PODS} also says what its containers ask for and are held
     * to and how they last stopped, from its live manifest: one more call per pod, so only for who asks for them (an
     * agent diagnosing), not for the console's page that polls the list. A pod whose manifest cannot be read keeps
     * what the tree says of it.
     */
    async listPods(projectId: string, slug: string, environmentId: string, { details = false }: { details?: boolean } = {}): Promise<ArgoCdPod[]> {
        const environment = await this.readableEnvironment(projectId, slug, environmentId)
        const { client, application, appProject } = await this.deployedApplication(toObjectId(projectId), slug, environment)
        const pods = await client.listPods(application, appProject)
        if (!details) return pods
        const detailed = [...pods]
        const detail = async (index: number) => {
            const pod = pods[index]
            const containerDetails = await client.getPodContainers(application, appProject, pod).catch(error => {
                fastify.log.warn({ error: toErrorMessage(error), application, pod: pod.name }, "Argo CD pod manifest not read")
                return null
            })
            if (containerDetails) detailed[index] = { ...pod, containerDetails }
        }
        // A few at a time: a Deployment of many replicas must not open as many requests to Argo CD at once
        const indexes = pods.slice(0, MAX_DETAILED_PODS).map((_pod, index) => index)
        for (let start = 0; start < indexes.length; start += POD_DETAIL_CONCURRENCY) {
            await Promise.all(indexes.slice(start, start + POD_DETAIL_CONCURRENCY).map(detail))
        }
        return detailed
    }

    /**
     * The pods of an application of the project in `environment`, as the tree of its Application describes them,
     * without the details of their containers. Whoever calls it checks who may.
     */
    async podsOf(projectId: Schema.Types.ObjectId, slug: string, environment: { slug: string; namespace?: string }): Promise<ArgoCdPod[]> {
        const { client, application, appProject } = await this.deployedApplication(projectId, slug, environment)
        return client.listPods(application, appProject)
    }

    /**
     * The last lines a pod of `slug` wrote in the environment, read through Argo CD, which refuses a pod its
     * Application does not run: a pod of another application of the namespace is not reachable from here.
     */
    async getLogs(projectId: string, slug: string, environmentId: string, query: ArgoCdLogsInput): Promise<ArgoCdLogLine[]> {
        const environment = await this.readableEnvironment(projectId, slug, environmentId)
        return this.logsOf(toObjectId(projectId), slug, environment, query)
    }

    /** As {@link getLogs}, for an application of the project in `environment`. Whoever calls it checks who may. */
    async logsOf(projectId: Schema.Types.ObjectId, slug: string, environment: { slug: string; namespace?: string }, query: ArgoCdLogsInput): Promise<ArgoCdLogLine[]> {
        const pod = podOf(query)
        const { client, application, appProject } = await this.deployedApplication(projectId, slug, environment)
        return client.getPodLogs(application, appProject, podLogsQuery(query, pod, environmentNamespace(environment)))
    }

    /**
     * What the applications of `input.slugs`, else every backend and container frontend each environment runs, wrote in the
     * environments, read through Argo CD pod by pod and merged oldest first: the newest `maxLines` of the lines kept. A pod
     * that restarted gives the lines of the container before too, unless `previous` is false. At most
     * {@link MAX_SEARCHED_PODS} pods are read. An application that cannot be read says why in its source, the others are
     * read anyway.
     */
    async searchLogs(projectId: string, input: LogSearchInput): Promise<LogSearchDTO> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        await this.ensureNotViewer(projectIdObj, LOGS_FORBIDDEN)
        const project = await Project.findById(projectIdObj, { slug: 1, gitOps: 1, argoCd: 1, containerRegistry: 1 })
        if (!project || !argoCdInUse(project)) throw notConfigured()
        const environments = await this.environmentsAmong(projectIdObj, input.environmentIds)
        const wanted = input.slugs?.length
            ? environments.flatMap(environment => [...new Set(input.slugs)].map(slug => ({ environment, slug })))
            : await this.runningApplications(projectIdObj, project.containerRegistry, environments)

        const notes: string[] = []
        const targets = wanted.slice(0, MAX_SEARCH_TARGETS)
        if (targets.length < wanted.length) {
            const left = wanted.slice(MAX_SEARCH_TARGETS).map(({ environment, slug }) => `${environment.slug}/${slug}`)
            notes.push(`Not read, past the ${MAX_SEARCH_TARGETS} applications one search reads: ${left.join(", ")}`)
        }
        const streams: LogStream[] = []
        let podsLeft = MAX_SEARCHED_PODS
        const sources = await inBatches(targets, SEARCH_CONCURRENCY, async ({ environment, slug }) => {
            const source: LogSearchSource = { environment: environment.slug, application: slug, pods: 0, matched: 0 }
            // Argo CD is not asked once the search has read all the pods it reads
            if (podsLeft <= 0) {
                notes.push(`${environment.slug}/${slug}: not read, past the ${MAX_SEARCHED_PODS} pods one search reads`)
                return source
            }
            try {
                await this.readableEnvironment(projectId, slug, String(environment._id))
                const { client, application, appProject } = await this.deployedApplication(projectIdObj, slug, environment)
                const pods = await client.listPods(application, appProject)
                // Taken before any wait: the applications read at once share what is left
                const read = pods.slice(0, Math.max(podsLeft, 0))
                podsLeft -= read.length
                source.pods = pods.length
                if (read.length < pods.length)
                    notes.push(`${environment.slug}/${slug}: ${pods.length - read.length} of its ${pods.length} pods not read, past the ${MAX_SEARCHED_PODS} one search reads`)
                const containers = read.flatMap(pod => [{ pod, previous: false }, ...(input.previous !== false && (pod.restarts ?? 0) > 0 ? [{ pod, previous: true }] : [])])
                for (const { pod, previous } of containers) {
                    const query = podLogsQuery({ tailLines: input.tailLines ?? DEFAULT_SEARCH_TAIL_LINES, sinceSeconds: input.sinceSeconds, previous }, pod.name, environmentNamespace(environment))
                    // The container before a restart may be gone already: its lines come when there are some
                    const lines = await client.getPodLogs(application, appProject, query).catch(error => (previous ? [] : Promise.reject(error)))
                    const kept = keptLines(lines, input)
                    source.matched += kept.length
                    streams.push({ environment: environment.slug, pod: pod.name, previous, lines: kept })
                }
            } catch (error) {
                if (!(error instanceof BusinessException) && !(error instanceof EntityNotFoundError)) fastify.log.warn({ error: toErrorMessage(error), slug }, "Argo CD logs not read for a search")
                source.error = error instanceof BusinessException ? error.message : error instanceof EntityNotFoundError ? "Not found in this project" : "The logs could not be read"
            }
            return source
        })
        const { lines, matched } = mergedLines(streams, input.maxLines ?? DEFAULT_SEARCH_MAX_LINES)
        return { lines, matched, truncated: matched > lines.length, sources, ...(notes.length ? { notes } : {}) }
    }

    /**
     * How the backends and container frontends an environment serves are doing now, of those the user reaches: per
     * application the version the deployment the environment serves ships, where Argo CD stands with it, as
     * {@link rollout} says it, and its pods with their restarts. Not for a viewer: the pods are read as the logs are.
     */
    async environmentStatus(projectId: string, environmentId: string): Promise<EnvironmentStatusDTO> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        await this.ensureNotViewer(projectIdObj, LOGS_FORBIDDEN)
        const [environment] = await this.environmentsAmong(projectIdObj, [environmentId])
        const summary = { _id: String(environment._id), name: environment.name, slug: environment.slug }
        // The active one, else the latest, as the environment serves it
        const deployment = await Deployment.findOne({ environmentId: environment._id }, `${DEPLOYED_VERSIONS} deploymentId deployedAt`, { sort: { active: -1, deployedAt: -1 } })
        if (!deployment) return { environment: summary, deployment: null, tracked: false, applications: [] }

        const rollout = await this.rollout(projectIdObj, deployment._id)
        const versions = new Map([...(deployment.backends ?? []), ...(deployment.frontends ?? [])].map(application => [String(application._id), application.version ?? null]))
        const applications = await inBatches(rollout.applications, SEARCH_CONCURRENCY, async ({ updated: _updated, pods, ...application }) => {
            // The rollout reads the pods of those not healthy only: those of the others still say how often they restarted
            // Checked as the pods of one application are: a slug shared with an application of another domain is not read
            const read =
                pods ??
                (await this.readableEnvironment(projectId, application.slug, String(environment._id))
                    .then(() => this.podsOf(projectIdObj, application.slug, environment))
                    .catch(() => undefined))
            return {
                ...application,
                version: versions.get(application._id) ?? null,
                ...(read ? { pods: read.map(({ namespace: _namespace, containerDetails: _details, ...pod }) => pod) } : {})
            }
        })
        return {
            environment: summary,
            deployment: { _id: String(deployment._id), deploymentId: deployment.deploymentId, deployedAt: deployment.deployedAt },
            tracked: rollout.tracked,
            applications,
            ...(rollout.alignError ? { alignError: rollout.alignError } : {})
        }
    }

    /**
     * The last lines of the pods a rollout of the deployment left crashing or not ready, of its applications not healthy:
     * what a crash printed, read from the container before its restart when the pod restarted. Read as the logs are: not
     * for a viewer, and of the applications the user reaches only. A pod whose lines cannot be read is left out.
     */
    async rolloutLogs(projectId: string, deploymentId: string, applications: RolloutApplication[]): Promise<RolloutPodLogs[]> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        await this.ensureNotViewer(projectIdObj, LOGS_FORBIDDEN)
        if (!isValidObjectId(deploymentId)) throw new EntityNotFoundError(deploymentId)
        const deployment = await Deployment.findById(toObjectId(deploymentId), { environmentId: 1 })
        const environment = deployment ? await Environment.findOne({ _id: deployment.environmentId, projectId: projectIdObj }, { slug: 1, namespace: 1 }) : null
        if (!environment) throw new EntityNotFoundError(deploymentId)

        const troubled = applications
            .filter(application => application.state !== "healthy")
            .flatMap(application =>
                (application.pods ?? [])
                    .filter(isTroubled)
                    .slice(0, ROLLOUT_LOG_PODS_PER_APPLICATION)
                    .map(pod => ({ slug: application.slug, pod }))
            )
            .slice(0, MAX_ROLLOUT_LOG_PODS)
        const read = await inBatches(troubled, SEARCH_CONCURRENCY, async ({ slug, pod }) => {
            const previous = (pod.restarts ?? 0) > 0
            const lines = await this.readableEnvironment(projectId, slug, String(environment._id))
                .then(() => this.logsOf(projectIdObj, slug, environment, { pod: pod.name, tailLines: ROLLOUT_LOG_LINES, previous }))
                .catch(() => [])
            return { application: slug, pod: pod.name, previous, lines: lines.map(line => line.content.slice(0, MAX_LINE_LENGTH)) }
        })
        return read.filter(entry => entry.lines.length > 0)
    }

    /** The environments of `environmentIds`, in that order; one that is not the project's is not found */
    private async environmentsAmong(projectId: Schema.Types.ObjectId, environmentIds: string[]) {
        const ids = [...new Set(environmentIds)]
        const invalid = ids.find(id => !isValidObjectId(id))
        if (invalid) throw new EntityNotFoundError(invalid)
        const environments = await Environment.find({ _id: { $in: ids.map(id => toObjectId(id)) }, projectId }, { name: 1, slug: 1, namespace: 1 })
        return ids.map(id => {
            const environment = environments.find(candidate => String(candidate._id) === id)
            if (!environment) throw new EntityNotFoundError(id)
            return environment
        })
    }

    /** Every backend and container frontend each environment runs, of those the user reaches: those with a version and an image there */
    private async runningApplications<Target extends { _id: unknown }>(projectId: Schema.Types.ObjectId, containerRegistry: string | undefined, environments: Target[]) {
        const scope = { projectId, ...(await this.domainScopeFilter(projectId)) }
        const fields = { slug: 1, environmentVersions: 1, image: 1 }
        const [backends, frontends] = await allInOrder([Backend.find(scope, fields), Frontend.find({ ...scope, kind: FrontendKind.DOCKER }, fields)])
        return environments.flatMap(environment => {
            // A backend and a container frontend may share a slug: they run under one Application
            const slugs = new Set([...backends, ...frontends].filter(application => isDeployable(application, containerRegistry, environment._id)).map(application => application.slug))
            return [...slugs].map(slug => ({ environment, slug }))
        })
    }

    /**
     * The variables the running container of a backend or a DOCKER frontend got in the environment, from the live
     * manifest of one of its pods, a running one first, read through Argo CD: its `env`, then what the ConfigMaps
     * and Secrets of its `envFrom` hold now in the cluster, read through the Application of the environment, which
     * applies them. Argo CD hides the values of a Secret: only its keys are listed. Who may read the logs may read them.
     * With `reveal`, for whoever may see the values of the project's secrets, a Secret's values come in clear, from
     * the manifest of the configuration repository at the revision Argo CD synced the environment to.
     */
    async runningEnvironment(
        projectId: string,
        target: { kind: "backend" | "frontend"; id: string },
        environmentId: string,
        options: { reveal?: boolean } = {}
    ): Promise<RunningContainerEnvironmentDTO> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        if (options.reveal && !(await this.mayRevealSecrets(projectIdObj))) throw secretRevealForbidden()
        if (!isValidObjectId(target.id)) throw new EntityNotFoundError(target.id)
        const component =
            target.kind === "backend"
                ? await Backend.findOne({ _id: toObjectId(target.id), projectId: projectIdObj }, { slug: 1 })
                : await Frontend.findOne({ _id: toObjectId(target.id), projectId: projectIdObj, kind: FrontendKind.DOCKER }, { slug: 1 })
        if (!component) throw new EntityNotFoundError(target.id)
        const environment = await this.readableEnvironment(projectId, component.slug, environmentId)
        const { client, application, appProject, environmentApplication } = await this.deployedApplication(projectIdObj, component.slug, environment)
        const pods = await client.listPods(application, appProject)
        const pod = pods.find(candidate => candidate.status === "Running") ?? pods[0]
        const manifest = pod ? ((await client.getLiveManifest(application, appProject, { kind: "Pod", name: pod.name, namespace: pod.namespace })) as LivePod | null) : null
        const container = manifest ? liveContainerOf(manifest, component.slug) : undefined
        if (!pod || !manifest || !container) return { state: "no_pod", variables: [] }

        const notes: string[] = []
        const data = new Map<string, Record<string, string> | null>()
        const sources = liveSourcesOf(container)
        for (const source of sources) {
            const object = await client.getLiveManifest(environmentApplication, appProject, { ...source, namespace: pod.namespace })
            if (object) data.set(`${source.kind}/${source.name}`, liveData(object))
            else notes.push(`${source.kind} ${source.name} not read: the Application of the environment does not manage it`)
        }
        const secrets = sources.filter(source => source.kind === "Secret" && data.has(`Secret/${source.name}`))
        const revealed = options.reveal && secrets.length ? await this.committedSecrets(projectIdObj, environment, { client, appProject, environmentApplication }, secrets, notes) : undefined
        const startedAt = liveStartedAt(manifest, container)
        return {
            state: "running",
            pod: pod.name,
            ...(startedAt ? { startedAt } : {}),
            variables: liveContainerVariables(container, data, revealed),
            ...(notes.length ? { notes } : {})
        }
    }

    /**
     * What the Secrets of `secrets` hold in the environment, by `Secret/name`: Argo CD hides it in their live manifests,
     * so it is read from those the deploy committed to the configuration repository, at the revision Argo CD synced
     * the environment to, which is what it applied to the cluster. A Secret not found there stays masked, with a note.
     */
    private async committedSecrets(
        projectId: Schema.Types.ObjectId,
        environment: { slug: string },
        argoCd: { client: ArgoCdClient; appProject: string; environmentApplication: string },
        secrets: LiveSource[],
        notes: string[]
    ): Promise<Map<string, Record<string, string>>> {
        const [project, application] = await Promise.all([Project.findById(projectId, { gitOps: 1 }), argoCd.client.getApplication(argoCd.environmentApplication, argoCd.appProject)])
        const link = project?.gitOps?.codeRepository
        const revision = application?.status?.sync?.revision
        if (!link || !revision) {
            notes.push("Secret values not shown: Argo CD reports no revision of the configuration repository synced to the environment")
            return new Map()
        }
        const connection = await new GitOpsService(this.user).connectionOf(link, projectId)
        const repository = { codeRepository: connection, repositoryName: repositoryNameFor(link, connection) }
        const files = new RepositoryFileService(this.user)
        const read = await Promise.all(
            secrets.map(async ({ name }) => {
                const path = name.endsWith(RESOURCE_SECRET_SUFFIX)
                    ? resourceFilePath(environment, { name: name.slice(0, -RESOURCE_SECRET_SUFFIX.length) })
                    : name.endsWith(BACKEND_ENV_SECRET_SUFFIX)
                      ? backendEnvFilePath(environment, { slug: name.slice(0, -BACKEND_ENV_SECRET_SUFFIX.length) })
                      : gitOpsFilePath("secret", environment, name)
                const file = await files.readFile(repository, path, revision, "commit")
                if (!file) notes.push(`Secret ${name}: values not shown, ${path} is not in the configuration repository at ${revision.slice(0, 7)}`)
                return file ? ([`Secret/${name}`, committedSecretData(file.raw)] as const) : undefined
            })
        )
        return new Map(read.filter(entry => entry !== undefined))
    }

    /**
     * Where the deploy `deploymentId` stands, application by application: Argo CD applies what it committed, then
     * Kubernetes replaces the pods. Followed are the backends and the container frontends a deploy installs through
     * Argo CD, of `domainId` for the deploy of a domain, otherwise of the domains the user reaches. Not tracked when
     * the project deploys through no Argo CD: there the deploy is over with its commit.
     */
    async rollout(projectId: string | Schema.Types.ObjectId, deploymentId: string | Schema.Types.ObjectId, domainId?: string | Schema.Types.ObjectId): Promise<RolloutDTO> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        if (!isValidObjectId(deploymentId)) throw new EntityNotFoundError(String(deploymentId))
        if (domainId !== undefined && !isValidObjectId(domainId)) throw new EntityNotFoundError(String(domainId))
        if (domainId) await this.ensureInDomainScope(projectIdObj, domainId)
        const deployment = await Deployment.findById(toObjectId(deploymentId), DEPLOYED_VERSIONS)
        const [project, environment] = await Promise.all([
            Project.findById(projectIdObj, { slug: 1, gitOps: 1, argoCd: 1, containerRegistry: 1 }),
            deployment ? Environment.findOne({ _id: deployment.environmentId, projectId: projectIdObj }, { slug: 1, namespace: 1 }) : null
        ])
        if (!project) throw new ProjectNotFoundError(String(projectId))
        if (!deployment || !environment) throw new EntityNotFoundError(String(deploymentId))
        const argoCd = argoCdInUse(project)
        if (!argoCd) return { tracked: false, applications: [], done: true, failed: false }
        const domainScope = () => (domainId ? Promise.resolve({ domainId: toObjectId(domainId) }) : this.domainScopeFilter(projectIdObj))
        return followRollout(projectIdObj, project, argoCd, deployment, environment, domainScope)
    }

    /**
     * The environment of the Application of `slug`, for a member of the project who is not a viewer: logs may
     * hold what the configuration hides, a viewer does not read them. `slug` must be one of the project's.
     */
    private async readableEnvironment(projectId: string, slug: string, environmentId: string) {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        await this.ensureNotViewer(projectIdObj, LOGS_FORBIDDEN)
        if (!isValidObjectId(environmentId)) throw new EntityNotFoundError(String(environmentId))
        const [environment, backend, frontend, agent] = await Promise.all([
            Environment.findOne({ _id: toObjectId(environmentId), projectId: projectIdObj }, { slug: 1, namespace: 1 }),
            Backend.exists({ projectId: projectIdObj, slug }),
            Frontend.exists({ projectId: projectIdObj, slug, kind: FrontendKind.DOCKER }),
            MaintenanceAgent.exists({ projectId: projectIdObj, slug })
        ])
        if (!environment) throw new EntityNotFoundError(String(environmentId))
        if (!backend && !frontend && !agent) throw new EntityNotFoundError(String(slug))
        // A domain-scoped member reads the applications of their domains only, as everywhere else in the console. The
        // Application is named after the slug alone, which a backend, a frontend and an agent may share: each one
        // running under it must be in scope, or one of their own would open the pods of another domain's
        const scope = await this.getDomainScope(projectIdObj)
        if (scope) {
            // $nin also matches a component with no domain at all, outside every scope
            const outside = { projectId: projectIdObj, slug, domainId: { $nin: scope.map(id => toObjectId(id)) } }
            const elsewhere = await Promise.all([Backend.exists(outside), Frontend.exists({ ...outside, kind: FrontendKind.DOCKER }), MaintenanceAgent.exists(outside)])
            if (elsewhere.some(Boolean)) throw domainScopeForbidden()
        }
        return environment
    }

    /** The client of the Argo CD the project deploys through, and the names of the Application of `slug` in the environment there */
    private async deployedApplication(projectId: Schema.Types.ObjectId, slug: string, environment: { slug: string; namespace?: string }) {
        const project = await Project.findById(projectId, { slug: 1, gitOps: 1, argoCd: 1 })
        const argoCd = argoCdInUse(project)
        if (!project || !argoCd) throw notConfigured()
        return {
            client: clientOf(argoCd),
            application: applicationName(String(projectId), project.slug, slug, environmentSlug(environment)),
            appProject: appProjectName(String(projectId), project.slug),
            // The Application of the environment: it applies its config maps and secrets
            environmentApplication: environmentApplicationName(String(projectId), project.slug, environmentSlug(environment))
        }
    }

    /** Any member of the project sees where it is deployed from; the credentials stay behind */
    async get(projectId: string | Schema.Types.ObjectId): Promise<ArgoCdStatusDTO> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        const project = await Project.findById(projectIdObj, { organizationId: 1, gitOps: 1, argoCd: 1 })
        if (!project) throw new ProjectNotFoundError(String(projectId))
        const canInitialize = await new GitOpsService(this.user).ensureOwner(projectIdObj, project.organizationId).then(
            () => true,
            () => false
        )
        return this.status(projectIdObj, project.gitOps, project.argoCd, canInitialize)
    }

    /**
     * Initializes Argo CD for the project, or re-aligns it. Only an owner of the project does it, one at a time,
     * and only once GitOps has a configuration repository. The token is checked, and every name the project
     * would take is checked to be free or its own, before anything is written. A GitLab repository gets a new
     * deploy token, and the one before is revoked only once Argo CD holds the new one. A failure is stored on
     * the project, for the screen to show, and goes on as it was.
     */
    async initialize(projectId: string | Schema.Types.ObjectId, input: ArgoCdInitializeInput): Promise<ArgoCdStatusDTO> {
        const projectIdObj = toObjectId(projectId)
        await this.ensureAccessToProject(projectIdObj)
        const project = await Project.findById(projectIdObj)
        if (!project) throw new ProjectNotFoundError(String(projectId))
        const gitOpsService = new GitOpsService(this.user)
        await gitOpsService.ensureOwner(projectIdObj, project.organizationId)

        if (!project.gitOps?.enabled || !project.gitOps.codeRepository) throw gitOpsRequired()

        const url = normalizeUrl(input?.url)
        const insecure = input?.insecure === true
        // Checked again under the lease, on the project as it is then: this only refuses early what cannot go through
        if (!retyped(input?.token) && project.argoCd?.url !== url) throw tokenRequired()

        // An environment whose slug or namespace Kubernetes refuses stops the run before anything is written
        const environments = await environmentsOf(projectIdObj)

        const lease: Lease = { at: new Date() }
        await acquire(projectIdObj, lease)
        try {
            // Read again under the lease: a run that ended meanwhile may have rotated the tokens read above
            const current = await Project.findById(projectIdObj, { slug: 1, gitOps: 1, argoCd: 1, containerRegistry: 1 })
            if (!current) throw new ProjectNotFoundError(String(projectId))
            const gitOps = current.gitOps
            if (!gitOps?.enabled || !gitOps.codeRepository) throw gitOpsRequired()
            const previous = current.argoCd
            // The stored token goes only to the URL it was stored with: pointing the console elsewhere asks for it again
            const token = retyped(input?.token) ?? (previous?.url === url ? previous.token : undefined)
            if (!token) throw tokenRequired()

            const client = new ArgoCdClient(url, token, { insecure })
            const repositories: ArgoCdRepositories = { ...previous?.repositories }
            // Those of another Argo CD are left there, as the rest of what the console made on it
            let deletions = (previous?.pendingRepositoryDeletions ?? []).filter(registration => registration.argoCdUrl === url)
            let pending: PendingDeployToken | undefined
            let verified = false
            const saveRun = (argoCd: IProjectArgoCd) => save(projectIdObj, { ...argoCd, pendingRepositoryDeletions: deletions }, lease)
            try {
                await client.getUserInfo()
                verified = true

                const projectName = appProjectName(String(projectIdObj), current.slug)
                const targets = await repositoryTargets(gitOpsService, gitOps, projectIdObj, projectName)
                const applicationsTarget = targets.find(target => target.kind === "applications")
                const [applications, applicationBranches] = applicationsTarget ? await allInOrder([deployableSlugs(projectIdObj, current.containerRegistry), this.branchesOf(applicationsTarget)]) : []
                const state = buildArgoCdState({
                    projectId: String(projectIdObj),
                    projectSlug: current.slug,
                    configurationRepoUrl: targets.find(target => target.kind === "configuration")?.repoUrl,
                    applicationsRepoUrl: applicationsTarget?.repoUrl,
                    environments,
                    ...(applicationsTarget ? { applications, applicationBranches } : {})
                })
                const clash = clashingName(state)
                if (clash) throw nameClash(clash)

                await ensureNamesFree(client, state, projectName, projectIdObj)
                const movedFrom = await earlierAppProjects(client, previous, url, projectIdObj, current.slug, projectName)
                const shared = await sharedRepositories(client, targets, previous, url, { _id: projectIdObj, organizationId: project.organizationId }, movedFrom)

                await client.upsertProject(state.appProject)

                const undeleted: IArgoCdRepositoryRegistration[] = []
                for (const target of targets) {
                    const { kind, connection, repoUrl, argoProject } = target
                    const before = previous?.repositories?.[kind]
                    const common = { argoCdUrl: url, repoUrl, argoProject, codeRepositoryId: String(connection._id) }
                    if (shared.has(kind)) {
                        // No token of its own: the registration and its credentials stay those of the project that made them
                        const credential: IArgoCdRepositoryCredential = { source: "shared", username: "", password: "", ...common }
                        repositories[kind] = credential
                        await saveRun({ ...previous, url, token, insecure, repositories })
                        if (before) undeleted.push(...(await retire(client, url, projectIdObj, before, credential)))
                        continue
                    }
                    const created = await newCredential(target, common, retyped(input?.repositoryToken), previous)
                    if (created.pending) pending = created.pending
                    const { credential } = created

                    await client.upsertRepository({ repo: repoUrl, username: credential.username, password: credential.password, project: argoProject })
                    repositories[kind] = credential
                    // Stored at once: whatever fails next, the console knows which token Argo CD holds. Until it is
                    // stored the new deploy token stays pending, revoked should the save fail
                    await saveRun({ ...previous, url, token, insecure, repositories })
                    pending = undefined
                    if (before) undeleted.push(...(await retire(client, url, projectIdObj, before, credential)))
                }
                for (const kind of ["configuration", "applications"] as const) {
                    const before = previous?.repositories?.[kind]
                    if (!before || targets.some(target => target.kind === kind)) continue
                    undeleted.push(...(await retire(client, url, projectIdObj, before)))
                    delete repositories[kind]
                }
                // The deletions an earlier run could not make, unless the repository is registered there again now
                const retried: IArgoCdRepositoryRegistration[] = []
                for (const registration of deletions) {
                    if (targets.some(target => target.repoUrl === registration.repoUrl && target.argoProject === registration.argoProject)) continue
                    if (!(await deleteRegistration(client, projectIdObj, registration))) retried.push(registration)
                }
                deletions = [...retried, ...undeleted]
                await saveRun({ ...previous, url, token, insecure, repositories })

                for (const applicationSet of state.applicationSets) await client.upsertApplicationSet(applicationSet)

                await deleteLeftovers(client, projectIdObj, projectName, movedFrom, new Set(state.applicationSets.map(resource => resource.metadata.name)))

                const argoCd: IProjectArgoCd = { url, token, insecure, repositories, initializedAt: new Date() }
                await saveRun(argoCd)
                return this.status(projectIdObj, gitOps, { ...argoCd, pendingRepositoryDeletions: deletions }, true)
            } catch (error) {
                if (pending) await revoke(pending)
                const lastError = errorOf(error)
                // Once the token is known to be good it is kept, and so are the credentials Argo CD already holds
                await saveRun(verified ? { ...previous, url, token, insecure, repositories, lastError } : { ...previous, lastError }).catch(saveError =>
                    fastify.log.error({ error: toErrorMessage(saveError) }, "Argo CD initialization failure not stored")
                )
                throw error
            }
        } finally {
            await release(projectIdObj, lease)
        }
    }

    /**
     * Gives Argo CD the ApplicationSet of every backend and frontend once a deploy has committed their values:
     * a backend deployed for the first time, or an environment whose branch the deploy just created, gets its
     * Applications without initializing again. Only while the applications repository is the one Argo CD was
     * handed; the environments and the AppProject wait for the next initialization. Never fails the deploy,
     * which already went through: what goes wrong is stored on the project, for the settings to show.
     * `deployedSlugs` are the environments the deploy just committed: each must find its branch now.
     */
    async alignApplications(projectId: Schema.Types.ObjectId, deployedSlugs: string[] = []): Promise<void> {
        // Stored only while no initialization runs: the one that runs re-aligns everything, and saves over it
        const idle = { _id: projectId, "argoCd.initializingAt": { $exists: false } }
        try {
            const project = await Project.findById(projectId, { slug: 1, gitOps: 1, argoCd: 1, containerRegistry: 1 })
            const argoCd = argoCdInUse(project)
            const link = project?.gitOps?.applicationsCodeRepository
            if (!project || !argoCd || !link) return
            // An initialization running read the applications already: its cleanup would delete what this creates
            if (argoCd.initializingAt && new Date(argoCd.initializingAt).getTime() > Date.now() - LEASE_MS) return

            const registered = argoCd.repositories?.applications
            const connection = await new GitOpsService(this.user).connectionOf(link, projectId)
            const repoUrl = repoUrlOf(link, connection)
            // Argo CD was handed another repository, or none: only an initialization registers this one
            if (registered?.argoCdUrl !== argoCd.url || registered.repoUrl !== repoUrl) throw reinitializeRequired()

            const client = clientOf(argoCd)
            const projectName = appProjectName(String(projectId), project.slug)
            const environments = await environmentsOf(projectId)
            const [applications, applicationBranches] = await allInOrder([deployableSlugs(projectId, project.containerRegistry), this.branchesOf({ link, connection })])
            const target = {
                projectId: String(projectId),
                projectSlug: project.slug,
                // Only for the names its objects take, which no application may take too
                configurationRepoUrl: argoCd.repositories?.configuration?.repoUrl,
                applicationsRepoUrl: repoUrl,
                environments,
                applications,
                applicationBranches
            }
            const clash = clashingName(buildArgoCdState(target))
            const appProject = await client.getProject(projectName)
            // Initialized under another name of the AppProject, as 10.x named it: only an initialization moves the project to this one
            if (!appProject) throw reinitializeRequired()
            // An environment added since the initialization has no namespace in the AppProject yet: its Applications would only fail
            const destinations = (appProject.spec?.destinations ?? []) as Array<{ namespace?: string }>
            const inProject = (environment: ArgoCdEnvironment) => destinations.some(destination => destination.namespace === environment.namespace)
            const outside = target.environments.filter(environment => !inProject(environment))
            target.environments = target.environments.filter(inProject)
            if (clash) throw nameClash(clash)

            const applicationSets = buildApplicationSets(target)
            for (const { metadata } of applicationSets) {
                const existing = await client
                    .getApplicationSet(metadata.name)
                    .catch(error => Promise.reject(error instanceof BusinessException && error.code === "ARGOCD_FORBIDDEN" ? nameConflict("ApplicationSet", metadata.name) : error))
                if (existing && (projectIdOf(existing) !== String(projectId) || projectOf({ ...existing, kind: "ApplicationSet" }) !== projectName)) throw nameConflict("ApplicationSet", metadata.name)
            }
            for (const applicationSet of applicationSets) await client.upsertApplicationSet(applicationSet)
            // The others are aligned already: the settings tell those left out wait for an initialization
            if (outside.length > 0) throw namespacesNotInProject(outside)
            // Just committed to, yet not among the branches read: Argo CD gets no Application for it, and nothing else would say so
            const unbranched = target.environments.filter(environment => deployedSlugs.includes(environment.slug) && !branchOf(target, environment))
            if (unbranched.length > 0) throw environmentsWithoutBranch(unbranched, link.name, target.applicationBranches)
            if (argoCd.alignError) await Project.updateOne(idle, { $unset: { "argoCd.alignError": 1 } })
        } catch (error) {
            fastify.log.error({ error: toErrorMessage(error), projectId: String(projectId) }, "Argo CD ApplicationSets of the applications not aligned after a deploy")
            await Project.updateOne(idle, { $set: { "argoCd.alignError": errorOf(error) } }).catch(saveError =>
                fastify.log.error({ error: toErrorMessage(saveError) }, "Argo CD alignment failure not stored")
            )
        }
    }

    /**
     * Has Argo CD read the repositories again for the Applications of `environmentSlugs`, those of the environments
     * and those of the backends and frontends, once a deploy has committed to them: they sync now, not at the next
     * poll of Argo CD, three minutes by default. An Application the ApplicationSet has yet to generate is not there
     * to refresh, it comes with the next poll of the ApplicationSet. Best effort: the deploy already went through,
     * and Argo CD gets there anyway.
     */
    async refreshApplications(projectId: Schema.Types.ObjectId, environmentSlugs: string[]): Promise<void> {
        if (environmentSlugs.length === 0) return
        try {
            const project = await Project.findById(projectId, { slug: 1, gitOps: 1, argoCd: 1 })
            const argoCd = project?.argoCd
            if (!project?.gitOps?.enabled || !argoCd?.initializedAt || !argoCd.url || !argoCd.token) return

            const client = new ArgoCdClient(argoCd.url, argoCd.token, { insecure: argoCd.insecure })
            const projectName = appProjectName(String(projectId), project.slug)
            const selector = `${PROJECT_ID_LABEL}=${projectId},${ENVIRONMENT_LABEL} in (${environmentSlugs.join(",")})`
            const applications = (await client.listApplications(selector, projectName)).filter(application => projectOf(application) === projectName)
            const refreshes = await Promise.allSettled(applications.map(application => client.refreshApplication(application.metadata.name, projectName)))
            const failed = refreshes.flatMap((refresh, index) => (refresh.status === "rejected" ? [{ application: applications[index].metadata.name, error: toErrorMessage(refresh.reason) }] : []))
            if (failed.length > 0) fastify.log.warn({ projectId: String(projectId), failed }, "Argo CD Applications not refreshed after a deploy: they sync at the next poll")
        } catch (error) {
            fastify.log.warn({ error: toErrorMessage(error), projectId: String(projectId) }, "Argo CD Applications not refreshed after a deploy: they sync at the next poll")
        }
    }

    /** The branches of the applications repository: Argo CD fails an ApplicationSet listing a revision that does not exist */
    private async branchesOf({ link, connection }: Pick<RepositoryTarget, "link" | "connection">): Promise<string[]> {
        const branches = await new CodeRepositoryService(this.user)
            .getBranches(String(connection._id), repositoryNameFor(link, connection))
            .catch(error => Promise.reject(branchesFailed(link.name, error)))
        return branches.map(branch => branch.branch)
    }

    private async status(projectId: Schema.Types.ObjectId, gitOps: IProjectGitOps | undefined, argoCd: IProjectArgoCd | undefined, canInitialize: boolean): Promise<ArgoCdStatusDTO> {
        const links = linksOf(gitOps)
        const connections = links.length > 0 ? await CodeRepository.find({ _id: { $in: links.map(([, link]) => link.codeRepositoryId) }, projectId }, { provider: 1 }) : []
        const repositoryTokenProviders = [...new Set(connections.map(connection => connection.provider).filter(provider => provider !== CodeRepositoryProvider.GITLAB))]
        const repositories: ArgoCdStatusDTO["repositories"] = {}
        for (const [kind] of links) {
            const credential = argoCd?.repositories?.[kind]
            if (credential) repositories[kind] = { source: credential.source }
        }
        return {
            url: argoCd?.url,
            configured: Boolean(argoCd?.url && argoCd.token),
            insecure: Boolean(argoCd?.insecure),
            initializedAt: argoCd?.initializedAt,
            lastError: argoCd?.lastError,
            alignError: argoCd?.alignError,
            repositories,
            needsRepositoryToken: repositoryTokenProviders.length > 0,
            repositoryTokenProviders,
            repositoryTokenStored: Boolean(storedRepositoryToken(argoCd, argoCd?.url)),
            canInitialize
        }
    }
}

export default ArgoCdService
