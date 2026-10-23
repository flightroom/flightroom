import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { Market } from "@/hooks/apiClients/useMarketApi"
import type { Service } from "@/hooks/apiClients/useServicesApi"

/** Le tecnologie di default che un progetto puo' scegliere: stessi valori dell'API */
export const FRONTEND_TECHNOLOGIES = ["REACT", "VUE", "ANGULAR"] as const
export const BACKEND_TECHNOLOGIES = ["NODE", "PYTHON", "SPRING_BOOT", "QUARKUS", "MICRONAUT", "GO", "DOTNET"] as const

export type FrontendTechnology = (typeof FRONTEND_TECHNOLOGIES)[number]
export type BackendTechnology = (typeof BACKEND_TECHNOLOGIES)[number]
export type Technology = FrontendTechnology | BackendTechnology

/** Le tecnologie di default del progetto: guidano template e agenti, non vincolano nulla */
export interface ProjectTechnologies {
    frontend?: FrontendTechnology
    backend?: BackendTechnology
}

export const TECHNOLOGY_LABEL_KEYS: Record<Technology, string> = {
    REACT: "technologies.names.REACT",
    VUE: "technologies.names.VUE",
    ANGULAR: "technologies.names.ANGULAR",
    NODE: "technologies.names.NODE",
    PYTHON: "technologies.names.PYTHON",
    SPRING_BOOT: "technologies.names.SPRING_BOOT",
    QUARKUS: "technologies.names.QUARKUS",
    MICRONAUT: "technologies.names.MICRONAUT",
    GO: "technologies.names.GO",
    DOTNET: "technologies.names.DOTNET"
}

export const isFrontendTechnology = (value?: string): value is FrontendTechnology => (FRONTEND_TECHNOLOGIES as readonly string[]).includes(value ?? "")
export const isBackendTechnology = (value?: string): value is BackendTechnology => (BACKEND_TECHNOLOGIES as readonly string[]).includes(value ?? "")

/** Testo libero (framework di un template, stack rilevato) normalizzato: minuscolo, senza spazi, punti, trattini e underscore */
const ALIASES: Record<string, Technology> = {
    react: "REACT",
    reactjs: "REACT",
    vue: "VUE",
    vuejs: "VUE",
    angular: "ANGULAR",
    node: "NODE",
    nodejs: "NODE",
    fastify: "NODE",
    python: "PYTHON",
    fastapi: "PYTHON",
    springboot: "SPRING_BOOT",
    spring: "SPRING_BOOT",
    quarkus: "QUARKUS",
    micronaut: "MICRONAUT",
    go: "GO",
    golang: "GO",
    net: "DOTNET",
    dotnet: "DOTNET"
}

export const normalizeTechnology = (value?: string | null): Technology | undefined => (value ? ALIASES[value.toLowerCase().replace(/[\s.\-_]/g, "")] : undefined)

export const frontendTechnologyOf = (frontend: Pick<Frontend, "stack">): FrontendTechnology | undefined => {
    const technology = normalizeTechnology(frontend.stack?.framework)
    return isFrontendTechnology(technology) ? technology : undefined
}

/** Dal framework rilevato, altrimenti dal runtime: JAVA da solo non dice se e' Spring Boot, Quarkus o Micronaut */
const RUNTIME_TECHNOLOGIES: Partial<Record<string, BackendTechnology>> = { NODE: "NODE", PYTHON: "PYTHON", GO: "GO", DOTNET: "DOTNET" }

export const backendTechnologyOf = (service: Pick<Service, "stack">): BackendTechnology | undefined => {
    const technology = normalizeTechnology(service.stack?.framework)
    if (isBackendTechnology(technology)) return technology
    return service.stack?.runtime ? RUNTIME_TECHNOLOGIES[service.stack.runtime] : undefined
}

/** Un template di servizio porta una tecnologia backend, gli altri (remote, host) una frontend */
export const technologyOfMarket = (market: Pick<Market, "framework" | "type">): Technology | undefined => {
    const technology = normalizeTechnology(market.framework)
    const isService = market.type?.trim().toLowerCase() === "service"
    return (isService ? isBackendTechnology(technology) : isFrontendTechnology(technology)) ? technology : undefined
}

/** Il template usa la tecnologia di default del progetto per il suo tipo */
export const isRecommendedTemplate = (market: Pick<Market, "framework" | "type">, technologies?: ProjectTechnologies) => {
    const technology = technologyOfMarket(market)
    if (!technology || !technologies) return false
    return technology === technologies.frontend || technology === technologies.backend
}
