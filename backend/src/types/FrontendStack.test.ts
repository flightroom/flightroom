import { describe, expect, it } from "vitest"
import { FrontendCompiler, isIntegrationModel, parseCompiler, supportsModuleFederation } from "./FrontendStack"

describe("parseCompiler", () => {
    it.each(["single-spa", "Single-SPA", "SINGLE_SPA", "singlespa", " single-spa "])("given %j, when it is parsed, then it is SINGLE_SPA", value => {
        expect(parseCompiler(value)).toBe(FrontendCompiler.SINGLE_SPA)
    })

    it.each(["micro-lc", "Micro-LC", "MICRO_LC", "microlc"])("given %j, when it is parsed, then it is MICRO_LC", value => {
        expect(parseCompiler(value)).toBe(FrontendCompiler.MICRO_LC)
    })

    it.each([
        ["vite", FrontendCompiler.VITE],
        ["Webpack", FrontendCompiler.WEBPACK],
        ["webcomponent", FrontendCompiler.WEBCOMPONENT],
        ["web-component", FrontendCompiler.WEBCOMPONENT],
        ["WEBCOMPONENT", FrontendCompiler.WEBCOMPONENT]
    ])("given %j, when it is parsed, then the existing values keep their meaning", (value, compiler) => {
        expect(parseCompiler(value)).toBe(compiler)
    })

    it("given an unknown value, when it is parsed, then it is undefined", () => {
        expect(parseCompiler("rspack")).toBeUndefined()
        expect(parseCompiler(undefined)).toBeUndefined()
    })
})

describe("integration models", () => {
    it("given single-spa and micro-lc, then they are integration models and never module federation", () => {
        for (const compiler of [FrontendCompiler.SINGLE_SPA, FrontendCompiler.MICRO_LC]) {
            expect(isIntegrationModel(compiler)).toBe(true)
            expect(supportsModuleFederation(compiler)).toBe(false)
        }
        expect(isIntegrationModel(FrontendCompiler.VITE)).toBe(false)
        expect(isIntegrationModel(FrontendCompiler.WEBCOMPONENT)).toBe(false)
    })
})
