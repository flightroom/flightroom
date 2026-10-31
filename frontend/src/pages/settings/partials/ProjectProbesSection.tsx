import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { zodResolver } from "@hookform/resolvers/zod"
import { useEffect, useMemo } from "react"
import { FormProvider, useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import * as z from "zod"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import { BACKEND_HTTP_PATH } from "@/pages/backends/partials/backendVariables"
import {
    CHART_PROBE_SECONDS_DEFAULT,
    MAX_PROBE_SECONDS,
    PROBE_FIELDS,
    PROBE_PATH_DEFAULTS,
    PROBE_TIMING_FIELDS,
    type ProbeField,
    type ProbePathField,
    type ProbeSide,
    type ProbeTemplate,
    probeFormValues,
    probePaths,
    probeSecondsField,
    probeTimings
} from "@/pages/backends/partials/containerResources"
import { SettingsDetails } from "./SettingsDetails"

const SIDES: ProbeSide[] = ["backend", "frontend"]

type ProbeSideValues = Record<ProbeField, string>
type ProbeFormValues = Record<ProbeSide, ProbeSideValues>

/** What the API receives: a side left blank is removed, one with values replaces the side as a whole */
export type ProjectProbesPayload = Record<ProbeSide, ProbeTemplate | null>

interface ProjectProbesSectionProps {
    probes?: { backend?: ProbeTemplate; frontend?: ProbeTemplate }
    onUpdate: (values: ProjectProbesPayload) => void
    isUpdating: boolean
}

const fieldsOf = (probes?: ProjectProbesSectionProps["probes"]): ProbeFormValues => ({ backend: probeFormValues(probes?.backend), frontend: probeFormValues(probes?.frontend) })

const LABELS: Record<ProbeField, string> = {
    livenessPath: "backends.liveness_path",
    livenessInitialDelaySeconds: "backends.liveness_initial_delay",
    livenessPeriodSeconds: "backends.liveness_period",
    readinessPath: "backends.readiness_path",
    readinessInitialDelaySeconds: "backends.readiness_initial_delay",
    readinessPeriodSeconds: "backends.readiness_period"
}

/** The probe template of the project: what backends (and DOCKER frontends) inherit, each one free to override any field */
export const ProjectProbesSection: React.FC<ProjectProbesSectionProps> = ({ probes, onUpdate, isUpdating }) => {
    const { t } = useTranslation()

    const schema = useMemo(() => {
        const path = z
            .string()
            .trim()
            .refine(value => value === "" || BACKEND_HTTP_PATH.test(value), t("backends.path_invalid"))
        const side = z.object({
            livenessPath: path,
            readinessPath: path,
            livenessInitialDelaySeconds: probeSecondsField(0, t("backends.probe_initial_delay_invalid", { max: MAX_PROBE_SECONDS })),
            livenessPeriodSeconds: probeSecondsField(1, t("backends.probe_period_invalid", { max: MAX_PROBE_SECONDS })),
            readinessInitialDelaySeconds: probeSecondsField(0, t("backends.probe_initial_delay_invalid", { max: MAX_PROBE_SECONDS })),
            readinessPeriodSeconds: probeSecondsField(1, t("backends.probe_period_invalid", { max: MAX_PROBE_SECONDS }))
        })
        return z.object({ backend: side, frontend: side })
    }, [t])

    const form = useForm<ProbeFormValues>({ defaultValues: fieldsOf(probes), resolver: zodResolver(schema) })

    // Cambiare progetto lascia questa pagina montata, quindi il form deve seguire il nuovo progetto.
    useEffect(() => {
        form.reset(fieldsOf(probes))
    }, [probes, form])

    const onSubmit = (values: ProbeFormValues) => {
        const sideOf = (side: ProbeSide): ProbeTemplate | null => {
            const own = values[side]
            if (PROBE_FIELDS.every(field => !own[field].trim())) return null
            return { ...probePaths(own), ...probeTimings(own) }
        }
        onUpdate({ backend: sideOf("backend"), frontend: sideOf("frontend") })
    }

    const placeholderOf = (field: ProbeField) => String(field in PROBE_PATH_DEFAULTS ? PROBE_PATH_DEFAULTS[field as ProbePathField] : CHART_PROBE_SECONDS_DEFAULT)

    return (
        <Card className="pt-4">
            <CardHeader>
                <CardTitle as="h2">{t("settings.probes.title")}</CardTitle>
                <CardDescription>{t("settings.probes.subtitle")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
                <FormProvider {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
                        <SettingsDetails summary={t("settings.howItWorks")} dataTestId="project-probes-details">
                            <p>{t("settings.probes.details")}</p>
                        </SettingsDetails>

                        {SIDES.map(side => (
                            <section key={side} className="flex flex-col gap-3 rounded-md border border-border p-4">
                                <div>
                                    <h3 className="text-sm font-semibold">{t(`settings.probes.${side}_title`)}</h3>
                                    <p className="text-sm text-foreground-secondary">{t(`settings.probes.${side}_description`)}</p>
                                </div>
                                <div className="grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-2">
                                    {PROBE_FIELDS.map(field => (
                                        <TextField
                                            key={field}
                                            name={`${side}.${field}`}
                                            type={PROBE_TIMING_FIELDS.includes(field as never) ? "number" : "text"}
                                            label={t(LABELS[field])}
                                            placeholder={placeholderOf(field)}
                                            description={t("settings.probes.field_hint")}
                                            dataTestId={`project-probes-${side}-${field}`}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}

                        <div className="flex justify-end">
                            <Button type="submit" loading={isUpdating} loadingLabel={t("common.loading")} dataTestId="project-probes-save">
                                {t("common.save")}
                            </Button>
                        </div>
                    </form>
                </FormProvider>
            </CardContent>
        </Card>
    )
}

export default ProjectProbesSection
