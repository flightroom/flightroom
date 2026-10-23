import { Card, CardContent, CardDescription, CardHeader, CardTitle, DescriptionItem, DescriptionList } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { useParams } from "react-router-dom"
import AiUsageSummary from "@/components/ai-usage/AiUsageSummary"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import RepositoryLink from "@/components/RepositoryLink"
import useFrontendsApi, { CanaryType, Frontend, FrontendKind, HostedOn } from "@/hooks/apiClients/useFrontendsApi"
import useStorageApi, { Storage } from "@/hooks/apiClients/useStorageApi"
import BackendConfigurationSection from "@/pages/backends/partials/BackendConfigurationSection"
import BackendVariableMapsSection from "@/pages/backends/partials/BackendVariableMapsSection"
import BackendVersionsTable from "@/pages/backends/partials/BackendVersionsTable"
import { useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import { FrontendActions, FrontendHeader, isAiEditAvailable } from "@/pages/frontends/partials/components"
import { CANARY_DEPLOYMENT_TYPE_LABEL_KEYS, CANARY_TYPE_LABEL_KEYS, HOST_TYPE_LABEL_KEYS } from "@/pages/frontends/partials/labels"
import { useVariableMapsQuery } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"

const FrontendRepositorySection: React.FC<{ frontend: Frontend }> = ({ frontend }) => {
    const { t } = useTranslation()

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("frontend.code_repository")}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3 text-sm">
                {frontend.codeRepository?.enabled ? <RepositoryLink repository={frontend.codeRepository} /> : <p className="text-foreground-secondary">{t("frontend.overview.no_repository")}</p>}
            </CardContent>
        </Card>
    )
}

/** The version served and the canary rolled out next to it, with the bundles published so far */
const FrontendReleaseSection: React.FC<{ frontend: Frontend; versions: string[] }> = ({ frontend, versions }) => {
    const { t } = useTranslation()
    const canary = frontend.canary?.enabled ? frontend.canary : undefined

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("frontend.release_settings")}</CardTitle>
                <CardDescription>{t("frontend.release_settings_description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-3">
                <DescriptionList orientation="inline">
                    <DescriptionItem label={t("frontend.version")}>{frontend.version ? <span className="font-mono">{frontend.version}</span> : "—"}</DescriptionItem>
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
                                    <Badge variant={version === frontend.version ? "default" : "outline"}>{version}</Badge>
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

/** The read-only screen of a frontend, as a backend's: what it serves, from where, and with what. Edited in its settings. */
const FrontendOverview: React.FC = () => {
    const { t } = useTranslation()
    const { id } = useParams<{ id: string }>()
    const frontendsApi = useFrontendsApi()
    const storageApi = useStorageApi()
    const projectId = useProjectStore(state => state.project?._id)
    const aiModels = useProjectAiModels()

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
                    <FrontendRepositorySection frontend={frontend} />
                    <AiUsageSummary target={{ kind: "frontend", id: frontend._id! }} />
                    {isDocker ? (
                        <>
                            <BackendVersionsTable versions={buildsQuery.data ?? []} />
                            <BackendConfigurationSection backend={frontend} environments={environmentsQuery.data ?? []} description={t("frontend.overview.container_description")} />
                            <BackendVariableMapsSection backend={frontend} configMaps={configMapsQuery.data ?? []} secrets={secretsQuery.data ?? []} environments={environmentsQuery.data ?? []} />
                        </>
                    ) : (
                        <>
                            <FrontendReleaseSection frontend={frontend} versions={versionsQuery.data ?? []} />
                            <FrontendHostingSection frontend={frontend} storages={storagesQuery.data ?? []} />
                        </>
                    )}
                </div>
            )}
        </ApiStatusHandler>
    )
}

export default FrontendOverview
