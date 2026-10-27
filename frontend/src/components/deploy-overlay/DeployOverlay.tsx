import { useIsMutating } from "@tanstack/react-query"
import { Rocket } from "lucide-react"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import Mascot from "@/components/mascot/Mascot"
import { DEPLOY_MUTATION_KEY } from "@/hooks/apiClients/useDeploymentsApi"
import DeployGame from "./DeployGame"

const MESSAGE_INTERVAL = 6000

const formatElapsed = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0")
    const seconds = String(totalSeconds % 60).padStart(2, "0")
    return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

const useElapsed = (startedAt: number) => {
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(interval)
    }, [])
    return formatElapsed(Math.max(0, Math.floor((now - startedAt) / 1000)))
}

const DeployScreen: React.FC<{ startedAt: number; onHide: () => void }> = ({ startedAt, onHide }) => {
    const { t } = useTranslation()
    const elapsed = useElapsed(startedAt)
    const messages = t("deployments.overlay.messages", { returnObjects: true }) as string[]
    const [messageIndex, setMessageIndex] = useState(() => Math.floor(Math.random() * messages.length))

    useEffect(() => {
        const interval = setInterval(() => setMessageIndex(index => index + 1), MESSAGE_INTERVAL)
        return () => clearInterval(interval)
    }, [])

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            event.stopPropagation()
            onHide()
        }
        window.addEventListener("keydown", onKeyDown, true)
        return () => window.removeEventListener("keydown", onKeyDown, true)
    }, [onHide])

    return (
        // pointer-events-auto: a modal dialog of Radix underneath turns them off on the body
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="deploy-overlay-title"
            className="pointer-events-auto fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 overflow-y-auto bg-background/95 p-4 backdrop-blur-sm"
        >
            <div className="flex flex-col items-center gap-2 text-center">
                <Mascot mood="deploying" className="size-28" />
                <h2 id="deploy-overlay-title" className="text-2xl font-semibold">
                    {t("deployments.overlay.title")}
                </h2>
                <p className="text-sm font-medium tabular-nums text-foreground-secondary">{t("deployments.overlay.elapsed", { time: elapsed })}</p>
                <p className="min-h-6 text-foreground-secondary" aria-live="polite">
                    {messages[messageIndex % messages.length]}
                </p>
            </div>
            <div className="w-full max-w-3xl">
                <DeployGame />
            </div>
            <div className="flex flex-col items-center gap-2">
                <Button variant="secondary" onClick={onHide} dataTestId="deploy-overlay-hide">
                    {t("deployments.overlay.hide")}
                </Button>
                <p className="text-xs text-foreground-secondary">{t("deployments.overlay.hide_hint")}</p>
            </div>
        </div>
    )
}

const DeployPill: React.FC<{ startedAt: number; onShow: () => void }> = ({ startedAt, onShow }) => {
    const { t } = useTranslation()
    const elapsed = useElapsed(startedAt)

    return (
        <div role="status" className="pointer-events-auto fixed bottom-4 right-4 z-[60] flex items-center gap-3 rounded-full border border-border bg-background py-2 pl-4 pr-2 shadow-lg">
            <Rocket className="size-4 text-primary animate-pulse motion-reduce:animate-none" aria-hidden="true" />
            <span className="text-sm tabular-nums">{t("deployments.overlay.pill", { time: elapsed })}</span>
            <Button variant="secondary" size="sm" onClick={onShow} dataTestId="deploy-overlay-show">
                {t("deployments.overlay.show")}
            </Button>
        </div>
    )
}

/**
 * While a deploy runs the whole screen goes to a game and a timer: with GitOps a deploy can take long minutes.
 * The deploy goes on when the screen is hidden, and the next deploy shows it again.
 */
export const DeployOverlay: React.FC = () => {
    const isDeploying = useIsMutating({ mutationKey: DEPLOY_MUTATION_KEY }) > 0
    const [startedAt, setStartedAt] = useState<number | null>(null)
    const [hidden, setHidden] = useState(false)

    useEffect(() => {
        setStartedAt(isDeploying ? Date.now() : null)
        setHidden(false)
    }, [isDeploying])

    if (!isDeploying || startedAt === null) return null

    return createPortal(hidden ? <DeployPill startedAt={startedAt} onShow={() => setHidden(false)} /> : <DeployScreen startedAt={startedAt} onHide={() => setHidden(true)} />, document.body)
}

export default DeployOverlay
