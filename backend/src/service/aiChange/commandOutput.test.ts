import { describe, expect, it } from "vitest"
import { maskedEnd } from "./commandOutput"

describe("maskedEnd", () => {
    it("Given colours and a progress bar drawn again in place, then only the text and the last frame are kept", () => {
        const output = "\x1b[32mresolving\x1b[0m\r\nProgress: 1\rProgress: 2\rProgress: 3\ndone\n"

        expect(maskedEnd(output, 1_000)).toEqual({ text: "resolving\nProgress: 3\ndone", cut: false })
    })

    it("Given more output than is kept, when a secret starts before the cut, then it is masked whole and the cut line left out", () => {
        const output = `NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789\n${"added 1 package\n".repeat(10)}`
        const { text, cut } = maskedEnd(output, 100)

        expect(cut).toBe(true)
        expect(text.startsWith("added 1 package\n")).toBe(true)
        expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz")
    })

    it("Given output already cut where it was read, then its first line is left out even when it fits", () => {
        expect(maskedEnd("-----END\nadded 1 package\n", 1_000, true)).toEqual({ text: "added 1 package", cut: true })
    })
})
