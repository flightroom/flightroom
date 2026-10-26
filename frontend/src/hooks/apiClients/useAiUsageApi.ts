import useApiClient from "../useApiClient"
import type { AiCurrency } from "./useAiModelsApi"

/** The periods the tokens are summed over: the last 30 days (the default), the current month, the last 90 days, everything recorded. */
export const AI_USAGE_PERIODS = ["30d", "month", "90d", "all"] as const

export type AiUsagePeriod = (typeof AI_USAGE_PERIODS)[number]

/** What spent the tokens: an Edit with AI job or an answer of the assistant. */
export type AiUsageSource = "agent" | "assistant"

export interface AiUsageCost {
    amount: number
    currency: AiCurrency
}

export interface AiUsageTotals {
    /** Every input token, the ones read from the cache included. */
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    /** What they cost, one amount per currency: only the AIs given their prices count, none priced is empty. */
    costs?: AiUsageCost[]
}

export interface AiUsageSummary {
    period: AiUsagePeriod
    /** The first instant counted: missing for all time. */
    since?: string
    total: AiUsageTotals
}

export interface ProjectAiUsageSummary extends AiUsageSummary {
    bySource: Record<AiUsageSource, AiUsageTotals>
}

export interface ProjectAiUsage extends AiUsageTotals {
    projectId: string
    /** Missing for a project deleted since. */
    name?: string
}

export interface OrganizationAiUsageSummary extends AiUsageSummary {
    /** Most tokens first. */
    byProject: ProjectAiUsage[]
}

/**
 * What the usage is asked of. A frontend or a backend counts an equal share of each job on it, a domain the
 * whole of the jobs asked from it; the assistant only counts for the project and the organization.
 */
export type AiUsageTarget = { kind: "domain" | "frontend" | "backend" | "project" | "organization"; id: string }

const PATHS: Record<AiUsageTarget["kind"], string> = {
    domain: "domains",
    frontend: "frontends",
    backend: "backends",
    project: "projects",
    organization: "organizations"
}

export const AI_USAGE_QUERY_KEY = "ai-usage"

const useAiUsageApi = () => {
    const apiClient = useApiClient()

    // Silent: the summary says it could not load in place, a toast would repeat it on every page that shows one.
    const get = async (target: AiUsageTarget, period: AiUsagePeriod): Promise<AiUsageSummary | ProjectAiUsageSummary | OrganizationAiUsageSummary> => {
        const response = await apiClient.doRequest<AiUsageSummary>({ url: `/api/${PATHS[target.kind]}/${target.id}/ai-usage`, params: { period }, silent: true })
        return response.data
    }

    return { get }
}

export default useAiUsageApi
