import { describe, expect, it } from "vitest"
import { isValidRefName } from "./gitRefUtils"

describe("isValidRefName", () => {
    it.each([["main"], ["release/1.4"], ["feature/JIRA-12_fix"], ["v1.2.0"]])("given %j, when it is checked, then it is a branch name", ref => {
        expect(isValidRefName(ref)).toBe(true)
    })

    it.each([
        [""],
        ["a..b"],
        ["has space"],
        ["tab\there"],
        ["a~1"],
        ["a^"],
        ["a:b"],
        ["a?"],
        ["a*"],
        ["a[b"],
        ["a\\b"],
        ["/main"],
        ["main/"],
        ["a//b"],
        ["main.lock"],
        ["main."],
        [".hidden"],
        ["a/.b"],
        ["a@{1}"],
        ["@"],
        ["x".repeat(256)]
    ])("given %j, when it is checked, then git would refuse it", ref => {
        expect(isValidRefName(ref)).toBe(false)
    })
})
