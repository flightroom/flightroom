import { lookup as dnsLookup } from "node:dns"
import http, { IncomingMessage } from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import { parse as parseYaml } from "yaml"
import { isPublicAddress, publicOnlyLookup } from "../../utils/clientMetadataFetcher"

/**
 * What the agent's `read_api_spec` tool reads: the Swagger/OpenAPI document of an `api` resource attached to
 * a service of the job, pasted in the console or fetched from its specUrl, and shown in a form a model can
 * use without reading megabytes of JSON: an index of the operations, or one operation in full.
 */

export const API_SPEC_LIMITS = {
    /** For the whole fetch, redirects included */
    fetchTimeoutMs: 10_000,
    /** A document past it is refused while it streams, not after */
    maxFetchedBytes: 2 * 1024 * 1024,
    /** Every hop is checked again before it is followed */
    maxRedirects: 3,
    /** Operations the index lists; the others are counted */
    maxIndexedOperations: 400,
    /** Bytes of an answer of the tool, index or detail */
    maxAnswerBytes: 60_000,
    /** References followed inside one another, past it left as `$ref` */
    maxRefDepth: 8,
    /** Nodes an operation is expanded to: a schema referenced from everywhere would otherwise multiply */
    maxExpandedNodes: 20_000,
    /** YAML past it is refused unparsed: a parser holds a document many times its size, JSON keeps the cap of whoever read it */
    maxYamlBytes: 1024 * 1024
}

/**
 * How YAML is read: duplicated keys are not looked for (the check is quadratic, a mapping of some tens of
 * thousands of keys holds the event loop for seconds), aliases are capped against the billion laughs
 */
const YAML_OPTIONS = { uniqueKeys: false, maxAliasCount: 100, prettyErrors: false } as const

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

/** Where the tool finds the document of one resource: the one pasted in the console first, its specUrl otherwise */
export interface AiChangeApiSpecSource {
    /** The name of the resource, what the agent passes */
    resource: string
    specUrl?: string
    /** The pasted document, read only when the agent asks for it: it can take megabytes */
    loadPasted?: () => Promise<string | undefined>
}

type ApiDocument = Record<string, unknown>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/** A URL as an error or the agent sees it: no user, password, query nor fragment, any of which can carry a credential */
const shownUrl = (url: URL) => `${url.origin}${url.pathname}`

/** Why the backend will not request this URL, undefined when it will. A host name is judged again by the address it resolves to */
const refusalOf = (url: URL): string | undefined => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https URLs are fetched"
    if (url.username || url.password) return "a URL carrying credentials is not fetched"
    const host = url.hostname.replace(/^\[|\]$/g, "")
    // An address typed as such is never looked up, so the lookup below would not see it
    if (isIP(host) && !isPublicAddress(host)) return `${host} is not a public address`
    return undefined
}

type Hop = { body: string } | { location: string }

/** One request, no redirect followed: the caller checks where a redirect goes before it goes there */
const requestOnce = (url: URL, deadline: number, maxBytes: number): Promise<Hop> =>
    new Promise((resolve, reject) => {
        const remaining = Math.max(1, deadline - Date.now())
        const client = url.protocol === "https:" ? https : http
        const request = client.get(
            url,
            {
                // The connection goes to the very address that was checked: a DNS answer changing in between gains nothing
                lookup: publicOnlyLookup as unknown as typeof dnsLookup,
                // A fresh agent: no socket of an earlier request is reused, nor anything sent but these headers
                agent: false,
                timeout: remaining,
                headers: { accept: "application/json, application/yaml, text/yaml, */*;q=0.5", "user-agent": "Flightroom" }
            },
            (response: IncomingMessage) => {
                const status = response.statusCode ?? 0
                if ([301, 302, 303, 307, 308].includes(status)) {
                    response.resume()
                    const location = response.headers.location
                    if (!location) reject(new Error(`answered HTTP ${status} without a Location`))
                    else resolve({ location })
                    return
                }
                if (status < 200 || status >= 300) {
                    response.resume()
                    reject(new Error(`answered HTTP ${status}`))
                    return
                }
                if (Number(response.headers["content-length"]) > maxBytes) {
                    request.destroy(new Error(`is larger than ${maxBytes / 1024 / 1024} MiB`))
                    return
                }
                const chunks: Buffer[] = []
                let size = 0
                response.on("data", (chunk: Buffer) => {
                    size += chunk.length
                    if (size > maxBytes) {
                        request.destroy(new Error(`is larger than ${maxBytes / 1024 / 1024} MiB`))
                        return
                    }
                    chunks.push(chunk)
                })
                response.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8") }))
                response.on("error", reject)
            }
        )
        // `timeout` only fires on an idle socket: a server trickling bytes would never trip it
        const timer = setTimeout(() => request.destroy(new Error("timed out")), remaining)
        request.on("close", () => clearTimeout(timer))
        request.on("timeout", () => request.destroy(new Error("timed out")))
        request.on("error", reject)
    })

