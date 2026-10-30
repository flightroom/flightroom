import { ArgoCdLogsQuery } from "../../client/ArgoCdClient"
import { createBusinessException } from "../../errors/BusinessException"
import { ArgoCdLogsInput } from "./argoCdTypes"

const DEFAULT_LOG_LINES = 500
const MAX_LOG_LINES = 5000
/** A week: the kubelet rotates the logs well before */
const MAX_LOG_SECONDS = 7 * 24 * 60 * 60
const MAX_FILTER_LENGTH = 200

/** The characters of the name of a pod, a DNS subdomain: Argo CD checks the pod is one of the Application */
const POD_NAME = /^[a-z0-9][-a-z0-9.]{0,252}$/

/** A whole number within the bounds, clamped to them; undefined when none is given */
const boundedInteger = (value: unknown, min: number, max: number): number | undefined => {
    const number = Math.trunc(Number(value))
    if (value === undefined || value === "" || !Number.isFinite(number)) return undefined
    return Math.min(Math.max(number, min), max)
}

/** The pod the logs are asked of, refused before anything is read when it cannot be the name of one */
export const podOf = (query: ArgoCdLogsInput): string => {
    const pod = String(query.pod ?? "")
    if (!POD_NAME.test(pod)) throw createBusinessException({ code: "ARGOCD_LOGS_INVALID", message: "Choose the pod to read the logs of" })
    return pod
}

/** What Argo CD is asked for of the logs of `pod`, the query string clamped to what is read at most */
export const podLogsQuery = (query: ArgoCdLogsInput, pod: string, namespace: string): ArgoCdLogsQuery => {
    const filter = String(query.filter ?? "").trim()
    return {
        namespace,
        podName: pod,
        tailLines: boundedInteger(query.tailLines, 1, MAX_LOG_LINES) ?? DEFAULT_LOG_LINES,
        sinceSeconds: boundedInteger(query.sinceSeconds, 1, MAX_LOG_SECONDS),
        previous: query.previous === true || query.previous === "true",
        ...(filter ? { filter: filter.slice(0, MAX_FILTER_LENGTH) } : {})
    }
}
