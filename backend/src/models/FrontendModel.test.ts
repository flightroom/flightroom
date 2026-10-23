import { Schema, Types } from "mongoose"
import { describe, expect, it } from "vitest"
import Frontend, { CanaryType } from "./FrontendModel"
import Project from "./ProjectModel"

const canaryTypePath = () => (Frontend.schema.path("canary") as unknown as { schema: Schema }).schema.path("type")

describe("canary type", () => {
    it("stores exactly the three strategies", () => {
        expect(Object.values(CanaryType)).toEqual(["RANDOM", "ON_SESSION", "ON_USER"])
    })

    /**
     * The values written by the previous model — ON_SESSIONS and COOKIE_BASED — are rewritten to
     * ON_SESSION by migrateLegacyCanaryTypes at boot, so nothing may accept them any more: leaving one
     * in the enum would let a document keep a value no strategy answers to, and that frontend
     * would quietly serve the stable version to everybody.
     */
    it("no longer accepts the values written by the previous model", () => {
        expect(canaryTypePath().options.enum).toEqual([CanaryType.RANDOM, CanaryType.ON_SESSION, CanaryType.ON_USER])
    })

    it("defaults to the sticky strategy", () => {
        expect(canaryTypePath().options.default).toBe(CanaryType.ON_SESSION)
    })
})

describe("design system", () => {
    const aFrontend = (designSystem: Record<string, unknown>) =>
        new Frontend({ slug: "catalog", name: "Catalog", version: "1.0.0", host: { type: "CUSTOM_URL" }, projectId: new Types.ObjectId(), designSystem })

    it("Given one with its package, then it is stored trimmed, without an _id of its own", async () => {
        const frontend = aFrontend({ packageName: " @acme/ui ", npmrc: "@acme:registry=https://npm.acme.dev/" })

        await expect(frontend.validate()).resolves.toBeUndefined()
        expect(frontend.toObject().designSystem).toEqual({ packageName: "@acme/ui", npmrc: "@acme:registry=https://npm.acme.dev/" })
    })

    it("Given one without its package, then it is refused", async () => {
        await expect(aFrontend({ notes: "Use its tokens." }).validate()).rejects.toMatchObject({ errors: { "designSystem.packageName": expect.anything() } })
    })

    it("Given the project, then it shares the very same schema as its default", () => {
        expect(Project.schema.path("designSystem").schema).toBe(Frontend.schema.path("designSystem").schema)
    })
})