/**
 * GETs a document the way a server can afford to on behalf of whoever typed the URL: http or https only,
 * no address that is not public (loopback, private, link local, unique local, CGNAT, the cloud metadata
 * endpoint, IPv4 hidden in IPv6), each redirect checked as the first URL was, a deadline and a size cap
 * for the whole exchange, and no credential of any kind sent along.
 */
export const fetchPublicDocument = async (address: string, limits = API_SPEC_LIMITS): Promise<string> => {
    let url: URL
    try {
        url = new URL(address)
    } catch {
        throw new Error(`"${address}" is not a URL`)
    }
    const deadline = Date.now() + limits.fetchTimeoutMs
    for (let redirects = 0; ; redirects++) {
        const refusal = refusalOf(url)
        if (refusal) throw new Error(`${shownUrl(url)} cannot be fetched: ${refusal}`)
        const hop = await requestOnce(url, deadline, limits.maxFetchedBytes).catch((error: unknown) => {
            throw new Error(`${shownUrl(url)} could not be fetched: ${error instanceof Error ? error.message : String(error)}`)
        })
        if ("body" in hop) return hop.body
        if (redirects >= limits.maxRedirects) throw new Error(`${shownUrl(url)} redirects more than ${limits.maxRedirects} times`)
        url = new URL(hop.location, url)
    }
}

/** A version as YAML reads it unquoted, `openapi: 3.1` a number, or quoted, a string */
const isVersion = (value: unknown) => typeof value === "string" || typeof value === "number"

/**
 * The document as an object: JSON or YAML whose root names its version with `openapi` or `swagger`. The one
 * parser of a pasted document, when it is saved (ensureValidApiSpec) and when read_api_spec reads it: JSON
 * first, as it costs less, then YAML up to {@link API_SPEC_LIMITS.maxYamlBytes}.
 */
export const parseApiDocument = (source: string): ApiDocument => {
    let parsed: unknown
    try {
        parsed = JSON.parse(source)
    } catch {
        if (Buffer.byteLength(source, "utf8") > API_SPEC_LIMITS.maxYamlBytes) {
            throw new Error(`The API document is not JSON, and is larger than the ${API_SPEC_LIMITS.maxYamlBytes / 1024 / 1024} MiB read as YAML`)
        }
        try {
            parsed = parseYaml(source, YAML_OPTIONS)
        } catch {
            throw new Error("The API document is neither JSON nor YAML")
        }
    }
    if (!isObject(parsed) || (!isVersion(parsed.openapi) && !isVersion(parsed.swagger))) {
        throw new Error("The API document is not an OpenAPI or Swagger document: its root has no openapi or swagger version")
    }
    return parsed
}

/** Cut at a byte count, saying so: the agent narrows down rather than reading a truncated answer as whole */
const bounded = (answer: string, note: string) => {
    if (Buffer.byteLength(answer, "utf8") <= API_SPEC_LIMITS.maxAnswerBytes) return answer
    const start = new TextDecoder("utf-8").decode(Buffer.from(answer, "utf8").subarray(0, API_SPEC_LIMITS.maxAnswerBytes), { stream: true })
    return `${start.slice(0, start.lastIndexOf("\n") > 0 ? start.lastIndexOf("\n") : start.length)}\n… truncated at ${API_SPEC_LIMITS.maxAnswerBytes} bytes: ${note}`
}

/** The value a local reference such as `#/components/schemas/Order` points at, undefined when it points nowhere */
const pointerTarget = (document: ApiDocument, ref: string): unknown => {
    if (!ref.startsWith("#/")) return undefined
    let target: unknown = document
    for (const part of ref.slice(2).split("/")) {
        const key = decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")
        if (!isObject(target) && !Array.isArray(target)) return undefined
        target = (target as Record<string, unknown>)[key]
    }
    return target
}

/**
 * A part of the document with its local references replaced by what they point at: a reference inside
 * itself stays a `$ref` marked circular, one too deep or past the budget stays a plain `$ref`.
 */
