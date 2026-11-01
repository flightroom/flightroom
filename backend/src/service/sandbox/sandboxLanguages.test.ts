import { describe, expect, it } from "vitest"
import { BackendRuntime } from "../../types/BackendStack"
import { languagesOfComponents, languagesOfLabels, templateForLanguages, withLanguageLabels, withoutLanguageLabels } from "./sandboxLanguages"

describe("sandboxLanguages", () => {
    it("Given the labels of a template, then its languages are those labelled true, and its other labels stay apart", () => {
        const labels = {
            app: "flightroom",
            "languages.flightroom.dev/java": "true",
            "languages.flightroom.dev/node": "true",
            "languages.flightroom.dev/ruby": "true",
            "languages.flightroom.dev/go": "false"
        }

        expect(languagesOfLabels(labels)).toEqual(["node", "java"])
        expect(withoutLanguageLabels(labels)).toEqual({ app: "flightroom" })
    })

    it("Given labels and languages, then the language labels are replaced by one per known language", () => {
        expect(withLanguageLabels({ app: "flightroom", "languages.flightroom.dev/java": "true" }, ["python", "cobol"])).toEqual({ app: "flightroom", "languages.flightroom.dev/python": "true" })
    })

    it("Given repositories, then a frontend needs Node.js and a backend its runtime, an unknown runtime nothing", () => {
        const components = [
            { kind: "frontend" as const },
            { kind: "backend" as const, runtime: BackendRuntime.JAVA },
            { kind: "backend" as const, runtime: BackendRuntime.OTHER },
            { kind: "backend" as const }
        ]

        expect(languagesOfComponents(components)).toEqual(["node", "java"])
    })

    describe("templateForLanguages", () => {
        const templates = [
            { name: "everything", languages: ["node", "java", "python", "go", "dotnet"] },
            { name: "jvm", languages: ["node", "java"] },
            { name: "a-jvm", languages: ["java", "node"] },
            { name: "untagged", languages: [] }
        ]

        it("Given the template in use holding every language needed, then it is chosen over a lighter one", () => {
            expect(templateForLanguages(templates, ["java"], "everything")).toBe("everything")
        })

        it("Given the template in use lacking a language, then the lightest holding them all is chosen, by name on a tie", () => {
            expect(templateForLanguages(templates, ["node", "java"], "untagged")).toBe("a-jvm")
            expect(templateForLanguages(templates, ["go"], "jvm")).toBe("everything")
        })

        it("Given nothing needed, or no template holding it all, then none is chosen", () => {
            expect(templateForLanguages(templates, [], "jvm")).toBeUndefined()
            expect(templateForLanguages(templates.slice(1), ["python"])).toBeUndefined()
        })
    })
})
