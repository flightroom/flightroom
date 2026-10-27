import { describe, expect, it } from "vitest"
import { ArgoCdApplicationStatus } from "../../client/ArgoCdClient"
import { rolloutStateOf } from "./rollout"

const DEPLOYED = "a1b2c3d"
const BEFORE = "9f8e7d6"
const deployed = new Set([DEPLOYED])

const stateOf = (status: ArgoCdApplicationStatus, revisions = deployed) => rolloutStateOf({ metadata: { name: "shop-orders-development" }, status }, revisions).state

/** Synced to the commit of the deploy and healthy */
const synced = (overrides: ArgoCdApplicationStatus = {}): ArgoCdApplicationStatus => ({
    sync: { status: "Synced", revision: DEPLOYED },
    health: { status: "Healthy" },
    ...overrides
})

describe("rolloutStateOf", () => {
    it("given no Application yet, when its state is read, then it is waiting", () => {
        expect(rolloutStateOf(undefined, deployed).state).toBe("waiting")
    })

    /** Argo CD may compare a branch at the revision it resolved before the commit: synced and healthy on it says nothing of the deploy */
    it("given an Application synced and healthy on the revision before the deploy, when its state is read, then it is waiting", () => {
        expect(stateOf(synced({ sync: { status: "Synced", revision: BEFORE } }))).toBe("waiting")
    })

    it("given an Application synced on a commit pushed after the deploy, when its state is read, then the deploy counts as applied", () => {
        expect(stateOf(synced({ sync: { status: "Synced", revision: "later01" } }), new Set([DEPLOYED, "later01"]))).toBe("healthy")
    })

    it("given an Application out of sync on the deploy, or with a sync running, when its state is read, then it is syncing", () => {
        expect(stateOf(synced({ sync: { status: "OutOfSync", revision: DEPLOYED } }))).toBe("syncing")
        expect(stateOf(synced({ sync: { status: "Synced", revision: BEFORE }, operationState: { phase: "Running", operation: { sync: { revision: DEPLOYED } } } }))).toBe("syncing")
    })

    it("given the deploy applied while the pods are replaced, when its state is read, then it is progressing", () => {
        expect(stateOf(synced({ health: { status: "Progressing", message: "Waiting for rollout to finish" } }))).toBe("progressing")
    })

    it("given the deploy applied and running, when its state is read, then it is healthy", () => {
        expect(stateOf(synced())).toBe("healthy")
    })

    it("given the deploy applied and broken, when its state is read, then it is degraded with Argo CD's message", () => {
        const state = rolloutStateOf({ metadata: { name: "a" }, status: synced({ health: { status: "Degraded", message: "Deployment exceeded its progress deadline" } }) }, deployed)

        expect(state).toMatchObject({ state: "degraded", message: "Deployment exceeded its progress deadline" })
    })

    it("given a sync of the deploy's commit that failed, when its state is read, then it is failed", () => {
        const failed = { phase: "Failed", message: "one or more objects failed to apply", syncResult: { revision: DEPLOYED } }

        expect(stateOf(synced({ sync: { status: "OutOfSync", revision: DEPLOYED }, operationState: failed }))).toBe("failed")
    })

    it("given a sync of an earlier commit that failed, when its state is read, then it is not taken for the deploy's", () => {
        expect(stateOf({ sync: { status: "OutOfSync", revision: BEFORE }, operationState: { phase: "Failed", syncResult: { revision: BEFORE } } })).toBe("waiting")
    })

    it("given a deploy that pushed nothing for the environment, when its state is read, then the health of now is what counts", () => {
        expect(stateOf(synced({ sync: { status: "Synced", revision: BEFORE } }), new Set())).toBe("healthy")
    })
})
