import type { AxiosError } from "axios"
import { AI_CHANGE_ACTIVE_STATUSES, AiChangeStatus, AiChangeTarget } from "@/hooks/apiClients/useAiChangesApi"
import { AiJob, AiJobRepository, isAiJobActive } from "@/hooks/apiClients/useAiJobsApi"

export const PROMPT_MAX_LENGTH = 8000
export const POLL_INTERVAL_MS = 2000

/** Whose code the agent works on: the repository of a frontend or of a backend, or every repository of a domain at once. */
export type AiWorkspaceTarget = AiChangeTarget | { kind: "domain"; id: string }

export const isRepositoryTarget = (target: AiWorkspaceTarget): target is AiChangeTarget => target.kind !== "domain"

export const isActive = (status?: AiChangeStatus) => Boolean(status && AI_CHANGE_ACTIVE_STATUSES.includes(status))

export const firstLine = (text: string) =>
    text
        .split("\n")
        .find(line => line.trim().length > 0)
        ?.trim() ?? ""

export const conflictsOf = (error: Error): string[] => (error as AxiosError<{ error?: { details?: { conflicts?: string[] } } }>)?.response?.data?.error?.details?.conflicts ?? []

/** The page of the frontend or backend a repository belongs to, open on the request. */
export const repositoryPath = (repository: AiJobRepository) => `/${repository.kind === "backend" ? "backend" : "frontend"}/${repository.frontendId}?change=${repository.requestId}`

/** One message of a conversation: what the user asked, and what the agent did with it on the repositories the workspace shows. */
export interface Turn {
    job: AiJob
    repositories: AiJobRepository[]
}

/** Still moving: the agent works, or a proposal is being pushed. */
export const isTurnActive = (turn: Turn) => isAiJobActive(turn.job.status) || turn.repositories.some(repository => isActive(repository.status))

/** Still moving, over every repository of the job. */
export const isJobBusy = (job: AiJob) => isTurnActive({ job, repositories: job.repositories })

/** Over several repositories, what needs the user comes before what is settled. */
const STATUS_PRECEDENCE: AiChangeStatus[] = ["PENDING", "RUNNING", "APPLYING", "PROPOSED", "APPLIED", "FAILED"]

/** Where a message stands: the status of its repository, or, over several, the most pressing of theirs. */
export const turnStatus = ({ job, repositories }: Turn): AiChangeStatus => {
    if (job.status === "PENDING" || job.status === "RUNNING") return job.status
    // A job stopped by a user discarded its requests: it did not fail.
    return STATUS_PRECEDENCE.find(status => repositories.some(repository => repository.status === status)) ?? (job.status === "FAILED" && !job.stoppedAt ? "FAILED" : "DISCARDED")
}

/** The tab a message opens on: the first repository with a proposal to review, else the first. */
export const firstTab = (repositories: AiJobRepository[]) => (repositories.find(repository => repository.status === "PROPOSED" && repository.files.length > 0) ?? repositories[0]).requestId

/** On a repository a follow-up goes on with that repository only: the others of a job over several go on from their own page, or from the assistant. A domain goes on with all of them. */
export const followUpScope = (target: AiWorkspaceTarget) => {
    if (target.kind === "backend") return { backendIds: [target.id] }
    if (target.kind === "frontend") return { frontendIds: [target.id] }
    return {}
}
