import { IMarket } from "../models/MarketModel"
import { BackendDefaults } from "../types/BackendStack"

const backendTemplate = (slug: string, name: string, framework: string, description: string, backendDefaults: BackendDefaults): IMarket =>
    ({
        name,
        slug,
        description,
        version: "1.0.0",
        author: "Lorenzo De Francesco",
        license: "MIT",
        repo: `https://github.com/flightroom/template-${slug}`,
        zipUrl: `https://github.com/flightroom/template-${slug}/archive/refs/heads/main.zip`,
        tags: ["template", "backend", "docker"],
        type: "service",
        compiler: "docker",
        framework,
        category: "Backend",
        icon: "/templates/docker.svg",
        backendDefaults
    }) as IMarket

/**
 * The backend templates ship with the backend instead of the shared marketplace.json:
 * every installation reads that manifest live, and one without backends would offer these as
 * frontend templates.
 */
export const BACKEND_TEMPLATES: IMarket[] = [
    backendTemplate("service-node-fastify", "Node.js & Fastify", "Node.js", "Backend with Node.js, TypeScript and Fastify, packaged as a Docker image", {
        port: 8080,
        livenessPath: "/health/live",
        readinessPath: "/health/ready",
        docsPath: "/docs",
        openApiPath: "/openapi.json"
    }),
    backendTemplate("service-python-fastapi", "Python & FastAPI", "Python", "Backend with Python and FastAPI, packaged as a Docker image", {
        port: 8080,
        livenessPath: "/health/live",
        readinessPath: "/health/ready",
        docsPath: "/docs",
        openApiPath: "/openapi.json"
    }),
    backendTemplate("service-spring-boot", "Spring Boot", "Spring Boot", "Backend with Java and Spring Boot, packaged as a Docker image", {
        port: 8080,
        livenessPath: "/actuator/health/liveness",
        readinessPath: "/actuator/health/readiness",
        docsPath: "/swagger-ui/index.html",
        openApiPath: "/v3/api-docs"
    }),
    backendTemplate("service-quarkus", "Quarkus", "Quarkus", "Backend with Java and Quarkus, packaged as a Docker image", {
        port: 8080,
        livenessPath: "/q/health/live",
        readinessPath: "/q/health/ready",
        docsPath: "/q/swagger-ui/",
        openApiPath: "/q/openapi.json"
    }),
    backendTemplate("service-micronaut", "Micronaut", "Micronaut", "Backend with Java and Micronaut, packaged as a Docker image", {
        port: 8080,
        livenessPath: "/health/liveness",
        readinessPath: "/health/readiness",
        docsPath: "/swagger-ui/index.html",
        openApiPath: "/swagger/openapi.json"
    })
]
