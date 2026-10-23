import { FrontendStackSource } from "./FrontendStack"

/** The marketplace `type` of a template that scaffolds a backend rather than a frontend */
export const BACKEND_TEMPLATE_TYPE = "service"

/** Whether a marketplace `type` is the backend one: the marketplace is hand edited, so its case is not trusted */
export const isBackendTemplateType = (type?: string): boolean => type?.trim().toLowerCase() === BACKEND_TEMPLATE_TYPE

/**
 * What a backend slug may be. It names the workspace folder (a subset of SAFE_SEGMENT in
 * utils/workspacePaths.ts), the registration URL the CI calls and usually the image, so it is
 * checked before anything is created at the provider.
 */
export const BACKEND_SLUG = /^[a-z0-9][a-z0-9-]{1,49}$/

/** What a version may be: it becomes a git tag and an image tag, which take no `+`, space or slash */
export const BACKEND_VERSION = /^[A-Za-z0-9._-]{1,128}$/

/**
 * A container registry as an image reference starts with it: a host, with a port if any, then a namespace
 * if any, e.g. `ghcr.io/acme` or `registry.example.com:5000`. No scheme, no trailing slash: the slug of an
 * application follows it after a slash.
 */
export const CONTAINER_REGISTRY = /^(?=.{1,255}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/

/**
 * What an HTTP path of a backend may be (probes, API docs, OpenAPI spec): absolute, at most 256
 * characters and without whitespace, since it becomes a Kubernetes probe path and a link.
 */
export const BACKEND_HTTP_PATH = /^\/\S{0,255}$/

/** What a key of the config map or of the secrets may be: it reaches the container as an environment variable name */
export const BACKEND_VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

/** The HTTP paths a backend exposes: the probes Kubernetes calls and its public API documentation */
export interface BackendPaths {
    livenessPath: string
    readinessPath: string
    /** The UI of the public API documentation, e.g. /docs */
    docsPath?: string
    /** The OpenAPI spec, e.g. /openapi.json */
    openApiPath?: string
}

/** What a backend template fills in when the backend being created does not say otherwise */
export interface BackendDefaults extends BackendPaths {
    port: number
}

/** The language runtime a backend image is built on */
export enum BackendRuntime {
    NODE = "NODE",
    PYTHON = "PYTHON",
    GO = "GO",
    DOTNET = "DOTNET",
    JAVA = "JAVA",
    OTHER = "OTHER"
}

export interface BackendStackDTO {
    runtime?: BackendRuntime
    framework?: string
    source: FrontendStackSource
    detectedAt?: Date
}

const RUNTIME_BY_NAME: Record<string, BackendRuntime> = {
    node: BackendRuntime.NODE,
    "node.js": BackendRuntime.NODE,
    nodejs: BackendRuntime.NODE,
    python: BackendRuntime.PYTHON,
    go: BackendRuntime.GO,
    golang: BackendRuntime.GO,
    dotnet: BackendRuntime.DOTNET,
    ".net": BackendRuntime.DOTNET,
    java: BackendRuntime.JAVA,
    "spring boot": BackendRuntime.JAVA,
    "spring-boot": BackendRuntime.JAVA,
    quarkus: BackendRuntime.JAVA,
    micronaut: BackendRuntime.JAVA
}

/**
 * The marketplace spells the framework of a backend template freely ("Node.js", "Spring Boot", "Quarkus"),
 * so it is normalised here. A value given but not recognised is OTHER: the backend does run on
 * something, only not on a runtime this console knows by name.
 */
export const parseRuntime = (value?: string): BackendRuntime | undefined => {
    if (!value?.trim()) return undefined
    return RUNTIME_BY_NAME[value.trim().toLowerCase()] ?? BackendRuntime.OTHER
}
