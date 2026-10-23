import { Card, CardContent, CardDescription, CardHeader, CardTitle, SwitchField } from "@flightroom/design-system"
import { useEffect } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { DesignSystem } from "@/hooks/apiClients/useProjectApi"
import { DesignSystemFields, type DesignSystemFormValues, designSystemFormValues, toDesignSystem } from "./DesignSystemFields"
import { SettingsDetails } from "./SettingsDetails"

type ProjectDesignSystemFormValues = DesignSystemFormValues & {
    /** Spento, il progetto eredita il design system dell'organizzazione */
    override: boolean
}

const formValuesOf = (designSystem?: DesignSystem): ProjectDesignSystemFormValues => ({ ...designSystemFormValues(designSystem), override: Boolean(designSystem?.packageName) })

interface ProjectDesignSystemSectionProps {
    /** Il design system proprio del progetto, nessuno quando eredita quello dell'organizzazione */
    designSystem?: DesignSystem
    organizationDesignSystem?: DesignSystem
    /** `null` quando il progetto torna a ereditare quello dell'organizzazione */
    onUpdate: (designSystem: DesignSystem | null) => void
    isUpdating: boolean
}

/** Il design system dei frontend del progetto: il suo, o quello dell'organizzazione che eredita; un frontend puo' sostituirlo col suo */
export const ProjectDesignSystemSection: React.FC<ProjectDesignSystemSectionProps> = ({ designSystem, organizationDesignSystem, onUpdate, isUpdating }) => {
    const { t } = useTranslation()

    const form = useForm<ProjectDesignSystemFormValues>({ defaultValues: formValuesOf(designSystem) })
    const override = form.watch("override")

    // Cambiare progetto lascia questa pagina montata, quindi il form deve seguire il nuovo progetto.
    useEffect(() => {
        form.reset(formValuesOf(designSystem))
    }, [designSystem, form])

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("designSystem.settings.title")}</CardTitle>
                <CardDescription>{t("designSystem.settings.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(values => onUpdate(values.override ? toDesignSystem(values) : null))} className="flex flex-col gap-4">
                        <SettingsDetails summary={t("settings.howItWorks")} dataTestId="project-design-system-details">
                            <p>{t("designSystem.settings.details")}</p>
                        </SettingsDetails>

                        <SwitchField<ProjectDesignSystemFormValues>
                            name="override"
                            label={t("designSystem.settings.override")}
                            description={t("designSystem.settings.overrideHint")}
                            dataTestId="project-design-system-override"
                        />

                        {override ? (
                            <DesignSystemFields<ProjectDesignSystemFormValues> required dataTestId="project-design-system" />
                        ) : (
                            <p className="text-sm text-muted-foreground" data-testid="project-design-system-inherited">
                                {organizationDesignSystem?.packageName
                                    ? t("designSystem.settings.inherited", { packageName: organizationDesignSystem.packageName })
                                    : t("designSystem.settings.noOrganizationDefault")}
                            </p>
                        )}

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
