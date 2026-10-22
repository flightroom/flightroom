import { Card, CardContent, CardDescription, CardHeader, CardTitle, SelectField } from "@flightroom/design-system"
import { useEffect } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import { technologyIconUrl } from "@/components/technology/technologyIcons"
import { BACKEND_TECHNOLOGIES, type BackendTechnology, FRONTEND_TECHNOLOGIES, type FrontendTechnology, type ProjectTechnologies, TECHNOLOGY_LABEL_KEYS, type Technology } from "@/utils/technologies"
import { SettingsDetails } from "./SettingsDetails"

// La select non accetta un valore vuoto: "nessuna" ha un valore suo, che non e' una tecnologia
const NO_TECHNOLOGY = "__none__"

interface TechnologyFields {
    frontend: FrontendTechnology | typeof NO_TECHNOLOGY
    backend: BackendTechnology | typeof NO_TECHNOLOGY
}

export interface ProjectTechnologiesFormValues {
    frontend?: FrontendTechnology
    backend?: BackendTechnology
}

interface ProjectTechnologiesSectionProps {
    technologies?: ProjectTechnologies
    onUpdate: (values: ProjectTechnologiesFormValues) => void
    isUpdating: boolean
}

const fieldsOf = (technologies?: ProjectTechnologies): TechnologyFields => ({ frontend: technologies?.frontend ?? NO_TECHNOLOGY, backend: technologies?.backend ?? NO_TECHNOLOGY })

/** Le tecnologie di default del progetto: preselezionano i template e guidano gli agenti AI, senza escludere le altre */
export const ProjectTechnologiesSection: React.FC<ProjectTechnologiesSectionProps> = ({ technologies, onUpdate, isUpdating }) => {
    const { t } = useTranslation()

    const form = useForm<TechnologyFields>({ defaultValues: fieldsOf(technologies) })

    // Cambiare progetto lascia questa pagina montata, quindi il form deve seguire il nuovo progetto.
    useEffect(() => {
        form.reset(fieldsOf(technologies))
    }, [technologies, form])

    const optionsOf = (values: readonly Technology[]) => [
        { value: NO_TECHNOLOGY, label: t("technologies.settings.none") },
        ...values.map(technology => ({ value: technology, label: t(TECHNOLOGY_LABEL_KEYS[technology]), icon: technologyIconUrl(technology) }))
    ]

    const onSubmit = (values: TechnologyFields) =>
        onUpdate({
            frontend: values.frontend === NO_TECHNOLOGY ? undefined : values.frontend,
            backend: values.backend === NO_TECHNOLOGY ? undefined : values.backend
        })

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("technologies.settings.title")}</CardTitle>
                <CardDescription>{t("technologies.settings.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
                        <SettingsDetails summary={t("settings.howItWorks")} dataTestId="project-technologies-details">
                            <p>{t("technologies.settings.details")}</p>
                        </SettingsDetails>

                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                            <SelectField<TechnologyFields>
                                name="frontend"
                                label={t("technologies.settings.frontend_label")}
                                description={t("technologies.settings.frontend_hint")}
                                containerClassName="flex-[1_1_240px]"
                                options={optionsOf(FRONTEND_TECHNOLOGIES)}
                                dataTestId="project-technology-frontend"
                            />
                            <SelectField<TechnologyFields>
                                name="backend"
                                label={t("technologies.settings.backend_label")}
                                description={t("technologies.settings.backend_hint")}
                                containerClassName="flex-[1_1_240px]"
                                options={optionsOf(BACKEND_TECHNOLOGIES)}
                                dataTestId="project-technology-backend"
                            />
                        </div>

                        <div className="flex justify-end">
                            <Button type="submit" loading={isUpdating} loadingLabel={t("common.loading")} dataTestId="project-technologies-save">
                                {t("common.save")}
                            </Button>
                        </div>
                    </form>
                </FormProvider>
            </CardContent>
        </Card>
    )
}

export default ProjectTechnologiesSection
