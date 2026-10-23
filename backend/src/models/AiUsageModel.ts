import mongoose, { Schema } from "mongoose"
import { LLM_EFFORTS, LlmEffort, LlmProvider } from "../service/llm/types"

/** What spent the tokens: an Edit with AI job or an answer of the assistant. */
export type AiUsageSource = "agent" | "assistant"

export const AI_USAGE_SOURCES: readonly AiUsageSource[] = ["agent", "assistant"]

/**
 * One amount of tokens spent, kept for good: a round of an Edit with AI job or a whole answer of the assistant.
 *
 * The jobs themselves are no ledger: those nobody applied are removed after a week, their usage with them. Each
 * document carries what it is counted against (organization, project, domain, repositories) so that the totals are
 * one aggregation away, without joining the jobs.
 */
export interface IAiUsage {
    organizationId: Schema.Types.ObjectId
    projectId: Schema.Types.ObjectId
    userId?: Schema.Types.ObjectId
    source: AiUsageSource
    /** The job of an `agent` usage: gone after a week if nobody applied it, the usage stays. */
    jobId?: Schema.Types.ObjectId
    /** The functional domain the job was asked from: the domain counts the whole usage. */
    domainId?: Schema.Types.ObjectId
    /** The repositories of the job: each of them counts an equal share of the usage. */
    frontendIds: Schema.Types.ObjectId[]
    backendIds: Schema.Types.ObjectId[]
    /** An id of the organization's AIs, or `system`. */
    aiModelId?: string
    /** The provider that served it, when the caller knows it. */
    provider?: LlmProvider
    effort?: LlmEffort
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    createdAt: Date
}

const aiUsageSchema = new Schema<IAiUsage>(
    {
        organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        userId: { type: Schema.Types.ObjectId, ref: "User" },
        source: { type: String, enum: [...AI_USAGE_SOURCES], required: true },
        jobId: { type: Schema.Types.ObjectId, ref: "AiChangeJob" },
        domainId: { type: Schema.Types.ObjectId, ref: "Domain" },
        frontendIds: { type: [{ type: Schema.Types.ObjectId, ref: "Frontend" }], default: [] },
        backendIds: { type: [{ type: Schema.Types.ObjectId, ref: "Backend" }], default: [] },
        aiModelId: { type: String },
        // No enum, as on AssistantUsage: a provider added later must not cost the usage of its answers.
        provider: { type: String },
        effort: { type: String, enum: [...LLM_EFFORTS] },
        inputTokens: { type: Number, default: 0 },
        cachedInputTokens: { type: Number, default: 0 },
        outputTokens: { type: Number, default: 0 }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
)

// One per level the console shows the totals of, the period last: every aggregation matches on both.
aiUsageSchema.index({ organizationId: 1, createdAt: -1 })
aiUsageSchema.index({ projectId: 1, createdAt: -1 })
// What a member spent in the project this month, read before each answer and job when they have a limit.
aiUsageSchema.index({ projectId: 1, userId: 1, createdAt: -1 }, { partialFilterExpression: { userId: { $exists: true } } })
aiUsageSchema.index({ domainId: 1, createdAt: -1 }, { partialFilterExpression: { domainId: { $exists: true } } })
aiUsageSchema.index({ frontendIds: 1, createdAt: -1 })
aiUsageSchema.index({ backendIds: 1, createdAt: -1 })

const AiUsage = mongoose.model<IAiUsage>("AiUsage", aiUsageSchema)
export default AiUsage
