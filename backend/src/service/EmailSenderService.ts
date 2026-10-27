import juice from "juice"
import nodemailer, { type Transporter } from "nodemailer"
import path from "path"
import pug from "pug"
import { fastify } from ".."
import { IApiKey } from "../models/ApiKeyModel"
import { IOrganization } from "../models/OrganizationModel"
import { IProject } from "../models/ProjectModel"
import { IUser } from "../models/UserModel"
import { RoleInOrganization } from "../models/UserOrganizationModel"
import { RoleInProject } from "../models/UserProjectModel"
import { ApiKeyExpiryText, EmailLanguage, emailStrings, InvitationText, toEmailLanguage } from "../templates/emails/i18n"
import type { AuthorizedPrincipal } from "./BaseAuthorizedService"

type EmailTemplate = "account-activation" | "password-reset" | "project-invitation" | "organization-invitation" | "api-key-expiry"

/** What every email shows, whatever its template: the button, the link under it and the lines around them. */
interface EmailMessage {
    to: string
    template: EmailTemplate
    language: EmailLanguage
    subject: string
    url: string
    header: string
    headerIcon: string
    preheader: string
    greeting: string
    /** The intro as text; invitations also pass it as markup in `locals.introHtml`. */
    intro: string
    prompt?: string
    button: string
    ignore: string
    expiry: string
    locals?: Record<string, unknown>
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string)

const strong = (value: string, className?: string) => `<strong${className ? ` class="${className}"` : ""}>${escapeHtml(value)}</strong>`

class EmailSenderService {
    private transporter: Transporter
    // biome-ignore lint/suspicious/noExplicitAny: Config object has dynamic properties
    private config: any
    private canSendEmail = false

    constructor() {
        this.config = fastify.config
        if (!this.config || !this.config?.EMAIL_SMTP_HOST) {
            this.canSendEmail = false
            this.transporter = nodemailer.createTransport({})
        } else {
            this.canSendEmail = true
            this.transporter = nodemailer.createTransport({
                host: this.config.EMAIL_SMTP_HOST,
                port: this.config.EMAIL_SMTP_PORT,
                secure: this.config.EMAIL_SMTP_SECURE,
                auth: {
                    user: this.config.EMAIL_SMTP_USER,
                    pass: this.config.EMAIL_SMTP_PASSWORD
                }
            })
        }
    }

    canSendEmails(): boolean {
        return this.canSendEmail
    }

    /** `inviter` is whoever sends the invitation; without one (or for an API key) the email names nobody. */
    async sendUserInvitationEmail(user: IUser, project: IProject, role: RoleInProject, token: string, inviter?: AuthorizedPrincipal) {
        const language = toEmailLanguage(user.language)
        const t = emailStrings[language]
        const strings = t.projectInvitation
        const invitation: InvitationText = { inviter: this.inviterName(inviter), target: project.name, role: t.projectRoles[role] }

        await this.send({
            to: user.email,
            template: "project-invitation",
            language,
            subject: strings.subject(project.name),
            url: `${this.config.FRONTEND_URL}/project-invitation/${token}`,
            header: strings.header,
            headerIcon: "👋",
            preheader: strings.preheader(invitation),
            greeting: t.greeting(user.name),
            intro: strings.intro(invitation),
            prompt: strings.prompt,
            button: strings.button,
            ignore: strings.ignore,
            expiry: strings.expiry,
            locals: { introHtml: strings.intro(this.invitationMarkup(invitation)) }
        })
    }

    async sendOrganizationInvitationEmail(user: IUser, organization: IOrganization, role: RoleInOrganization, token: string, inviter?: AuthorizedPrincipal) {
        const language = toEmailLanguage(user.language)
        const t = emailStrings[language]
        const strings = t.organizationInvitation
        const invitation: InvitationText = { inviter: this.inviterName(inviter), target: organization.name, role: t.organizationRoles[role] }

        await this.send({
            to: user.email,
            template: "organization-invitation",
            language,
            subject: strings.subject(organization.name),
            url: `${this.config.FRONTEND_URL}/organization-invitation/${token}`,
            header: strings.header,
            headerIcon: "\u{1F465}",
            preheader: strings.preheader(invitation),
            greeting: t.greeting(user.name),
            intro: strings.intro(invitation),
            prompt: strings.prompt,
            button: strings.button,
            ignore: strings.ignore,
            expiry: strings.expiry,
            locals: { introHtml: strings.intro(this.invitationMarkup(invitation)) }
        })
    }

