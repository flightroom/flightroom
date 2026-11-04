import { Schema } from "mongoose"
import { describe, expect, it } from "vitest"
import Frontend, { CanaryType } from "./FrontendModel"

const canaryTypePath = () => (Frontend.schema.path("canary") as unknown as { schema: Schema }).schema.path("type")

describe("canary type", () => {
    it("stores exactly the three strategies", () => {
        expect(Object.values(CanaryType)).toEqual(["RANDOM", "ON_SESSION", "ON_USER"])
    })

    /**
     * Nothing else may be accepted: a value no strategy answers to would let that frontend quietly serve
     * the stable version to everybody.
     */
    it("accepts no other value", () => {
        expect(canaryTypePath().options.enum).toEqual([CanaryType.RANDOM, CanaryType.ON_SESSION, CanaryType.ON_USER])
    })

    it("defaults to the sticky strategy", () => {
        expect(canaryTypePath().options.default).toBe(CanaryType.ON_SESSION)
    })
})

describe("design system", () => {
    it("Given a frontend, then it has no design system of its own: it builds with the project's", () => {
        expect(Frontend.schema.path("designSystem")).toBeUndefined()
    })
})