const expandRefs = (document: ApiDocument, value: unknown) => {
    let nodes = 0
    const expand = (current: unknown, stack: string[]): unknown => {
        nodes++
        if (Array.isArray(current)) return current.map(item => expand(item, stack))
        if (!isObject(current)) return current
        const { $ref, ...siblings } = current
        if (typeof $ref === "string") {
            if (stack.includes($ref)) return { $ref, circular: true }
            const target = pointerTarget(document, $ref)
            if (target === undefined || stack.length >= API_SPEC_LIMITS.maxRefDepth || nodes > API_SPEC_LIMITS.maxExpandedNodes) return current
            const expanded = expand(target, [...stack, $ref])
            return isObject(expanded) && Object.keys(siblings).length ? { ...expanded, ...(expand(siblings, stack) as object) } : expanded
        }
        return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, expand(item, stack)]))
    }
    return expand(value, [])
}

/** The schemes the document defines, by name: OpenAPI 3 keeps them in components, Swagger 2 at its root */
const securitySchemesOf = (document: ApiDocument): Record<string, unknown> => {
    const components = isObject(document.components) ? document.components : {}
    const schemes = isObject(components.securitySchemes) ? components.securitySchemes : isObject(document.securityDefinitions) ? document.securityDefinitions : {}
    return schemes
}

const describeScheme = (name: string, scheme: unknown) => {
    if (!isObject(scheme)) return `- ${name}`
    const details = [
        text(scheme.type),
        scheme.type === "apiKey" ? [text(scheme.in), text(scheme.name)].filter(Boolean).join(" ") : undefined,
        text(scheme.scheme),
        text(scheme.bearerFormat),
        isObject(scheme.flows) ? `flows ${Object.keys(scheme.flows).join(", ")}` : text(scheme.flow)
    ].filter(Boolean)
    return `- ${name}: ${details.join(", ")}`
}

/** The names of the schemes an operation needs: its own requirement, the document's otherwise; none when it is empty */
const authOf = (operation: Record<string, unknown>, document: ApiDocument) => {
    const requirement = Array.isArray(operation.security) ? operation.security : Array.isArray(document.security) ? document.security : undefined
    if (!requirement) return ""
    if (requirement.length === 0) return " [no auth]"
    const names = requirement.map(entry => (isObject(entry) ? Object.keys(entry).join(" + ") || "none" : "")).filter(Boolean)
    return names.length ? ` [auth: ${names.join(" | ")}]` : ""
}

/** The addresses the API answers on, as the document declares them */
const serversOf = (document: ApiDocument): string[] => {
    if (Array.isArray(document.servers)) return document.servers.flatMap(server => (isObject(server) && text(server.url) ? [text(server.url)!] : []))
    const host = text(document.host)
    if (!host) return []
    const schemes = Array.isArray(document.schemes) && document.schemes.length ? document.schemes : ["https"]
    return schemes.map(scheme => `${scheme}://${host}${text(document.basePath) ?? ""}`)
}

const operationsOf = (document: ApiDocument) => {
    const paths = isObject(document.paths) ? document.paths : {}
    return Object.entries(paths).flatMap(([path, item]) =>
        isObject(item) ? HTTP_METHODS.filter(method => isObject(item[method])).map(method => ({ path, method, operation: item[method] as Record<string, unknown> })) : []
    )
}

/** What the API is, its servers and its auth schemes, then one line per operation */
export const describeApiIndex = (document: ApiDocument, source: string): string => {
    const info = isObject(document.info) ? document.info : {}
    const schemes = securitySchemesOf(document)
    const operations = operationsOf(document)
    const listed = operations.slice(0, API_SPEC_LIMITS.maxIndexedOperations)
    const lines = [
        `source: ${source}`,
        `title: ${text(info.title) ?? "(untitled)"}`,
        `version: ${text(info.version) ?? "(none)"}`,
        `${isVersion(document.openapi) ? "openapi" : "swagger"}: ${document.openapi ?? document.swagger}`,
        ...(serversOf(document).length ? ["servers:", ...serversOf(document).map(server => `- ${server}`)] : []),
        ...(Object.keys(schemes).length ? ["security_schemes:", ...Object.entries(schemes).map(([name, scheme]) => describeScheme(name, scheme))] : []),
        `operations (${operations.length}):`,
        ...listed.map(({ path, method, operation }) => {
            const label = text(operation.summary) ?? text(operation.operationId)
            return `${method.toUpperCase()} ${path}${label ? ` — ${label.replace(/\s+/g, " ").slice(0, 200)}` : ""}${operation.deprecated === true ? " (deprecated)" : ""}${authOf(operation, document)}`
        }),
        ...(operations.length > listed.length ? [`… ${operations.length - listed.length} more operations`] : []),
        "Pass path (and method) for the parameters, request body and responses of one operation."
    ]
    return bounded(lines.join("\n"), "pass path (and method) to read one operation")
}

