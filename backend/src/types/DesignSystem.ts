import { createBusinessException } from "../errors/BusinessException"

/**
 * The UI library the frontends are built with: set by the organization, which a project may replace with
 * its own, and a frontend with its own again. It tells users and AI agents which package to build the UI with.
 */
export interface IDesignSystem {
    /** The npm package, e.g. `@acme/ui` */
    packageName: string
    /** A semver range, e.g. `^3.2.0` */
    version?: string
    docsUrl?: string
    /**
     * The .npmrc the package installs with, stored as the team pasted it: credentials included. The console
     * and MCP hand it out whole, MCP with {@link NPMRC_USAGE}; the console's own models (the assistant, the
     * AI change agent) get it through {@link redactNpmrc}.
     */
    npmrc?: string
    /** Markdown for AI agents on how to use it, e.g. "import from @acme/ui, use its tokens, no raw CSS colors" */
    notes?: string
}

export const DESIGN_SYSTEM_MAX_LENGTH = { packageName: 214, version: 100, docsUrl: 2_000, npmrc: 5_000, notes: 10_000 } satisfies Record<keyof IDesignSystem, number>

/** What npm takes as a package name, scoped or not */
export const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

const FIELDS = Object.keys(DESIGN_SYSTEM_MAX_LENGTH) as (keyof IDesignSystem)[]

/**
 * The lines of an .npmrc that carry a credential, scoped (`//registry.x/:_authToken=...`) or not, commented
 * out too. A value that only names an environment variable (`${NPM_TOKEN}`) is no credential and stays.
 */
const NPMRC_CREDENTIAL = /^(\s*[#;]?\s*(?:[^\s=#;]*:)?(?:_authToken|_auth|_password|password|username|email|certfile|keyfile|key|cert)\s*)=(?![ \t]*\$\{\w+\}[ \t\r]*$)[^\r\n]*/gim

/** The .npmrc with the value of every credential replaced by `***`: the registries and the other settings stay readable. */
export const redactNpmrc = (content: string): string => content.replace(NPMRC_CREDENTIAL, "$1=***")

/** The design system as stored, npmrc included; a plain object even from a mongoose subdocument. */
export const plainDesignSystem = (designSystem?: IDesignSystem | null): IDesignSystem | undefined => {
    if (!designSystem?.packageName) return undefined
    const { packageName, version, docsUrl, npmrc, notes } = designSystem
    return { packageName, ...(version ? { version } : {}), ...(docsUrl ? { docsUrl } : {}), ...(npmrc ? { npmrc } : {}), ...(notes ? { notes } : {}) }
}

/** The design system as the console's models read it, its npmrc redacted. */
export const redactDesignSystem = (designSystem?: IDesignSystem | null): IDesignSystem | undefined => {
    const plain = plainDesignSystem(designSystem)
    return plain?.npmrc ? { ...plain, npmrc: redactNpmrc(plain.npmrc) } : plain
}

/**
 * A JSON.stringify replacer redacting every `designSystem` of what is serialised: the assistant hands whole
 * projects and frontends to its model, and no tool has to remember it.
 */
export const redactDesignSystems = (key: string, value: unknown): unknown => (key === "designSystem" && value && typeof value === "object" ? redactDesignSystem(value as IDesignSystem) : value)

/** Next to every npmrc an MCP client reads: without it the client takes the token for something to ask the user about */
export const NPMRC_USAGE =
    "npmrc is the whole .npmrc packageName installs with, credentials included: write it as .npmrc next to package.json (or merge it into ~/.npmrc) and install. " +
    "Keep it out of git (add .npmrc to .gitignore): code_change_submit refuses it. design_system_npmrc_get returns it on its own."

/** The design system as an MCP client reads it: its npmrc whole, with how to use it. */
export const designSystemForMcp = (designSystem?: IDesignSystem | null): (IDesignSystem & { npmrcUsage?: string }) | undefined => {
    const plain = plainDesignSystem(designSystem)
    return plain?.npmrc ? { ...plain, npmrcUsage: NPMRC_USAGE } : plain
}

/** A JSON.stringify replacer giving every `designSystem` of an MCP result as {@link designSystemForMcp} does. */
export const designSystemsForMcp = (key: string, value: unknown): unknown => (key === "designSystem" && value && typeof value === "object" ? designSystemForMcp(value as IDesignSystem) : value)

/**
 * The design system that applies: the first of the chain that has one, from the most specific level, e.g.
 * frontend, project, organization.
 */
export const effectiveDesignSystem = (...candidates: (IDesignSystem | null | undefined)[]): IDesignSystem | undefined => candidates.find(candidate => candidate?.packageName) ?? undefined

/** The design system to store, trimmed, its blank fields left out: refused with a 400 rather than by the model with a 500. */
export const designSystemOf = (input: unknown): IDesignSystem => {
    const invalid = (message: string) => createBusinessException({ code: "DESIGN_SYSTEM_INVALID", message, statusCode: 400 })
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("The design system is an object with at least its packageName")
    const designSystem: Partial<IDesignSystem> = {}
    for (const field of FIELDS) {
        const value = (input as Record<string, unknown>)[field]
        if (value === undefined || value === null) continue
        if (typeof value !== "string") throw invalid(`The ${field} of the design system is a string`)
        const trimmed = value.trim()
        if (trimmed.length > DESIGN_SYSTEM_MAX_LENGTH[field]) throw invalid(`The ${field} of the design system is at most ${DESIGN_SYSTEM_MAX_LENGTH[field]} characters`)
        if (trimmed) designSystem[field] = trimmed
    }
    if (!designSystem.packageName || !NPM_PACKAGE_NAME.test(designSystem.packageName)) throw invalid("The design system needs the name of its npm package, e.g. @acme/ui")
    if (designSystem.docsUrl && !/^https?:\/\/\S+$/.test(designSystem.docsUrl)) throw invalid("The docsUrl of the design system is an http(s) URL")
    return designSystem as IDesignSystem
}

/**
 * The design system of a frontend as a block of an agent prompt, none when it has none. The agent
 * cannot install packages, so it says when the package is missing instead of reaching for another library.
 */
export const describeDesignSystem = (designSystem?: IDesignSystem): string | undefined => {
    const redacted = redactDesignSystem(designSystem)
    if (!redacted) return undefined
    return [
        "<design_system>",
        `package: ${redacted.packageName}`,
        redacted.version ? `version: ${redacted.version}` : undefined,
        redacted.docsUrl ? `docs: ${redacted.docsUrl}` : undefined,
        redacted.notes ? `notes:\n${redacted.notes}` : undefined,
        redacted.npmrc ? `npmrc (credentials masked):\n${redacted.npmrc}` : undefined,
        "Build the UI of this frontend with the components and tokens of this design system: do not add another UI library. You cannot install packages: if the package is missing from package.json, say so in the summary.",
        "</design_system>"
    ]
        .filter(Boolean)
        .join("\n")
}
