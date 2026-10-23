import { describe, expect, it } from "vitest"
import Frontend from "../models/FrontendModel"
import Organization from "../models/OrganizationModel"
import { describeDesignSystem, designSystemOf, effectiveDesignSystem, redactDesignSystems, redactNpmrc } from "./DesignSystem"

describe("redactNpmrc", () => {
    it.each([
        ["a scoped token", "//npm.acme.dev/:_authToken=npm_abc123", "//npm.acme.dev/:_authToken=***"],
        ["a registry with a port and a path", "//npm.acme.dev:8443/repository/npm/:_authToken = abc", "//npm.acme.dev:8443/repository/npm/:_authToken =***"],
        ["a global basic auth", "_auth=dXNlcjpwYXNz", "_auth=***"],
        ["a scoped password", "//npm.acme.dev/:_password=cGFzcw==", "//npm.acme.dev/:_password=***"],
        ["a username", "//npm.acme.dev/:username=ci-bot", "//npm.acme.dev/:username=***"],
        ["an email", "email=ci@acme.dev", "email=***"],
        ["a client certificate file", "//npm.acme.dev/:certfile=/home/ci/cert.pem", "//npm.acme.dev/:certfile=***"],
        ["a client key file", "//npm.acme.dev/:keyfile=/home/ci/key.pem", "//npm.acme.dev/:keyfile=***"],
        ["a line commented out", "# //npm.acme.dev/:_authToken=old-token", "# //npm.acme.dev/:_authToken=***"]
    ])("Given %s, when it is redacted, then its value is masked", (_case, line, expected) => {
        expect(redactNpmrc(line)).toBe(expected)
    })

    it("Given the registries and the settings of an npmrc, when it is redacted, then they stay readable and only the credentials are masked", () => {
        const npmrc = ["@acme:registry=https://npm.acme.dev/", "registry=https://registry.npmjs.org/", "always-auth=true", "//npm.acme.dev/:_authToken=npm_abc123", "strict-ssl=false"].join("\r\n")

        expect(redactNpmrc(npmrc)).toBe(
            ["@acme:registry=https://npm.acme.dev/", "registry=https://registry.npmjs.org/", "always-auth=true", "//npm.acme.dev/:_authToken=***", "strict-ssl=false"].join("\r\n")
        )
    })

    it("Given a token read from an environment variable, when it is redacted, then the reference stays: it is no credential", () => {
        expect(redactNpmrc("//npm.acme.dev/:_authToken=${NPM_TOKEN}")).toBe("//npm.acme.dev/:_authToken=${NPM_TOKEN}")
    })
})

describe("designSystemOf", () => {
    it("Given a design system, when it is read, then it is trimmed and its blank fields are left out", () => {
        expect(designSystemOf({ packageName: " @acme/ui ", version: "^3.2.0", docsUrl: "", notes: "  Use its tokens.  ", npmrc: null })).toEqual({
            packageName: "@acme/ui",
            version: "^3.2.0",
            notes: "Use its tokens."
        })
    })

    it.each([
        ["no package name", { version: "1.0.0" }],
        ["a package name npm refuses", { packageName: "Acme UI" }],
        ["a field that is no string", { packageName: "@acme/ui", version: 3 }],
        ["docs that are no http URL", { packageName: "@acme/ui", docsUrl: "javascript:alert(1)" }],
        ["an npmrc too long", { packageName: "@acme/ui", npmrc: "x".repeat(5_001) }],
        ["no object", "@acme/ui"]
    ])("Given %s, when it is read, then it is refused with a 400", (_case, input) => {
        expect(() => designSystemOf(input)).toThrow(expect.objectContaining({ code: "DESIGN_SYSTEM_INVALID", statusCode: 400 }))
    })
})

describe("effectiveDesignSystem", () => {
    const project = { packageName: "@acme/ui" }
    const organization = { packageName: "@acme/brand" }

    it("Given a frontend with its own, then its own wins over the project's and the organization's", () => {
        expect(effectiveDesignSystem({ packageName: "@acme/legacy-ui" }, project, organization)).toEqual({ packageName: "@acme/legacy-ui" })
    })

    it("Given a frontend without one, then it builds with the project's", () => {
        expect(effectiveDesignSystem(undefined, project, organization)).toEqual(project)
    })

    it("Given a frontend and a project without one, then it builds with the organization's", () => {
        expect(effectiveDesignSystem(null, undefined, organization)).toEqual(organization)
    })

    it("Given a level left with no package, then it is skipped as if it had none", () => {
        expect(effectiveDesignSystem({ packageName: "" }, undefined, organization)).toEqual(organization)
    })

    it("Given none at any level, then there is none", () => {
        expect(effectiveDesignSystem(undefined, null, undefined)).toBeUndefined()
        expect(effectiveDesignSystem()).toBeUndefined()
    })
})

describe("redactDesignSystems", () => {
    it("Given a frontend document serialised for an AI, when it carries a design system, then its npmrc reaches it masked and the rest untouched", () => {
        const frontend = new Frontend({
            slug: "catalog",
            name: "Catalog",
            version: "1.0.0",
            designSystem: { packageName: "@acme/ui", npmrc: "@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=npm_abc123" }
        })

        const serialised = JSON.parse(JSON.stringify({ ...frontend.toObject(), aiContext: { project: { designSystem: frontend.designSystem } } }, redactDesignSystems))

        expect(serialised.designSystem).toEqual({ packageName: "@acme/ui", npmrc: "@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=***" })
        expect(serialised.aiContext.project.designSystem.npmrc).not.toContain("npm_abc123")
        expect(serialised.slug).toBe("catalog")
    })

    it("Given an organization document serialised for an AI, when it carries a design system, then its npmrc reaches it masked", () => {
        const organization = new Organization({
            name: "Acme",
            slug: "acme",
            designSystem: { packageName: "@acme/brand", npmrc: "//npm.acme.dev/:_authToken=npm_abc123" }
        })

        const serialised = JSON.parse(JSON.stringify({ organization, role: "OWNER" }, redactDesignSystems))

        expect(serialised.organization.designSystem).toEqual({ packageName: "@acme/brand", npmrc: "//npm.acme.dev/:_authToken=***" })
        expect(serialised.organization.name).toBe("Acme")
    })
})

describe("describeDesignSystem", () => {
    it("Given no design system, then the prompt gets no block", () => {
        expect(describeDesignSystem(undefined)).toBeUndefined()
    })
})
