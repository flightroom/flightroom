import { useTranslation } from "react-i18next"
import TextField from "@/components/input/TextField.rhf"
import useProjectStore from "@/store/useProjectStore"
import { effectiveProbe, type ProbeField, type ProbeSide } from "./containerResources"

/** The probe template of the project for the backends (or the frontends), if it sets one */
export const useProbeTemplate = (side: ProbeSide) => useProjectStore(state => state.project?.probes?.[side])

const TIMING_LABELS = {
    livenessInitialDelaySeconds: "backends.liveness_initial_delay",
    livenessPeriodSeconds: "backends.liveness_period",
    readinessInitialDelaySeconds: "backends.readiness_initial_delay",
    readinessPeriodSeconds: "backends.readiness_period"
} as const

/** The six probe fields of a container: blank inherits the project template, shown as the placeholder */
export const ProbeFields: React.FC<{ side: ProbeSide }> = ({ side }) => {
    const { t } = useTranslation()
    const template = useProbeTemplate(side)
    const placeholder = (field: ProbeField) => String(effectiveProbe(field, null, template).value)

    return (
        <>
            <TextField name="livenessPath" label={t("backends.liveness_path")} placeholder={placeholder("livenessPath")} description={t("backends.liveness_path_hint")} />
            <TextField
                name="livenessInitialDelaySeconds"
                type="number"
                label={t(TIMING_LABELS.livenessInitialDelaySeconds)}
                placeholder={placeholder("livenessInitialDelaySeconds")}
                description={t("backends.probe_timing_hint")}
            />
            <TextField
                name="livenessPeriodSeconds"
                type="number"
                label={t(TIMING_LABELS.livenessPeriodSeconds)}
                placeholder={placeholder("livenessPeriodSeconds")}
                description={t("backends.probe_timing_hint")}
            />
            <TextField name="readinessPath" label={t("backends.readiness_path")} placeholder={placeholder("readinessPath")} description={t("backends.readiness_path_hint")} />
            <TextField
                name="readinessInitialDelaySeconds"
                type="number"
                label={t(TIMING_LABELS.readinessInitialDelaySeconds)}
                placeholder={placeholder("readinessInitialDelaySeconds")}
                description={t("backends.probe_timing_hint")}
            />
            <TextField
                name="readinessPeriodSeconds"
                type="number"
                label={t(TIMING_LABELS.readinessPeriodSeconds)}
                placeholder={placeholder("readinessPeriodSeconds")}
                description={t("backends.probe_timing_hint")}
            />
        </>
    )
}

/** The effective value of a probe field on a detail page, marked when the project template supplies it */
export const ProbeValue: React.FC<{ side: ProbeSide; field: ProbeField; own?: string | number | null }> = ({ side, field, own }) => {
    const { t } = useTranslation()
    const template = useProbeTemplate(side)
    const { value, source } = effectiveProbe(field, own, template)
    const isPath = field === "livenessPath" || field === "readinessPath"

    return (
        <span className="inline-flex flex-wrap items-center gap-2">
            <span className={isPath ? "font-mono" : undefined}>{isPath ? value : t("backends.seconds_value", { value })}</span>
            {source === "project" && <span className="text-xs text-foreground-secondary">{t("backends.probe_from_project")}</span>}
        </span>
    )
}
