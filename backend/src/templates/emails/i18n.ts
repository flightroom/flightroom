import { RoleInOrganization } from "../../models/UserOrganizationModel"
import { RoleInProject } from "../../models/UserProjectModel"

export type EmailLanguage = "en" | "it"

/** The language of an email from the one stored on the recipient: `it-IT` is Italian, anything unknown is English. */
export const toEmailLanguage = (language?: string | null): EmailLanguage => (language?.trim().toLowerCase().startsWith("it") ? "it" : "en")

/** Who invited whom, where and with which role. `inviter` is missing when nobody can be named. */
export interface InvitationText {
    inviter?: string
    target: string
    role: string
}

interface LinkEmailStrings {
    header: string
    button: string
    ignore: string
    expiry: string
}

interface FixedEmailStrings extends LinkEmailStrings {
    subject: string
    preheader: string
    intro: string
}

interface InvitationEmailStrings extends LinkEmailStrings {
    subject: (target: string) => string
    preheader: (invitation: InvitationText) => string
    /** Called with plain values for the text part and with already escaped markup for the HTML one. */
    intro: (invitation: InvitationText) => string
    prompt: string
}

/** Which key expires, in which project, when, and in how many days. */
export interface ApiKeyExpiryText {
    key: string
    project: string
    date: string
    daysLeft: number
}

interface ApiKeyExpiryEmailStrings extends Omit<LinkEmailStrings, "expiry"> {
    subject: (project: string) => string
    preheader: (expiry: ApiKeyExpiryText) => string
    /** Called with plain values for the text part and with already escaped markup for the HTML one. */
    intro: (expiry: ApiKeyExpiryText) => string
    prompt: string
    /** Shown under the email, where the others say when their link expires: why the recipient receives it. */
    reason: (project: string) => string
}

/** What an AI job worked on: one frontend, one backend, a domain, or several repositories. */
export type AiJobTarget = { kind: "frontend" | "backend" | "domain"; name: string } | { kind: "repositories"; count: number }

/** Which job ended (its title, else its prompt), on what, in which project. `target` is already worded by `aiJobEnded.target`. */
export interface AiJobEndedText {
    job: string
    target: string
    project: string
}

interface AiJobOutcomeStrings {
    subject: (job: string) => string
    header: string
    preheader: (ended: AiJobEndedText) => string
    /** Called with plain values for the text part and with already escaped markup for the HTML one. */
    intro: (ended: AiJobEndedText) => string
    prompt: string
    button: string
}

interface AiJobEndedEmailStrings {
    done: AiJobOutcomeStrings
    failed: AiJobOutcomeStrings
    /** With its preposition ("on the domain X", "sul dominio X"). `name` comes plain or as escaped markup, like the intro it goes into. */
    target: (target: AiJobTarget, name: string) => string
    ignore: string
    /** Shown under the email, where the others say when their link expires: why the recipient receives it. */
    reason: string
}

export interface EmailStrings {
    greeting: (name?: string) => string
    copyLink: string
    footer: string
    projectRoles: Record<RoleInProject, string>
    organizationRoles: Record<RoleInOrganization, string>
    accountActivation: FixedEmailStrings
    passwordReset: FixedEmailStrings
    projectInvitation: InvitationEmailStrings
    organizationInvitation: InvitationEmailStrings
    apiKeyExpiry: ApiKeyExpiryEmailStrings
    aiJobEnded: AiJobEndedEmailStrings
}

const inDays = (days: number) => (days <= 1 ? "tomorrow" : `in ${days} days`)
const traGiorni = (days: number) => (days <= 1 ? "domani" : `tra ${days} giorni`)

