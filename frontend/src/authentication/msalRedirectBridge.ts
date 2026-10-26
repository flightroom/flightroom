/**
 * Whether this page was loaded as the return of an MSAL login: a popup, a silent iframe or a redirect.
 *
 * MSAL 5 no longer reads the URL of the popup from the opener: it waits for the page at the
 * redirect URI to send the response over a BroadcastChannel, and times out otherwise. The redirect
 * URI is the origin, so that page is this app. Only a state MSAL wrote counts: Google and the MCP
 * consent come back with a `state` too, and the bridge would strip their response from the URL.
 */
export const isMsalResponse = (url: Location = window.location): boolean => {
    for (const part of [url.hash.replace(/^#/, ""), url.search.replace(/^\?/, "")]) {
        const state = new URLSearchParams(part).get("state")
        if (!state) continue
        try {
            const encoded = state.split("|")[0].replace(/-/g, "+").replace(/_/g, "/")
            const libraryState = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")))
            if (libraryState?.id && libraryState?.meta?.interactionType) return true
        } catch {
            // Not a state MSAL wrote
        }
    }
    return false
}

/** Hands the response to the window that started the login. */
export const broadcastMsalResponse = async (): Promise<void> => {
    const { broadcastResponseToMainFrame } = await import("@azure/msal-browser/redirect-bridge")
    await broadcastResponseToMainFrame()
}
