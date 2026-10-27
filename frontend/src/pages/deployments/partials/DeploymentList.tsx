import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, DescriptionItem, DescriptionList, EmptyState, SectionHeader } from "@flightroom/design-system"
import { useMutation, useQuery } from "@tanstack/react-query"
import { BadgeCheck, History, LayoutDashboard, PackageOpen, RefreshCw, UsersRound } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import useDomainsApi, { Domain } from "@/hooks/apiClients/useDomainsApi"
import { Frontend, FrontendKind } from "@/hooks/apiClients/useFrontendsApi"
import { exposedOrigin } from "@/pages/backends/partials/backendVariables"
import { useResourcesQuery } from "@/pages/resources/partials/resources"
import { VARIABLE_MAP_KINDS } from "@/pages/variable-maps/partials/variableMaps"
import useProjectStore from "@/store/useProjectStore"
import { cn } from "@/utils/styleUtils"
import useDeploymentsApi, { DEPLOY_MUTATION_KEY, DeployedBackend, DeployedVariableMap, DeploymentDTO } from "../../../hooks/apiClients/useDeploymentsApi"
import DeploymentBackendCard from "./DeploymentBackendCard"
import DeploymentFrontendCard from "./DeploymentFrontendCard"
import DeploymentResourceCard from "./DeploymentResourceCard"

/** The config maps or the secrets of a deployment, each with the keys it set in the environment and a link to its page */
const DeployedMaps: React.FC<{
    title: string
    maps: DeployedVariableMap[]
    path: (id: string) => string
    secret?: boolean
}> = ({ title, maps, path, secret }) => {
    const { t } = useTranslation()

    return (
        <div className="mt-4">
            <h4 className="font-semibold text-primary-strong mb-1">{title}</h4>
            {maps.map(map => (
                <div key={map._id} className="mt-2">
                    <p className="text-sm font-medium">
                        <Link to={path(map._id)} className="underline-offset-4 hover:underline">
                            {map.name}
                        </Link>
                    </p>
                    {map.entries.length > 0 ? (
                        <DescriptionList orientation="inline">
                            {map.entries.map(entry => (
                                <DescriptionItem key={entry.key} label={entry.key}>
                                    {secret ? (
                                        <span title={t("deployments.secret_value_hidden")}>
                                            <span aria-hidden="true">••••••</span>
                                            <span className="sr-only">{t("deployments.secret_value_hidden")}</span>
                                        </span>
                                    ) : (
                                        entry.value
                                    )}
                                </DescriptionItem>
                            ))}
                        </DescriptionList>
                    ) : (
                        <p className="text-sm text-foreground-secondary">{t("deployments.map_no_keys")}</p>
                    )}
                </div>
            ))}
        </div>
    )
}

interface DomainGroup {
    /** Undefined for the members of no domain, or of one deleted since */
    domain?: Domain
    frontends: Frontend[]
    backends: DeployedBackend[]
}

/** The frontends and backends of a deployment by functional domain: the domains by name, the members of none last */
const groupByDomain = (frontends: Frontend[], backends: DeployedBackend[], domains: Domain[]): DomainGroup[] => {
    const domainById = new Map(domains.map(domain => [domain._id, domain]))
    const groups = new Map<string | undefined, DomainGroup>()
    const groupOf = (domainId?: string | null) => {
        const domain = domainId ? domainById.get(domainId) : undefined
        if (!groups.has(domain?._id)) groups.set(domain?._id, { domain, frontends: [], backends: [] })
        return groups.get(domain?._id)!
    }
    for (const frontend of frontends) groupOf(frontend.domainId).frontends.push(frontend)
    for (const backend of backends) groupOf(backend.domainId).backends.push(backend)
    // An empty name sorts after any other: the group of no domain goes last
    return [...groups.values()].sort((a, b) => Number(!a.domain) - Number(!b.domain) || (a.domain?.name ?? "").localeCompare(b.domain?.name ?? ""))
}

