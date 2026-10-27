import { fastify } from ".."
import ApiKey, { ApiKeyStatus, IApiKey } from "../models/ApiKeyModel"
import Project, { IProject } from "../models/ProjectModel"
import User, { UserStatus } from "../models/UserModel"
import UserOrganization, { ORGANIZATION_ADMIN_ROLES } from "../models/UserOrganizationModel"
import UserProject, { RoleInProject } from "../models/UserProjectModel"
import EmailSenderService from "./EmailSenderService"

const DAY_MS = 24 * 60 * 60 * 1000

/** How many days ahead of the expiry the administrators are warned, the widest first: the console shows a key as expiring 30 days ahead */
export const EXPIRY_NOTICE_DAYS = [30, 7]

/** The notice a key due in `msLeft` is owed: the narrowest window it falls in, none when it is still out of all of them */
const noticeFor = (msLeft: number) => EXPIRY_NOTICE_DAYS.filter(days => msLeft <= days * DAY_MS).at(-1)

/**
 * Who administers the project: its owners (Admin in the console) and the owners and admins of its organization,
 * who reach every project in it. Pending invitations and disabled accounts are left out.
 */
const administratorsOf = async (projectId: IApiKey["projectId"], organizationId: IProject["organizationId"]) => {
    const [owners, organizationAdmins] = await Promise.all([
        UserProject.find({ projectId, role: RoleInProject.OWNER, invitationToken: null }, { userId: 1 }),
        UserOrganization.find({ organizationId, role: { $in: ORGANIZATION_ADMIN_ROLES }, invitationToken: null }, { userId: 1 })
    ])
    const userIds = [...owners, ...organizationAdmins].map(membership => membership.userId)
    if (userIds.length === 0) return []
    return User.find({ _id: { $in: userIds }, status: UserStatus.ACTIVE }, { email: 1, name: 1, language: 1 })
}

/** Emails the notice to every administrator of the key's project; answers how many received it */
const sendNotice = async (emailSender: EmailSenderService, key: Pick<IApiKey, "name" | "projectId" | "expiresAt"> & { _id: unknown }, daysLeft: number): Promise<number> => {
    const project = await Project.findById(key.projectId, { name: 1, organizationId: 1 })
    if (!project) return 0

    let sent = 0
    for (const user of await administratorsOf(key.projectId, project.organizationId)) {
        try {
            await emailSender.sendApiKeyExpiryEmail(user, project, key, daysLeft)
            sent++
        } catch (error) {
            fastify.log.warn({ err: error, apiKeyId: String(key._id), userId: String(user._id) }, "API key expiry notice not sent")
        }
    }
    return sent
}

/**
 * Warns the administrators of each project whose active API keys are about to expire: once 30 days ahead, again
 * 7 days ahead. Each notice is claimed on the key before it is sent, so replicas ticking together send it once.
 */
export const notifyExpiringApiKeys = async (emailSender = new EmailSenderService(), now = new Date()): Promise<void> => {
    // Without SMTP nothing is claimed: the notices go out once email is configured, if still in time
    if (!emailSender.canSendEmails()) return

    const widest = Math.max(...EXPIRY_NOTICE_DAYS)
    const keys = await ApiKey.find(
        { status: ApiKeyStatus.ACTIVE, expiresAt: { $gt: now, $lte: new Date(now.getTime() + widest * DAY_MS) } },
        { name: 1, projectId: 1, expiresAt: 1, expiryNoticeDays: 1 }
    )

    for (const key of keys) {
        const msLeft = key.expiresAt.getTime() - now.getTime()
        const notice = noticeFor(msLeft)
        const previous = key.expiryNoticeDays ?? null
        if (notice === undefined || (previous !== null && previous <= notice)) continue

        // null matches a key never warned as well: the field is unset until the first notice
        const claimed = await ApiKey.updateOne({ _id: key._id, expiryNoticeDays: previous }, { $set: { expiryNoticeDays: notice } })
        if (claimed.modifiedCount === 0) continue

        const sent = await sendNotice(emailSender, key, Math.ceil(msLeft / DAY_MS))
        if (sent === 0) {
            // Nobody got it (SMTP down, say): given back, so that the next tick tries again
            await ApiKey.updateOne({ _id: key._id, expiryNoticeDays: notice }, previous === null ? { $unset: { expiryNoticeDays: 1 } } : { $set: { expiryNoticeDays: previous } })
        }
    }
}
