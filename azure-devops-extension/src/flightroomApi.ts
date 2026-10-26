export const flightroomApiUrl = (domain: string, endpoint: string): string => {
    const base = new URL(domain)
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error("Domain must be an HTTP(S) base URL without credentials, query, or fragment")
    }

    const basePath = base.pathname.replace(/\/+$/, "").replace(/\/api$/, "")
    const route = endpoint.replace(/^\/+/, "")
    return new URL(`${basePath}/api/${route}`, base.origin).toString()
}
