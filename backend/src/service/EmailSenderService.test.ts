import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"

// Mocked for the same reason as in the other service tests: the real module boots the application.
vi.mock("..", () => ({
    fastify: { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: { FRONTEND_URL: "https://console.example.com", EMAIL_SMTP_FROM: "Flightroom <no-reply@example.com>" } }
}))

import type { SendMailOptions, Transporter } from "nodemailer"
import { IOrganization } from "../models/OrganizationModel"
import { IProject } from "../models/ProjectModel"
import { IUser } from "../models/UserModel"
import { RoleInOrganization } from "../models/UserOrganizationModel"
import { RoleInProject } from "../models/UserProjectModel"
import { toEmailLanguage } from "../templates/emails/i18n"
import type { AuthorizedPrincipal } from "./BaseAuthorizedService"
import EmailSenderService from "./EmailSenderService"

const FRONTEND_URL = "https://console.example.com"

const INVITER = { name: "Jane", surname: "Doe", email: "jane.doe@example.com" } as unknown as AuthorizedPrincipal

const anInvitee = (language: string) => ({ email: "invitee@example.com", name: "Alex", language }) as unknown as IUser

let service: EmailSenderService
let sendMail: MockInstance

/** The single message handed to the transporter. */
const sentMessage = () => {
    expect(sendMail).toHaveBeenCalledOnce()
    return sendMail.mock.calls[0][0] as SendMailOptions & { html: string; text: string }
}

beforeEach(() => {
    service = new EmailSenderService()
    const transporter = (service as unknown as { transporter: Transporter }).transporter
    sendMail = vi.spyOn(transporter, "sendMail").mockResolvedValue({} as never)
})

afterEach(() => {
    vi.restoreAllMocks()
})

interface EmailCase {
    name: string
    send: (language: string) => Promise<void>
    to: string
    url: string
    subject: Record<"en" | "it", string>
    /** What only this email says, in each language: the inviter for the invitations. */
    body: Record<"en" | "it", string>
}

const cases: EmailCase[] = [
    {
        name: "account activation",
        send: language => service.sendVerificationEmail("new.user@example.com", "activation-token", language),
        to: "new.user@example.com",
        url: `${FRONTEND_URL}/account-activation/activation-token`,
        subject: { en: "🎉 Activate Your Account", it: "🎉 Attiva il tuo account" },
        body: { en: "This activation link will expire in 24 hours.", it: "Questo link scade tra 24 ore." }
    },
    {
        name: "password reset",
        send: language => service.sendResetPasswordEmail("someone@example.com", "reset-token", language),
        to: "someone@example.com",
        url: `${FRONTEND_URL}/reset-password/reset-token`,
        subject: { en: "🔑 Reset Your Password", it: "🔑 Reimposta la password" },
        body: { en: "This password reset link will expire in 1 hour.", it: "Questo link scade tra 1 ora." }
    },
    {
        name: "project invitation",
        send: language => service.sendUserInvitationEmail(anInvitee(language), { name: "Demo Project" } as IProject, RoleInProject.MEMBER, "project-token", INVITER),
        to: "invitee@example.com",
        url: `${FRONTEND_URL}/project-invitation/project-token`,
        subject: { en: "🎉 You're invited to join Demo Project", it: "🎉 Invito a unirti a Demo Project" },
        body: { en: "Jane Doe invited you to join Demo Project as Editor.", it: "Jane Doe ti ha invitato a unirti a Demo Project con il ruolo Editore." }
    },
    {
        name: "organization invitation",
        send: language => service.sendOrganizationInvitationEmail(anInvitee(language), { name: "Acme" } as IOrganization, RoleInOrganization.ADMIN, "organization-token", INVITER),
        to: "invitee@example.com",
        url: `${FRONTEND_URL}/organization-invitation/organization-token`,
        subject: { en: "🎉 You're invited to join Acme", it: "🎉 Invito a unirti ad Acme" },
        body: {
            en: "Jane Doe invited you to join the organization Acme as Admin.",
            it: "Jane Doe ti ha invitato a unirti all'organizzazione Acme con il ruolo Amministratore."
        }
    },
    {
        name: "API key expiry",
        send: language => service.sendApiKeyExpiryEmail(anInvitee(language), { name: "Demo Project" } as IProject, { name: "CI deploy", expiresAt: new Date("2026-11-03T00:00:00Z") }, 7),
        to: "invitee@example.com",
        url: `${FRONTEND_URL}/api-keys`,
        subject: { en: "⏳ An API key of Demo Project is about to expire", it: "⏳ Una chiave API di Demo Project sta per scadere" },
        body: {
            en: "The API key CI deploy of the project Demo Project expires in 7 days, on November 3, 2026.",
            it: "La chiave API CI deploy del progetto Demo Project scade tra 7 giorni, il 3 novembre 2026."
        }
    },
    {
        name: "AI job ended",
        send: language =>
            service.sendAiJobEndedEmail(anInvitee(language), { _id: "p1", name: "Demo Project" } as unknown as IProject, {
                label: "Checkout page",
                failed: false,
                target: { kind: "domain", name: "Payments" },
                path: "/domain/d1"
            }),
        to: "invitee@example.com",
        url: `${FRONTEND_URL}/domain/d1?project=p1`,
        subject: { en: "✅ The AI job is done: Checkout page", it: "✅ Il job AI è terminato: Checkout page" },
        body: {
            en: "The AI agent finished the job Checkout page on the domain Payments of the project Demo Project.",
            it: "L'agente AI ha terminato il job Checkout page sul dominio Payments del progetto Demo Project."
        }
    }
]

