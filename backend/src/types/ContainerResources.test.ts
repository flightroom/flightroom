import { describe, expect, it } from "vitest"
import { parseCpu, parseMemory, requestAboveLimit } from "./ContainerResources"

describe("parseCpu", () => {
    it.each([
        ["250m", 250],
        ["0.5", 500],
        ["1", 1000],
        ["1.25", 1250]
    ])("given %s, when it is parsed, then it is %d millicores", (value, millicores) => {
        expect(parseCpu(value)).toBe(millicores)
    })

    it.each(["", "0", "0m", "-1", "1.5m", "0.0001", "250Mi", "1 core", " 1"])("given %j, when it is parsed, then it is no CPU quantity", value => {
        expect(parseCpu(value)).toBeUndefined()
    })
})

describe("parseMemory", () => {
    it.each([
        ["128Mi", 128 * 2 ** 20],
        ["1Gi", 2 ** 30],
        ["512M", 512e6],
        ["1000000", 1e6],
        ["1.5Gi", 1.5 * 2 ** 30]
    ])("given %s, when it is parsed, then it is %d bytes", (value, bytes) => {
        expect(parseMemory(value)).toBe(bytes)
    })

    it.each(["", "0Mi", "128mb", "1GB", "-1Gi", "Mi"])("given %j, when it is parsed, then it is no memory quantity", value => {
        expect(parseMemory(value)).toBeUndefined()
    })
})

describe("requestAboveLimit", () => {
    it.each([
        ["none set", {}],
        ["requests equal to their limits", { cpuRequest: "1", cpuLimit: "1000m", memoryRequest: "1Gi", memoryLimit: "1024Mi" }],
        ["a request within the default limit of the chart", { cpuRequest: "500m", memoryRequest: "512Mi" }],
        ["a value that is no quantity, left to the field", { cpuRequest: "lots" }]
    ])("given %s, when it is checked, then nothing is above its limit", (_case, resources) => {
        expect(requestAboveLimit(resources)).toBeUndefined()
    })

    it.each([
        ["a CPU request above its limit", { cpuRequest: "2", cpuLimit: "1" }, "cpu"],
        ["a CPU request above the default limit of the chart", { cpuRequest: "1" }, "cpu"],
        ["a memory limit below the default request of the chart", { memoryLimit: "64Mi" }, "memory"],
        ["a memory request above its limit, in other units", { memoryRequest: "1G", memoryLimit: "900Mi" }, "memory"]
    ])("given %s, when it is checked, then it is refused for %s", (_case, resources, resource) => {
        expect(requestAboveLimit(resources)).toBe(resource)
    })
})
