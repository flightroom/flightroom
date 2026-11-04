import { beforeEach, describe, expect, it } from "vitest"
import { resetExternalCalls, takeExternalCall } from "./externalCallLimiter"

describe("takeExternalCall", () => {
    beforeEach(() => {
        resetExternalCalls()
    })

    it("given ten calls of one principal in a minute, when an eleventh comes, then it is refused", () => {
        for (let call = 0; call < 10; call++) takeExternalCall("user-1", 1000 + call)

        expect(() => takeExternalCall("user-1", 2000)).toThrow(expect.objectContaining({ code: "EXTERNAL_CALLS_RATE_LIMITED", statusCode: 429 }))
    })

    it("given another principal, when it calls, then the count of the first does not stand in its way", () => {
        for (let call = 0; call < 10; call++) takeExternalCall("user-1", 1000)

        expect(() => takeExternalCall("user-2", 1000)).not.toThrow()
    })

    it("given a minute gone by, when the principal calls again, then the old calls no longer count", () => {
        for (let call = 0; call < 10; call++) takeExternalCall("user-1", 1000)

        expect(() => takeExternalCall("user-1", 61_001)).not.toThrow()
    })
})