describe.each(cases)("$name email", ({ send, to, url, subject, body }) => {
    describe.each(["en", "it"] as const)("in %s", language => {
        it("given the recipient language, when it is sent, then subject, recipient and title speak that language", async () => {
            await send(language)

            const message = sentMessage()
            expect(message.subject).toBe(subject[language])
            expect(message.to).toBe(to)
            expect(message.html).toContain(`<html lang="${language}">`)
            expect(message.html).toContain(`<title>${subject[language]}</title>`)
        })

        it("given the link, when it is sent, then the button and the fallback both point at it", async () => {
            await send(language)

            const { html } = sentMessage()
            expect(html.split(`href="${url}"`)).toHaveLength(3)
            expect(html).toContain(`src="${FRONTEND_URL}/img/logo.png"`)
        })

        it("given the stylesheet, when it is sent, then the styles are inlined and the button text stays dark on pumpkin", async () => {
            await send(language)

            const { html } = sentMessage()
            expect(html).toMatch(/<td class="button-cell"[^>]*bgcolor="#FE7F2D"[^>]*style="[^"]*background-color: #FE7F2D/)
            expect(html).toMatch(/<a class="button"[^>]*style="[^"]*color: #07202D/)
            expect(html).toContain("prefers-color-scheme: dark")
        })

        it("given the strings of the language, when it is sent, then html and text carry the same content", async () => {
            await send(language)

            const { html, text } = sentMessage()
            expect(text.split("\n")).toContain(url)
            expect(text).toContain(body[language])
            expect(html.replace(/<[^>]+>/g, "")).toContain(body[language])
        })
    })
})

describe("invitation emails", () => {
    const project = { name: "Demo Project" } as IProject

    it("given no inviter, when the invitation is sent, then the email names nobody", async () => {
        await service.sendUserInvitationEmail(anInvitee("en"), project, RoleInProject.VIEWER, "token")

        expect(sentMessage().text).toContain("You've been invited to join Demo Project as Viewer.")
    })

    it("given an API key as the principal, when the invitation is sent, then its synthetic email is not shown", async () => {
        const apiKey = { email: "api-key:123", apiKeyId: "123" } as unknown as AuthorizedPrincipal

        await service.sendUserInvitationEmail(anInvitee("it"), project, RoleInProject.OWNER, "token", apiKey)

        const { html, text } = sentMessage()
        expect(text).toContain("Hai ricevuto un invito a unirti a Demo Project con il ruolo Amministratore.")
        expect(html).not.toContain("api-key:123")
    })

    it("given an inviter without a name, when the invitation is sent, then the email address stands in for it", async () => {
        const inviter = { email: "owner@example.com" } as unknown as AuthorizedPrincipal

        await service.sendOrganizationInvitationEmail(anInvitee("en"), { name: "Acme" } as IOrganization, RoleInOrganization.MEMBER, "token", inviter)

        expect(sentMessage().text).toContain("owner@example.com invited you to join the organization Acme as Member.")
    })

    it("given a name carrying markup, when the invitation is sent, then the markup is escaped", async () => {
        await service.sendUserInvitationEmail(anInvitee("en"), { name: "<b>Evil</b>" } as IProject, RoleInProject.MEMBER, "token", INVITER)

        const { html } = sentMessage()
        expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;")
        expect(html).not.toContain("<b>Evil</b>")
    })
})

describe("API key expiry email", () => {
    const project = { name: "Demo Project" } as IProject

    it("given a key expiring within a day, when the notice is sent, then it says tomorrow", async () => {
        await service.sendApiKeyExpiryEmail(anInvitee("it"), project, { name: "CI deploy", expiresAt: new Date("2026-10-28T10:00:00Z") }, 1)

        expect(sentMessage().text).toContain("La chiave API CI deploy del progetto Demo Project scade domani, il 28 ottobre 2026.")
    })

    it("given a key name carrying markup, when the notice is sent, then the markup is escaped", async () => {
        await service.sendApiKeyExpiryEmail(anInvitee("en"), project, { name: "<b>Evil</b>", expiresAt: new Date("2026-11-03T00:00:00Z") }, 7)

        const { html } = sentMessage()
        expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;")
        expect(html).not.toContain("<b>Evil</b>")
    })
})

describe("toEmailLanguage", () => {
    it.each([
        ["it", "it"],
        ["it-IT", "it"],
        ["IT", "it"],
        ["en", "en"],
        ["en-US", "en"],
        ["fr", "en"],
        [undefined, "en"]
    ])("given %s, when normalised, then it is %s", (language, expected) => {
        expect(toEmailLanguage(language)).toBe(expected)
    })
})
