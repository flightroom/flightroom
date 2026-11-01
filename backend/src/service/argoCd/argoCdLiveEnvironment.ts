import { parse } from "yaml"
import { ContainerVariable, withOverrides } from "../gitops/applicationManifests"

/** The suffix of the Secret of a resource: its variables are told apart from a secret map's */
export const RESOURCE_SECRET_SUFFIX = ".resource"

interface LiveEnvFrom {
    prefix?: string
    configMapRef?: { name?: string }
    secretRef?: { name?: string }
}

export interface LiveContainer {
    name?: string
    env?: Array<{ name?: string; value?: string; valueFrom?: unknown }>
    envFrom?: LiveEnvFrom[]
}

export interface LivePod {
    spec?: { containers?: LiveContainer[] }
    status?: { containerStatuses?: Array<{ name?: string; state?: { running?: { startedAt?: string } } }> }
}

/**
 * The variables of the running container of a backend or a DOCKER frontend in one environment:
 * - `running`: read from `pod`, whose container started at `startedAt`. Its `env` is what it got; the values of its
 *   ConfigMaps are those the cluster holds now, which it got at its start unless they changed since
 * - `no_pod`: the environment runs no pod of it
 */
export interface RunningContainerEnvironmentDTO {
    state: "running" | "no_pod"
    pod?: string
    startedAt?: string
    variables: ContainerVariable[]
    /** The sources that could not be read, and why */
    notes?: string[]
}

/** When the container last started, while it runs */
export const liveStartedAt = (pod: LivePod, container: LiveContainer): string | undefined => pod.status?.containerStatuses?.find(status => status.name === container.name)?.state?.running?.startedAt

/** A ConfigMap or Secret an `envFrom` names */
export interface LiveSource {
    kind: "ConfigMap" | "Secret"
    name: string
}

/** The container of a live pod that runs `slug`: the one named after it, else the first */
export const liveContainerOf = (pod: LivePod, slug: string): LiveContainer | undefined => {
    const containers = pod.spec?.containers ?? []
    return containers.find(container => container.name === slug) ?? containers[0]
}

/** The ConfigMaps and Secrets the container takes its `envFrom` from, in its order */
export const liveSourcesOf = (container: LiveContainer): LiveSource[] =>
    (container.envFrom ?? []).flatMap((from): LiveSource[] => {
        if (from.configMapRef?.name) return [{ kind: "ConfigMap", name: from.configMapRef.name }]
        if (from.secretRef?.name) return [{ kind: "Secret", name: from.secretRef.name }]
        return []
    })

const sourceLabel = (source: LiveSource) => (source.kind === "ConfigMap" ? `configMap ${source.name}` : `${source.name.endsWith(RESOURCE_SECRET_SUFFIX) ? "resource" : "secret"} ${source.name}`)

/**
 * The variables a running container got, from its live pod: `env` as the platform wrote it, each value in clear
 * unless Kubernetes takes it from a Secret or a field, then each `envFrom` source with the keys its live object holds,
 * a ConfigMap's value in clear and a Secret's masked, unless `revealed` holds it. `data` holds what each source holds
 * by `kind/name`; a source missing from it could not be read and gives no variable.
 */
export const liveContainerVariables = (container: LiveContainer, data: Map<string, Record<string, string> | null>, revealed: Map<string, Record<string, string>> = new Map()): ContainerVariable[] =>
    withOverrides([
        ...(container.env ?? []).flatMap(variable =>
            variable.name ? [{ name: variable.name, source: "platform", ...(variable.valueFrom ? { masked: { set: true as const } } : { value: variable.value ?? "" }), fromEnv: true }] : []
        ),
        ...(container.envFrom ?? []).flatMap(from => {
            const [source] = liveSourcesOf({ envFrom: [from] })
            const held = source ? data.get(`${source.kind}/${source.name}`) : undefined
            if (!source || !held) return []
            // A ConfigMap's value is the live one; a Secret's is masked by Argo CD, so only `revealed` may give it
            const clear = source.kind === "ConfigMap" ? held : (revealed.get(`${source.kind}/${source.name}`) ?? {})
            return Object.keys(held).map(key => ({
                name: `${from.prefix ?? ""}${key}`,
                source: sourceLabel(source),
                ...(clear[key] !== undefined ? { value: clear[key] } : { masked: { set: true as const } }),
                fromEnv: false
            }))
        })
    ])

/** What a live ConfigMap or Secret holds, by key: a Secret's values are hidden by Argo CD and never used */
export const liveData = (manifest: unknown): Record<string, string> => {
    const object = (manifest ?? {}) as { data?: Record<string, string>; binaryData?: Record<string, string> }
    return { ...(object.binaryData ?? {}), ...(object.data ?? {}) }
}

/** What a Secret manifest committed by the deploy holds, by key, decoded: `data` is base64, `stringData` in clear and wins */
export const committedSecretData = (raw: string): Record<string, string> => {
    const object = (parse(raw) ?? {}) as { data?: Record<string, string> | null; stringData?: Record<string, string> | null }
    const decoded = Object.fromEntries(Object.entries(object.data ?? {}).map(([key, value]) => [key, Buffer.from(String(value), "base64").toString("utf8")]))
    return { ...decoded, ...(object.stringData ?? {}) }
}
