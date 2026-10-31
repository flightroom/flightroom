import { Card, CardContent, CardDescription, CardHeader, CardTitle, DescriptionItem, DescriptionList } from "@flightroom/design-system"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Hammer, Play } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useParams } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import RepositoryLink from "@/components/RepositoryLink"
import useBackendsApi, { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import useFrontendsApi, { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useMaintenanceAgentsApi, { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import BackendBuildDialog from "@/pages/backends/partials/BackendBuildDialog"
import BackendResourcesSection from "@/pages/backends/partials/BackendResourcesSection"
import BackendVariableMapsSection from "@/pages/backends/partials/BackendVariableMapsSection"
import BackendVersionsTable from "@/pages/backends/partials/BackendVersionsTable"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import { EnvironmentResourcesValue, RESOURCE_LABELS, ReplicasValue, ResourceValue } from "@/pages/backends/partials/ContainerResourceFields"
import { RESOURCE_FIELDS } from "@/pages/backends/partials/containerResources"
import { EnvironmentVersionsValue } from "@/pages/backends/partials/EnvironmentVersionFields"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore, { useIsProjectViewer } from "@/store/useProjectStore"
import MaintenanceAgentHeader from "./partials/MaintenanceAgentHeader"
import { KindBadge, ScheduleLabel, StatusLight } from "./partials/MaintenanceBadges"
import MaintenanceBay from "./partials/MaintenanceBay"
import MaintenanceRunDialog from "./partials/MaintenanceRunDialog"
import MaintenanceRunsTable from "./partials/MaintenanceRunsTable"
import { maintenanceStatusOf, useNow } from "./partials/maintenance"

const Path: React.FC<{ path?: string }> = ({ path }) => (path ? <span className="font-mono">{path}</span> : "—")

const ConfigurationSection: React.FC<{ agent: MaintenanceAgent; environments: EnvironmentDTO[] }> = ({ agent, environments }) => {
    const { t } = useTranslation()
    const now = useNow()
    const lastRun = agent.lastRun
    const lastEnvironment = lastRun && environments.find(environment => environment._id === lastRun.environmentId)?.name

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("maintenance.configuration.title")}</CardTitle>
                <CardDescription>{t("maintenance.configuration.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("maintenance.kind.label")}>
                        <KindBadge kind={agent.kind} />
                    </DescriptionItem>
                    <DescriptionItem label={t("maintenance.schedule.label")}>
                        <ScheduleLabel agent={agent} />
                    </DescriptionItem>
                    <DescriptionItem label={t("maintenance.status.label")}>
                        <StatusLight status={maintenanceStatusOf(agent, now)} />
                    </DescriptionItem>
                    <DescriptionItem label={t("maintenance.runs.last_run")}>
                        {lastRun ? (
                            <span className="inline-flex flex-wrap items-center gap-2">
                                {new Date(lastRun.at).toLocaleString()}
                                {lastEnvironment && <Badge variant="outline">{lastEnvironment}</Badge>}
                                {!lastRun.ok && <span className="text-destructive">{lastRun.error ?? t("maintenance.runs.status_failed")}</span>}
                            </span>
                        ) : (
                            t("maintenance.runs.never")
                        )}
                    </DescriptionItem>
                    {agent.kind === "container" && (
                        <>
                            <DescriptionItem label={t("maintenance.run_path")}>
                                <Path path={agent.runPath} />
                            </DescriptionItem>
                            <DescriptionItem label={t("backends.port")}>{agent.port ?? "—"}</DescriptionItem>
                            <DescriptionItem label={t("backends.liveness_path")}>
                                <Path path={agent.livenessPath} />
                            </DescriptionItem>
                            <DescriptionItem label={t("backends.readiness_path")}>
                                <Path path={agent.readinessPath} />
                            </DescriptionItem>
                        </>
                    )}
                    <DescriptionItem label={t("backends.image_repository")}>{agent.image?.repository ? <span className="font-mono">{agent.image.repository}</span> : "—"}</DescriptionItem>
                    {RESOURCE_FIELDS.map(field => (
                        <DescriptionItem key={field} label={t(RESOURCE_LABELS[field])}>
                            <ResourceValue field={field} value={agent[field]} />
                        </DescriptionItem>
                    ))}
                    <DescriptionItem label={t("backends.compute.replicas")}>
                        <ReplicasValue value={agent.replicas} />
                    </DescriptionItem>
                    <DescriptionItem label={t("backends.compute.by_environment.title")}>
                        <EnvironmentResourcesValue entries={agent.environmentResources} environments={environments} />
                    </DescriptionItem>
                    <DescriptionItem label={t("backends.version_by_environment.title")}>
                        <EnvironmentVersionsValue entries={agent.environmentVersions} environments={environments} />
                    </DescriptionItem>
                </DescriptionList>
                <div>
                    <h3 className="mb-2 text-base font-semibold">{t("backends.env.title")}</h3>
                    {agent.env?.length ? (
                        <ul className="flex flex-col gap-2">
                            {agent.env.map(variable => (
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
                </div>
            </CardContent>
        </Card>
    )
}

/** The backends and the frontends it maintains, each opening on its page */
const TargetsSection: React.FC<{ agent: MaintenanceAgent; backends: Backend[]; frontends: Frontend[] }> = ({ agent, backends, frontends }) => {
    const { t } = useTranslation()
    const groups = [
        { key: "backends", title: t("maintenance.targets.backends"), items: backends.filter(backend => agent.backendIds.includes(backend._id!)), path: (id: string) => `/backend/${id}` },
        { key: "frontends", title: t("maintenance.targets.frontends"), items: frontends.filter(frontend => agent.frontendIds.includes(frontend._id!)), path: (id: string) => `/frontend/${id}` }
    ]

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("maintenance.targets.title")}</CardTitle>
                <CardDescription>{t("maintenance.targets.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-6 pt-3">
                {groups.map(group => (
                    <div key={group.key} className="flex min-w-0 flex-[1_1_260px] flex-col gap-2">
                        <h3 className="text-sm font-semibold">{group.title}</h3>
                        {group.items.length === 0 ? (
                            <p className="text-sm text-foreground-secondary">{t("maintenance.targets.none")}</p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-divider rounded-md border border-divider">
                                {group.items.map(item => (
                                    <li key={item._id}>
                                        <Link to={group.path(item._id!)} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-primary/5">
                                            <span
                                                className={group.key === "backends" ? "size-2.5 shrink-0 rounded-full bg-zomp-600 dark:bg-zomp-400" : "size-2.5 shrink-0 rounded-full bg-primary"}
                                                aria-hidden="true"
                                            />
                                            <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                                            <span className="truncate font-mono text-xs text-foreground-secondary">{item.slug}</span>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ))}
            </CardContent>
        </Card>
    )
}

const MaintenanceAgentDetail: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const projectId = useProjectStore(state => state.project?._id)
    const api = useMaintenanceAgentsApi()
    const backendsApi = useBackendsApi()
    const frontendsApi = useFrontendsApi()
    const queryClient = useQueryClient()
    const isViewer = useIsProjectViewer()
    const [buildOpen, setBuildOpen] = useState(false)
    const [running, setRunning] = useState<MaintenanceAgent>()

    const agentQuery = useQuery({ queryKey: ["maintenance-agent", id], queryFn: () => api.getSingle(id!), enabled: !!id })
    const runsQuery = useQuery({ queryKey: ["maintenance-agent-runs", id], queryFn: () => api.getRuns(id!), enabled: !!id })
    const versionsQuery = useQuery({ queryKey: ["maintenance-agent-versions", id], queryFn: () => api.getVersions(id!), enabled: !!id })
    const backendsQuery = useQuery({ queryKey: ["backends", projectId], queryFn: backendsApi.getAll, enabled: !!projectId })
    const frontendsQuery = useQuery({ queryKey: ["frontends-by-project-id", projectId], queryFn: () => frontendsApi.getByProjectId(projectId), enabled: !!projectId })
    const environmentsQuery = useProjectEnvironmentsQuery()
    const configMapsQuery = useVariableMapsQuery("configMap")
    const secretsQuery = useVariableMapsQuery("secret")
    const resourcesQuery = useResourcesQuery()

    const agent = agentQuery.data
    const environments = environmentsQuery.data ?? []
    // A viewer may look, not build nor run
    const canBuild = Boolean(agent?.codeRepository?.enabled) && !isViewer

    return (
        <ApiStatusHandler queries={[agentQuery, runsQuery, versionsQuery, backendsQuery, frontendsQuery, environmentsQuery, configMapsQuery, secretsQuery, resourcesQuery]} interceptEmpty={false}>
            {agent && (
                <div className="flex min-h-full flex-col gap-6">
                    <MaintenanceAgentHeader
                        agent={agent}
                        active="overview"
                        actions={
                            !isViewer && (
                                <>
                                    {canBuild && (
                                        <Button variant="secondary" onClick={() => setBuildOpen(true)}>
                                            <Hammer />
                                            {t("backends.build.action")}
                                        </Button>
                                    )}
                                    <Button variant="primary" onClick={() => setRunning(agent)}>
                                        <Play />
                                        {t("maintenance.run.action")}
                                    </Button>
                                </>
                            )
                        }
                    />
                    <MaintenanceBay
                        variant="single"
                        agents={[agent]}
                        backends={backendsQuery.data ?? []}
                        frontends={frontendsQuery.data ?? []}
                        resources={resourcesQuery.data}
                        onRun={isViewer ? undefined : setRunning}
                    />
                    {agent.description && <p className="text-sm text-foreground-secondary">{agent.description}</p>}
                    <Card>
                        <CardHeader>
                            <CardTitle className="mb-0">{t("backends.code_repository")}</CardTitle>
                        </CardHeader>
                        <CardContent className="pt-3 text-sm">
                            {agent.codeRepository?.enabled ? <RepositoryLink repository={agent.codeRepository} /> : <p className="text-foreground-secondary">{t("backends.no_repository")}</p>}
                        </CardContent>
                    </Card>
                    <ConfigurationSection agent={agent} environments={environments} />
                    <TargetsSection agent={agent} backends={backendsQuery.data ?? []} frontends={frontendsQuery.data ?? []} />
                    <MaintenanceRunsTable runs={runsQuery.data ?? []} environments={environments} />
                    <BackendVersionsTable versions={versionsQuery.data ?? []} />
                    <BackendVariableMapsSection backend={agent} configMaps={configMapsQuery.data ?? []} secrets={secretsQuery.data ?? []} environments={environments} />
                    <BackendResourcesSection backend={agent} resources={resourcesQuery.data ?? []} environments={environments} />
                    {canBuild && (
                        <BackendBuildDialog
                            open={buildOpen}
                            onOpenChange={setBuildOpen}
                            backend={agent}
                            build={api.build}
                            onBuilt={() => {
                                queryClient.invalidateQueries({ queryKey: ["maintenance-agent-versions", id] })
                                queryClient.invalidateQueries({ queryKey: ["maintenance-agent", id] })
                            }}
                        />
                    )}
                    <MaintenanceRunDialog agent={running} onOpenChange={open => !open && setRunning(undefined)} />
                </div>
            )}
        </ApiStatusHandler>
    )
}

export default MaintenanceAgentDetail
