import type { LlmEffort } from "@/types/ConfigResponseDTO"
import useApiClient, { IClientRequestMetadataExtended } from "../useApiClient"
import type { AiChangeStatus } from "./useAiChangesApi"
import type { AiJobStatus, AiUsage } from "./useAiJobsApi"

/** `global`: one agent sees the repositories of a batch together; `perRepository`: one isolated agent per repository. */
export type AiMissionMode = "global" | "perRepository"

export type AiMissionStatus = "RUNNING" | "DONE" | "FAILED" | "STOPPED"

/** Mirrors the backend: the repositories are split in batches of this size, run one after the other. */
export const MISSION_BATCH_SIZE = 10
/** Mirrors the backend: a mission works on at most this many repositories. */
export const MISSION_MAX_REPOSITORIES = 200
/** How many agents work at once inside a batch, in per repository mode. */
export const MISSION_CONCURRENCY = { min: 1, max: 10, default: 3 }
/** Missions are slow, batch after batch: a glance every few seconds is enough. */
export const MISSIONS_POLL_INTERVAL_MS = 5000

export interface AiMissionCreateInput {
    prompt: string
    mode: AiMissionMode
    /** Every frontend and service with a linked repository: the ids are then left out. */
    all?: boolean
    frontendIds?: string[]
    serviceIds?: string[]
    /** Only in per repository mode. */
    concurrency?: number
    effort?: LlmEffort
    aiModelId?: string
}

/** One repository of the mission and what its job did so far. */
export interface AiMissionRepositoryView {
    kind: "frontend" | "service"
    id: string
    name: string
    domainId?: string
    /** 0-based index of the batch the repository runs in. */
    batch: number
    /** Unset while the repository waits for its batch. The latest job on it: a follow-up of the mission's job replaces it. */
    jobId?: string
    /** Only once the job exists: unset while it is being started, or when it could not be (`error` says why). */
    jobStatus?: AiJobStatus
    requestStatus?: AiChangeStatus
    filesChanged?: number
    branch?: string
    pullRequestUrl?: string
    error?: string
}

export interface AiMissionCounts {
    /** Waiting for their batch, or created and not started yet. */
    queued: number
    running: number
    /** Proposals with files, still to apply. */
    proposed: number
    /** Proposals being pushed onto their base branch. */
    applying: number
    applied: number
    failed: number
    noChanges: number
}

export interface AiMissionView {
    _id: string
    projectId: string
    userId: string
    userName?: string
    prompt: string
    mode: AiMissionMode
    concurrency: number
    status: AiMissionStatus
    /** 0-based index of the batch at work, or of the last one once the mission is over. */
    currentBatch: number
    batchCount: number
    repositories: AiMissionRepositoryView[]
    counts: AiMissionCounts
    usage: AiUsage
    /** Whether the current user may stop or apply it: who started it, or an organization administrator. */
    canAct: boolean
    createdAt: string
    updatedAt: string
}

/** A frontend or a service the current user may start a mission on. */
export interface AiMissionRepositoryOption {
    kind: "frontend" | "service"
    id: string
    name: string
    domainId?: string
}

/** What the current user may start a mission on: `all` is false for a member assigned to some domains, who must pick. */
export interface AiMissionRepositoryOptions {
    all: boolean
    repositories: AiMissionRepositoryOption[]
}

/** Still moving: agents are at work (a follow-up included), or proposals are being pushed. */
export const isAiMissionBusy = (mission: AiMissionView) => mission.status === "RUNNING" || mission.counts.applying > 0 || mission.counts.running > 0

/** Project-scoped: the API client sends the `Project-Id` header of the open project. */
const useAiMissionsApi = () => {
    const apiClient = useApiClient()

    const create = async (data: AiMissionCreateInput, metadata?: IClientRequestMetadataExtended): Promise<AiMissionView> => {
        const response = await apiClient.doRequest<AiMissionView, AiMissionCreateInput>({
            url: "/api/ai-missions",
            method: "POST",
            data,
            ...metadata
        })
        return response.data
    }

    /** Newest first; `active` keeps the running ones only. */
    const list = async (filter?: { active?: boolean }, metadata?: IClientRequestMetadataExtended): Promise<AiMissionView[]> => {
        const response = await apiClient.doRequest<AiMissionView[]>({
            url: "/api/ai-missions",
            params: filter?.active !== undefined ? { active: filter.active } : undefined,
            ...metadata
        })
        return response.data
    }

    const get = async (id: string, metadata?: IClientRequestMetadataExtended): Promise<AiMissionView> => {
        const response = await apiClient.doRequest<AiMissionView>({
            url: `/api/ai-missions/${id}`,
            ...metadata
        })
        return response.data
    }

    /** Stops the agents of the current batch and cancels the batches still to come. */
    const stop = async (id: string, metadata?: IClientRequestMetadataExtended): Promise<AiMissionView> => {
        const response = await apiClient.doRequest<AiMissionView>({
            url: `/api/ai-missions/${id}/stop`,
            method: "POST",
            // The client always sends a JSON content type, and Fastify rejects an empty JSON body.
            data: {},
            ...metadata
        })
        return response.data
    }

    /** Applies every proposal of the mission on its base branch. */
    const apply = async (id: string, metadata?: IClientRequestMetadataExtended): Promise<AiMissionView> => {
        const response = await apiClient.doRequest<AiMissionView>({
            url: `/api/ai-missions/${id}/apply`,
            method: "POST",
            data: {},
            ...metadata
        })
        return response.data
    }

    const repositories = async (metadata?: IClientRequestMetadataExtended): Promise<AiMissionRepositoryOptions> => {
        const response = await apiClient.doRequest<AiMissionRepositoryOptions>({
            url: "/api/ai-missions/repositories",
            ...metadata
        })
        return response.data
    }

    return { create, list, get, stop, apply, repositories }
}

export default useAiMissionsApi
