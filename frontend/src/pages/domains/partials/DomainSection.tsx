import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import DomainSelectField from "./DomainSelectField"

/** The domain of a frontend or a backend, in a card of its own in the General tab of its settings */
export const DomainSection: React.FC = () => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("domains.field.label")}</CardTitle>
                <CardDescription>{t("domains.field.section_description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                <DomainSelectField containerClassName="w-full" />
            </CardContent>
        </Card>
    )
}

export default DomainSection
