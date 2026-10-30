import axios from "axios"

export interface NpmPackageInfo {
    name: string
    latest?: string
    deprecated?: boolean
    modifiedAt?: string
}

interface NpmAbbreviatedPackument {
    name: string
    "dist-tags"?: Record<string, string>
    modified?: string
    versions?: Record<string, { deprecated?: string }>
}

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org"
const CACHE_TTL_MS = 1000 * 60 * 60
/**
 * A package the registry answered 404 for, private packages first of all: remembered briefly, so a report
 * of many dependencies does not ask again for each of them every time it is loaded. Any other failure is
 * not remembered, a registry blip must not hide what it knows
 */
const NOT_FOUND_TTL_MS = 1000 * 60 * 5
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CONCURRENCY = 8

interface CacheEntry {
    expiresAt: number
    value: NpmPackageInfo | null
}

const cache = new Map<string, CacheEntry>()

class NpmRegistryClient {
    private readonly registryUrl: string

    constructor(registryUrl?: string) {
        this.registryUrl = (registryUrl || process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL).replace(/\/+$/, "")
    }

    private buildUrl(packageName: string): string {
        // Scoped packages must keep the leading "@" but escape every other reserved
        // character, so a crafted name cannot escape the registry path segment.
        const encodedName = encodeURIComponent(packageName).replace(/^%40/, "@")
        return `${this.registryUrl}/${encodedName}`
    }

    /**
     * Returns the published metadata of a package, or null when the package is unknown
     * to the registry (private packages, typos, no network access, ...).
     */
    async getPackageInfo(packageName: string): Promise<NpmPackageInfo | null> {
        const cacheKey = `${this.registryUrl}:${packageName}`
        const cached = cache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value
        }

        try {
            const response = await axios.request<NpmAbbreviatedPackument>({
                url: this.buildUrl(packageName),
                timeout: REQUEST_TIMEOUT_MS,
                headers: {
                    // Abbreviated metadata: same dist-tags with a much smaller payload
                    Accept: "application/vnd.npm.install-v1+json",
                    "User-Agent": "Flightroom"
                }
            })

            const latest = response.data["dist-tags"]?.latest

            const value = {
                name: response.data.name || packageName,
                latest,
                deprecated: Boolean(latest && response.data.versions?.[latest]?.deprecated),
                modifiedAt: response.data.modified
            }
            cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value })
            return value
        } catch (error) {
            // A missing or unreachable package must not break the whole analysis
            if (axios.isAxiosError(error) && error.response?.status === 404) {
                cache.set(cacheKey, { expiresAt: Date.now() + NOT_FOUND_TTL_MS, value: null })
            }
            return null
        }
    }

    /**
     * Resolves many packages at once with a bounded concurrency, so a project with
     * hundreds of dependencies does not open hundreds of sockets.
     */
    async getPackagesInfo(packageNames: string[], concurrency: number = DEFAULT_CONCURRENCY): Promise<Map<string, NpmPackageInfo>> {
        const uniqueNames = [...new Set(packageNames)]
        const result = new Map<string, NpmPackageInfo>()
        let cursor = 0

        const worker = async () => {
            while (cursor < uniqueNames.length) {
                const packageName = uniqueNames[cursor++]
                const info = await this.getPackageInfo(packageName)
                if (info) {
                    result.set(packageName, info)
                }
            }
        }

        // At least one worker, or a concurrency of 0, below or NaN would resolve nothing and answer an empty map
        const workers = Math.min(Math.max(Math.floor(concurrency) || 1, 1), uniqueNames.length)
        await Promise.all(Array.from({ length: workers }, worker))

        return result
    }
}

export default NpmRegistryClient
