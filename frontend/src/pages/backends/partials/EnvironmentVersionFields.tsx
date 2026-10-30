import { Plus, Trash2 } from "lucide-react"
import { useFieldArray, useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { useProjectEnvironmentsQuery } from "./backendVariables"
import type { EnvironmentVersion, EnvironmentVersionFormValues } from "./environmentVersions"

/**
 * The version each environment runs, one row per environment in their order: an environment with none does not get the
 * container. Setting one starts from the latest version, the one above.
 */
export const EnvironmentVersionFields: React.FC<{ className?: string }> = ({ className }) => {
    const { t } = useTranslation()
    const { control } = useFormContext()
    const { fields, append, remove } = useFieldArray({ control, name: "environmentVersions" })
    const latest: string | undefined = useWatch({ control, name: "version" })
    const environments = useProjectEnvironmentsQuery({ inForm: true }).data ?? []
    const entries = fields as unknown as (EnvironmentVersionFormValues & { id: string })[]

    return (
        <div className={`flex flex-col gap-3 ${className ?? ""}`}>
            <div>
                <h4 className="text-sm font-semibold">{t("backends.version_by_environment.title")}</h4>
                <p className="text-sm text-foreground-secondary">{t("backends.version_by_environment.description")}</p>
            </div>
            {environments.map(environment => {
                const index = entries.findIndex(entry => entry.environmentId === environment._id)
                return index >= 0 ? (
                    <div key={environment._id} className="flex items-end gap-2">
                        <TextField name={`environmentVersions.${index}.version`} label={environment.name} placeholder="1.0.0" containerClassName="flex-1" />
                        <Button type="button" variant="secondary" size="sm" aria-label={t("common.remove")} title={t("common.remove")} onClick={() => remove(index)}>
                            <Trash2 />
                        </Button>
                    </div>
                ) : (
                    <div key={environment._id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-divider px-3 py-2">
                        <span className="text-sm">
                            <span className="font-medium">{environment.name}</span>
                            <span className="text-foreground-secondary"> · {t("backends.version_by_environment.not_deployed")}</span>
                        </span>
                        <Button type="button" variant="secondary" size="sm" onClick={() => append({ environmentId: environment._id, version: latest?.trim() ?? "" })}>
                            <Plus />
                            {t("backends.version_by_environment.set")}
                        </Button>
                    </div>
                )
            })}
        </div>
    )
}

/** The version each environment runs, as the detail views show it: an environment with none is not deployed */
export const EnvironmentVersionsValue: React.FC<{ entries?: EnvironmentVersion[] | null; environments: EnvironmentDTO[] }> = ({ entries, environments }) => {
    const { t } = useTranslation()

    if (environments.length === 0) return <span className="text-foreground-secondary">—</span>
    return (
        <ul className="flex flex-col gap-1">
            {environments.map(environment => {
                const version = entries?.find(entry => entry.environmentId === environment._id)?.version
                return (
                    <li key={environment._id} className="flex items-center gap-2 text-sm">
                        <Badge variant="outline">{environment.name}</Badge>
                        {version ? <span className="font-mono">{version}</span> : <span className="text-foreground-secondary">{t("backends.version_by_environment.not_deployed")}</span>}
                    </li>
                )
            })}
        </ul>
    )
}

export default EnvironmentVersionFields