// Role labels as the console shows them (frontend/public/locales/*/platform.json, project_users.roles and organization_users.roles)
const en: EmailStrings = {
    greeting: name => (name ? `Hello ${name},` : "Hello,"),
    copyLink: "Or copy and paste this link into your browser:",
    footer: "Flightroom — this is an automated message, please do not reply.",
    projectRoles: {
        [RoleInProject.OWNER]: "Admin",
        [RoleInProject.MEMBER]: "Editor",
        [RoleInProject.VIEWER]: "Viewer"
    },
    organizationRoles: {
        [RoleInOrganization.OWNER]: "Owner",
        [RoleInOrganization.ADMIN]: "Admin",
        [RoleInOrganization.MEMBER]: "Member"
    },
    accountActivation: {
        subject: "🎉 Activate Your Account",
        header: "Welcome Aboard!",
        preheader: "Confirm your email address to start using Flightroom.",
        intro: "Welcome to Flightroom! We're excited to have you on board. Please verify your email address by clicking the button below:",
        button: "Activate Account",
        ignore: "If you didn't create an account, you can safely ignore this email.",
        expiry: "This activation link will expire in 24 hours."
    },
    passwordReset: {
        subject: "🔑 Reset Your Password",
        header: "Reset Your Password",
        preheader: "Choose a new password for your Flightroom account. The link expires in 1 hour.",
        intro: "You've requested to reset your password. Click the button below to set a new password:",
        button: "Reset Password",
        ignore: "If you didn't request this, you can safely ignore this email. Your password will remain unchanged.",
        expiry: "This password reset link will expire in 1 hour."
    },
    projectInvitation: {
        subject: target => `🎉 You're invited to join ${target}`,
        header: "You're Invited!",
        preheader: ({ inviter, target }) => (inviter ? `${inviter} invited you to join ${target} on Flightroom.` : `You've been invited to join ${target} on Flightroom.`),
        intro: ({ inviter, target, role }) => (inviter ? `${inviter} invited you to join ${target} as ${role}.` : `You've been invited to join ${target} as ${role}.`),
        prompt: "Click the button below to accept this invitation and get started:",
        button: "Accept Invitation",
        ignore: "If you weren't expecting this invitation, you can safely ignore this email.",
        expiry: "This invitation link will expire in 5 days."
    },
    organizationInvitation: {
        subject: target => `🎉 You're invited to join ${target}`,
        header: "You're Invited!",
        preheader: ({ inviter, target }) => (inviter ? `${inviter} invited you to join ${target} on Flightroom.` : `You've been invited to join ${target} on Flightroom.`),
        intro: ({ inviter, target, role }) =>
            inviter ? `${inviter} invited you to join the organization ${target} as ${role}.` : `You've been invited to join the organization ${target} as ${role}.`,
        prompt: "Click the button below to accept this invitation and get started:",
        button: "Accept Invitation",
        ignore: "If you weren't expecting this invitation, you can safely ignore this email.",
        expiry: "This invitation link will expire in 5 days."
    },
    apiKeyExpiry: {
        subject: project => `⏳ An API key of ${project} is about to expire`,
        header: "Your API Key Is About to Expire",
        preheader: ({ key, project, daysLeft }) => `The API key ${key} of ${project} expires ${inDays(daysLeft)}.`,
        intro: ({ key, project, date, daysLeft }) => `The API key ${key} of the project ${project} expires ${inDays(daysLeft)}, on ${date}.`,
        prompt: "Create a new key and hand it to whatever uses this one (CI pipelines, integrations, MCP clients) before then, or they will stop working:",
        button: "Manage API Keys",
        ignore: "If the key is no longer needed, you can let it expire.",
        reason: project => `You receive this email because you administer ${project}.`
    },
    aiJobEnded: {
        done: {
            subject: job => `✅ The AI job is done: ${job}`,
            header: "Your AI Job Is Done",
            preheader: ({ target }) => `The AI agent finished working ${target}.`,
            intro: ({ job, target, project }) => `The AI agent finished the job ${job} ${target} of the project ${project}.`,
            prompt: "Click the button below to see what it did and review its changes:",
            button: "Review the Job"
        },
        failed: {
            subject: job => `⚠️ The AI job failed: ${job}`,
            header: "Your AI Job Failed",
            preheader: ({ target }) => `The AI agent stopped before finishing its work ${target}.`,
            intro: ({ job, target, project }) => `The AI agent stopped before finishing the job ${job} ${target} of the project ${project}.`,
            prompt: "Click the button below to see what went wrong and try again:",
            button: "Open the Job"
        },
        target: (target, name) => (target.kind === "repositories" ? `on ${target.count} repositories` : `on the ${target.kind} ${name}`),
        ignore: "If you have already seen it in Flightroom, you can ignore this email.",
        reason: "You receive this email because you started this job and were away from Flightroom when it ended."
    }
}

/** "a Demo Project" but "ad Acme": the euphonic d before a word starting with a, also when wrapped in a tag. */
const toTarget = (target: string) => (/^(?:<[^>]*>)*a/i.test(target) ? `ad ${target}` : `a ${target}`)

