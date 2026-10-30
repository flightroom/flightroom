import { Plus, Trash2 } from "lucide-react"
import { useFieldArray, useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { useProjectEnvironmentsQuery } from "./backendVariables"
import { CHART_RESOURCE_DEFAULTS, type EnvironmentResources, type EnvironmentResourcesFormValues, RESOURCE_FIELDS, ResourceField } from "./containerResources"

export const RESOURCE_LABELS: Record<ResourceField, string> = {
    cpuRequest: "backends.compute.cpu_request",
    cpuLimit: "backends.compute.cpu_limit",
    memoryRequest: "backends.compute.memory_request",
    memoryLimit: "backends.compute.memory_limit"
}

/**
 * The environments that run the container with CPU and memory of their own, e.g. more in production. Each value left
 * empty is the container's, shown as placeholder; an environment is added once.
 */
const EnvironmentResourceFields: React.FC = () => {
    const { t } = useTranslation()
    const { control } = useFormContext()
    const { fields, append, remove } = useFieldArray({ control, name: "environmentResources" })
    const container: (string | undefined)[] = useWatch({ control, name: [...RESOURCE_FIELDS] })
    const environments = useProjectEnvironmentsQuery().data ?? []
    const entries = fields as unknown as (EnvironmentResourcesFormValues & { id: string })[]
    const setApart = new Set(entries.map(entry => entry.environmentId))
    const available = environments.filter(environment => environment._id && !setApart.has(environment._id))
    const inherited = (field: ResourceField) => container[RESOURCE_FIELDS.indexOf(field)]?.trim() || CHART_RESOURCE_DEFAULTS[field]

    return (
        <div className="flex flex-col gap-3 pt-2 md:col-span-2">
            <div>
                <h4 className="text-sm font-semibold">{t("backends.compute.by_environment.title")}</h4>
                <p className="text-sm text-foreground-secondary">{t("backends.compute.by_environment.description")}</p>
            </div>
            {entries.map((entry, index) => (
                <div key={entry.id} className="rounded-md border border-divider p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{environments.find(environment => environment._id === entry.environmentId)?.name ?? entry.environmentId}</span>
                        <Button type="button" variant="secondary" size="sm" aria-label={t("common.remove")} title={t("common.remove")} onClick={() => remove(index)}>
                            <Trash2 />
                        </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-2">
                        {RESOURCE_FIELDS.map(field => (
                            <TextField key={field} name={`environmentResources.${index}.${field}`} label={t(RESOURCE_LABELS[field])} placeholder={inherited(field)} />
                        ))}
                    </div>
                </div>
            ))}
            {available.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {available.map(environment => (
                        <Button
                            key={environment._id}
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => append({ environmentId: environment._id, cpuRequest: "", cpuLimit: "", memoryRequest: "", memoryLimit: "" })}
                        >
                            <Plus />
                            {t("backends.compute.by_environment.add", { environment: environment.name })}
                        </Button>
                    ))}
                </div>
            )}
        </div>
    )
}

/** CPU and memory of a container, for a two-column grid: each one left empty takes the default of the chart, shown as placeholder, and each environment may set its own */
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
            <EnvironmentResourceFields />
        </>
    )
}

/** A value of a container as the detail views show it: the default of the chart when it sets none */
export const ResourceValue: React.FC<{ value?: string | null; field: ResourceField }> = ({ value, field }) => {
    const { t } = useTranslation()

    return value ? <span className="font-mono">{value}</span> : <span className="text-foreground-secondary">{t("backends.compute.default_value", { value: CHART_RESOURCE_DEFAULTS[field] })}</span>
}

/** What each environment sets apart, as the detail views show it: only the values it sets */
export const EnvironmentResourcesValue: React.FC<{ entries?: EnvironmentResources[] | null; environments: EnvironmentDTO[] }> = ({ entries, environments }) => {
    const { t } = useTranslation()

    if (!entries?.length) return <span className="text-foreground-secondary">{t("backends.compute.by_environment.none")}</span>
    return (
        <ul className="flex flex-col gap-1">
            {entries.map(entry => (
                <li key={entry.environmentId} className="text-sm">
                    <span className="font-medium">{environments.find(environment => environment._id === entry.environmentId)?.name ?? entry.environmentId}</span>
                    {": "}
                    {RESOURCE_FIELDS.filter(field => entry[field])
                        .map(field => `${t(RESOURCE_LABELS[field])} ${entry[field]}`)
                        .join(" · ")}
                </li>
            ))}
        </ul>
    )
}

export default ContainerResourceFields
