import { Card, CardContent, CardHeader, CardTitle, DescriptionItem, DescriptionList } from "@flightroom/design-system"
import { ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectStore from "@/store/useProjectStore"
import { exposedOrigin } from "./backendVariables"
import { RESOURCE_LABELS } from "./ContainerResourceFields"
import { CHART_REPLICAS_DEFAULT, CHART_RESOURCE_DEFAULTS, type ResourceField } from "./containerResources"

/** What a container declares: a backend, or a frontend served by its own container */
export type ContainerConfiguration = Partial<
    Pick<
        Backend,
        | "port"
        | "livenessPath"
        | "readinessPath"
        | "livenessInitialDelaySeconds"
        | "livenessPeriodSeconds"
        | "readinessInitialDelaySeconds"
        | "readinessPeriodSeconds"
        | "logLevel"
        | "docsPath"
        | "openApiPath"
        | "exposurePath"
        | "image"
        | "env"
        | "cpuRequest"
        | "cpuLimit"
        | "memoryRequest"
        | "memoryLimit"
        | "replicas"
        | "environmentResources"
        | "environmentVersions"
    >
>

const BackendLink: React.FC<{ href: string; label: string }> = ({ href, label }) => (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline" title={href}>
        {label}
        <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
)

/** A path of the backend under the URL it is exposed at: the exposure path may end with a slash, the paths start with one */
const joinPath = (base: string, path: string) => base.replace(/\/+$/, "") + path

/** The port the backend listens on, and where it answers in each environment: its exposure path on their host, with the docs and the OpenAPI spec reached from there */
export const BackendEndpointsCard: React.FC<{ backend: ContainerConfiguration; environments: EnvironmentDTO[] }> = ({ backend, environments }) => {
    const { t } = useTranslation()
    const exposure = useProjectStore(state => state.project?.exposure)
    const path = backend.exposurePath

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.urls.title")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("backends.port")}>{backend.port ?? "—"}</DescriptionItem>
                </DescriptionList>
                {!path ? (
                    <p className="text-sm text-foreground-secondary">{t("backends.urls.not_exposed")}</p>
                ) : !exposure?.domain ? (
                    // No host to put it on: the path is all there is to show
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-mono">{path}</span>
                        <span className="text-foreground-secondary">{t("backends.urls.no_domain")}</span>
                    </p>
                ) : environments.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("backends.urls.no_environments")}</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {environments.map(environment => {
                            const url = exposedOrigin(exposure, environment) + path
                            return (
                                <li key={environment._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                    <Badge variant="outline">{environment.name}</Badge>
                                    <span className="min-w-0 break-all font-mono">
                                        <BackendLink href={url} label={url} />
                                    </span>
                                    {backend.docsPath && <BackendLink href={joinPath(url, backend.docsPath)} label={t("backends.urls.open_docs")} />}
                                    {backend.openApiPath && <BackendLink href={joinPath(url, backend.openApiPath)} label={t("backends.urls.open_openapi")} />}
                                </li>
                            )
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    )
}

/** The replicas, CPU and memory the container runs with in each environment: its own, else the chart's, unless the environment sets them apart, marked custom */
export const ContainerComputeCard: React.FC<{ backend: ContainerConfiguration; environments: EnvironmentDTO[] }> = ({ backend, environments }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.compute.title")}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
                <ul className="flex flex-col gap-2">
                    {environments.map(environment => {
                        const entry = backend.environmentResources?.find(resources => resources.environmentId === environment._id)
                        const value = (field: ResourceField) => entry?.[field] || backend[field] || CHART_RESOURCE_DEFAULTS[field]
                        const pair = (request: ResourceField, limit: ResourceField) => ({
                            value: `${value(request)} / ${value(limit)}`,
                            title: `${t(RESOURCE_LABELS[request])} / ${t(RESOURCE_LABELS[limit])}`
                        })
                        const cpu = pair("cpuRequest", "cpuLimit")
                        const memory = pair("memoryRequest", "memoryLimit")
                        return (
                            <li key={environment._id} className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="min-w-24 font-medium">{environment.name}</span>
                                <Badge variant="outline">
                                    {t("backends.compute.replicas")} <span className="font-mono">{entry?.replicas ?? backend.replicas ?? CHART_REPLICAS_DEFAULT}</span>
                                </Badge>
                                <Badge variant="outline" title={cpu.title}>
                                    {t("backends.compute.cpu")} <span className="font-mono">{cpu.value}</span>
                                </Badge>
                                <Badge variant="outline" title={memory.title}>
                                    {t("backends.compute.memory")} <span className="font-mono">{memory.value}</span>
                                </Badge>
                                {entry && <Badge variant="accent">{t("backends.custom")}</Badge>}
                            </li>
                        )
                    })}
                </ul>
            </CardContent>
        </Card>
    )
}

/** The variables the container declares it reads: with its config maps, secrets and resources, what it uses */
export const ContainerEnvSection: React.FC<{ backend: Pick<ContainerConfiguration, "env"> }> = ({ backend }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.env.title")}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
                {backend.env?.length ? (
                    <ul className="flex flex-col gap-2">
                        {backend.env.map(variable => (
                            <li key={variable.name} className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-mono font-medium">{variable.name}</span>
                                {variable.required && <Badge variant="outline">{t("backends.env.required")}</Badge>}
                                {variable.secret && <Badge variant="outline">{t("backends.env.secret")}</Badge>}
                                {variable.description && <span className="text-foreground-secondary">{variable.description}</span>}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-foreground-secondary">{t("backends.env.empty")}</p>
                )}
            </CardContent>
        </Card>
    )
}
