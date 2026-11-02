import { Card, CardContent, CardDescription, CardHeader, CardTitle, DescriptionItem, DescriptionList, Tabs, TabsContent, TabsList, TabsTrigger } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { Boxes, Info, Rocket, ScrollText, Server, Variable } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useParams, useSearchParams } from "react-router-dom"
import AiUsageSummary from "@/components/ai-usage/AiUsageSummary"
import ApplicationLogsSection from "@/components/application-logs/ApplicationLogsSection"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import useFrontendsApi, { CanaryType, Frontend, FrontendKind, HostedOn } from "@/hooks/apiClients/useFrontendsApi"
import useStorageApi, { Storage } from "@/hooks/apiClients/useStorageApi"
import useArgoCdInitialized from "@/hooks/useArgoCdInitialized"
import { BackendEndpointsCard, ContainerComputeCard, ContainerEnvSection } from "@/pages/backends/partials/BackendConfigurationSection"
import BackendVariableMapsSection from "@/pages/backends/partials/BackendVariableMapsSection"
import BackendVersionsTable from "@/pages/backends/partials/BackendVersionsTable"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import ContainerEnvironmentCard from "@/pages/backends/partials/ContainerEnvironmentCard"
import { EnvironmentVersionsCard } from "@/pages/backends/partials/EnvironmentVersionFields"
import { LogLevelCard } from "@/pages/backends/partials/LogLevelOverrideField"
import { FrontendActions, FrontendHeader, isAiEditAvailable } from "@/pages/frontends/partials/components"
import { CANARY_DEPLOYMENT_TYPE_LABEL_KEYS, CANARY_TYPE_LABEL_KEYS, HOST_TYPE_LABEL_KEYS } from "@/pages/frontends/partials/labels"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"

