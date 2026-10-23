import mongoose, { Document, ObjectId, Schema } from "mongoose"

export enum RoleInProject {
    OWNER = "OWNER",
    MEMBER = "MEMBER",
    VIEWER = "VIEWER"
}

export interface IUserProject extends Document<ObjectId> {
    userId: Schema.Types.ObjectId
    projectId: Schema.Types.ObjectId
    role: RoleInProject
    /**
     * Set when the membership is confined to some functional domains of the project: the member then
     * reaches only the frontends and backends of `domainIds`. Kept apart from the list because
     * deleting a domain pulls its id from every list: a scope whose last domain is deleted must stay
     * a scope over nothing, never turn into the whole project because its list became empty.
     */
    domainScoped?: boolean
    /** The domains of a scoped membership; meaningless when `domainScoped` is not set. */
    domainIds?: Schema.Types.ObjectId[]
    /**
     * The AI tokens (input and output) the member may spend in the project each calendar month, by the assistant and
     * Edit with AI together; left out, no limit. Checked before an answer or a job starts: one already running ends.
     */
    aiTokenLimit?: number
    invitationToken?: string
    inviationTokenExpiresAt?: Date
    createdAt: Date
    updatedAt: Date
}

const userProjectSchema = new Schema<IUserProject>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },
        projectId: {
            type: Schema.Types.ObjectId,
            ref: "Project",
            required: true,
            index: true
        },
        role: {
            type: String,
            enum: [RoleInProject.OWNER, RoleInProject.MEMBER, RoleInProject.VIEWER],
            default: RoleInProject.MEMBER,
            required: true
        },
        domainScoped: {
            type: Boolean,
            default: false
        },
        domainIds: {
            type: [{ type: Schema.Types.ObjectId, ref: "Domain" }],
            default: []
        },
        aiTokenLimit: {
            type: Number,
            min: 0
        },
        invitationToken: {
            type: String,
            required: false
        },
        inviationTokenExpiresAt: {
            type: Date,
            required: false
        }
    },
    {
        timestamps: true
    }
)

userProjectSchema.index({ userId: 1, projectId: 1 }, { unique: true })

/**
 * A project membership as the answers carry it, to the console and to the MCP tools. The document carries the
 * invitation token, which is what lets whoever holds it accept the invitation and set the account's password: it
 * never leaves.
 */
export const membershipView = (membership: IUserProject | undefined) =>
    membership && {
        userId: String(membership.userId),
        role: membership.role,
        domainIds: membership.domainScoped ? (membership.domainIds ?? []).map(String) : [],
        domainScoped: Boolean(membership.domainScoped),
        invitationPending: Boolean(membership.invitationToken),
        invitationExpiresAt: membership.inviationTokenExpiresAt,
        aiTokenLimit: membership.aiTokenLimit ?? null
    }

const UserProject = mongoose.model<IUserProject>("UserProject", userProjectSchema)
export default UserProject
