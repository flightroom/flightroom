import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, SelectField, Switch } from "@flightroom/design-system"
import { useEffect, useState } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import type { ProjectTelemetry, ProjectUpdateDTO } from "@/hooks/apiClients/useProjectApi"
import { TELEMETRY_PROVIDER_IDS, TELEMETRY_PROVIDERS, type TelemetryProvider } from "@/utils/telemetryProviders"
import { SettingsDetails } from "./SettingsDetails"

/** I campi di ogni provider stanno sotto `settings.<provider>.<campo>`: passare da un provider all'altro non perde cio' che e' stato scritto */
export interface ProjectTelemetryFormValues {
    provider: TelemetryProvider
    settings: Record<TelemetryProvider, Record<string, string>>
}

interface ProjectTelemetrySectionProps {
    telemetry?: ProjectTelemetry
    environments: EnvironmentDTO[]
    onUpdate: (telemetry: ProjectUpdateDTO["telemetry"]) => void
    isUpdating: boolean
}

/** I campi non segreti partono dal valore salvato; i segreti vuoti, perche' non tornano mai indietro */
const defaultsOf = (telemetry?: ProjectTelemetry): ProjectTelemetryFormValues => ({
    provider: telemetry?.provider ?? "openTelemetry",
    settings: Object.fromEntries(
        TELEMETRY_PROVIDER_IDS.map(provider => [
            provider,
            Object.fromEntries(TELEMETRY_PROVIDERS[provider].map(field => [field.name, field.secret ? "" : (telemetry?.settings[provider]?.[field.name]?.value ?? "")]))
        ])
    ) as ProjectTelemetryFormValues["settings"]
})

/** Gli ambienti accesi: senza una scelta salvata, tutti */
const enabledOf = (telemetry: ProjectTelemetry | undefined, environments: EnvironmentDTO[]) =>
    Object.fromEntries(environments.map(environment => [environment._id ?? "", !telemetry?.environmentIds || telemetry.environmentIds.includes(environment._id ?? "")]))

/**
 * Dove le applicazioni mandano la telemetria, scelto dal team tra i provider del catalogo: OpenTelemetry, Application Insights,
 * CloudWatch, Google Cloud, Datadog. A ogni Deploy i container degli ambienti accesi ricevono le variabili del provider scelto e
 * gli agenti AI strumentano le applicazioni per lui. Un campo segreto non torna mai indietro: lasciato vuoto conserva quello salvato.
 */
