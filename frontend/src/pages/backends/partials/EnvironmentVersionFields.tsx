import { Plus, Trash2 } from "lucide-react"
import { useFieldArray, useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { useProjectEnvironmentsQuery } from "./backendVariables"
import type { EnvironmentVersion, EnvironmentVersionFormValues } from "./environmentVersions"

const environmentName = (environments: EnvironmentDTO[], environmentId: string) => environments.find(environment => environment._id === environmentId)?.name ?? environmentId

/**
 * The environments that run a version of their own, e.g. production held on an older one while the others take the
 * latest. One left empty runs the container's, shown as placeholder; an environment is added once.
 */
export const EnvironmentVersionFields: React.FC<{ className?: string }> = ({ className }) => {
    const { t } = useTranslation()
    const { control } = useFormContext()
    const { fields, append, remove } = useFieldArray({ control, name: "environmentVersions" })
    const version: string | undefined = useWatch({ control, name: "version" })
    const environments = useProjectEnvironmentsQuery({ inForm: true }).data ?? []
    const entries = fields as unknown as (EnvironmentVersionFormValues & { id: string })[]
    const setApart = new Set(entries.map(entry => entry.environmentId))
    const available = environments.filter(environment => environment._id && !setApart.has(environment._id))

    return (
        <div className={`flex flex-col gap-3 ${className ?? ""}`}>
            <div>
                <h4 className="text-sm font-semibold">{t("backends.version_by_environment.title")}</h4>
                <p className="text-sm text-foreground-secondary">{t("backends.version_by_environment.description")}</p>
            </div>
            {entries.map((entry, index) => (
                <div key={entry.id} className="flex items-end gap-2">
                    <TextField
                        name={`environmentVersions.${index}.version`}
                        label={environmentName(environments, entry.environmentId)}
                        placeholder={version?.trim() || t("backends.version_by_environment.no_version")}
                        containerClassName="flex-1"
                    />
                    <Button type="button" variant="secondary" size="sm" aria-label={t("common.remove")} title={t("common.remove")} onClick={() => remove(index)}>
                        <Trash2 />
                    </Button>
                </div>
            ))}
            {available.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {available.map(environment => (
                        <Button key={environment._id} type="button" variant="secondary" size="sm" onClick={() => append({ environmentId: environment._id, version: "" })}>
                            <Plus />
                            {t("backends.version_by_environment.add", { environment: environment.name })}
                        </Button>
                    ))}
                </div>
            )}
        </div>
    )
}

/** What each environment runs apart, as the detail views show it */
export const EnvironmentVersionsValue: React.FC<{ entries?: EnvironmentVersion[] | null; environments: EnvironmentDTO[] }> = ({ entries, environments }) => {
    const { t } = useTranslation()

    if (!entries?.length) return <span className="text-foreground-secondary">{t("backends.version_by_environment.none")}</span>
    return (
        <ul className="flex flex-col gap-1">
            {entries.map(entry => (
                <li key={entry.environmentId} className="text-sm">
                    <span className="font-medium">{environmentName(environments, entry.environmentId)}</span>
                    {": "}
                    <span className="font-mono">{entry.version}</span>
                </li>
            ))}
        </ul>
    )
}

export default EnvironmentVersionFields
