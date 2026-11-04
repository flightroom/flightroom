import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import TextareaField from "@/components/input/TextareaField.rhf"
import { CONTEXT_MAX_LENGTH } from "@/pages/settings/partials/ProjectContextSection"

/** The notes for the agents: the design system comes from the project, else the organization */
export const ContextTab: React.FC = () => {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle className="mb-0">{t("frontend.context.title")}</CardTitle>
                    <CardDescription>{t("frontend.context.subtitle")}</CardDescription>
                </CardHeader>
                <CardContent className="pt-3">
                    <TextareaField
                        name="context"
                        maxLength={CONTEXT_MAX_LENGTH}
                        label={t("frontend.context.label")}
                        placeholder={t("frontend.context.placeholder")}
                        description={t("frontend.context.hint")}
                        rows={12}
                        className="font-mono text-sm"
                        dataTestId="frontend-context"
                    />
                </CardContent>
            </Card>
        </div>
    )
}
