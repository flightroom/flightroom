import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle, DescriptionItem, DescriptionList, Spinner } from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, ExternalLink, Hammer, Tag } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Navigate, useParams } from "react-router-dom"
import AiWorkspace from "@/components/ai-workspace/AiWorkspace"
import { workspaceRepositoriesOf } from "@/components/ai-workspace/RepositoryBranches"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge, Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import RepositoryLink from "@/components/RepositoryLink"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useServicesApi, { Service } from "@/hooks/apiClients/useServicesApi"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import ServiceBuildDialog from "./partials/ServiceBuildDialog"
import ServiceHeader, { isServiceAiAvailable } from "./partials/ServiceHeader"
import ServiceReleaseDialog from "./partials/ServiceReleaseDialog"
import ServiceVariableMapsSection from "./partials/ServiceVariableMapsSection"
import ServiceVersionsTable from "./partials/ServiceVersionsTable"
import { exposedOrigin, useProjectEnvironmentsQuery } from "./partials/serviceVariables"

/** A path of the service, as declared: no URL is made up from it, the host depends on where the service runs */
const ServicePath: React.FC<{ path?: string | null }> = ({ path }) => {
    const { t } = useTranslation()
    const notifications = useToastNotificationStore()

    if (!path) return "—"

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(path)
            notifications.showSuccessNotification({ message: t("services.configuration.path_copied") })
        } catch {
            notifications.showErrorNotification({ message: t("services.configuration.copy_failed") })
        }
    }

    return (
        <span className="inline-flex items-center gap-1">
            <span className="font-mono">{path}</span>
            <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={t("services.configuration.copy_path")} title={t("services.configuration.copy_path")}>
                <Copy />
            </Button>
        </span>
    )
}

const ServiceLink: React.FC<{ href: string; label: string }> = ({ href, label }) => (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline" title={href}>
        {label}
        <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
)

/** A path of the service under the URL it is exposed at: the exposure path may end with a slash, the paths start with one */
const joinPath = (base: string, path: string) => base.replace(/\/+$/, "") + path

