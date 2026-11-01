import { BackendRuntime } from "../../types/BackendStack"

/** The languages a workload template can say its image holds: the runtimes the console knows a backend by, and Node.js for every frontend. */
export const SANDBOX_LANGUAGES = ["node", "java", "python", "go", "dotnet"] as const

export type SandboxLanguage = (typeof SANDBOX_LANGUAGES)[number]

/**
 * A language a template holds is a label of its own on the template, `languages.flightroom.dev/java: "true"`: a label
 * value cannot hold a list, and the template lives on the gateway, shared by the installations on its workspace.
 */
const LANGUAGE_LABEL_PREFIX = "languages.flightroom.dev/"

const isLanguage = (value: string): value is SandboxLanguage => (SANDBOX_LANGUAGES as readonly string[]).includes(value)

/** The languages the labels of a template say it holds, in the order of {@link SANDBOX_LANGUAGES}. */
export const languagesOfLabels = (labels: Record<string, string> = {}): SandboxLanguage[] => SANDBOX_LANGUAGES.filter(language => labels[`${LANGUAGE_LABEL_PREFIX}${language}`] === "true")

/** The labels without those of the languages: what the installation page shows and edits as labels. */
export const withoutLanguageLabels = (labels: Record<string, string> = {}): Record<string, string> =>
    Object.fromEntries(Object.entries(labels).filter(([key]) => !key.startsWith(LANGUAGE_LABEL_PREFIX)))

/** The labels, those of the languages replaced by one for each language given. */
export const withLanguageLabels = (labels: Record<string, string> | undefined, languages: readonly string[]): Record<string, string> => ({
    ...withoutLanguageLabels(labels),
    ...Object.fromEntries(languages.filter(isLanguage).map(language => [`${LANGUAGE_LABEL_PREFIX}${language}`, "true"]))
})

const LANGUAGE_OF_RUNTIME: Partial<Record<BackendRuntime, SandboxLanguage>> = {
    [BackendRuntime.NODE]: "node",
    [BackendRuntime.JAVA]: "java",
    [BackendRuntime.PYTHON]: "python",
    [BackendRuntime.GO]: "go",
    [BackendRuntime.DOTNET]: "dotnet"
}

/**
 * The languages a sandbox needs to build and preview these repositories: Node.js for a frontend, the runtime of a
 * backend. A backend whose runtime is unknown, or not one of these, asks for none: no template could say it holds it.
 */
export const languagesOfComponents = (components: readonly { kind: "frontend" | "backend"; runtime?: BackendRuntime }[]): SandboxLanguage[] => {
    const needed = new Set<SandboxLanguage>()
    for (const component of components) {
        const language = component.kind === "frontend" ? "node" : component.runtime && LANGUAGE_OF_RUNTIME[component.runtime]
        if (language) needed.add(language)
    }
    return SANDBOX_LANGUAGES.filter(language => needed.has(language))
}

/** A workload template as the choice of the sandbox needs it. */
export interface TemplateLanguages {
    name: string
    languages: readonly string[]
}

/**
 * The template a sandbox needing these languages is created from: the one in use when it holds them all, so that the
 * warm sandboxes serve it, else the one holding them all with the fewest languages, the lightest image, by name on a
 * tie. Undefined, the sandbox created as the settings say, when nothing is needed or no template holds it all: a
 * template that names no language is never picked for its languages.
 */
export const templateForLanguages = (templates: readonly TemplateLanguages[], needed: readonly string[], inUse?: string): string | undefined => {
    if (!needed.length) return undefined
    const holding = templates.filter(template => needed.every(language => template.languages.includes(language)))
    if (inUse && holding.some(template => template.name === inUse)) return inUse
    const [lightest] = [...holding].sort((left, right) => left.languages.length - right.languages.length || left.name.localeCompare(right.name))
    return lightest?.name
}
