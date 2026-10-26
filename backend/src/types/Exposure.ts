import { isIP } from "node:net"

/**
 * Where a project is exposed: on the domain of the project, under the subdomain of each environment. Each
 * application declares only the path it is exposed at, the same in every environment.
 */

const DNS_LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"

/** A domain of at least two labels, e.g. `example.com`, in lowercase */
export const DOMAIN_NAME = new RegExp(`^(?=.{1,253}$)${DNS_LABEL}(\\.${DNS_LABEL})+$`)

/** One or more labels put in front of the domain, e.g. `dev` or `dev.eu`; empty: the domain itself */
export const SUBDOMAIN = new RegExp(`^(${DNS_LABEL}(\\.${DNS_LABEL})*)?$`)

/** A port a listener of the Gateway may take */
export const isListenerPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535

/** The name of a cert-manager ClusterIssuer, as Kubernetes takes it */
export const CERTIFICATE_ISSUER = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/

/**
 * A path an application is exposed at, as the HTTPRoute CRD takes it: `/`, or segments of unreserved and
 * sub-delimiter characters and percent escapes. No query, fragment, `//`, `.` or `..` segment, nor an escaped
 * slash: the API server refuses them, and the whole application with them.
 */
export const EXPOSURE_PATH = /^(?!.*%2[fF])(\/|(\/(?!\.{1,2}(\/|$))([-A-Za-z0-9._~!$&'()*+,;=:@]|%[0-9a-fA-F]{2})+)+\/?)$/

/** At most what a probe or docs path may be */
export const EXPOSURE_PATH_MAX_LENGTH = 256

export const isExposurePath = (value: string): boolean => value.length <= EXPOSURE_PATH_MAX_LENGTH && EXPOSURE_PATH.test(value)

/** Two exposure paths are the same prefix with or without the trailing slash */
export const sameExposurePath = (a: string, b: string): boolean => (a.replace(/\/$/, "") || "/") === (b.replace(/\/$/, "") || "/")

/**
 * What an environment is exposed under: the subdomain set on it, else nothing for a production one, which
 * takes the domain itself, and its slug in lowercase for the others, so that `DEV` lands on `dev.<domain>`.
 */
export const effectiveSubdomain = (environment: { slug: string; subdomain?: string; isProduction?: boolean }): string =>
    environment.subdomain || (environment.isProduction ? "" : environment.slug.toLowerCase())

/** The host an environment is exposed on: its subdomain of the domain, the domain itself without one */
export const exposedHost = (domain: string, subdomain?: string): string => (subdomain ? `${subdomain}.${domain}` : domain)

/** Where browsers reach an environment: HTTPS when the project asks an issuer for its certificates, HTTP without one */
export const exposedOrigin = (exposure: { domain: string; certificateIssuer?: string | null }, subdomain?: string): string =>
    `${exposure.certificateIssuer ? "https" : "http"}://${exposedHost(exposure.domain, subdomain)}`

/**
 * An address or a CIDR range Traefik takes in an `ipAllowList` source range, e.g. `203.0.113.7`,
 * `203.0.113.0/24` or `2001:db8::/32`
 */
export const isIpRange = (value: string): boolean => {
    const [address, prefix, ...rest] = value.split("/")
    // Node takes an IPv6 zone, `fe80::1%eth0`; Traefik does not
    const version = address.includes("%") ? 0 : isIP(address)
    if (version === 0 || rest.length > 0) return false
    return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128))
}

/** At most this many ranges per environment: a longer list belongs in a firewall in front of the cluster */
export const IP_ALLOW_LIST_MAX = 100
