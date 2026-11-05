/**
 * The package cache of the sandboxes: a folder next to their home where the package managers keep what they download.
 * A workload template may mount a PersistentVolumeClaim on it, shared by every sandbox created from the template, so
 * that a package is downloaded once for all of them instead of once per sandbox. Without one it is a folder of the
 * sandbox's own disk, as the home is.
 */

/** The driver config of a workload template, keyed by compute driver: only the Kubernetes one mounts volumes. */
type DriverConfig = Record<string, unknown>

interface VolumeMount {
    name?: string
    mount_path?: string
}

interface Volume {
    name?: string
    persistent_volume_claim?: { claim_name?: string }
}

/** The name of the volume of the cache in the pod of a sandbox. */
const VOLUME = "flightroom-package-cache"

/** The folder of the cache, next to the home of the sandboxes, under their root. */
export const packageCacheFolder = (root: string) => `${root}/cache`

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const objectAt = (parent: unknown, key: string): Record<string, unknown> => {
    const value = isObject(parent) ? parent[key] : undefined
    return isObject(value) ? value : {}
}

const arrayAt = <T>(parent: Record<string, unknown>, key: string): T[] => (Array.isArray(parent[key]) ? (parent[key] as T[]) : [])

const mountsOf = (driverConfig: DriverConfig | undefined) => arrayAt<VolumeMount>(objectAt(objectAt(objectAt(driverConfig, "kubernetes"), "containers"), "agent"), "volume_mounts")

/** The claim a template mounts on the cache folder, whatever its volume is named: none when the cache is the sandbox's own. */
export const packageCacheOf = (driverConfig: DriverConfig | undefined, folder: string): string | undefined => {
    const mount = mountsOf(driverConfig).find(candidate => candidate.mount_path === folder)
    if (!mount) return undefined
    const volume = arrayAt<Volume>(objectAt(driverConfig, "kubernetes"), "volumes").find(candidate => candidate.name === mount.name)
    return volume?.persistent_volume_claim?.claim_name || undefined
}

/** Drops the empty objects and arrays left behind: a driver config with nothing in it is no driver config. */
const pruned = (value: Record<string, unknown>): Record<string, unknown> | undefined => {
    const kept = Object.entries(value).flatMap(([key, child]): [string, unknown][] => {
        if (Array.isArray(child)) return child.length ? [[key, child]] : []
        if (isObject(child)) {
            const inner = pruned(child)
            return inner ? [[key, inner]] : []
        }
        return [[key, child]]
    })
    return kept.length ? Object.fromEntries(kept) : undefined
}

/**
 * The driver config of a template with the claim mounted on the cache folder, read-write, or with no cache mounted
 * when there is no claim. Every other setting is kept; a volume mounted there before, under any name, is replaced.
 */
export const withPackageCache = (driverConfig: DriverConfig | undefined, claim: string | null | undefined, folder: string): DriverConfig | undefined => {
    const kubernetes = objectAt(driverConfig, "kubernetes")
    const containers = objectAt(kubernetes, "containers")
    const agent = objectAt(containers, "agent")
    const replaced = new Set(mountsOf(driverConfig).flatMap(mount => (mount.mount_path === folder && mount.name ? [mount.name] : [])))
    const mounts = mountsOf(driverConfig).filter(mount => mount.mount_path !== folder)
    // A volume another mount still uses stays.
    const used = new Set(mounts.map(mount => mount.name))
    const volumes = arrayAt<Volume>(kubernetes, "volumes").filter(volume => !(volume.name && replaced.has(volume.name) && !used.has(volume.name)))
    if (claim) {
        volumes.push({ name: VOLUME, persistent_volume_claim: { claim_name: claim, read_only: false } } as Volume)
        mounts.push({ name: VOLUME, mount_path: folder, read_only: false } as VolumeMount)
    }
    return pruned({
        ...driverConfig,
        kubernetes: { ...kubernetes, volumes, containers: { ...containers, agent: { ...agent, volume_mounts: mounts } } }
    })
}

/** The driver config without the cache: what is left is set on the gateway otherwise, and the page does not show it. */
export const withoutPackageCache = (driverConfig: DriverConfig | undefined, folder: string) => withPackageCache(driverConfig, undefined, folder)

/**
 * Where each package manager keeps what it downloads: in the cache folder. pnpm reads its settings from pnpm_config_*
 * since version 11 and from npm_config_* before. Several builds may write the Maven repository at once, from sandboxes
 * sharing the cache: Maven locks it one artifact at a time. Gradle is left out: it does not support a home shared by
 * concurrent builds on another file system.
 */
export const packageCacheEnvironment = (folder: string): Record<string, string> => ({
    pnpm_config_store_dir: `${folder}/pnpm-store`,
    npm_config_store_dir: `${folder}/pnpm-store`,
    npm_config_cache: `${folder}/npm`,
    YARN_CACHE_FOLDER: `${folder}/yarn`,
    MAVEN_OPTS: `-Dmaven.repo.local=${folder}/m2 -Daether.syncContext.named.factory=file-lock -Daether.syncContext.named.nameMapper=file-gav`,
    PIP_CACHE_DIR: `${folder}/pip`,
    GOMODCACHE: `${folder}/go-mod`,
    NUGET_PACKAGES: `${folder}/nuget`
})
