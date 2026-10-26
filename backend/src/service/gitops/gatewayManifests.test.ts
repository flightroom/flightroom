import { describe, expect, it } from "vitest"
import { parseAllDocuments } from "yaml"
import { applicationListener, GATEWAY_HTTP_PORT, GATEWAY_HTTPS_PORT, ipAllowListMiddleware, renderGateway } from "./gatewayManifests"

const documentsOf = (content: string) => parseAllDocuments(content).map(document => document.toJSON())

describe("renderGateway", () => {
    const gateway = { name: "mfe-shop-1a2b3c", namespace: "production", host: "app.example.com" }

    it("given no issuer, when the Gateway is rendered, then it is the Gateway alone with a plain HTTP listener on the host", () => {
        const documents = documentsOf(renderGateway(gateway))

        expect(documents.map(document => document.kind)).toEqual(["Gateway"])
        expect(documents[0].spec.listeners).toEqual([{ name: "http", protocol: "HTTP", port: GATEWAY_HTTP_PORT, hostname: "app.example.com", allowedRoutes: { namespaces: { from: "Same" } } }])
    })

    it("given an issuer, when the Gateway is rendered, then the HTTPS listener serves the secret of the Certificate", () => {
        const [certificate, rendered] = documentsOf(renderGateway({ ...gateway, certificateIssuer: "letsencrypt" }))
        const https = rendered.spec.listeners.find((listener: { name: string }) => listener.name === "https")

        expect(https).toMatchObject({ protocol: "HTTPS", port: GATEWAY_HTTPS_PORT, tls: { mode: "Terminate", certificateRefs: [{ kind: "Secret", name: certificate.spec.secretName }] } })
    })

    it("given the ports of the entry points, when the Gateway is rendered, then the listeners are on them", () => {
        const [, rendered] = documentsOf(renderGateway({ ...gateway, certificateIssuer: "letsencrypt", httpPort: 8000, httpsPort: 8443 }))

        expect(rendered.spec.listeners.map((listener: { port: number }) => listener.port)).toEqual([8000, 8443])
    })

    it("given an issuer, when the Gateway is rendered, then plain HTTP is redirected to HTTPS", () => {
        const redirect = documentsOf(renderGateway({ ...gateway, certificateIssuer: "letsencrypt" }))[2]

        expect(redirect.spec).toEqual({
            parentRefs: [{ name: "mfe-shop-1a2b3c", sectionName: "http" }],
            rules: [{ filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https", statusCode: 301 } }] }]
        })
    })

    it("given an IP allow list, when the Gateway is rendered, then a Traefik Middleware lets only its ranges through", () => {
        const documents = documentsOf(renderGateway({ ...gateway, ipAllowList: ["203.0.113.0/24", "2001:db8::/32"] }))
        const middleware = documents.find(document => document.kind === "Middleware")

        expect(middleware).toMatchObject({
            apiVersion: "traefik.io/v1alpha1",
            metadata: { name: "mfe-shop-1a2b3c-ip-allowlist", namespace: "production" },
            spec: { ipAllowList: { sourceRange: ["203.0.113.0/24", "2001:db8::/32"] } }
        })
    })

    it("given an environment that never had an IP allow list, when the Gateway is rendered, then there is no Middleware", () => {
        expect(documentsOf(renderGateway(gateway)).map(document => document.kind)).not.toContain("Middleware")
        expect(ipAllowListMiddleware(gateway)).toBeUndefined()
    })

    it("given an emptied IP allow list, when the Gateway is rendered, then the Middleware stays and lets every address through", () => {
        const middleware = documentsOf(renderGateway({ ...gateway, ipAllowList: [] })).find(document => document.kind === "Middleware")

        expect(middleware.spec.ipAllowList.sourceRange).toEqual(["0.0.0.0/0", "::/0"])
        expect(ipAllowListMiddleware({ ...gateway, ipAllowList: [] })).toBe(middleware.metadata.name)
    })

    it("given two listeners, when the Gateway is rendered, then the YAML has no anchors nor aliases", () => {
        const rendered = renderGateway({ ...gateway, certificateIssuer: "letsencrypt" })

        expect(rendered).not.toMatch(/[&*]a\d/)
    })

    it("given any Gateway, when it is rendered, then every manifest is in the namespace and labelled as managed", () => {
        for (const document of documentsOf(renderGateway({ ...gateway, certificateIssuer: "letsencrypt", ipAllowList: ["203.0.113.0/24"] }))) {
            expect(document.metadata).toMatchObject({ namespace: "production", labels: { "app.kubernetes.io/managed-by": "flightroom" } })
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