/** One operation, or every operation of a path, with the schemas it references written out */
export const describeApiOperation = (document: ApiDocument, path: string, method?: string): string => {
    const paths = isObject(document.paths) ? document.paths : {}
    const trimmed = (candidate: string) => candidate.replace(/\/+$/, "") || "/"
    const key = Object.hasOwn(paths, path) ? path : Object.keys(paths).find(candidate => trimmed(candidate) === trimmed(path))
    if (key === undefined) {
        const near = Object.keys(paths)
            .filter(candidate => candidate.toLowerCase().includes(trimmed(path).toLowerCase().split("/").filter(Boolean).at(-1) ?? "\0"))
            .slice(0, 10)
        throw new Error(`The API document has no path "${path}"${near.length ? `: maybe ${near.join(", ")}` : ""}. Call read_api_spec without path for the index.`)
    }
    // The whole path item at once: its operations share one budget of expanded nodes
    const item = expandRefs(document, paths[key]) as Record<string, unknown>
    const available = HTTP_METHODS.filter(candidate => isObject(item?.[candidate]))
    const wanted = method?.trim().toLowerCase()
    if (wanted && !available.includes(wanted)) {
        throw new Error(`"${key}" has no ${wanted.toUpperCase()} operation: it has ${available.map(candidate => candidate.toUpperCase()).join(", ") || "none"}`)
    }
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    const operations = (wanted ? [wanted] : available).map(name => {
        const operation = item[name] as Record<string, unknown>
        const parameters = [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
        return {
            method: name.toUpperCase(),
            path: key,
            ...(operation.summary !== undefined && { summary: operation.summary }),
            ...(operation.description !== undefined && { description: operation.description }),
            ...(operation.operationId !== undefined && { operationId: operation.operationId }),
            ...(operation.deprecated === true && { deprecated: true }),
            security: operation.security ?? document.security ?? [],
            ...(parameters.length && { parameters }),
            ...(operation.requestBody !== undefined && { requestBody: operation.requestBody }),
            ...(operation.consumes !== undefined && { consumes: operation.consumes }),
            ...(operation.produces !== undefined && { produces: operation.produces }),
            responses: operation.responses ?? {}
        }
    })
    return bounded(JSON.stringify(operations.length === 1 ? operations[0] : operations, null, 2), "pass method to read one operation of the path")
}

const argument = (input: unknown, key: string): string | undefined => {
    const value = (input as Record<string, unknown> | null)?.[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== "string") throw new Error(`"${key}" must be text`)
    return value.trim() || undefined
}

/** Where a document fetched from its specUrl came from, as the agent is told it */
const sourceOf = (address: string) => {
    try {
        return shownUrl(new URL(address))
    } catch {
        return "its spec_url"
    }
}

/**
 * The documents of one run of the agent, each read once: a pasted one from the database, another from its
 * specUrl. A failed read is not kept, so the agent can try again.
 */
export class ApiSpecReader {
    private readonly documents = new Map<string, Promise<{ document: ApiDocument; source: string }>>()

    constructor(
        private readonly sources: AiChangeApiSpecSource[],
        private readonly fetchDocument: (url: string) => Promise<string> = fetchPublicDocument
    ) {}

    get resources(): string[] {
        return this.sources.map(source => source.resource)
    }

    private load(source: AiChangeApiSpecSource) {
        const cached = this.documents.get(source.resource)
        if (cached) return cached
        const loading = (async () => {
            const pasted = await source.loadPasted?.()
            if (pasted) return { document: parseApiDocument(pasted), source: "pasted in the console" }
            if (source.specUrl) return { document: parseApiDocument(await this.fetchDocument(source.specUrl)), source: sourceOf(source.specUrl) }
            throw new Error(`"${source.resource}" has no API document: none was pasted in the console and it has no spec_url. Say so in the summary.`)
        })()
        this.documents.set(source.resource, loading)
        loading.catch(() => this.documents.delete(source.resource))
        return loading
    }

    /**
     * The answer of read_api_spec, framed as what it is: a document someone else wrote, which the system
     * prompt says is data, never instructions. A closing tag inside it cannot end the frame early.
     */
    async read(input: unknown): Promise<string> {
        const name = argument(input, "resource")
        if (!name) throw new Error('Missing argument "resource"')
        const source = this.sources.find(candidate => candidate.resource === name)
        if (!source) throw new Error(`"${name}" is not an api resource of the services of this job: one of ${this.resources.join(", ")}`)
        const { document, source: origin } = await this.load(source)
        const path = argument(input, "path")
        const answer = path ? describeApiOperation(document, path, argument(input, "method")) : describeApiIndex(document, origin)
        // The name is one of the resources, as the project names them: no quote nor angle bracket
        return `<api_document resource="${source.resource}" untrusted="true">\n${answer.replaceAll("</api_document", "<\\/api_document")}\n</api_document>`
    }
}
