import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useEffect } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { DesignSystem } from "@/hooks/apiClients/useProjectApi"
import { DesignSystemFields, type DesignSystemFormValues, designSystemFormValues } from "./DesignSystemFields"
import { SettingsDetails } from "./SettingsDetails"

interface ProjectDesignSystemSectionProps {
    designSystem?: DesignSystem
    onUpdate: (values: DesignSystemFormValues) => void
    isUpdating: boolean
}

/** Il design system di default dei frontend: guida chi li costruisce e gli agenti AI, e un frontend puo' sostituirlo col suo */
export const ProjectDesignSystemSection: React.FC<ProjectDesignSystemSectionProps> = ({ designSystem, onUpdate, isUpdating }) => {
    const { t } = useTranslation()

    const form = useForm<DesignSystemFormValues>({ defaultValues: designSystemFormValues(designSystem) })

    // Cambiare progetto lascia questa pagina montata, quindi il form deve seguire il nuovo progetto.
    useEffect(() => {
        form.reset(designSystemFormValues(designSystem))
    }, [designSystem, form])

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("designSystem.settings.title")}</CardTitle>
                <CardDescription>{t("designSystem.settings.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onUpdate)} className="flex flex-col gap-4">
                        <SettingsDetails summary={t("settings.howItWorks")} dataTestId="project-design-system-details">
                            <p>{t("designSystem.settings.details")}</p>
                        </SettingsDetails>

                        <DesignSystemFields<DesignSystemFormValues> dataTestId="project-design-system" />

                        <div className="flex justify-end">
                            <Button type="submit" loading={isUpdating} loadingLabel={t("common.loading")} dataTestId="project-design-system-save">
                                {t("common.save")}
                            </Button>
                        </div>
                    </form>
                </FormProvider>
            </CardContent>
        </Card>
    )
}

export default ProjectDesignSystemSection
