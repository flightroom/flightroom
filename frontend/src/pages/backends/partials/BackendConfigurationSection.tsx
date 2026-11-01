import { Card, CardContent, CardDescription, CardHeader, CardTitle, DescriptionItem, DescriptionList } from "@flightroom/design-system"
import { Copy, ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useProjectStore from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { exposedOrigin } from "./backendVariables"
import { EnvironmentResourcesValue, ReplicasValue } from "./ContainerResourceFields"
import { LogLevelValue } from "./LogLevelOverrideField"

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

/** A path of the backend, as declared: no URL is made up from it, the host depends on where the backend runs */
const BackendPath: React.FC<{ path?: string | null }> = ({ path }) => {
    const { t } = useTranslation()
    const notifications = useToastNotificationStore()

    if (!path) return "—"

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(path)
            notifications.showSuccessNotification({ message: t("backends.configuration.path_copied") })
        } catch {
            notifications.showErrorNotification({ message: t("backends.configuration.copy_failed") })
        }
    }

    return (
        <span className="inline-flex items-center gap-1">
            <span className="font-mono">{path}</span>
            <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={t("backends.configuration.copy_path")} title={t("backends.configuration.copy_path")}>
                <Copy />
            </Button>
        </span>
    )
}

const BackendLink: React.FC<{ href: string; label: string }> = ({ href, label }) => (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline" title={href}>
        {label}
        <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
)

/** A path of the backend under the URL it is exposed at: the exposure path may end with a slash, the paths start with one */
const joinPath = (base: string, path: string) => base.replace(/\/+$/, "") + path

/** Where the backend answers in each environment, its exposure path on their host, with the docs and the OpenAPI spec reached from there */
const BackendUrls: React.FC<{ backend: ContainerConfiguration; environments: EnvironmentDTO[] }> = ({ backend, environments }) => {
    const { t } = useTranslation()
    const exposure = useProjectStore(state => state.project?.exposure)
    const path = backend.exposurePath

    return (
        <div>
            <h3 className="mb-2 text-base font-semibold">{t("backends.urls.title")}</h3>
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
        </div>
    )
}

interface BackendConfigurationSectionProps {
    backend: ContainerConfiguration
    environments: EnvironmentDTO[]
    /** Under the title: whose container it is */
    description?: string
}

export const BackendConfigurationSection: React.FC<BackendConfigurationSectionProps> = ({ backend, environments, description }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.configuration.title")}</CardTitle>
                <CardDescription>{description ?? t("backends.configuration.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("backends.port")}>{backend.port ?? "—"}</DescriptionItem>
                    <DescriptionItem label={t("backends.exposure_path")}>
                        <BackendPath path={backend.exposurePath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("backends.docs_path")}>
                        <BackendPath path={backend.docsPath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("backends.openapi_path")}>
                        <BackendPath path={backend.openApiPath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("backends.log_level")}>
                        <LogLevelValue value={backend.logLevel} />
                    </DescriptionItem>
                    <DescriptionItem label={t("backends.compute.replicas")}>
                        <ReplicasValue value={backend.replicas} />
                    </DescriptionItem>
                    <DescriptionItem label={t("backends.compute.by_environment.title")}>
                        <EnvironmentResourcesValue entries={backend.environmentResources} environments={environments} />
                    </DescriptionItem>
                </DescriptionList>
                <BackendUrls backend={backend} environments={environments} />
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

export default BackendConfigurationSection
