import useApiClient from "../useApiClient"

/** The container whose variables are read: a backend, or a DOCKER frontend */
export type ContainerKind = "backend" | "frontend"

export interface ContainerVariable {
    name: string
    /** `platform`, or the source it comes from: `configMap logging`, `secret database`, `resource orders-db.resource` */
    source: string
    /** In clear for the platform's variables and a config map's */
    value?: string
    /** A secret's or a resource's: only that it is set */
    masked?: { set: true; length?: number }
    /** The source whose value the container gets instead */
    overriddenBy?: string
}

/**
 * The variables of the running container, read from its live pod:
 * - `running`: those of `pod`, whose container started at `startedAt`
 * - `no_pod`: the environment runs no pod of it
 */
export interface RunningContainerEnvironment {
    state: "running" | "no_pod"
    pod?: string
    startedAt?: string
    variables: ContainerVariable[]
    /** The sources that could not be read, and why */
    notes?: string[]
}

const useContainerEnvironmentApi = () => {
    const apiClient = useApiClient()

    /** With `reveal`, for an owner or a member of the project, the values of its Secrets in clear */
    const get = async (kind: ContainerKind, id: string, environmentId: string, reveal = false): Promise<RunningContainerEnvironment> => {
        const response = await apiClient.doRequest<RunningContainerEnvironment>({ url: `/api/${kind}s/${id}/environments/${environmentId}/variables`, params: reveal ? { reveal: "true" } : undefined })
        return response.data
    }

    return { get }
}

export default useContainerEnvironmentApi
