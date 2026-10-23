import { Types } from "mongoose"
import { describe, expect, it } from "vitest"
import Backend from "./BackendModel"
import Domain from "./DomainModel"
import Frontend from "./FrontendModel"

describe("Domain model", () => {
    it("given a name and a slug with spaces and capitals, when it is built, then they are stored trimmed and the slug lowercase", async () => {
        const domain = new Domain({ projectId: new Types.ObjectId(), slug: "  Payments ", name: "  Payments  " })

        expect(domain.name).toBe("Payments")
        expect(domain.slug).toBe("payments")
        await expect(domain.validate()).resolves.toBeUndefined()
    })

    it.each([["projectId"], ["name"], ["slug"]])("given no %s, when it is validated, then it is refused", async field => {
        const domain = new Domain({ projectId: new Types.ObjectId(), slug: "payments", name: "Payments", [field]: undefined })

        await expect(domain.validate()).rejects.toMatchObject({ errors: { [field]: expect.anything() } })
    })

    it.each([
        ["name", "x".repeat(101)],
        ["description", "x".repeat(2001)]
    ])("given a %s over its limit, when it is validated, then it is refused", async (field, value) => {
        const domain = new Domain({ projectId: new Types.ObjectId(), slug: "payments", name: "Payments", [field]: value })

        await expect(domain.validate()).rejects.toMatchObject({ errors: { [field]: expect.anything() } })
    })

    it("declares the slug unique inside its project", () => {
        expect(Domain.schema.indexes()).toContainEqual([{ slug: 1, projectId: 1 }, expect.objectContaining({ unique: true })])
    })

    it("given a frontend and a backend without a domain, when they are validated, then they are accepted", async () => {
        const frontend = new Frontend({ projectId: new Types.ObjectId(), slug: "shell", name: "Shell", version: "1.0.0", host: { type: "MFE_ORCHESTRATOR_HUB" } })
        const backend = new Backend({ projectId: new Types.ObjectId(), slug: "orders", name: "Orders" })

        await expect(frontend.validate()).resolves.toBeUndefined()
        await expect(backend.validate()).resolves.toBeUndefined()
        expect(frontend.domainId).toBeUndefined()
        expect(backend.domainId).toBeUndefined()
    })
})
