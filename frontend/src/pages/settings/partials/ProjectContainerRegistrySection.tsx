import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useEffect } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import { SettingsDetails } from "./SettingsDetails"

/** Stessa regola del backend (CONTAINER_REGISTRY): un host, con porta e namespace se servono, senza schema né slash finale */
const CONTAINER_REGISTRY = /^(?=.{1,255}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/

export interface ProjectContainerRegistryFormValues {
    containerRegistry: string
}

interface ProjectContainerRegistrySectionProps {
    containerRegistry?: string
    onUpdate: (values: ProjectContainerRegistryFormValues) => void
    isUpdating: boolean
}

/** Il registry delle immagini: un servizio o un frontend Docker senza repository immagine suo viene deployato come <registry>/<slug> */
export const ProjectContainerRegistrySection: React.FC<ProjectContainerRegistrySectionProps> = ({ containerRegistry, onUpdate, isUpdating }) => {
    const { t } = useTranslation()

    const form = useForm<ProjectContainerRegistryFormValues>({ defaultValues: { containerRegistry: containerRegistry ?? "" } })

    // Cambiare progetto lascia questa pagina montata, quindi il form deve seguire il nuovo progetto.
    useEffect(() => {
        form.reset({ containerRegistry: containerRegistry ?? "" })
    }, [containerRegistry, form])

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("settings.containerRegistry.title")}</CardTitle>
                <CardDescription>{t("settings.containerRegistry.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onUpdate)} className="flex flex-col gap-4">
                        <SettingsDetails summary={t("settings.howItWorks")} dataTestId="project-container-registry-details">
                            <p>{t("settings.containerRegistry.details")}</p>
                        </SettingsDetails>

                        <TextField<ProjectContainerRegistryFormValues>
                            name="containerRegistry"
                            label={t("settings.containerRegistry.label")}
                            placeholder="ghcr.io/acme"
                            description={t("settings.containerRegistry.hint")}
                            dataTestId="project-container-registry"
                            // Il backend toglie gli spazi e lo slash finale: qui si controlla quello che salverà
                            rules={{ validate: value => !value.trim() || CONTAINER_REGISTRY.test(value.trim().replace(/\/+$/, "")) || t("settings.containerRegistry.invalid") }}
                        />

                        <div className="flex justify-end">
                            <Button type="submit" loading={isUpdating} loadingLabel={t("common.loading")} dataTestId="project-container-registry-save">
                                {t("common.save")}
                            </Button>
                        </div>
                    </form>
                </FormProvider>
            </CardContent>
        </Card>
    )
}

export default ProjectContainerRegistrySection
