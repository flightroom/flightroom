import { describe, expect, it } from "vitest"
import { redactSecrets } from "./redactSecrets"

describe("redactSecrets", () => {
    it("Given a CI log echoing credentials, when redacted, then tokens and passwords are blanked and the rest is kept", () => {
        const log = [
            "git clone https://ci-user:s3cr3tpass@github.com/acme/app.git",
            "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
            "aws key AKIAABCDEFGHIJKLMNOP",
            "ERROR in src/main.ts: Cannot find module './app'"
        ].join("\n")

        const redacted = redactSecrets(log)

        for (const secret of ["s3cr3tpass", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "AKIAABCDEFGHIJKLMNOP"]) {
            expect(redacted).not.toContain(secret)
        }
        expect(redacted).toContain("ERROR in src/main.ts: Cannot find module './app'")
        expect(redacted).toContain("github.com/acme/app.git")
    })

    it("Given variables, bearer tokens, private keys and Azure storage credentials in a log, when redacted, then each value is blanked and the names stay", () => {
        const log = [
            "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "NPM_TOKEN: abc123def456",
            "DB_PASSWD=hunter2",
            "MY_PWD = pa55",
            "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload'",
            "-----BEGIN RSA PRIVATE KEY-----",
            "MIIEowIBAAKCAQEAtopsecretkeymaterial",
            "-----END RSA PRIVATE KEY-----",
            "DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=Zm9vYmFyYmF6PT0=;EndpointSuffix=core.windows.net",
            "Endpoint=sb://acme.servicebus.windows.net/;SharedAccessSignature=SharedAccessSignature sr=x",
            "GET https://acme.blob.core.windows.net/c/app.js?sv=2024-01-01&sig=AbCdEf%2B123&se=2026",
            "Build finished in 12s"
        ].join("\n")

        const redacted = redactSecrets(log)

        for (const secret of ["wJalrXUtnFEMI", "abc123def456", "hunter2", "pa55", "eyJhbGciOiJIUzI1NiJ9", "topsecretkeymaterial", "Zm9vYmFyYmF6PT0", "AbCdEf%2B123"]) {
            expect(redacted).not.toContain(secret)
        }
        expect(redacted).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]")
        expect(redacted).toContain("NPM_TOKEN: [REDACTED]")
        expect(redacted).toContain("Bearer [REDACTED]")
        expect(redacted).toContain("[REDACTED PRIVATE KEY]")
        expect(redacted).toContain("AccountName=acme;AccountKey=[REDACTED];EndpointSuffix")
        expect(redacted).toContain("SharedAccessSignature=[REDACTED]")
        expect(redacted).toContain("&sig=[REDACTED]&se=2026")
        expect(redacted).toContain("Build finished in 12s")
    })

    it.each([
        ["mongodb://admin:hunter2@db.internal:27017/orders", "mongodb://[REDACTED]@db.internal:27017/orders"],
        ["mongodb+srv://app:hunter2@cluster0.example.net/shop?retryWrites=true", "mongodb+srv://[REDACTED]@cluster0.example.net/shop?retryWrites=true"],
        ["postgres://orders:hunter2@pg:5432/orders", "postgres://[REDACTED]@pg:5432/orders"],
        ["postgresql://orders:hunter2@pg/orders", "postgresql://[REDACTED]@pg/orders"],
        ["mysql://root:hunter2@mysql:3306/app", "mysql://[REDACTED]@mysql:3306/app"],
        ["REDIS_URL redis://:hunter2@cache:6379/0", "REDIS_URL redis://[REDACTED]@cache:6379/0"],
        ["rediss://default:hunter2@cache:6380", "rediss://[REDACTED]@cache:6380"],
        ["amqp://guest:hunter2@rabbit:5672/vhost", "amqp://[REDACTED]@rabbit:5672/vhost"],
        ["HTTPS://CI:hunter2@GITHUB.COM/acme/app.git", "HTTPS://[REDACTED]@GITHUB.COM/acme/app.git"]
    ])("given the connection string %s, when it is redacted, then its credentials are blanked and the rest still reads", (value, expected) => {
        expect(redactSecrets(value)).toBe(expected)
    })

    it("given a URL with no credentials or a user only, when it is redacted, then it is left as it is", () => {
        expect(redactSecrets("connecting to mongodb://db.internal:27017/orders and https://user@example.com/x")).toBe("connecting to mongodb://db.internal:27017/orders and https://user@example.com/x")
    })
})