export const ProjectTelemetrySection: React.FC<ProjectTelemetrySectionProps> = ({ telemetry, environments, onUpdate, isUpdating }) => {
    const { t } = useTranslation()
    const form = useForm<ProjectTelemetryFormValues>({ defaultValues: defaultsOf(telemetry) })
    const [enabled, setEnabled] = useState(() => enabledOf(telemetry, environments))
    const provider = form.watch("provider")
    const values = form.watch(`settings.${provider}`)
    const saved = telemetry?.settings[provider]
    const fields = TELEMETRY_PROVIDERS[provider]

    // Dopo un salvataggio, o cambiando progetto, il form e gli switch seguono cio' che e' salvato
    useEffect(() => {
        form.reset(defaultsOf(telemetry))
        setEnabled(enabledOf(telemetry, environments))
    }, [telemetry, environments, form])

    // Gli switch servono solo se il provider passa qualcosa ai container: OpenTelemetry senza endpoint ne' header non passa nulla
    const delivers = fields.some(field => Boolean(values?.[field.name]?.trim()) || Boolean(saved?.[field.name]))

    const submit = (submitted: ProjectTelemetryFormValues) => {
        const ids = environments.map(environment => environment._id ?? "").filter(id => enabled[id])
        const typed = submitted.settings[submitted.provider]
        onUpdate({
            provider: submitted.provider,
            settings: {
                [submitted.provider]: Object.fromEntries(
                    TELEMETRY_PROVIDERS[submitted.provider].flatMap(field => {
                        const value = typed[field.name]?.trim() ?? ""
                        // Un segreto vuoto resta com'e'; un campo in chiaro svuotato si toglie
                        if (field.secret) return value ? [[field.name, value]] : []
                        return [[field.name, value || null]]
                    })
                )
            },
            // Tutti accesi: null, cosi' vale anche per gli ambienti creati dopo
            environmentIds: ids.length === environments.length ? null : ids
        })
    }

    const hasSaved = Object.keys(telemetry?.settings ?? {}).length > 0

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("settings.telemetry.title")}</CardTitle>
                <CardDescription>{t("settings.telemetry.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4">
                        <SettingsDetails summary={t("settings.howItWorks")} dataTestId="project-telemetry-details">
                            <p>{t("settings.telemetry.details")}</p>
                        </SettingsDetails>

                        <SelectField<ProjectTelemetryFormValues>
                            name="provider"
                            label={t("settings.telemetry.providerLabel")}
                            description={t(`settings.telemetry.providerHint.${provider}`)}
                            options={TELEMETRY_PROVIDER_IDS.map(value => ({ value, label: t(`settings.telemetry.providers.${value}`) }))}
                            dataTestId="project-telemetry-provider"
                        />

                        {fields.map(field => {
                            const isSet = Boolean(saved?.[field.name])
                            return (
                                <TextField<ProjectTelemetryFormValues>
                                    key={`${provider}.${field.name}`}
                                    name={`settings.${provider}.${field.name}`}
                                    type={field.secret ? "password" : "text"}
                                    label={t(`settings.telemetry.fields.${provider}.${field.name}.label`)}
                                    placeholder={field.secret && isSet ? t("settings.telemetry.valueSet") : field.example}
                                    description={`${t(`settings.telemetry.fields.${provider}.${field.name}.hint`)} ${t("settings.telemetry.variable", { variable: field.variable })}`}
                                    dataTestId={`project-telemetry-${provider}-${field.name}`}
                                    rules={{
                                        validate: (value: unknown) => {
                                            const text = typeof value === "string" ? value.trim() : ""
                                            if (!text) return !field.required || (field.secret && isSet) || t("settings.telemetry.fieldRequired")
                                            return !field.pattern || field.pattern.test(text) || t("settings.telemetry.fieldInvalid", { example: field.example })
                                        }
                                    }}
                                />
                            )
                        })}

                        {delivers && (
                            <fieldset className="flex flex-col gap-3">
                                <legend className="mb-2 text-sm font-medium">{t("settings.telemetry.environments")}</legend>
                                <p className="text-muted-foreground text-sm">{t("settings.telemetry.environmentsHint")}</p>
                                {environments.length === 0 && <p className="text-muted-foreground text-sm">{t("settings.telemetry.noEnvironments")}</p>}
                                {environments.map(environment => {
                                    const id = environment._id ?? ""
                                    return (
                                        <div key={id} className="flex items-center gap-3">
                                            <Switch
                                                id={`telemetry-environment-${id}`}
                                                checked={enabled[id] ?? false}
                                                disabled={isUpdating}
                                                onCheckedChange={checked => setEnabled(current => ({ ...current, [id]: checked }))}
                                                dataTestId={`project-telemetry-environment-${environment.slug}`}
                                            />
                                            <Label htmlFor={`telemetry-environment-${id}`}>{environment.name}</Label>
                                        </div>
                                    )
                                })}
                            </fieldset>
                        )}

                        <div className="flex justify-end gap-2">
                            {hasSaved && (
                                <Button type="button" variant="secondary" disabled={isUpdating} onClick={() => onUpdate(null)} dataTestId="project-telemetry-remove">
                                    {t("settings.telemetry.remove")}
                                </Button>
                            )}
                            <Button type="submit" loading={isUpdating} loadingLabel={t("common.loading")} dataTestId="project-telemetry-save">
                                {t("common.save")}
                            </Button>
                        </div>
                    </form>
                </FormProvider>
            </CardContent>
        </Card>
    )
}

export default ProjectTelemetrySection
