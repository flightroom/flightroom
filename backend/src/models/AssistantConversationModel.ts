import mongoose, { Schema } from "mongoose"
import { AssistantConversationMessageDTO } from "../types/AssistantDTO"

/**
 * A conversation with the console assistant, kept so that the user can reopen it. The id comes
 * from the browser, which names the conversation before its first answer is saved.
 *
 * Conversations are never removed from the database: deleting one only sets `deletedAt`, and
 * there is no expiry.
 */
export interface IAssistantConversation {
    _id: string
    userId: Schema.Types.ObjectId
    projectId: Schema.Types.ObjectId
    /** The first question, shortened: what the history lists. */
    title: string
    /** As the panel shows them, without tool inputs and results (see `conversations.ts`). */
    messages: AssistantConversationMessageDTO[]
    /** Set when the user deletes it: it leaves the history but stays in the database. */
    deletedAt?: Date
    /**
     * Held while a turn of the conversation runs, the user's or one the server runs when an agent it started ends:
     * two turns never run at once. A lease rather than a flag, so that a turn dying with its process frees it.
     */
    turnUntil?: Date
    /** When the user last asked a question: the agents the assistant starts are counted from it. */
    askedAt?: Date
    /** Update turns the server ran since the user last asked a question: they are capped, the user is asked again. */
    updateTurns?: number
    /** The AI of the user's last question: the update turns answer with it too. */
    aiModelId?: string
    /** Raised by every write of the messages, the browser's saves and the server's notes: a save is guarded on it. */
    version?: number
    /**
     * Set when a turn of the user starts, cleared once the browser saved its answer: until then the conversation
     * the server holds lacks that turn, and no update turn runs on it (for a while: a browser closed never saves).
     */
    savePendingSince?: Date
    createdAt: Date
    updatedAt: Date
}

const assistantConversationSchema = new Schema<IAssistantConversation>(
    {
        _id: { type: String, required: true },
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        title: { type: String, required: true },
        messages: { type: Schema.Types.Mixed, required: true },
        deletedAt: { type: Date },
        turnUntil: { type: Date },
        askedAt: { type: Date },
        updateTurns: { type: Number },
        aiModelId: { type: String },
        version: { type: Number },
        savePendingSince: { type: Date }
    },
    { timestamps: true }
)

assistantConversationSchema.index({ userId: 1, projectId: 1, updatedAt: -1 })

const AssistantConversation = mongoose.model<IAssistantConversation>("AssistantConversation", assistantConversationSchema)
export default AssistantConversation
