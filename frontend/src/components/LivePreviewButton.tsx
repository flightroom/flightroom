import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"

const LivePreviewButton: React.FC<{ url?: string; isPending?: boolean }> = ({ url, isPending = false }) => {
    const { t } = useTranslation()
    const disabled = isPending || !url

    return (
        <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            title={disabled && !isPending ? t("frontend.live_preview.unavailable") : undefined}
            aria-label={disabled && !isPending ? `${t("frontend.live_preview.button")}: ${t("frontend.live_preview.unavailable")}` : undefined}
            onClick={() => {
                if (url) window.open(url, "_blank", "noopener,noreferrer")
            }}
        >
            <ExternalLink aria-hidden="true" />
            {t("frontend.live_preview.button")}
        </Button>
    )
}

export default LivePreviewButton
