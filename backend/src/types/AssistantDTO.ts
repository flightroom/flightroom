import type { AiCurrency } from "../models/AiModelModel"
import type { LlmEffort } from "../service/llm/types"

export interface AssistantChatMessageDTO {
    role: "user" | "assistant"
    content: string
}

export interface AssistantChatRequestDTO {
    /**
     * The whole conversation, oldest first; the last message is the user's question, or, with a
     * `confirmation`, may be the assistant's message that asked for it.
     */
    messages: AssistantChatMessageDTO[]
    /** How hard the model reasons before answering: `medium` when left out. */
    effort?: LlmEffort
    /** The AI that answers, one the project may use: the project's default when left out. */
    aiModelId?: string
    /** The user's answer to a `confirm` frame: the turn resumes from the action it names. */
    confirmation?: {
        actionId: string
        approved: boolean
    }
    /** Where the user is in the console when asking. */
    context?: {
        page?: string
        environmentId?: string
        locale?: string
        /** The voice mode of the panel is on: the answer is read aloud, so it is asked short and spoken. */
        voice?: boolean
    }
}

export interface AssistantProjectDraftRequestDTO {
    /** The organization the project is created in: its AIs write the draft. */
    organizationId: string
    /** The conversation about the project so far, oldest first; the last message is the user's. */
    messages: AssistantChatMessageDTO[]
    locale?: string
    /** One of the organization's AIs: its default when left out. */
    aiModelId?: string
}

export interface AssistantProjectDraftDTO {
    name: string
    description: string
    environments: {
        name: string
        slug: string
        isProduction: boolean
        color: string
    }[]
    /** The functional domains the project's frontends and backends will be grouped in. */
    domains: {
        name: string
        description: string
    }[]
    codeRepository: "NONE" | "GITHUB" | "GITLAB" | "AZURE_DEV_OPS"
    notes: string
}

/** One answer of the assistant while it shapes a new project with the user. */
export interface AssistantProjectDraftTurnDTO {
    /** What the assistant says: a question, or a proposal to confirm. */
    reply: string
    /** Short answers the user can pick instead of typing. */
    options: string[]
    /** True once the draft covers the name, the environments and the domains. */
    ready: boolean
    /** The project as proposed so far. */
    draft: AssistantProjectDraftDTO
}

/** A message of a saved conversation, as the panel shows it. Tool inputs and results are never kept. */
export interface AssistantConversationMessageDTO {
    id: string
    role: "user" | "assistant"
    content: string
    /** The summary of the model's reasoning, shown above the answer. */
    thinking?: string
    /** The effort the answer was asked with. */
    effort?: LlmEffort
    status?: "streaming" | "done" | "error"
    errorKey?: string
    tools?: {
        id: string
        name: string
        title: string
        kind: string
        status: string
        summary?: string
    }[]
    confirmation?: {
        actionId: string
        callId: string
        name: string
        title: string
        details: { label: string; value: string }[]
        expiresAt: string
        status: string
    }
    usage?: {
        inputTokens: number
        cachedInputTokens: number
        outputTokens: number
        cost?: number
        currency?: AiCurrency
        costUsd?: number
    }
}

export interface AssistantConversationSaveDTO {
    messages: AssistantConversationMessageDTO[]
}

/** An entry of the history: the messages are loaded when the user opens it. */
export interface AssistantConversationSummaryDTO {
    id: string
    title: string
    updatedAt: Date
}

export interface AssistantConversationDTO extends AssistantConversationSummaryDTO {
    messages: AssistantConversationMessageDTO[]
}
