import { describe, expect, it } from "vitest"
import { liveContainerOf, liveContainerVariables, liveData, liveSourcesOf, liveStartedAt } from "./argoCdLiveEnvironment"

const container = {
    name: "orders",
    env: [
        { name: "LOG_LEVEL", value: "info" },
        { name: "PUBLIC_URL", value: "https://dev.example.com/orders" },
        { name: "TOKEN", valueFrom: { secretKeyRef: { name: "orders-db", key: "TOKEN" } } }
    ],
    envFrom: [{ configMapRef: { name: "orders-config" } }, { secretRef: { name: "orders-db" } }, { secretRef: { name: "cache.resource" } }, { prefix: "X_", configMapRef: { name: "extra" } }]
}

describe("liveContainerVariables", () => {
    it("given a running container, when its variables are read, then env comes in clear, a ConfigMap's too, a Secret's masked, and what Kubernetes drops is marked", () => {
        const data = new Map<string, Record<string, string> | null>([
            ["ConfigMap/orders-config", { LOG_LEVEL: "warn", SHOWN: "yes" }],
            ["Secret/orders-db", { DB_PASSWORD: "++++++++" }],
            ["Secret/cache.resource", { REDIS_HOST: "++++++++", SHOWN: "++++++++" }],
            ["ConfigMap/extra", { FLAG: "on" }]
        ])

        expect(liveContainerVariables(container, data)).toEqual([
            { name: "LOG_LEVEL", source: "platform", value: "info" },
            { name: "PUBLIC_URL", source: "platform", value: "https://dev.example.com/orders" },
            { name: "TOKEN", source: "platform", masked: { set: true } },
            { name: "LOG_LEVEL", source: "configMap orders-config", value: "warn", overriddenBy: "platform" },
            { name: "SHOWN", source: "configMap orders-config", value: "yes", overriddenBy: "resource cache.resource" },
            { name: "DB_PASSWORD", source: "secret orders-db", masked: { set: true } },
            { name: "REDIS_HOST", source: "resource cache.resource", masked: { set: true } },
            { name: "SHOWN", source: "resource cache.resource", masked: { set: true } },
            { name: "X_FLAG", source: "configMap extra", value: "on" }
        ])
    })

    it("given a source that could not be read, when the variables are read, then it gives none", () => {
        expect(liveContainerVariables({ envFrom: [{ configMapRef: { name: "gone" } }] }, new Map())).toEqual([])
    })
})

describe("live pod", () => {
    const pod = {
        spec: { containers: [{ name: "istio-proxy" }, { name: "orders" }] },
        status: { containerStatuses: [{ name: "orders", state: { running: { startedAt: "2026-11-01T10:00:00Z" } } }] }
    }

    it("given a pod of several containers, when the one of the slug is looked for, then it is the one named after it, else the first", () => {
        expect(liveContainerOf(pod, "orders")?.name).toBe("orders")
        expect(liveContainerOf(pod, "other")?.name).toBe("istio-proxy")
        expect(liveContainerOf({}, "orders")).toBeUndefined()
    })

    it("given a running container, when its start is read, then it is the one of its status", () => {
        expect(liveStartedAt(pod, { name: "orders" })).toBe("2026-11-01T10:00:00Z")
        expect(liveStartedAt(pod, { name: "istio-proxy" })).toBeUndefined()
    })

    it("given envFrom and live objects, when they are read, then the sources keep their order and the data merges binaryData under data", () => {
        expect(liveSourcesOf(container)).toEqual([
            { kind: "ConfigMap", name: "orders-config" },
            { kind: "Secret", name: "orders-db" },
            { kind: "Secret", name: "cache.resource" },
            { kind: "ConfigMap", name: "extra" }
        ])
        expect(liveData({ data: { A: "1" }, binaryData: { B: "Ag==" } })).toEqual({ B: "Ag==", A: "1" })
        expect(liveData(null)).toEqual({})
    })
})
