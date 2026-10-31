import { describe, expect, it } from "vitest"
import { effectiveProbes } from "./Probes"

describe("effectiveProbes", () => {
    it("given a container that sets nothing and a project without a template, when its probes are resolved, then they are the platform's paths and no timing", () => {
        expect(effectiveProbes({})).toEqual({ livenessPath: "/health/live", readinessPath: "/health/ready" })
    })

    it("given a template of the project, when the probes of a container that sets some are resolved, then each field is its own, else the template's", () => {
        const template = { livenessPath: "/healthz", readinessPath: "/readyz", livenessInitialDelaySeconds: 60, livenessPeriodSeconds: 10 }

        expect(effectiveProbes({ readinessPath: "/ready", livenessInitialDelaySeconds: 0, livenessPeriodSeconds: null, readinessPeriodSeconds: 5 }, template)).toEqual({
            livenessPath: "/healthz",
            readinessPath: "/ready",
            livenessInitialDelaySeconds: 0,
            livenessPeriodSeconds: 10,
            readinessPeriodSeconds: 5
        })
    })

    it("given blank or null paths on the container, when its probes are resolved, then they inherit", () => {
        expect(effectiveProbes({ livenessPath: "", readinessPath: null }, { readinessPath: "/readyz" })).toEqual({ livenessPath: "/health/live", readinessPath: "/readyz" })
    })
})
