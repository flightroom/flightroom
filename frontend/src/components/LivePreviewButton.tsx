import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import { useAiSandboxStatusQuery } from "@/hooks/apiClients/useAiSandboxApi"
import useOrganizationStore from "@/store/useOrganizationStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/**
 * Starts a preview on the OpenShell gateway, so it is left out while the gateway is not online. The window opens once
 * the link is there; a browser that blocks it, as the click is long gone by then, gets the link in a notification.
 */
const LivePreviewButton: React.FC<{ start: () => Promise<string>; isPending?: boolean }> = ({ start, isPending = false }) => {
    const { t } = useTranslation()
    const notifications = useToastNotificationStore()
    const organizationId = useOrganizationStore(state => state.organization?._id)
    const sandboxQuery = useAiSandboxStatusQuery(organizationId)

    if (sandboxQuery.data?.status !== "online") return null

    return (
        <Button
            type="button"
            variant="secondary"
            disabled={isPending}
            aria-busy={isPending}
            onClick={async () => {
                let url: string
                try {
                    url = await start()
                } catch {
                    notifications.showErrorNotification({ message: t("frontend.live_preview.start_error") })
                    return
                }
                const previewWindow = window.open(url, "_blank")
                if (previewWindow) {
                    previewWindow.opener = null
                    return
                }
                notifications.showInfoNotification({
                    duration: 60_000,
                    message: (
                        <span>
                            {t("frontend.live_preview.popup_blocked")}{" "}
                            <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                                {t("frontend.live_preview.open")}
                            </a>
                        </span>
                    )
                })
            }}
        >
            <ExternalLink aria-hidden="true" />
            {t(isPending ? "frontend.live_preview.starting" : "frontend.live_preview.button")}
        </Button>
    )
}

export default LivePreviewButton
