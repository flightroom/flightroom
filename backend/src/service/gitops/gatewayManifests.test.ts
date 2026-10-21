import { describe, expect, it } from "vitest"
import { parseAllDocuments } from "yaml"
import { applicationListener, GATEWAY_HTTPS_PORT, gatewayName, renderGateway } from "./gatewayManifests"

const documentsOf = (content: string) => parseAllDocuments(content).map(document => document.toJSON())

describe("gatewayName", () => {
    it("given a project, when its Gateway is named, then it is the slug, gateway and a hash of the project id", () => {
        expect(gatewayName("64b7f0c2e4b0a1a2b3c4d5e6", "tnb-ai-portal")).toMatch(/^tnb-ai-portal-gateway-[0-9a-f]{6}$/)
    })

    it("given a long slug, when its Gateway is named, then the redirect route named after it still fits 63 characters", () => {
        expect(`${gatewayName("64b7f0c2e4b0a1a2b3c4d5e6", "a".repeat(80))}-https-redirect`.length).toBeLessThanOrEqual(63)
    })
})

describe("renderGateway", () => {
    const gateway = { name: "shop-gateway-1a2b3c", namespace: "production", host: "app.example.com" }

    it("given no issuer, when the Gateway is rendered, then it is the Gateway alone with a plain HTTP listener on the host", () => {
        const documents = documentsOf(renderGateway(gateway))

        expect(documents.map(document => document.kind)).toEqual(["Gateway"])
        expect(documents[0].spec.listeners).toEqual([{ name: "http", protocol: "HTTP", port: 8000, hostname: "app.example.com", allowedRoutes: { namespaces: { from: "Same" } } }])
    })

    it("given an issuer, when the Gateway is rendered, then the HTTPS listener serves the secret of the Certificate", () => {
        const [certificate, rendered] = documentsOf(renderGateway({ ...gateway, certificateIssuer: "letsencrypt" }))
        const https = rendered.spec.listeners.find((listener: { name: string }) => listener.name === "https")

        expect(https).toMatchObject({ protocol: "HTTPS", port: GATEWAY_HTTPS_PORT, tls: { mode: "Terminate", certificateRefs: [{ kind: "Secret", name: certificate.spec.secretName }] } })
    })

    it("given an issuer, when the Gateway is rendered, then plain HTTP is redirected to HTTPS", () => {
        const redirect = documentsOf(renderGateway({ ...gateway, certificateIssuer: "letsencrypt" }))[2]

        expect(redirect.spec).toEqual({
            parentRefs: [{ name: "shop-gateway-1a2b3c", sectionName: "http" }],
            rules: [{ filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https", statusCode: 301 } }] }]
        })
    })

    it("given two listeners, when the Gateway is rendered, then the YAML has no anchors nor aliases", () => {
        const rendered = renderGateway({ ...gateway, certificateIssuer: "letsencrypt" })

        expect(rendered).not.toMatch(/[&*]a\d/)
    })

    it("given any Gateway, when it is rendered, then every manifest is in the namespace and labelled as managed", () => {
        for (const document of documentsOf(renderGateway({ ...gateway, certificateIssuer: "letsencrypt" }))) {
            expect(document.metadata).toMatchObject({ namespace: "production", labels: { "app.kubernetes.io/managed-by": "mfe-orchestrator" } })
        }
    })
})

describe("applicationListener", () => {
    it.each([
        ["an issuer", { certificateIssuer: "letsencrypt" }, "https"],
        ["no issuer", {}, "http"]
    ])("given %s, when the listener of the applications is picked, then it is %s", (_case, gateway, expected) => {
        expect(applicationListener(gateway)).toBe(expected)
    })
})
