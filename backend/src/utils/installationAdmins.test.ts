import { describe, expect, it } from "vitest"
import { ensureInstallationAdmin, isInstallationAdmin } from "./installationAdmins"

describe("installation administrators", () => {
    it("Given INSTALLATION_ADMINS, then an email among them is an administrator whatever its case and the spaces around it", () => {
        expect(isInstallationAdmin("Ops@Example.com", " admin@example.com , ops@example.com,")).toBe(true)
        expect(isInstallationAdmin(" admin@example.com ", "ADMIN@EXAMPLE.COM")).toBe(true)
    })

    it("Given an email not listed, or no list at all, then nobody is an administrator, an empty email least of all", () => {
        expect(isInstallationAdmin("someone@example.com", "admin@example.com")).toBe(false)
        expect(isInstallationAdmin("admin@example.com", undefined)).toBe(false)
        expect(isInstallationAdmin("admin@example.com", "")).toBe(false)
        expect(isInstallationAdmin("", "admin@example.com,")).toBe(false)
        expect(isInstallationAdmin(undefined, ",")).toBe(false)
        // Part of a listed email is not the email
        expect(isInstallationAdmin("admin@example.co", "admin@example.com")).toBe(false)
    })

    it("Given somebody who is not an administrator, when they are checked, then they are refused with a 403", () => {
        expect(() => ensureInstallationAdmin("someone@example.com", "admin@example.com")).toThrow(expect.objectContaining({ statusCode: 403, code: "INSTALLATION_ADMIN_REQUIRED" }))
        expect(() => ensureInstallationAdmin("admin@example.com", "admin@example.com")).not.toThrow()
    })
})
