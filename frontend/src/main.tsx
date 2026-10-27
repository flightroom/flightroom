import { createRoot } from "react-dom/client"
import App from "./App.tsx"
import { broadcastMsalResponse, isMsalResponse } from "./authentication/msalRedirectBridge"
import "./index.css"

// A release removes the chunks of the previous one: a tab opened before it fails to load the
// next page. Reloading picks up the new build; once a minute at most, so a broken one does not loop.
window.addEventListener("vite:preloadError", event => {
    const lastReload = Number(sessionStorage.getItem("chunkReloadAt") ?? 0)
    if (Date.now() - lastReload < 60_000) return
    event.preventDefault()
    sessionStorage.setItem("chunkReloadAt", String(Date.now()))
    window.location.reload()
})

const render = () => createRoot(document.getElementById("root")!).render(<App />)

// The return of a Microsoft login goes to the window that started it, not to a second copy of the app
if (isMsalResponse()) {
    broadcastMsalResponse().catch(error => {
        console.error("Microsoft login response could not be delivered:", error)
        render()
    })
} else {
    render()
}