    /** Warns an administrator of the project that one of its API keys expires in `daysLeft` days. */
    async sendApiKeyExpiryEmail(user: Pick<IUser, "email" | "name" | "language">, project: Pick<IProject, "name">, apiKey: Pick<IApiKey, "name" | "expiresAt">, daysLeft: number): Promise<void> {
        const language = toEmailLanguage(user.language)
        const t = emailStrings[language]
        const strings = t.apiKeyExpiry
        // UTC as the console stores it: a key expiring at midnight would otherwise show the day before or after
        const date = new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(apiKey.expiresAt)
        const expiry: ApiKeyExpiryText = { key: apiKey.name, project: project.name, date, daysLeft }

        await this.send({
            to: user.email,
            template: "api-key-expiry",
            language,
            subject: strings.subject(project.name),
            url: `${this.config.FRONTEND_URL}/api-keys`,
            header: strings.header,
            headerIcon: "⏳",
            preheader: strings.preheader(expiry),
            greeting: t.greeting(user.name),
            intro: strings.intro(expiry),
            prompt: strings.prompt,
            button: strings.button,
            ignore: strings.ignore,
            expiry: strings.reason(project.name),
            locals: { introHtml: strings.intro({ ...expiry, key: strong(expiry.key, "accent"), project: strong(expiry.project) }) }
        })
    }

    /** `language` is the one stored on the recipient (`IUser.language`). */
    async sendResetPasswordEmail(email: string, token: string, language?: string): Promise<void> {
        const lang = toEmailLanguage(language)
        const t = emailStrings[lang]
        const strings = t.passwordReset

        await this.send({
            to: email,
            template: "password-reset",
            language: lang,
            url: `${this.config.FRONTEND_URL}/reset-password/${token}`,
            headerIcon: "🔑",
            greeting: t.greeting(),
            ...strings
        })
    }

    /** `language` is the one stored on the recipient (`IUser.language`). */
    async sendVerificationEmail(email: string, token: string, language?: string): Promise<void> {
        const lang = toEmailLanguage(language)
        const t = emailStrings[lang]
        const strings = t.accountActivation

        await this.send({
            to: email,
            template: "account-activation",
            language: lang,
            url: `${this.config.FRONTEND_URL}/account-activation/${token}`,
            headerIcon: "🎉",
            greeting: t.greeting(),
            ...strings
        })
    }

    /** Renders the template, inlines its CSS and sends it together with a plain text part built from the same strings. */
    private async send(message: EmailMessage): Promise<void> {
        const t = emailStrings[message.language]
        const html = pug.renderFile(path.join(__dirname, `../templates/emails/${message.template}.pug`), {
            cache: true,
            ...message,
            ...message.locals,
            lang: message.language,
            logoUrl: `${this.config.FRONTEND_URL}/img/logo.png`,
            copyLink: t.copyLink,
            footer: t.footer,
            footerText: message.expiry
        })

        const text = [message.greeting, message.intro, message.prompt, message.url, message.ignore, message.expiry, `--\n${t.footer}`].filter(Boolean).join("\n\n")

        await this.transporter.sendMail({
            from: this.config.EMAIL_SMTP_FROM,
            to: message.to,
            subject: message.subject,
            html: juice(html),
            text
        })
    }

    private inviterName(inviter?: AuthorizedPrincipal): string | undefined {
        // An API key has no person behind it, and its email is synthetic
        if (!inviter || inviter.apiKeyId) {
            return undefined
        }
        return [inviter.name, inviter.surname].filter(Boolean).join(" ").trim() || inviter.email || undefined
    }

    private invitationMarkup({ inviter, target, role }: InvitationText): InvitationText {
        return { inviter: inviter ? strong(inviter) : undefined, target: strong(target), role: strong(role, "accent") }
    }
}

export default EmailSenderService
