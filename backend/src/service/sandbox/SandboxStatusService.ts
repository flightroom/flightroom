import BaseAuthorizedService from "../BaseAuthorizedService"
import { OpenShellConfiguration, openShellSandboxes } from "./OpenShellSandboxes"

/** The gateway answers healthy, answers degraded, does not answer or answers unhealthy, or is not configured at all. */
export type SandboxStatus = "online" | "degraded" | "offline" | "notConfigured"

export interface SandboxStatusSummary {
    status: SandboxStatus
    /** What the gateway reports, when it answers */
    version?: string
    checkedAt: Date
}

/** A gateway slower than this is as good as down for the agent waiting on it */
export const HEALTH_TIMEOUT_MS = 5_000
/** Every member opening the tab asks: the gateway is asked at most this often by a replica */
const CACHE_MS = 30_000

type Probe = () => Promise<{ status: string; version: string }>

/** Asks the gateway once, within the timeout: whatever goes wrong, it is offline and `onError` hears why. */
export const probeGateway = async (probe: Probe, onError?: (error: unknown) => void, timeoutMs = HEALTH_TIMEOUT_MS): Promise<SandboxStatusSummary> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The OpenShell gateway did not answer within ${timeoutMs} ms`)), timeoutMs)
    })
    try {
        const health = await Promise.race([probe(), timeout])
        // An answer without a status still came from a gateway that is up
        const status: SandboxStatus = health.status === "degraded" ? "degraded" : health.status === "unhealthy" ? "offline" : "online"
        return { status, version: health.version || undefined, checkedAt: new Date() }
    } catch (error) {
        onError?.(error)
        return { status: "offline", checkedAt: new Date() }
    } finally {
        clearTimeout(timer)
    }
}

let cached: { at: number; summary: Promise<SandboxStatusSummary> } | undefined

/** The status of the gateway of this installation, the same for every organization: it is one per console. */
export const sandboxGatewayStatus = (config: OpenShellConfiguration, onError?: (error: unknown) => void, now = Date.now()): Promise<SandboxStatusSummary> => {
    const sandboxes = openShellSandboxes(config)
    if (!sandboxes) return Promise.resolve({ status: "notConfigured", checkedAt: new Date(now) })
    // The promise is kept, not the result: members opening the tab together share one call
    if (!cached || now - cached.at >= CACHE_MS) cached = { at: now, summary: probeGateway(() => sandboxes.health(), onError) }
    return cached.summary
}

/** Whether the coding agent's sandboxes can run: for every member of the organization, who sees Edit with AI fail otherwise. */
export default class SandboxStatusService extends BaseAuthorizedService {
    async forOrganization(organizationId: string, config: OpenShellConfiguration, onError?: (error: unknown) => void): Promise<SandboxStatusSummary> {
        await this.ensureAccessToOrganization(organizationId)
        return sandboxGatewayStatus(config, onError)
    }
}
