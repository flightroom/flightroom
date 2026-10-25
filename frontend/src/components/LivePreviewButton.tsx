import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useToastNotificationStore from "@/store/useToastNotificationStore"

const LivePreviewButton: React.FC<{ start: () => Promise<string>; isPending?: boolean }> = ({ start, isPending = false }) => {
    const { t } = useTranslation()
    const notifications = useToastNotificationStore()

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