/** Where the service answers in each environment, its exposure path on their host, with the docs and the OpenAPI spec reached from there */
const ServiceUrls: React.FC<{ service: Service; environments: EnvironmentDTO[] }> = ({ service, environments }) => {
    const { t } = useTranslation()
    const exposure = useProjectStore(state => state.project?.exposure)
    const path = service.exposurePath

    return (
        <div>
            <h3 className="mb-2 text-base font-semibold">{t("services.urls.title")}</h3>
            {!path ? (
                <p className="text-sm text-foreground-secondary">{t("services.urls.not_exposed")}</p>
            ) : !exposure?.domain ? (
                // No host to put it on: the path is all there is to show
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-mono">{path}</span>
                    <span className="text-foreground-secondary">{t("services.urls.no_domain")}</span>
                </p>
            ) : environments.length === 0 ? (
                <p className="text-sm text-foreground-secondary">{t("services.urls.no_environments")}</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {environments.map(environment => {
                        const url = exposedOrigin(exposure, environment) + path
                        return (
                            <li key={environment._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                <Badge variant="outline">{environment.name}</Badge>
                                <span className="min-w-0 break-all font-mono">
                                    <ServiceLink href={url} label={url} />
                                </span>
                                {service.docsPath && <ServiceLink href={joinPath(url, service.docsPath)} label={t("services.urls.open_docs")} />}
                                {service.openApiPath && <ServiceLink href={joinPath(url, service.openApiPath)} label={t("services.urls.open_openapi")} />}
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}

const ServiceConfigurationSection: React.FC<{ service: Service; environments: EnvironmentDTO[] }> = ({ service, environments }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("services.configuration.title")}</CardTitle>
                <CardDescription>{t("services.configuration.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("services.port")}>{service.port}</DescriptionItem>
                    <DescriptionItem label={t("services.liveness_path")}>
                        <ServicePath path={service.livenessPath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("services.readiness_path")}>
                        <ServicePath path={service.readinessPath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("services.docs_path")}>
                        <ServicePath path={service.docsPath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("services.openapi_path")}>
                        <ServicePath path={service.openApiPath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("services.exposure_path")}>
                        <ServicePath path={service.exposurePath} />
                    </DescriptionItem>
                    <DescriptionItem label={t("services.image_repository")}>{service.image?.repository ? <span className="font-mono">{service.image.repository}</span> : "—"}</DescriptionItem>
                </DescriptionList>
                <ServiceUrls service={service} environments={environments} />
                <div>
                    <h3 className="mb-2 text-base font-semibold">{t("services.env.title")}</h3>
                    {service.env?.length ? (
                        <ul className="flex flex-col gap-2">
                            {service.env.map(variable => (
                                <li key={variable.name} className="flex flex-wrap items-center gap-2 text-sm">
                                    <span className="font-mono font-medium">{variable.name}</span>
                                    {variable.required && <Badge variant="outline">{t("services.env.required")}</Badge>}
                                    {variable.secret && <Badge variant="outline">{t("services.env.secret")}</Badge>}
                                    {variable.description && <span className="text-foreground-secondary">{variable.description}</span>}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-foreground-secondary">{t("services.env.empty")}</p>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

const ServiceRepositorySection: React.FC<{ service: Service }> = ({ service }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("services.code_repository")}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3 text-sm">
                {service.codeRepository?.enabled ? <RepositoryLink repository={service.codeRepository} /> : <p className="text-foreground-secondary">{t("services.no_repository")}</p>}
            </CardContent>
        </Card>
    )
}

/**
 * The landing screen of a service: Edit with AI on its repository, the same workspace as a frontend's.
 * Without AI editing, the overview takes its place. Not inside an ApiStatusHandler: it unmounts its children on every background refetch, and the workspace holds a draft prompt.
 */
const ServiceAiSection: React.FC<{ serviceQuery: { isPending: boolean; isError: boolean; error: unknown; data?: Service } }> = ({ serviceQuery }) => {
    const { t } = useTranslation()
    const aiModels = useProjectAiModels()

    // The project's AIs decide where the page goes: it waits for them as for the service.
    if (serviceQuery.isPending || aiModels.isPending) {
        return (
            <div className="flex min-h-[200px] items-center justify-center">
                <Spinner size={32} />
            </div>
        )
    }

    if (serviceQuery.isError || !serviceQuery.data) {
        return (
            <Alert variant="destructive">
                <AlertDescription>{serviceQuery.error instanceof Error ? serviceQuery.error.message : t("app.error.generic")}</AlertDescription>
            </Alert>
        )
    }

    const service = serviceQuery.data
    if (!isServiceAiAvailable(service, aiModels.enabled)) return <Navigate to={`/service/${service._id}/overview`} replace />

    return (
        <div className="flex min-h-full flex-col gap-6">
            <ServiceHeader service={service} active="ai" />
            {/* Keyed: the route instance is reused across services, and a draft must not follow the user to another one. */}
            <AiWorkspace key={service._id} target={{ kind: "service", id: service._id! }} name={service.name} repositories={workspaceRepositoriesOf("service", service)} />
        </div>
    )
}

interface ServiceDetailProps {
    /** The overview of the service, or its Edit with AI workspace. */
    view?: "overview" | "ai"
}

const ServiceDetail: React.FC<ServiceDetailProps> = ({ view = "overview" }) => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const servicesApi = useServicesApi()
    const queryClient = useQueryClient()
    const [buildOpen, setBuildOpen] = useState(false)
    const [releaseOpen, setReleaseOpen] = useState(false)
    const isViewer = useIsProjectViewer()

    const serviceQuery = useQuery({ queryKey: ["service", id], queryFn: () => servicesApi.getSingle(id!), enabled: !!id })
    const versionsQuery = useQuery({ queryKey: ["service-versions", id], queryFn: () => servicesApi.getVersions(id!), enabled: !!id && view === "overview" })
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")

    const service = serviceQuery.data
    // A viewer may look, not release: the version is created by those who can write
    const canBuild = Boolean(service?.codeRepository?.enabled) && !isViewer

    if (view === "ai") return <ServiceAiSection serviceQuery={serviceQuery} />

    return (
        <ApiStatusHandler queries={[serviceQuery, versionsQuery, environmentsQuery, configMapsQuery, secretsQuery]} interceptEmpty={false}>
            {service && (
                <div className="flex min-h-full flex-col gap-6">
                    <ServiceHeader
                        service={service}
                        active="overview"
                        actions={
                            !isViewer && (
                                <>
                                    {/* For an image pushed without the CI registration call: the deploy runs the tag set here */}
                                    <Button variant="secondary" onClick={() => setReleaseOpen(true)}>
                                        <Tag />
                                        {t("services.release.action")}
                                    </Button>
                                    {canBuild && (
                                        <Button variant="primary" onClick={() => setBuildOpen(true)}>
                                            <Hammer />
                                            {t("services.build.action")}
                                        </Button>
                                    )}
                                </>
                            )
                        }
                    />
                    {/* Sections are siblings so further ones (e.g. AI) can be added next to them. */}
                    <ServiceRepositorySection service={service} />
                    <ServiceVersionsTable versions={versionsQuery.data ?? []} />
                    <ServiceConfigurationSection service={service} environments={environmentsQuery.data ?? []} />
                    <ServiceVariableMapsSection service={service} configMaps={configMapsQuery.data ?? []} secrets={secretsQuery.data ?? []} environments={environmentsQuery.data ?? []} />
                    {!isViewer && (
                        <ServiceReleaseDialog open={releaseOpen} onOpenChange={setReleaseOpen} service={service} onSaved={() => queryClient.invalidateQueries({ queryKey: ["service", id] })} />
                    )}
                    {canBuild && (
                        <ServiceBuildDialog
                            open={buildOpen}
                            onOpenChange={setBuildOpen}
                            service={service}
                            onBuilt={() => {
                                queryClient.invalidateQueries({ queryKey: ["service-versions", id] })
                                queryClient.invalidateQueries({ queryKey: ["service", id] })
                            }}
                        />
                    )}
                </div>
            )}
        </ApiStatusHandler>
    )
}

export default ServiceDetail