/** What a deployment shipped: the same summary for the active one and for the history */
const DeploymentSummary: React.FC<{ deployment: DeploymentDTO }> = ({ deployment }) => {
    const { t } = useTranslation()
    const backends = deployment.backends ?? []
    const configMaps = deployment.configMaps ?? []
    const secrets = deployment.secrets ?? []
    const resources = deployment.resources ?? []
    // The deployment records names and keys only: the type and icon come from the resource as it is now, none once it is deleted
    const resourcesQuery = useResourcesQuery(resources.length > 0)
    const exposure = useProjectStore(state => state.project?.exposure)
    const environment = useProjectStore(state => state.environments?.find(candidate => candidate._id === deployment.environmentId))
    // No link without a domain to expose on: the path alone does not open anything
    const origin = exposure?.domain && environment ? exposedOrigin(exposure, environment) : undefined
    const exposedUrl = (path?: string | null) => (origin && path ? origin + path : undefined)
    const projectId = useProjectStore(state => state.project?._id)
    const domainsApi = useDomainsApi()
    const inSomeDomain = [...deployment.frontends, ...backends].some(member => member.domainId)
    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll, enabled: !!projectId && inSomeDomain })
    const groups = groupByDomain(deployment.frontends, backends, domainsQuery.data ?? [])
    // Without any domain the headings would only repeat "without a domain": the members stay as they were
    const showDomains = groups.some(group => group.domain)

    return (
        <>
            {/* The domains two by two on wide screens, one under the other on narrow ones */}
            <div className={cn("grid grid-cols-1 gap-6", showDomains && "lg:grid-cols-2")}>
                {groups.map(group => (
                    <section key={group.domain?._id ?? "none"} className={cn("min-w-0", showDomains && "rounded-md border border-divider p-4")}>
                        {showDomains && (
                            <h4 className="mb-3 flex items-center gap-2 font-semibold">
                                <LayoutDashboard className="size-4 text-foreground-secondary" aria-hidden="true" />
                                {group.domain ? (
                                    <Link to={`/domain/${group.domain._id}`} className="underline-offset-4 hover:underline">
                                        {group.domain.name}
                                    </Link>
                                ) : (
                                    <span className="text-foreground-secondary">{t("deployments.no_domain")}</span>
                                )}
                            </h4>
                        )}
                        {/* One grid for both: the tag and the color of each card tell a frontend from a backend */}
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
                            {group.frontends.map(frontend => (
                                <DeploymentFrontendCard key={frontend._id} frontend={frontend} url={frontend.kind === FrontendKind.DOCKER ? exposedUrl(frontend.exposurePath) : undefined} />
                            ))}
                            {group.backends.map(backend => (
                                <DeploymentBackendCard key={backend._id} backend={backend} url={exposedUrl(backend.exposurePath)} />
                            ))}
                        </div>
                    </section>
                ))}
            </div>
            {deployment.variables.length > 0 && (
                <div className="mt-4">
                    <h4 className="font-semibold text-primary-strong mb-1">{t("deployments.env_variables_title")}</h4>
                    <DescriptionList orientation="inline">
                        {deployment.variables.map(variable => (
                            <DescriptionItem key={variable._id} label={variable.key}>
                                {variable.value}
                            </DescriptionItem>
                        ))}
                    </DescriptionList>
                </div>
            )}
            {configMaps.length > 0 && <DeployedMaps title={t("deployments.config_maps_title")} maps={configMaps} path={VARIABLE_MAP_KINDS.configMap.detailPath} />}
            {secrets.length > 0 && <DeployedMaps title={t("deployments.secrets_title")} maps={secrets} path={VARIABLE_MAP_KINDS.secret.detailPath} secret />}
            {resources.length > 0 && (
                <div className="mt-4">
                    <h4 className="font-semibold text-primary-strong mb-2">{t("deployments.resources_title")}</h4>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
                        {resources.map(deployed => (
                            <DeploymentResourceCard key={deployed._id} deployed={deployed} resource={resourcesQuery.data?.find(candidate => candidate._id === deployed._id)} />
                        ))}
                    </div>
                </div>
            )}
        </>
    )
}

interface DeploymentListProps {
    environmentId: string
}

