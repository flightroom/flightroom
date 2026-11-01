import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useEffect } from "react"
import { useFormContext, useWatch } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import TextField from "@/components/input/TextField.rhf"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import { useProjectEnvironmentsQuery } from "./backendVariables"
import { CHART_REPLICAS_DEFAULT, type ContainerReplicas, type EnvironmentResources } from "./containerResources"
import type { EnvironmentVersion, EnvironmentVersionFormValues } from "./environmentVersions"

/**
 * The version each environment runs, one field per environment in their order: left empty, the environment does not get
 * the container. The server drops the empty ones.
 */
export const EnvironmentVersionFields: React.FC<{ className?: string }> = ({ className }) => {
    const { t } = useTranslation()
    const { control, setValue } = useFormContext()
    const entries: EnvironmentVersionFormValues[] = useWatch({ control, name: "environmentVersions" }) ?? []
    const environments = useProjectEnvironmentsQuery({ inForm: true }).data ?? []
    const missing = environments.filter(environment => !entries.some(entry => entry.environmentId === environment._id))

    // A field per environment, so each one needs an entry: added without dirtying the form, again after a reset
    useEffect(() => {
        if (missing.length === 0) return
        setValue("environmentVersions", [...entries, ...missing.map(environment => ({ environmentId: environment._id, version: "" }))], { shouldDirty: false })
    }, [missing, entries, setValue])

    return (
        <div className={`flex flex-col gap-3 ${className ?? ""}`}>
            <div>
                <h4 className="text-sm font-semibold">{t("backends.version_by_environment.title")}</h4>
                <p className="text-sm text-foreground-secondary">{t("backends.version_by_environment.description")}</p>
            </div>
            {environments.map(environment => {
                const index = entries.findIndex(entry => entry.environmentId === environment._id)
                return index >= 0 ? (
                    <TextField key={environment._id} name={`environmentVersions.${index}.version`} label={environment.name} placeholder={t("backends.version_by_environment.not_deployed")} />
                ) : null
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

/**
 * The version each environment runs, one tile per environment in their order, the version large: the first thing to know
 * of a container is what runs where. An environment without one is not deployed. Given the container, each tile also
 * tells how many replicas it runs there: those of the environment, else its own, else the default of the chart.
 */
export const EnvironmentVersionsCard: React.FC<{
    entries?: EnvironmentVersion[] | null
    environments: EnvironmentDTO[]
    container?: ContainerReplicas & { environmentResources?: EnvironmentResources[] | null }
}> = ({ entries, environments, container }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.version_by_environment.title")}</CardTitle>
                <CardDescription>{t("backends.version_by_environment.summary")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                {environments.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("backends.urls.no_environments")}</p>
                ) : (
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-3">
                        {environments.map(environment => {
                            const version = entries?.find(entry => entry.environmentId === environment._id)?.version
                            const replicas =
                                container && (container.environmentResources?.find(entry => entry.environmentId === environment._id)?.replicas ?? container.replicas ?? CHART_REPLICAS_DEFAULT)
                            return (
                                <li
                                    key={environment._id}
                                    className="flex flex-col gap-1 rounded-lg border border-divider p-3"
                                    style={environment.color ? { borderTopColor: environment.color, borderTopWidth: 3 } : undefined}
                                >
                                    <span className="flex items-center justify-between gap-2 text-sm text-foreground-secondary">
                                        <span className="truncate" title={environment.name}>
                                            {environment.name}
                                        </span>
                                        {environment.isProduction && <Badge variant="outline">{t("domains.deployments.production")}</Badge>}
                                    </span>
                                    {version ? (
                                        <span className="truncate font-mono text-2xl font-semibold" title={version}>
                                            {version}
                                        </span>
                                    ) : (
                                        <span className="text-2xl font-semibold text-foreground-secondary">{t("backends.version_by_environment.not_deployed")}</span>
                                    )}
                                    {/* Not deployed, it runs none whatever it sets */}
                                    {version && replicas != null && <span className="text-sm text-foreground-secondary">{t("backends.version_by_environment.replicas", { count: replicas })}</span>}
                                </li>
                            )
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    )
}

export default EnvironmentVersionFields
