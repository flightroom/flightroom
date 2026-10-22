import { FrontendFramework } from "./FrontendStack"

/**
 * The backend technologies a project can pick as its default for new services. They name what the
 * team builds with rather than a runtime: Spring Boot, Quarkus and Micronaut all run on Java, but an
 * agent scaffolding a service has to know which one the team expects.
 */
export enum BackendTechnology {
    NODE = "NODE",
    PYTHON = "PYTHON",
    SPRING_BOOT = "SPRING_BOOT",
    QUARKUS = "QUARKUS",
    MICRONAUT = "MICRONAUT",
    GO = "GO",
    DOTNET = "DOTNET"
}

/**
 * The default technologies of a project, one per side. They guide users and AI agents creating a
 * frontend or a service (the template proposed first, what an agent picks when the user says
 * nothing), and never block another choice.
 */
export interface IProjectTechnologies {
    frontend?: FrontendFramework
    backend?: BackendTechnology
}

/** Keyed by the normalised spelling: lowercase, without dots, dashes, underscores or spaces */
const BACKEND_TECHNOLOGY_BY_NAME: Record<string, BackendTechnology> = {
    node: BackendTechnology.NODE,
    nodejs: BackendTechnology.NODE,
    fastify: BackendTechnology.NODE,
    python: BackendTechnology.PYTHON,
    fastapi: BackendTechnology.PYTHON,
    springboot: BackendTechnology.SPRING_BOOT,
    spring: BackendTechnology.SPRING_BOOT,
    quarkus: BackendTechnology.QUARKUS,
    micronaut: BackendTechnology.MICRONAUT,
    go: BackendTechnology.GO,
    golang: BackendTechnology.GO,
    net: BackendTechnology.DOTNET,
    dotnet: BackendTechnology.DOTNET
}

/**
 * The service templates and the stacks of the services spell their framework freely ("Node.js",
 * "Spring Boot", ".NET"), so it is normalised to compare it with the project's choice. An unknown
 * value is undefined: a template no technology is recognised in matches none.
 */
export const parseBackendTechnology = (value?: string): BackendTechnology | undefined =>
    value
        ? BACKEND_TECHNOLOGY_BY_NAME[
              value
                  .trim()
                  .toLowerCase()
                  .replace(/[\s._-]/g, "")
          ]
        : undefined

const FRONTEND_LABELS: Record<FrontendFramework, string> = { REACT: "React", VUE: "Vue", ANGULAR: "Angular" }

const BACKEND_LABELS: Record<BackendTechnology, string> = {
    NODE: "Node.js",
    PYTHON: "Python",
    SPRING_BOOT: "Spring Boot",
    QUARKUS: "Quarkus",
    MICRONAUT: "Micronaut",
    GO: "Go",
    DOTNET: ".NET"
}

/**
 * The technologies as a block of an agent prompt, none when the project picked neither. Worded as a
 * default and not a rule: the user may ask for another stack, and a repository that exists already
 * keeps the one it is built with.
 */
export const describeProjectTechnologies = (technologies?: IProjectTechnologies): string | undefined => {
    const lines = [
        technologies?.frontend ? `frontend: ${FRONTEND_LABELS[technologies.frontend]}` : undefined,
        technologies?.backend ? `backend: ${BACKEND_LABELS[technologies.backend]}` : undefined
    ].filter(Boolean)
    if (lines.length === 0) return undefined
    return [
        "<project_technologies>",
        ...lines,
        "The team chose these as the default technologies of the project: use them for anything new (a frontend, a service, the stack of new code) unless the user explicitly asks for another. An existing repository keeps the stack it is built with.",
        "</project_technologies>"
    ].join("\n")
}
