import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import { useAiSandboxStatusQuery } from "@/hooks/apiClients/useAiSandboxApi"
import useOrganizationStore from "@/store/useOrganizationStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** Starts a preview on the OpenShell gateway, so it is left out while the gateway is not online. */
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
                const previewWindow = window.open("about:blank", "_blank")
                if (!previewWindow) {
                    notifications.showErrorNotification({ message: t("frontend.live_preview.popup_blocked") })
                    return
                }
                previewWindow.opener = null
                previewWindow.document.title = t("frontend.live_preview.starting")
                try {
                    previewWindow.location.href = await start()
                } catch {
                    previewWindow.close()
                    notifications.showErrorNotification({ message: t("frontend.live_preview.start_error") })
                }
            }}
        >
            <ExternalLink aria-hidden="true" />
            {t(isPending ? "frontend.live_preview.starting" : "frontend.live_preview.button")}
        </Button>
    )
}

export default LivePreviewButton
