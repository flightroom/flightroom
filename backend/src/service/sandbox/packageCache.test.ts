import { describe, expect, it } from "vitest"
import { PACKAGE_CACHE_FOLDER, packageCacheEnvironment, packageCacheOf, withoutPackageCache, withPackageCache } from "./packageCache"

const KATA = { kubernetes: { pod: { runtime_class_name: "kata" } } }

describe("packageCache", () => {
    it("Given a claim, when it is set on a driver config, then it is mounted read-write outside /sandbox and every other setting stays", () => {
        const config = withPackageCache(KATA, "sandbox-pkg-cache")

        expect(config).toEqual({
            kubernetes: {
                pod: { runtime_class_name: "kata" },
                volumes: [{ name: "flightroom-package-cache", persistent_volume_claim: { claim_name: "sandbox-pkg-cache", read_only: false } }],
                containers: { agent: { volume_mounts: [{ name: "flightroom-package-cache", mount_path: "/tmp/flightroom-package-cache", read_only: false }] } }
            }
        })
        // A mount under /sandbox would take the workspace over from the gateway.
        expect(PACKAGE_CACHE_FOLDER.startsWith("/sandbox")).toBe(false)
        expect(packageCacheOf(config)).toBe("sandbox-pkg-cache")
        expect(withoutPackageCache(config)).toEqual(KATA)
    })

    it("Given a cache mounted on /sandbox/cache under another volume name, when the template is saved, then it moves out of /sandbox, and a mount elsewhere stays with its volume", () => {
        const config = {
            kubernetes: {
                volumes: [
                    { name: "pkg-cache", persistent_volume_claim: { claim_name: "old", read_only: false } },
                    { name: "data", persistent_volume_claim: { claim_name: "datasets", read_only: true } }
                ],
                containers: {
                    agent: {
                        volume_mounts: [
                            { name: "pkg-cache", mount_path: "/sandbox/cache", read_only: false },
                            { name: "data", mount_path: "/data", read_only: true }
                        ]
                    }
                }
            }
        }
        expect(packageCacheOf(config)).toBe("old")

        const replaced = withPackageCache(config, "old")

        expect(replaced).toEqual({
            kubernetes: {
                volumes: [
                    { name: "data", persistent_volume_claim: { claim_name: "datasets", read_only: true } },
                    { name: "flightroom-package-cache", persistent_volume_claim: { claim_name: "old", read_only: false } }
                ],
                containers: {
                    agent: {
                        volume_mounts: [
                            { name: "data", mount_path: "/data", read_only: true },
                            { name: "flightroom-package-cache", mount_path: "/tmp/flightroom-package-cache", read_only: false }
                        ]
                    }
                }
            }
        })
    })

    it("Given no claim, when the cache is removed from a driver config holding only it, then nothing is left", () => {
        const config = withPackageCache(undefined, "sandbox-pkg-cache")

        expect(withPackageCache(config, null)).toBeUndefined()
        expect(withPackageCache(config, "")).toBeUndefined()
        expect(packageCacheOf(undefined)).toBeUndefined()
    })

    it("Given the cache folder, when the environment of a command is made, then every package manager but Gradle keeps its downloads there", () => {
        const environment = packageCacheEnvironment(PACKAGE_CACHE_FOLDER)

        expect(environment).toMatchObject({
            pnpm_config_store_dir: "/tmp/flightroom-package-cache/pnpm-store",
            npm_config_store_dir: "/tmp/flightroom-package-cache/pnpm-store",
            npm_config_cache: "/tmp/flightroom-package-cache/npm",
            PIP_CACHE_DIR: "/tmp/flightroom-package-cache/pip",
            GOMODCACHE: "/tmp/flightroom-package-cache/go-mod",
            NUGET_PACKAGES: "/tmp/flightroom-package-cache/nuget"
        })
        expect(environment.MAVEN_OPTS).toContain("-Dmaven.repo.local=/tmp/flightroom-package-cache/m2")
        expect(Object.keys(environment).some(name => name.startsWith("GRADLE"))).toBe(false)
    })
})