export const DeploymentList: React.FC<DeploymentListProps> = ({ environmentId }) => {
    const { t } = useTranslation()
    const { getDeployments, redeploy } = useDeploymentsApi()
    const [selectedDeploymentId, _setSelectedDeploymentId] = useState<string | null>(null)

    const dataQuery = useQuery({
        queryKey: ["deployments", environmentId],
        queryFn: () => getDeployments(environmentId)
    })

    const redeployQuery = useMutation({
        mutationKey: DEPLOY_MUTATION_KEY,
        mutationFn: redeploy,
        onSuccess: () => dataQuery.refetch()
    })

    const onRedeploy = (deploymentId: string) => {
        redeployQuery.mutate(deploymentId)
    }

    const deployments = dataQuery.data || []

    const _selectedDeployment = deployments.find(deployment => deployment._id === selectedDeploymentId)

    return (
        <ApiStatusHandler queries={[dataQuery]}>
            {deployments.length > 0 ? (
                <div>
                    {deployments.filter(deployment => deployment.active) !== null && (
                        <section className="mb-8">
                            <SectionHeader icon={<BadgeCheck />} title={t("deployments.active_deployments")} />
                            <div>
                                <Accordion type="single" defaultValue={deployments.find(deployment => deployment.active)?._id} collapsible>
                                    {deployments
                                        .filter(deployment => deployment.active)
                                        ?.map(deployment => (
                                            <AccordionItem key={deployment._id} value={deployment._id}>
                                                <AccordionTrigger>
                                                    <div className="flex items-end gap-2">
                                                        <h3 className="font-medium">Deployment {deployment.deploymentId}</h3>
                                                        <span className="text-sm text-foreground-secondary font-normal">{new Date(deployment.deployedAt).toLocaleDateString()}</span>
                                                    </div>
                                                </AccordionTrigger>
                                                <AccordionContent>
                                                    <DeploymentSummary deployment={deployment} />
                                                    <div className="mt-8">
                                                        <Button variant="secondary" href={`/deployments/${deployment._id}/canary-users`}>
                                                            <UsersRound />
                                                            {t("deployments.actions.view_canary_users")}
                                                        </Button>
                                                    </div>
                                                </AccordionContent>
                                            </AccordionItem>
                                        ))}
                                </Accordion>
                            </div>
                        </section>
                    )}

                    {deployments.filter(deployment => !deployment.active) !== null && (
                        <section>
                            <SectionHeader icon={<History />} title={t("deployments.history")} />
                            <Accordion type="single" collapsible>
                                {deployments
                                    .filter(deployment => !deployment.active)
                                    ?.map(deployment => (
                                        <AccordionItem key={deployment._id} value={deployment._id}>
                                            <AccordionTrigger>
                                                <div className="flex items-end gap-2">
                                                    <h3>Deployment {deployment.deploymentId}</h3>
                                                    <span className="text-sm text-foreground-secondary font-normal">{new Date(deployment.deployedAt).toLocaleDateString()}</span>
                                                </div>
                                            </AccordionTrigger>
                                            <AccordionContent>
                                                <DeploymentSummary deployment={deployment} />
                                                <div className="flex gap-2 mt-8">
                                                    <Button variant="secondary" href={`/deployments/${deployment._id}/canary-users`}>
                                                        <UsersRound />
                                                        {t("deployments.actions.view_canary_users")}
                                                    </Button>
                                                    <Button
                                                        variant="primary"
                                                        onClick={e => {
                                                            e.stopPropagation()
                                                            onRedeploy(deployment._id)
                                                        }}
                                                        disabled={redeployQuery.isPending || deployment.active}
                                                        loading={redeployQuery.isPending && redeployQuery.variables === deployment._id}
                                                        loadingLabel={t("deployments.actions.redeploying")}
                                                    >
                                                        <RefreshCw />
                                                        {t("deployments.actions.redeploy")}
                                                    </Button>
                                                </div>
                                            </AccordionContent>
                                        </AccordionItem>
                                    ))}
                            </Accordion>
                        </section>
                    )}
                </div>
            ) : (
                <EmptyState
                    size="default"
                    iconVariant="bare"
                    tone="muted"
                    grow
                    icon={<PackageOpen />}
                    title={t("deployments.no_deployments")}
                    description={t("deployments.no_deployments_description")}
                />
            )}
        </ApiStatusHandler>
    )
}

export default DeploymentList
