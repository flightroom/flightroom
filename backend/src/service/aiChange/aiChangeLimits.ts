import { LlmEffort } from "../llm"

export const AI_CHANGE_LIMITS = {
    /** Model ↔ tool round-trips for a job on one repository. */
    maxRounds: 40,
    /** Rounds added for each repository past the first: exploring several codebases takes longer. */
    extraRoundsPerRepository: 20,
    /** Rounds of a job however many repositories it has. */
    maxRoundsTotal: 120,
    /** The reasoning counts towards it: the highest efforts get more room. */
    maxTokensPerTurn: { low: 32_000, medium: 32_000, high: 32_000, xhigh: 64_000, max: 64_000 } satisfies Record<LlmEffort, number>,
    /** Files read are cut here: past it a file is generated or vendored, rarely something to edit by hand. */
    maxReadBytes: 100_000,
    /** Files read by lines are loaded whole to count them: past it, only the first maxReadBytes can be read. */
    maxReadByLinesBytes: 5_000_000,
    /** Lines of the folder layout in the repository map: past it, the layout goes less deep. */
    maxLayoutLines: 150,
    /** Bytes of the notes and of the instructions for agents shown in the repository map, each. */
    maxMapBytes: 16_000,
    /** Lines search may show around each match. */
    maxSearchContextLines: 5,
    /** Lines one search returns, context included: with context, 100 matches would be over a thousand. */
    maxSearchLines: 300,
    /** Distinct paths the agent may write or delete in one repository. */
    maxChangedFiles: 20,
    /** Bytes the agent may write for each repository of the job. */
    maxWrittenBytes: 500_000,
    /** Bytes the agent may write in one job however many repositories it has. */
    maxWrittenBytesTotal: 2_000_000,
    maxListedFiles: 2_000,
    maxSearchMatches: 100,
    /** Files bigger than this are skipped by search. */
    maxSearchedFileBytes: 200_000,
    /**
     * Waits before each retry of a turn the provider rate-limited. Its quota is per minute, so the
     * later waits span a whole window; all of them together stay well short of a job looking dead.
     */
    rateLimitWaitsMs: [15_000, 30_000, 60_000, 60_000, 60_000]
}

/**
 * The notes agents keep in each repository on how it is laid out, committed with their changes: the
 * next job starts from them instead of exploring the repository again.
 */
export const REPOSITORY_MAP_PATH = ".flightroom/REPO_MAP.md"

/** When neither the user nor a parent job chose: code changes are worth reasoning hard. */
export const AI_CHANGE_DEFAULT_EFFORT: LlmEffort = "high"

/** The limits that grow with the number of repositories of a job. */
export const agentLimitsFor = (repositoryCount: number) => {
    const count = Math.max(1, repositoryCount)
    return {
        maxRounds: Math.min(AI_CHANGE_LIMITS.maxRounds + AI_CHANGE_LIMITS.extraRoundsPerRepository * (count - 1), AI_CHANGE_LIMITS.maxRoundsTotal),
        maxWrittenBytes: Math.min(AI_CHANGE_LIMITS.maxWrittenBytes * count, AI_CHANGE_LIMITS.maxWrittenBytesTotal)
    }
}
