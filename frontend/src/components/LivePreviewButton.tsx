import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import useAiSandboxApi, { AI_SANDBOX_QUERY_KEY } from "@/hooks/apiClients/useAiSandboxApi"
import useOrganizationStore from "@/store/useOrganizationStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** The server asks the gateway at most every 30 seconds: polling faster would only read the same answer */
const SANDBOX_REFRESH_MS = 60_000

/** Starts a preview on the OpenShell gateway, so it is left out while the gateway is not online. */
const LivePreviewButton: React.FC<{ start: () => Promise<string>; isPending?: boolean }> = ({ start, isPending = false }) => {
    const { t } = useTranslation()
    const notifications = useToastNotificationStore()
    const organizationId = useOrganizationStore(state => state.organization?._id)
    const aiSandboxApi = useAiSandboxApi()

    // The same query as the status card of the organization settings, so the two share one answer
    const sandboxQuery = useQuery({
        queryKey: [AI_SANDBOX_QUERY_KEY, organizationId],
        queryFn: () => aiSandboxApi.getStatus(organizationId as string),
        enabled: Boolean(organizationId),
        refetchInterval: SANDBOX_REFRESH_MS
    })

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
