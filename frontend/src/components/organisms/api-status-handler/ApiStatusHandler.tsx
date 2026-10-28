import { ApiStatusHandler as DesignSystemApiStatusHandler, type IApiStatusHandlerProps } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"

/** ApiStatusHandler del design system con i testi di default tradotti: lista vuota ed errore generico. */
export const ApiStatusHandler: React.FC<IApiStatusHandlerProps> = props => {
    const { t } = useTranslation()

    return <DesignSystemApiStatusHandler emptyLabel={t("common.no_data")} errorLabel={t("app.error.generic")} {...props} />
}

export default ApiStatusHandler
