import type { AiChangeRequest, AiChangeStatus } from "@/hooks/apiClients/useAiChangesApi"
import type { AiJob } from "@/hooks/apiClients/useAiJobsApi"
import { JobBadge } from "./AiChangeParts"
import { firstLine, isActive, isJobBusy, turnStatus } from "./aiWorkspaceUtils"
import type { WorkshopEntry } from "./workshop/VegaWorkshop"

/** The value of `?change=` that opens the composer instead of a conversation. */
export const NEW_CHANGE = "new"

/** The queue groups conversations by what they wait for: the user's review, the agent, or nothing at all. */
export type QueueGroup = "review" | "active" | "discarded" | "applied" | "failed"

/** In the order the queue shows them. */
export const QUEUE_GROUPS: QueueGroup[] = ["review", "active", "discarded", "applied", "failed"]

export const groupOf = (status: AiChangeStatus): QueueGroup => {
    if (status === "PROPOSED") return "review"
    if (isActive(status)) return "active"
    if (status === "DISCARDED") return "discarded"
    if (status === "APPLIED") return "applied"
    return "failed"
}

/** One conversation in the queue, whatever the workspace lists them from. */
export interface QueueEntry {
    /** What `?change=` holds to open it. */
    id: string
    /** Every value of `?change=` that opens it: on a repository, any request of the conversation does. */
    ids: string[]
    /** The first request: what the conversation is about. */
    prompt: string
    /** What the model summed the first request up in; the first line of the request when it could not. */
    title: string
    /** When it last moved. */
    at: string
    status: AiChangeStatus
    turns?: number
    files?: number
    repositories?: number
    /** Next to the status. */
    badge?: React.ReactNode
    /** While the agent works on it: what the workshop reads its events from. */
    live?: WorkshopEntry["live"]
}

/** A repository lists its requests, newest first; a conversation is one entry, opened on where it stands: the request the agent works on, else the proposal to review, else the newest. */
export const requestEntries = (requests: AiChangeRequest[]): QueueEntry[] => {
    const chains = new Map<string, AiChangeRequest[]>()
    for (const request of requests) chains.set(request.conversationId, [...(chains.get(request.conversationId) ?? []), request])
    return [...chains.values()].map(chain => {
        const current = chain.find(request => isActive(request.status)) ?? chain.find(request => request.status === "PROPOSED") ?? chain.find(request => request.status === "APPLIED") ?? chain[0]
        return {
            id: current._id,
            ids: chain.map(request => request._id),
            prompt: chain[chain.length - 1].prompt,
            title: chain[chain.length - 1].title ?? firstLine(chain[chain.length - 1].prompt),
            at: chain[0].createdAt,
            status: current.status,
            turns: chain.length,
            files: current.files.length,
            badge: <JobBadge request={current} />,
            live: isActive(current.status) ? { kind: "request", id: current._id } : undefined
        }
    })
}

/** A domain lists its jobs: the backend sends the first and the latest of each chain, newest first, so the first met of a chain is its latest, the last met its first. */
export const jobEntries = (jobs: AiJob[]): QueueEntry[] => {
    const chains = new Map<string, { first: AiJob; latest: AiJob }>()
    for (const job of jobs) {
        const known = chains.get(job.rootJobId)
        if (known) known.first = job
        else chains.set(job.rootJobId, { first: job, latest: job })
    }
    return [...chains.entries()].map(([rootJobId, { first, latest }]) => {
        const status = turnStatus({ job: latest, repositories: latest.repositories })
        // A failed or stopped follow-up leaves the proposals before it open: the conversation still waits for a review.
        const reviewable = (status === "FAILED" || Boolean(latest.stoppedAt)) && turnStatus({ job: first, repositories: first.repositories }) === "PROPOSED"
        return {
            id: rootJobId,
            ids: [rootJobId],
            prompt: first.prompt,
            title: first.title ?? firstLine(first.prompt),
            at: latest.updatedAt,
            status: reviewable ? "PROPOSED" : status,
            repositories: latest.repositories.length,
            live: isJobBusy(latest) ? { kind: "job", id: latest._id } : undefined
        }
    })
}

/** What opens when nothing is linked: a proposal to review first, then work in progress, otherwise a new request. */
export const defaultSelection = (entries: QueueEntry[]) => entries.find(entry => entry.status === "PROPOSED")?.id ?? entries.find(entry => isActive(entry.status))?.id ?? NEW_CHANGE
