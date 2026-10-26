import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { flightroomApiUrl } from "../src/flightroomApi.js"

describe("flightroomApiUrl", () => {
    it("adds the API path and normalizes an existing /api suffix", () => {
        assert.equal(
            flightroomApiUrl("https://console.flightroom.dev/api/", "backends/by-slug/orders-api/versions/1.2.0"),
            "https://console.flightroom.dev/api/backends/by-slug/orders-api/versions/1.2.0"
        )
    })

    it("keeps an application base path", () => {
        assert.equal(flightroomApiUrl("https://example.com/flightroom", "frontends/by-slug/cart/versions/v1"), "https://example.com/flightroom/api/frontends/by-slug/cart/versions/v1")
    })

    it("rejects URLs that could leak credentials or use an unsafe protocol", () => {
        assert.throws(() => flightroomApiUrl("file:///tmp", "backends"), /HTTP\(S\)/)
        assert.throws(() => flightroomApiUrl("https://user:pass@example.com", "backends"), /HTTP\(S\)/)
    })
})
