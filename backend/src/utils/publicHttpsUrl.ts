import { BlockList, isIP } from "node:net"
import { BusinessException } from "../errors/BusinessException"

const refused = (message: string) => new BusinessException({ code: "INVALID_URL", message, statusCode: 400 })

/**
 * Addresses a user-supplied git host may never be: loopback, link-local (cloud metadata lives at
 * 169.254.169.254) and unspecified. Private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) are NOT
 * listed on purpose: a self-hosted GitLab on the internal network is a legitimate target.
 */
const DANGEROUS = new BlockList()
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16]
] as const) {
    DANGEROUS.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fe80::", 10]
] as const) {
    DANGEROUS.addSubnet(network, prefix, "ipv6")
}

/** True for loopback, link-local and unspecified addresses (IPv4-mapped IPv6 included). */
export const isDangerousAddress = (address: string): boolean => {
    const family = isIP(address)
    if (family === 4) return DANGEROUS.check(address, "ipv4")
    if (family === 6) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
        if (mapped) return isDangerousAddress(mapped[1])
        // Hex form of a mapped address (::ffff:7f00:1), as the URL parser normalizes it
        const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
        if (hex) {
            const high = Number.parseInt(hex[1], 16)
            const low = Number.parseInt(hex[2], 16)
            return isDangerousAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
        }
        return DANGEROUS.check(address, "ipv6")
    }
    return false
}

/** A DNS label of a `*.visualstudio.com` host: the organization of Azure DevOps. */
const AZURE_ORGANIZATION = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/i

/**
 * Syntactic check of a git host URL: https, no credentials, not localhost, not a loopback /
 * link-local / unspecified IP literal. No DNS: internal names must validate where they do not resolve.
 */
export const isAllowedGitHostSyntax = (value: string): boolean => {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return false
    }
    if (url.protocol !== "https:" || url.username || url.password) return false
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) return false
    return !isDangerousAddress(hostname)
}

/**
 * Refuses a self-hosted git URL the backend would call on behalf of a user, unless it passes
 * `isAllowedGitHostSyntax`. Private and internal hosts stay allowed (self-hosted GitLab on the
 * company network is intended); only loopback, link-local/metadata and unspecified targets are refused.
 */
export const assertAllowedGitUrl = (value: string | undefined, what = "URL"): void => {
    if (!value || !isAllowedGitHostSyntax(value)) {
        throw refused(`The ${what} must be an https URL without credentials, not pointing at localhost, loopback or link-local addresses`)
    }
}

export const isAzureOrganization = (organization: string | undefined): boolean => !!organization && AZURE_ORGANIZATION.test(organization)

/** Refuses an Azure DevOps organization that is not a plain subdomain label: it is interpolated into `<organization>.visualstudio.com`. */
export const assertAzureOrganization = (organization: string | undefined): void => {
    if (!isAzureOrganization(organization)) {
        throw refused("The Azure DevOps organization is not valid")
    }
}
