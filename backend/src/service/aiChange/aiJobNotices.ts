import AiChangeJob, { AiJobStatus, IAiChangeJob } from "../../models/AiChangeJobModel"
import Backend from "../../models/BackendModel"
import Domain from "../../models/DomainModel"
import Frontend from "../../models/FrontendModel"
import Project from "../../models/ProjectModel"
import User, { UserStatus } from "../../models/UserModel"
import type { AiJobTarget } from "../../templates/emails/i18n"
import EmailSenderService from "../EmailSenderService"
import { isAway } from "../UserService"

/** A prompt standing for a job without a title is cut here: it ends up in a subject line. */
const LABEL_LENGTH = 80

type EndedJob = Pick<IAiChangeJob, "_id" | "rootJobId" | "projectId" | "prompt" | "title" | "scope" | "domainId" | "frontendIds" | "backendIds">

/** What the email names: the job's title, else the one of its chain (a follow-up has none), else its prompt. */
const labelOf = async (job: EndedJob): Promise<string> => {
    const title = job.title ?? (String(job.rootJobId) === String(job._id) ? undefined : (await AiChangeJob.findById(job.rootJobId, { title: 1 }))?.title)
    if (title) return title
    const prompt = job.prompt.replace(/\s+/g, " ").trim()
    return prompt.length > LABEL_LENGTH ? `${prompt.slice(0, LABEL_LENGTH - 1)}…` : prompt
}

/**
 * What the job worked on, and the page of the console that shows it: the domain, the one frontend or
 * backend, else the assistant, whose panel reopens the job. A component deleted since falls back to the assistant.
 */
const targetOf = async (job: EndedJob): Promise<{ target: AiJobTarget; path: string }> => {
    const repositories = { target: { kind: "repositories", count: job.frontendIds.length + job.backendIds.length }, path: "/assistant" } as const
    if (job.scope === "domain" && job.domainId) {
        const domain = await Domain.findOne({ _id: job.domainId, projectId: job.projectId }, { name: 1 })
        return domain ? { target: { kind: "domain", name: domain.name }, path: `/domain/${String(domain._id)}` } : repositories
    }
    if (job.frontendIds.length + job.backendIds.length !== 1) return repositories
    const kind = job.frontendIds.length ? "frontend" : "backend"
    const component =
        kind === "frontend"
            ? await Frontend.findOne({ _id: job.frontendIds[0], projectId: job.projectId }, { name: 1 })
            : await Backend.findOne({ _id: job.backendIds[0], projectId: job.projectId }, { name: 1 })
    return component ? { target: { kind, name: component.name }, path: `/${kind}/${String(component._id)}` } : repositories
}

/**
 * Emails whoever started the job that it is over, when they were away from the console as it ended:
 * those at it see it end there. A job they stopped is not worth an email, nor one of a mission, which
 * runs many at once and pushes its changes on its own.
 */
export const notifyAiJobEnded = async (jobId: IAiChangeJob["_id"], emailSender = new EmailSenderService(), now = new Date()): Promise<boolean> => {
    if (!emailSender.canSendEmails()) return false

    const job = await AiChangeJob.findById(jobId, {
        rootJobId: 1,
        projectId: 1,
        userId: 1,
        missionId: 1,
        prompt: 1,
        title: 1,
        scope: 1,
        domainId: 1,
        frontendIds: 1,
        backendIds: 1,
        status: 1,
        stoppedAt: 1
    })
    if (!job || job.missionId || job.stoppedAt || (job.status !== AiJobStatus.DONE && job.status !== AiJobStatus.FAILED)) return false

    const user = await User.findById(job.userId, { email: 1, name: 1, language: 1, lastSeenAt: 1, status: 1 })
    if (!user || user.status !== UserStatus.ACTIVE || !isAway(user, now)) return false

    const project = await Project.findById(job.projectId, { name: 1 })
    if (!project) return false

    const { target, path } = await targetOf(job)
    await emailSender.sendAiJobEndedEmail(user, project, { label: await labelOf(job), failed: job.status === AiJobStatus.FAILED, target, path })
    return true
}
