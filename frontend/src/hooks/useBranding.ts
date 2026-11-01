import { useTranslation } from "react-i18next"
import { useGlobalParameters } from "@/contexts/GlobalParameterProvider"
import useIsDark from "@/hooks/useIsDark"

export const DEFAULT_LOGO_URL = "/img/logo.png"

const asText = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/**
 * Nome e logo dell'installazione: quelli impostati con INSTALLATION_NAME e INSTALLATION_LOGO_URL, altrimenti quelli di Flightroom.
 * Col tema scuro il logo è INSTALLATION_LOGO_DARK_URL, se impostato.
 */
export const useBranding = () => {
    const { t } = useTranslation()
    const globalParameters = useGlobalParameters()
    const isDark = useIsDark()
    const name = asText(globalParameters.getParameter("branding.name"))
    const logoUrl = asText(globalParameters.getParameter("branding.logoUrl"))
    const logoDarkUrl = asText(globalParameters.getParameter("branding.logoDarkUrl"))

    return {
        name: name ?? t("app.name"),
        logoUrl: (isDark ? logoDarkUrl : undefined) ?? logoUrl ?? DEFAULT_LOGO_URL
    }
}

export default useBranding
