import { Maximize, Minimize } from "lucide-react"
import { type RefObject, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"

/**
 * Puts the map alone over the whole screen and back: the browser sizes it, and the map, which observes its own
 * size, follows. Esc, or leaving the page from a click on a world, puts it back too.
 */
const GalaxyFullscreenButton: React.FC<{ targetRef: RefObject<HTMLElement | null> }> = ({ targetRef }) => {
    const { t } = useTranslation()
    const [fullscreen, setFullscreen] = useState(false)

    useEffect(() => {
        const onChange = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === targetRef.current)
        document.addEventListener("fullscreenchange", onChange)
        return () => document.removeEventListener("fullscreenchange", onChange)
    }, [targetRef])

    if (!document.fullscreenEnabled) return null

    const toggle = () => {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void targetRef.current?.requestFullscreen()
    }
    const label = t(fullscreen ? "domains.galaxy.exit_fullscreen" : "domains.galaxy.fullscreen")

    return (
        <Button variant="secondary" size="icon" aria-pressed={fullscreen} aria-label={label} title={label} onClick={toggle} dataTestId="domain-galaxy-fullscreen">
            {fullscreen ? <Minimize /> : <Maximize />}
        </Button>
    )
}

export default GalaxyFullscreenButton