/** The canary rolled out next to the versions the environments serve, with the bundles published so far */
const FrontendReleaseSection: React.FC<{ frontend: Frontend; versions: string[] }> = ({ frontend, versions }) => {
    const { t } = useTranslation()
    const canary = frontend.canary?.enabled ? frontend.canary : undefined
    // The bundles some environment serves, set apart from those only published
    const served = new Set((frontend.environmentVersions ?? []).map(entry => entry.version).filter(Boolean))

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("frontend.release_settings")}</CardTitle>
                <CardDescription>{t("frontend.release_settings_description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("frontend.card.canary")}>{canary ? (canary.type ? t(CANARY_TYPE_LABEL_KEYS[canary.type]) : "—") : t("frontend.canary_none")}</DescriptionItem>
                    {/* On User goes to the enrolled users: it has no traffic share */}
                    {canary && (
                        <DescriptionItem label={t("frontend.canary_percentage")}>{canary.type === CanaryType.ON_USER ? t("frontend.canary_enrolled_users") : `${canary.percentage}%`}</DescriptionItem>
                    )}
                    {canary?.deploymentType && <DescriptionItem label={t("frontend.deployment_type")}>{t(CANARY_DEPLOYMENT_TYPE_LABEL_KEYS[canary.deploymentType])}</DescriptionItem>}
                    {canary?.version && (
                        <DescriptionItem label={t("frontend.canary_version")}>
                            <span className="font-mono">{canary.version}</span>
                        </DescriptionItem>
                    )}
                    {canary?.url && (
                        <DescriptionItem label={t("frontend.canary_url")}>
                            <span className="break-all font-mono">{canary.url}</span>
                        </DescriptionItem>
                    )}
                </DescriptionList>
                <div>
                    <h3 className="mb-2 text-base font-semibold">{t("frontend.overview.published_versions")}</h3>
                    {versions.length ? (
                        <ul className="flex flex-wrap gap-2">
                            {versions.map(version => (
                                <li key={version}>
                                    <Badge variant={served.has(version) ? "default" : "outline"}>{version}</Badge>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-foreground-secondary">{t("frontend.overview.no_versions")}</p>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}

/** Where Flightroom serves the bundle from */
const FrontendHostingSection: React.FC<{ frontend: Frontend; storages: Storage[] }> = ({ frontend, storages }) => {
    const { t } = useTranslation()
    const host = frontend.host
    const storage = host?.storageId ? storages.find(candidate => candidate._id === host.storageId) : undefined

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("frontend.hosting_information")}</CardTitle>
                <CardDescription>{t("frontend.overview.hosting_description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("frontend.hosting_type")}>{host?.type ? t(HOST_TYPE_LABEL_KEYS[host.type]) : "—"}</DescriptionItem>
                    {host?.type === HostedOn.CUSTOM_URL && (
                        <DescriptionItem label={t("frontend.custom_url")}>
                            <span className="break-all font-mono">{host.url || "—"}</span>
                        </DescriptionItem>
                    )}
                    {host?.type === HostedOn.CUSTOM_SOURCE && <DescriptionItem label={t("frontend.card.storage")}>{storage?.name ?? "—"}</DescriptionItem>}
                    <DescriptionItem label={t("frontend.entry_point")}>{host?.entryPoint ? <span className="font-mono">{host.entryPoint}</span> : "—"}</DescriptionItem>
                </DescriptionList>
            </CardContent>
        </Card>
    )
}

/** A DOCKER frontend has the tabs of a backend, a BUNDLE its release and its hosting */
const CONTAINER_TABS = ["summary", "resources", "logs", "variables"] as const
const BUNDLE_TABS = ["summary", "release", "hosting"] as const
type Tab = (typeof CONTAINER_TABS)[number] | (typeof BUNDLE_TABS)[number]

const TAB_ICONS: Record<Tab, React.ComponentType> = {
    summary: Info,
    resources: Boxes,
    logs: ScrollText,
    variables: Variable,
    release: Rocket,
    hosting: Server
}

const TAB_LABEL_KEYS: Record<Tab, string> = {
    summary: "backends.overview_tabs.summary",
    resources: "backends.overview_tabs.resources",
    logs: "backends.overview_tabs.logs",
    variables: "backends.overview_tabs.variables",
    release: "frontend.overview_tabs.release",
    hosting: "frontend.overview_tabs.hosting"
}

/** The read-only screen of a frontend, as a backend's: what it serves, from where, and with what. Edited in its settings. */
const FrontendOverview: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const frontendsApi = useFrontendsApi()
    const storageApi = useStorageApi()
    const projectId = useProjectStore(state => state.project?._id)
    const aiModels = useProjectAiModels()
    const argoCdInitialized = useArgoCdInitialized()
    // The tab lives in the URL (`?tab=logs`), as in the overview of a backend
    const [searchParams, setSearchParams] = useSearchParams()
    const requestedTab = searchParams.get("tab")

    const frontendQuery = useQuery({ queryKey: ["mfe", id], queryFn: () => frontendsApi.getSingle(id), enabled: !!id })
    const frontend: Frontend | undefined = frontendQuery.data
    // A BUNDLE has published bundles, a DOCKER images built by its pipeline: only the ones of its kind are asked for
    const isDocker = frontend?.kind === FrontendKind.DOCKER
    const versionsQuery = useQuery({ queryKey: ["versions", id], queryFn: () => frontendsApi.getVersions(id!), enabled: !!frontend && !isDocker })
    const buildsQuery = useQuery({ queryKey: ["frontend-builds", id], queryFn: () => frontendsApi.getBuilds(id!), enabled: isDocker })
    const storagesQuery = useQuery({ queryKey: ["storages", projectId], queryFn: () => storageApi.getMultiple(projectId!), enabled: !!projectId && !!frontend && !isDocker })
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")

    const aiAvailable = isAiEditAvailable(frontend, aiModels.enabled)
    // The logs and the variables the container received are read through Argo CD, and never by a viewer: no tabs for them otherwise
    const tabs: readonly Tab[] = isDocker ? CONTAINER_TABS.filter(value => (value !== "logs" && value !== "variables") || argoCdInitialized) : BUNDLE_TABS
    const tab: Tab = tabs.includes(requestedTab as Tab) ? (requestedTab as Tab) : "summary"

    return (
        <ApiStatusHandler queries={[frontendQuery, versionsQuery, buildsQuery, storagesQuery, environmentsQuery, configMapsQuery, secretsQuery]} interceptEmpty={false}>
            {frontend && (
                <div className="flex min-h-full flex-col gap-6">
                    <FrontendHeader
                        frontend={frontend}
                        active="overview"
                        aiAvailable={aiAvailable}
                        // The actions live in Edit with AI: here only when that screen does not exist
                        actions={!aiModels.isPending && !aiAvailable && <FrontendActions frontend={frontend} />}
                    />
                    <Tabs value={tab} onValueChange={value => setSearchParams({ tab: value }, { replace: true })}>
                        <TabsList aria-label={t("backends.overview_tabs.label")}>
                            {tabs.map(value => {
                                const Icon = TAB_ICONS[value]
                                return (
                                    <TabsTrigger key={value} value={value} dataTestId={`frontend-tab-${value}`}>
                                        <Icon />
                                        {t(TAB_LABEL_KEYS[value])}
                                    </TabsTrigger>
                                )
                            })}
                        </TabsList>

                        {/* What runs where, for either kind: only a container has replicas */}
                        <TabsContent value="summary" className="mt-6 flex flex-col gap-6">
                            <EnvironmentVersionsCard entries={frontend.environmentVersions} environments={environmentsQuery.data ?? []} container={isDocker ? frontend : undefined} />
                            {isDocker && <BackendEndpointsCard backend={frontend} environments={environmentsQuery.data ?? []} settingsPath={`/frontend/${frontend._id}/settings`} />}
                            {/* Above the logs when they have a tab */}
                            {isDocker && !tabs.includes("logs") && <LogLevelCard value={frontend.logLevel} environments={environmentsQuery.data ?? []} />}
                            <AiUsageSummary target={{ kind: "frontend", id: frontend._id! }} />
                            {isDocker && <BackendVersionsTable versions={buildsQuery.data ?? []} />}
                        </TabsContent>

                        {isDocker ? (
                            <>
                                {/* A frontend uses no resources: its replicas, CPU and memory, its config maps and secrets, and the variables it declares */}
                                <TabsContent value="resources" className="mt-6 flex flex-col gap-6">
                                    <ContainerComputeCard backend={frontend} environments={environmentsQuery.data ?? []} />
                                    <BackendVariableMapsSection
                                        backend={frontend}
                                        configMaps={configMapsQuery.data ?? []}
                                        secrets={secretsQuery.data ?? []}
                                        environments={environmentsQuery.data ?? []}
                                    />
                                    <ContainerEnvSection backend={frontend} />
                                </TabsContent>

                                <TabsContent value="logs" className="mt-6 flex flex-col gap-6">
                                    <LogLevelCard value={frontend.logLevel} environments={environmentsQuery.data ?? []} />
                                    <ApplicationLogsSection slug={frontend.slug} environments={environmentsQuery.data ?? []} />
                                </TabsContent>

                                <TabsContent value="variables" className="mt-6 flex flex-col gap-6">
                                    <ContainerEnvironmentCard kind="frontend" id={frontend._id!} environments={environmentsQuery.data ?? []} />
                                </TabsContent>
                            </>
                        ) : (
                            <>
                                <TabsContent value="release" className="mt-6 flex flex-col gap-6">
                                    <FrontendReleaseSection frontend={frontend} versions={versionsQuery.data ?? []} />
                                </TabsContent>

                                <TabsContent value="hosting" className="mt-6 flex flex-col gap-6">
                                    <FrontendHostingSection frontend={frontend} storages={storagesQuery.data ?? []} />
                                </TabsContent>
                            </>
                        )}
                    </Tabs>
                </div>
            )}
        </ApiStatusHandler>
    )
}

export default FrontendOverview
