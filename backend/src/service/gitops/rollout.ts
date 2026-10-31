import { ArgoCdPod, ArgoCdResource } from "../../client/ArgoCdClient"

/**
 * Where an application stands after a deploy, as Argo CD tells it:
 * - waiting: Argo CD has not read the commit of the deploy yet, its Application may not even exist yet
 * - syncing: Argo CD is applying the commit to the cluster
 * - progressing: applied, Kubernetes is replacing the pods
 * - healthy: the pods of what was deployed run and are ready
 * - degraded: what runs is broken, a crash or a rollout past its deadline
 * - failed: Argo CD could not apply the commit
 */
export type RolloutState = "waiting" | "syncing" | "progressing" | "healthy" | "degraded" | "failed"

/** A backend or a container frontend the deploy shipped, and where its rollout stands */
export interface RolloutApplication {
    _id: string
    kind: "frontend" | "backend"
    name: string
    slug: string
    /** The deploy changed its version or its image: the others are only applied again */
    updated?: boolean
    state: RolloutState
    /** As Argo CD has them, for whoever wants the detail */
    health?: string
    sync?: string
    /** Why it is not healthy yet, in Argo CD's words */
    message?: string
    /** Only while the pods are being replaced, or are broken: those of a healthy application are not read */
    pods?: ArgoCdPod[]
}

export interface RolloutDTO {
    /** The project deploys through Argo CD: without it there is nothing to follow, the deploy is over with its commit */
    tracked: boolean
    applications: RolloutApplication[]
    /** Every application the deploy updated runs what was deployed, every application when it updated none */
    done: boolean
    /** Argo CD could not apply the commit for at least one of those applications */
    failed: boolean
}

const STARTED = new Set(["Running", "Terminating"])
const FAILED = new Set(["Failed", "Error"])

/**
 * The state of the Application of an application after a deploy. `revisions` are the commits on the branch of the
 * environment that hold the deploy: the one it pushed, and those pushed after it, which contain it as a push is never
 * forced. Until Argo CD is synced to one of them, what it says is of the version before, whatever its clock. Without
 * any, the deploy changed nothing Argo CD reads for the environment, and the health of now is what counts.
 */
export const rolloutStateOf = (application: ArgoCdResource | undefined, revisions: Set<string>): Pick<RolloutApplication, "state" | "health" | "sync" | "message"> => {
    const status = application?.status
    if (!status) return { state: "waiting" }
    const facts = { health: status.health?.status, sync: status.sync?.status }
    const operation = status.operationState
    const operationRevision = operation?.syncResult?.revision ?? operation?.operation?.sync?.revision
    if (operation?.phase && FAILED.has(operation.phase) && operationRevision && revisions.has(operationRevision)) return { ...facts, state: "failed", message: operation.message }
    if (operation?.phase && STARTED.has(operation.phase)) return { ...facts, state: "syncing", message: operation.message }
    if (revisions.size > 0 && !revisions.has(status.sync?.revision ?? "")) return { ...facts, state: "waiting" }
    if (facts.sync !== "Synced") return { ...facts, state: "syncing" }
    if (facts.health === "Healthy") return { ...facts, state: "healthy" }
    if (facts.health === "Degraded") return { ...facts, state: "degraded", message: status.health?.message }
    return { ...facts, state: "progressing", message: status.health?.message }
}
