import { EmptyState } from "@flightroom/design-system"
import { Settings } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Outlet, useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import useArgoCdStatus from "@/hooks/useArgoCdStatus"

/**
 * The pages of the config maps, the secrets and the resources, opened by URL: without Argo CD initialized they reach no
 * container, so a short notice pointing to its settings stands in for the page. Nothing while the status loads, rather
 * than the page flashing before the notice.
 */
const ArgoCdRequired: React.FC = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { initialized, loading } = useArgoCdStatus()

    if (loading) return null
    if (initialized) return <Outlet />

    return (
        <EmptyState
            title={t("settings.argoCd.required.title")}
            description={t("settings.argoCd.required.description")}
            dataTestId="argocd-required"
            actions={
                // The Argo CD section lives in the delivery tab of the settings
                <Button variant="secondary" onClick={() => navigate("/settings?tab=delivery")} dataTestId="argocd-required-settings">
                    <Settings />
                    {t("settings.argoCd.required.open_settings")}
                </Button>
            }
        />
    )
}

export default ArgoCdRequired