const it: EmailStrings = {
    greeting: name => (name ? `Ciao ${name},` : "Ciao,"),
    copyLink: "Oppure copia e incolla questo link nel browser:",
    footer: "Flightroom — questo è un messaggio automatico, non rispondere.",
    projectRoles: {
        [RoleInProject.OWNER]: "Amministratore",
        [RoleInProject.MEMBER]: "Editore",
        [RoleInProject.VIEWER]: "Visualizzatore"
    },
    organizationRoles: {
        [RoleInOrganization.OWNER]: "Proprietario",
        [RoleInOrganization.ADMIN]: "Amministratore",
        [RoleInOrganization.MEMBER]: "Membro"
    },
    accountActivation: {
        subject: "🎉 Attiva il tuo account",
        header: "Ti diamo il benvenuto!",
        preheader: "Conferma il tuo indirizzo email per iniziare a usare Flightroom.",
        intro: "Ti diamo il benvenuto su Flightroom, siamo felici di averti a bordo! Conferma il tuo indirizzo email con il pulsante qui sotto:",
        button: "Attiva l'account",
        ignore: "Se non hai creato un account, puoi ignorare questa email.",
        expiry: "Questo link scade tra 24 ore."
    },
    passwordReset: {
        subject: "🔑 Reimposta la password",
        header: "Reimposta la password",
        preheader: "Scegli una nuova password per il tuo account Flightroom. Il link scade tra 1 ora.",
        intro: "Abbiamo ricevuto una richiesta di reimpostazione della password. Usa il pulsante qui sotto per sceglierne una nuova:",
        button: "Reimposta la password",
        ignore: "Se non hai fatto tu questa richiesta, puoi ignorare questa email: la password resterà invariata.",
        expiry: "Questo link scade tra 1 ora."
    },
    projectInvitation: {
        subject: target => `🎉 Invito a unirti ${toTarget(target)}`,
        header: "Hai ricevuto un invito!",
        preheader: ({ inviter, target }) => (inviter ? `${inviter} ti ha invitato a unirti ${toTarget(target)} su Flightroom.` : `Hai ricevuto un invito a unirti ${toTarget(target)} su Flightroom.`),
        intro: ({ inviter, target, role }) =>
            inviter ? `${inviter} ti ha invitato a unirti ${toTarget(target)} con il ruolo ${role}.` : `Hai ricevuto un invito a unirti ${toTarget(target)} con il ruolo ${role}.`,
        prompt: "Usa il pulsante qui sotto per accettare l'invito e iniziare:",
        button: "Accetta l'invito",
        ignore: "Se non ti aspettavi questo invito, puoi ignorare questa email.",
        expiry: "Questo link scade tra 5 giorni."
    },
    organizationInvitation: {
        subject: target => `🎉 Invito a unirti ${toTarget(target)}`,
        header: "Hai ricevuto un invito!",
        preheader: ({ inviter, target }) => (inviter ? `${inviter} ti ha invitato a unirti ${toTarget(target)} su Flightroom.` : `Hai ricevuto un invito a unirti ${toTarget(target)} su Flightroom.`),
        intro: ({ inviter, target, role }) =>
            inviter ? `${inviter} ti ha invitato a unirti all'organizzazione ${target} con il ruolo ${role}.` : `Hai ricevuto un invito a unirti all'organizzazione ${target} con il ruolo ${role}.`,
        prompt: "Usa il pulsante qui sotto per accettare l'invito e iniziare:",
        button: "Accetta l'invito",
        ignore: "Se non ti aspettavi questo invito, puoi ignorare questa email.",
        expiry: "Questo link scade tra 5 giorni."
    },
    apiKeyExpiry: {
        subject: project => `⏳ Una chiave API di ${project} sta per scadere`,
        header: "La chiave API sta per scadere",
        preheader: ({ key, project, daysLeft }) => `La chiave API ${key} di ${project} scade ${traGiorni(daysLeft)}.`,
        intro: ({ key, project, date, daysLeft }) => `La chiave API ${key} del progetto ${project} scade ${traGiorni(daysLeft)}, il ${date}.`,
        prompt: "Crea una nuova chiave e passala a chi usa questa (pipeline di CI, integrazioni, client MCP) prima di allora, altrimenti smetteranno di funzionare:",
        button: "Gestisci le chiavi API",
        ignore: "Se la chiave non serve più, puoi lasciarla scadere.",
        reason: project => `Ricevi questa email perché amministri ${project}.`
    },
    aiJobEnded: {
        done: {
            subject: job => `✅ Il job AI è terminato: ${job}`,
            header: "Il tuo job AI è terminato",
            preheader: ({ target }) => `L'agente AI ha finito di lavorare ${target}.`,
            intro: ({ job, target, project }) => `L'agente AI ha terminato il job ${job} ${target} del progetto ${project}.`,
            prompt: "Usa il pulsante qui sotto per vedere cosa ha fatto e rivedere le modifiche:",
            button: "Rivedi il job"
        },
        failed: {
            subject: job => `⚠️ Il job AI non è riuscito: ${job}`,
            header: "Il tuo job AI non è riuscito",
            preheader: ({ target }) => `L'agente AI si è fermato prima di finire il lavoro ${target}.`,
            intro: ({ job, target, project }) => `L'agente AI si è fermato prima di terminare il job ${job} ${target} del progetto ${project}.`,
            prompt: "Usa il pulsante qui sotto per vedere cosa è andato storto e riprovare:",
            button: "Apri il job"
        },
        target: (target, name) =>
            target.kind === "repositories" ? `su ${target.count} repository` : `${{ frontend: "sul frontend", backend: "sul backend", domain: "sul dominio" }[target.kind]} ${name}`,
        ignore: "Se l'hai già visto su Flightroom, puoi ignorare questa email.",
        reason: "Ricevi questa email perché hai avviato questo job e non eri su Flightroom quando è terminato."
    }
}

export const emailStrings: Record<EmailLanguage, EmailStrings> = { en, it }
