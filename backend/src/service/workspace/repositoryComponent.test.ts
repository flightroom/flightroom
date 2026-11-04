import { Types } from "mongoose"
import { describe, expect, it } from "vitest"
import Backend from "../../models/BackendModel"
import { backendFacts } from "../aiChange/aiChangeFacts"
import { fromBackend } from "./repositoryComponent"

describe("fromBackend", () => {
    const backend = Backend.hydrate({
        _id: new Types.ObjectId(),
        projectId: new Types.ObjectId(),
        slug: "orders",
        name: "Orders",
        env: [
            { name: "API_TOKEN", secret: true, value: "hunter2", description: "Calls the payments API" },
            { name: "FEATURE_FLAGS", secret: false, value: "beta" }
        ]
    })

    it("given variables with values, when the backend becomes a component for an agent, then no value goes with it, a plain one neither", () => {
        const component = fromBackend(backend)

        expect(component.env).toEqual([
            { name: "API_TOKEN", secret: true, description: "Calls the payments API" },
            { name: "FEATURE_FLAGS", secret: false, description: undefined }
        ])
        expect(JSON.stringify(component)).not.toContain("hunter2")
        expect(JSON.stringify(component)).not.toContain("beta")
    })

    it("given a variable set by Flightroom, when the facts of the backend are written for the agent, then it says so without the value", () => {
        const facts = backendFacts({ name: "Orders", slug: "orders", env: fromBackend(backend).env })
            .filter(Boolean)
            .join("\n")

        expect(facts).toContain("- API_TOKEN (secret, set by Flightroom on every deploy): Calls the payments API")
        expect(facts).toContain("- FEATURE_FLAGS (set by Flightroom on every deploy)")
        expect(facts).not.toContain("hunter2")
    })
})
