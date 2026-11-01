import { describe, expect, it } from "vitest"
import { inBatches, isTroubled, keptLines, levelOf, mergedLines } from "./argoCdLogSearch"

const lines = (...contents: string[]) => contents.map(content => ({ content }))

describe("levelOf", () => {
    it("given a JSON line, when its level is read, then the level field says it, by name or as pino's number", () => {
        expect(levelOf('{"level":"warn","msg":"slow"}')).toBe("warn")
        expect(levelOf('{"level":50,"msg":"boom"}')).toBe("error")
        expect(levelOf('{"severity":"WARNING","message":"slow"}')).toBe("warn")
    })

    it("given a JSON line without a level, when its level is read, then none is guessed from its message", () => {
        expect(levelOf('{"msg":"error budget fine"}')).toBeUndefined()
    })

    it("given a line of text, when its level is read, then a level word at its start says it, one far in the message does not", () => {
        expect(levelOf("2026-11-02 10:00:00 ERROR Connection refused")).toBe("error")
        expect(levelOf("[info] started on 8080")).toBe("info")
        expect(levelOf(`${"x".repeat(100)} error later in the message`)).toBeUndefined()
    })

    it("given the console of .NET or an access log, when the level is read, then .NET's names are known and a path is not a level", () => {
        expect(levelOf("fail: Orders.Api[0] Unhandled exception")).toBe("error")
        expect(levelOf("dbug: Orders.Api[0] query")).toBe("debug")
        expect(levelOf('{"Level":"x","level":"Information"}')).toBe("info")
        expect(levelOf("10.0.0.1 GET /api/info 200")).toBeUndefined()
    })
})

describe("keptLines", () => {
    it("given a filter and an exclusion, when the lines are kept, then the case of neither matters", () => {
        const kept = keptLines(lines("Scheduler Interrupted", "GET /health 200", "scheduler started", "GET /HEALTH 200"), { filter: "SCHEDULER", exclude: "health" })

        expect(kept.map(line => line.content)).toEqual(["Scheduler Interrupted", "scheduler started"])
    })

    it("given a minimum level, when the lines are kept, then a stack trace follows its error and a line with no level before it is left out", () => {
        const kept = keptLines(lines("no level yet", "INFO ready", '{"level":"error","msg":"boom"}', "    at handler (index.js:1)", "WARN slow", "DEBUG noise"), { minLevel: "warn" })

        expect(kept.map(line => line.content)).toEqual(['{"level":"error","msg":"boom"}', "    at handler (index.js:1)", "WARN slow"])
    })
})

describe("mergedLines", () => {
    it("given lines of several pods, when they are merged, then they come oldest first with where they come from, a line without a time after the one before it", () => {
        const merged = mergedLines(
            [
                { environment: "dev", pod: "orders-1", previous: false, lines: [{ content: "b", timestamp: "2026-11-02T10:00:02Z" }, { content: "b2" }] },
                { environment: "uat", pod: "cart-1", previous: true, lines: [{ content: "a", timestamp: "2026-11-02T10:00:01Z" }] }
            ],
            10
        )

        expect(merged).toEqual({ lines: ["2026-11-02T10:00:01Z uat/cart-1 (previous) a", "2026-11-02T10:00:02Z dev/orders-1 b", "- dev/orders-1 b2"], matched: 3 })
    })

    it("given more lines than asked for, when they are merged, then the newest are kept", () => {
        const stream = { environment: "dev", pod: "orders-1", previous: false, lines: ["1", "2", "3"].map(second => ({ content: second, timestamp: `2026-11-02T10:00:0${second}Z` })) }

        expect(mergedLines([stream], 2)).toEqual({ lines: ["2026-11-02T10:00:02Z dev/orders-1 2", "2026-11-02T10:00:03Z dev/orders-1 3"], matched: 3 })
    })
})

describe("isTroubled", () => {
    it("given pods, when they are judged, then one that restarted or has a container not ready is troubled", () => {
        expect(isTroubled({ name: "a", namespace: "dev", containers: "1/1", restarts: 0 })).toBe(false)
        expect(isTroubled({ name: "b", namespace: "dev", containers: "0/1" })).toBe(true)
        expect(isTroubled({ name: "c", namespace: "dev", containers: "1/1", restarts: 2 })).toBe(true)
    })
})

describe("inBatches", () => {
    it("given more items than a batch, when they are run, then never more than a batch at once and in their order", async () => {
        let running = 0
        let most = 0
        const results = await inBatches([1, 2, 3, 4, 5], 2, async item => {
            running++
            most = Math.max(most, running)
            await new Promise(resolve => setTimeout(resolve, 1))
            running--
            return item * 10
        })

        expect(results).toEqual([10, 20, 30, 40, 50])
        expect(most).toBe(2)
    })
})
