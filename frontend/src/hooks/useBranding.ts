import { useTranslation } from "react-i18next"
import { useGlobalParameters } from "@/contexts/GlobalParameterProvider"

export const DEFAULT_LOGO_URL = "/img/logo.png"

/** Nome e logo dell'installazione: quelli impostati con INSTALLATION_NAME e INSTALLATION_LOGO_URL, altrimenti quelli di Flightroom */
export const useBranding = () => {
    const { t } = useTranslation()
    const globalParameters = useGlobalParameters()
    const name = globalParameters.getParameter("branding.name")
    const logoUrl = globalParameters.getParameter("branding.logoUrl")

    return {
        name: typeof name === "string" && name ? name : t("app.name"),
        logoUrl: typeof logoUrl === "string" && logoUrl ? logoUrl : DEFAULT_LOGO_URL
    }
}

export default useBranding
