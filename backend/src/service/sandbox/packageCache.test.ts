import { describe, expect, it } from "vitest"
import { packageCacheEnvironment, packageCacheFolder, packageCacheOf, withoutPackageCache, withPackageCache } from "./packageCache"

const FOLDER = packageCacheFolder("/sandbox")
const KATA = { kubernetes: { pod: { runtime_class_name: "kata" } } }

describe("packageCache", () => {
    it("Given a claim, when it is set on a driver config, then it is mounted read-write on the cache folder and every other setting stays", () => {
        const config = withPackageCache(KATA, "sandbox-pkg-cache", FOLDER)

        expect(config).toEqual({
            kubernetes: {
                pod: { runtime_class_name: "kata" },
                volumes: [{ name: "flightroom-package-cache", persistent_volume_claim: { claim_name: "sandbox-pkg-cache", read_only: false } }],
                containers: { agent: { volume_mounts: [{ name: "flightroom-package-cache", mount_path: "/sandbox/cache", read_only: false }] } }
            }
        })
        expect(packageCacheOf(config, FOLDER)).toBe("sandbox-pkg-cache")
        expect(withoutPackageCache(config, FOLDER)).toEqual(KATA)
    })

    it("Given a cache mounted under another volume name, when another claim is set, then it replaces it, and a mount elsewhere stays with its volume", () => {
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
        expect(packageCacheOf(config, FOLDER)).toBe("old")

        const replaced = withPackageCache(config, "new", FOLDER)

        expect(packageCacheOf(replaced, FOLDER)).toBe("new")
        expect(withoutPackageCache(replaced, FOLDER)).toEqual({
            kubernetes: {
                volumes: [{ name: "data", persistent_volume_claim: { claim_name: "datasets", read_only: true } }],
                containers: { agent: { volume_mounts: [{ name: "data", mount_path: "/data", read_only: true }] } }
            }
        })
    })

    it("Given no claim, when the cache is removed from a driver config holding only it, then nothing is left", () => {
        const config = withPackageCache(undefined, "sandbox-pkg-cache", FOLDER)

        expect(withPackageCache(config, null, FOLDER)).toBeUndefined()
        expect(withPackageCache(config, "", FOLDER)).toBeUndefined()
        expect(packageCacheOf(undefined, FOLDER)).toBeUndefined()
    })

    it("Given the cache folder, when the environment of a command is made, then every package manager but Gradle keeps its downloads there", () => {
        const environment = packageCacheEnvironment(FOLDER)

        expect(environment).toMatchObject({
            pnpm_config_store_dir: "/sandbox/cache/pnpm-store",
            npm_config_store_dir: "/sandbox/cache/pnpm-store",
            npm_config_cache: "/sandbox/cache/npm",
            PIP_CACHE_DIR: "/sandbox/cache/pip",
            GOMODCACHE: "/sandbox/cache/go-mod",
            NUGET_PACKAGES: "/sandbox/cache/nuget"
        })
        expect(environment.MAVEN_OPTS).toContain("-Dmaven.repo.local=/sandbox/cache/m2")
        expect(Object.keys(environment).some(name => name.startsWith("GRADLE"))).toBe(false)
    })
})
