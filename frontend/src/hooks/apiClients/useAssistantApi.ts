import { AssistantMessage } from "@/store/useAssistantStore"
import useApiClient from "../useApiClient"

export interface ProjectDraft {
    name: string
    description: string
    environments: {
        name: string
        slug: string
        isProduction: boolean
        color: string
    }[]
    /** The functional domains the frontends and backends will be grouped in */
    domains: {
        name: string
        description: string
    }[]
    codeRepository: "NONE" | "GITHUB" | "GITLAB" | "AZURE_DEV_OPS"
    notes: string
}

export interface ProjectDraftMessage {
    role: "user" | "assistant"
    content: string
}

/** One answer of the assistant while it shapes a new project with the user */
export interface ProjectDraftTurn {
    /** A question, or a proposal to confirm */
    reply: string
    /** Short answers the user can pick instead of typing */
    options: string[]
    /** The draft covers the name, the environments and the domains */
    ready: boolean
    draft: ProjectDraft
}

/** An entry of the assistant's history on the project open in the console. */
export interface AssistantConversationSummary {
    id: string
    title: string
    updatedAt: string
}

export interface AssistantConversation extends AssistantConversationSummary {
    messages: AssistantMessage[]
}

const useAssistantApi = () => {
    const apiClient = useApiClient()

    /**
     * The next answer of the conversation that drafts a new project, with an AI of `organizationId`, the organization the
     * project will belong to. The chat itself streams, see useAssistantChat.
     */
    const draftProject = async (messages: ProjectDraftMessage[], locale: string, organizationId: string, aiModelId?: string): Promise<ProjectDraftTurn> => {
        const response = await apiClient.doRequest<ProjectDraftTurn>({
            url: "/api/assistant/project-draft",
            method: "POST",
            data: { messages, locale, organizationId, aiModelId },
            silent: true
        })
        return response.data
    }

    /** The user's conversations on the current project, most recent first. */
    const listConversations = async (): Promise<AssistantConversationSummary[]> => {
        const response = await apiClient.doRequest<AssistantConversationSummary[]>({ url: "/api/assistant/conversations" })
        return response.data
    }

    const getConversation = async (id: string): Promise<AssistantConversation> => {
        const response = await apiClient.doRequest<AssistantConversation>({ url: `/api/assistant/conversations/${id}` })
        return response.data
    }

    /** Silent: the answer is already on screen, a failed save only costs it its place in the history. */
    const saveConversation = async (id: string, messages: AssistantMessage[]): Promise<void> => {
        await apiClient.doRequest<void, { messages: AssistantMessage[] }>({
            url: `/api/assistant/conversations/${id}`,
            method: "PUT",
            data: { messages },
            silent: true
        })
    }

    const deleteConversation = async (id: string): Promise<void> => {
        await apiClient.doRequest<void>({ url: `/api/assistant/conversations/${id}`, method: "DELETE" })
    }

    return { draftProject, listConversations, getConversation, saveConversation, deleteConversation }
}

export default useAssistantApi
