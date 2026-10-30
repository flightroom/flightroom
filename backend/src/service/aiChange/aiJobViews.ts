import { AiJobScope, AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import { AiChangeFileAction, AiChangeStatus, IAiChangeEvent, IAiChangeRequest } from "../../models/AiChangeRequestModel"
import { LlmEffort, LlmUsage } from "../llm"
import { componentIdOf, componentsOfJob, RepositoryComponent, RepositoryComponentKind } from "../workspace/repositoryComponent"
import { AI_CHANGE_DEFAULT_EFFORT } from "./aiChangeAgent"
import { staleOutcome } from "./aiChangeShared"

/** File contents stay out of every view: the diff is read from the request of each repository. */
export const WITHOUT_CONTENTS = { "files.originalContent": 0, "files.proposedContent": 0, events: 0 } as const
/** Neither the progress nor the conversation of the agent: what lists of jobs read. */
export const JOB_LISTED = { events: 0, transcript: 0 } as const

export interface AiJobRepositoryView {
    requestId: string
    /** Whether the repository is a frontend's or a backend's: the `frontend*` fields describe either. */
    kind: RepositoryComponentKind
    frontendId: string
    frontendName: string
    frontendSlug: string
    /** The repository on its provider, unset when the component has none any more. */
    repository?: { name: string; cloneUrlHttps?: string }
    status: AiChangeStatus
    files: { path: string; action: AiChangeFileAction }[]
    error?: string
    baseBranch: string
    /** The feature branch the proposal is pushed on. */
    branch?: string
    /** On the feature branch while proposed, on the base once applied. */
    commit?: string
    pushError?: string
    pullRequestUrl?: string
    pullRequestError?: string
}

/** A job as the console and the assistant see it: its requests summed up per repository, without file contents. */
export interface AiJobView {
    _id: string
    projectId: string
    userId: string
    parentJobId?: string
    rootJobId: string
    prompt: string
    title?: string
    scope: AiJobScope
    domainId?: string
    status: AiJobStatus
    effort: LlmEffort
    /** The AI the agent ran on; unset on jobs from before AIs could be chosen. */
    aiModelId?: string
    /** Left out of lists. */
    events?: { at: Date; kind: IAiChangeEvent["kind"]; message: string }[]
    summary?: string
    error?: string
    /** Set when a user stopped the agent before it finished. */
    stoppedAt?: Date
    /** When the agent began to work, and when it ended: unset on jobs from before they were recorded. */
    startedAt?: Date
    finishedAt?: Date
    usage: LlmUsage & { cost?: number; currency?: "USD" | "EUR"; costUsd?: number }
    repositories: AiJobRepositoryView[]
    /** Whether the caller may apply, stop or follow it up: who started it, or an organization administrator. Others only read it. */
    canAct: boolean
    /** Who started it, told only to those who cannot act on it: the console says whose it is. */
    userName?: string
    createdAt: Date
    updatedAt: Date
}

/** An agent at work, whoever started it: the console animates the frontends and backends it works on. */
export interface AiWorkingJobView {
    /** The job's id, or the request's for a change asked from a component page. */
    jobId: string
    /** A job opens in the assistant; a request has no job, it is shown on its component's page. */
    kind: "job" | "request"
    missionId?: string
    /** The ids of the frontends and backends it works on that the caller may see. */
    componentIds: string[]
}

/** A job as lists read it: without the conversation of the agent, and without its progress unless asked. */
export type ListedJob = Omit<IAiChangeJob, "events" | "transcript"> & Partial<Pick<IAiChangeJob, "events">>

/** The frontends and backends the jobs work on, each once. */
export const uniqueRefs = (jobs: ListedJob[]) => jobs.flatMap(job => componentsOfJob(job)).filter((ref, index, all) => all.findIndex(other => other.id === ref.id) === index)

export const toJobView = (
    job: ListedJob,
    requests: Omit<IAiChangeRequest, "events">[],
    components: Map<string, Pick<RepositoryComponent, "name" | "slug" | "codeRepository">>,
    withEvents: boolean,
    canAct: boolean,
    userName?: string
): AiJobView => ({
    _id: String(job._id),
    projectId: String(job.projectId),
    userId: String(job.userId),
    parentJobId: job.parentJobId ? String(job.parentJobId) : undefined,
    rootJobId: String(job.rootJobId),
    prompt: job.prompt,
    title: job.title,
    scope: job.scope,
    domainId: job.domainId ? String(job.domainId) : undefined,
    status: job.status,
    effort: job.effort ?? AI_CHANGE_DEFAULT_EFFORT,
    aiModelId: job.aiModelId,
    events: withEvents ? (job.events ?? []).map(entry => ({ at: entry.at, kind: entry.kind, message: entry.message })) : undefined,
    summary: job.summary,
    error: job.error,
    stoppedAt: job.stoppedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    usage: {
        inputTokens: job.usage?.inputTokens ?? 0,
        cachedInputTokens: job.usage?.cachedInputTokens ?? 0,
        outputTokens: job.usage?.outputTokens ?? 0,
        ...(job.usage?.cost !== undefined
            ? { cost: job.usage.cost, currency: job.usage.currency ?? "USD" }
            : job.usage?.costUsd === undefined
              ? {}
              : { cost: job.usage.costUsd, currency: "USD" as const })
    },
    repositories: componentsOfJob(job).flatMap(ref => {
        // A request nobody acted upon expires: the job then only lists the others.
        const request = requests.find(candidate => String(candidate.jobId) === String(job._id) && componentIdOf(candidate) === ref.id)
        if (!request) return []
        const component = components.get(ref.id)
        return [
            {
                requestId: String(request._id),
                kind: ref.kind,
                frontendId: ref.id,
                frontendName: component?.name ?? "",
                frontendSlug: component?.slug ?? "",
                repository: component?.codeRepository?.name ? { name: component.codeRepository.name, cloneUrlHttps: component.codeRepository.cloneUrlHttps } : undefined,
                status: staleOutcome(request) ?? request.status,
                files: (request.files ?? []).map(file => ({ path: file.path, action: file.action })),
                error: request.error,
                baseBranch: request.baseBranch,
                branch: request.branch,
                commit: request.commit,
                pushError: request.pushError,
                pullRequestUrl: request.pullRequestUrl,
                pullRequestError: request.pullRequestError
            }
        ]
    }),
    canAct,
    userName,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
})
