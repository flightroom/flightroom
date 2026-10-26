import { createRoot } from "react-dom/client"
import App from "./App.tsx"
import { broadcastMsalResponse, isMsalResponse } from "./authentication/msalRedirectBridge"
import "./index.css"

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
