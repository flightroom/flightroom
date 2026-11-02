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
    /**
     * The saved conversation the question belongs to: the agents the assistant starts are linked to it, and its
     * turns, the user's and those the server runs when an agent ends, never run at once. Without it the assistant
     * cannot start agents.
     */
    conversationId?: string
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
        /** The IANA time zone of the browser, e.g. Europe/Rome: the day the model is told it is today. */
        timeZone?: string
        /** The voice mode of the panel is on: the answer is read aloud, so it is asked short and spoken. */
        voice?: boolean
        /**
         * Set by the server only, never by the browser: the turn it runs on its own when agents of the conversation
         * end. Nobody is at the console, and confirmations wait for the user.
         */
        update?: boolean
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

/**
 * A line of a confirmation card the console words in the user's language: `key` under
 * `assistant.confirmation.lines`, `params` its values (names, branches, a `count` for plurals).
 */
export interface ConfirmationLineDTO {
    key: string
    params?: Record<string, string | number>
}

/** A message of a saved conversation, as the panel shows it. Tool inputs and results are never kept. */
export interface AssistantConversationMessageDTO {
    id: string
    role: "user" | "assistant"
    content: string
    /**
     * `server` on the messages the server added on its own, when an agent the assistant started ended: a save from
     * the browser that has not seen them yet keeps them.
     */
    origin?: "server"
    /** `agent_update`: the note of how agents of the conversation ended, shown as a notice rather than as the user's words. */
    kind?: "agent_update"
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
        details: { label: string; value: string; lines?: ConfirmationLineDTO[] }[]
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
    /** A turn holds the conversation: an answer, maybe the server's to an agent that ended, is being written. */
    busy?: boolean
}
