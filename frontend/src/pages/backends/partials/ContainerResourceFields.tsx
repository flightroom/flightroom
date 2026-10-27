import { useTranslation } from "react-i18next"
import TextField from "@/components/input/TextField.rhf"
import { CHART_RESOURCE_DEFAULTS, RESOURCE_FIELDS, ResourceField } from "./containerResources"

export const RESOURCE_LABELS: Record<ResourceField, string> = {
    cpuRequest: "backends.compute.cpu_request",
    cpuLimit: "backends.compute.cpu_limit",
    memoryRequest: "backends.compute.memory_request",
    memoryLimit: "backends.compute.memory_limit"
}

/** CPU and memory of a container, for a two-column grid: each one left empty takes the default of the chart, shown as placeholder */
export const ContainerResourceFields: React.FC = () => {
    const { t } = useTranslation()

    return (
        <>
            {RESOURCE_FIELDS.map(field => (
                <TextField
                    key={field}
                    name={field}
                    label={t(RESOURCE_LABELS[field])}
                    placeholder={CHART_RESOURCE_DEFAULTS[field]}
                    description={t("backends.compute.default_hint", { value: CHART_RESOURCE_DEFAULTS[field] })}
                />
            ))}
        </>
    )
}

/** A value of a container as the detail views show it: the default of the chart when it sets none */
export const ResourceValue: React.FC<{ value?: string | null; field: ResourceField }> = ({ value, field }) => {
    const { t } = useTranslation()

    return value ? <span className="font-mono">{value}</span> : <span className="text-foreground-secondary">{t("backends.compute.default_value", { value: CHART_RESOURCE_DEFAULTS[field] })}</span>
}

export default ContainerResourceFields
