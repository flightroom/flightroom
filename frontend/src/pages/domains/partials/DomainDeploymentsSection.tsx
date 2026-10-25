import { Card, CardContent, CardDescription, CardHeader, CardTitle, ColorSwatch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { format } from "date-fns"
import { ExternalLink, LayoutDashboard, Server } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { Badge } from "@/components/atoms"
import { DeployedFrontend, DomainDeployments, EnvironmentDeployment } from "@/hooks/apiClients/useDomainDeploymentsApi"
import { CanaryType, type Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { exposedOrigin, useProjectEnvironmentsQuery } from "@/pages/backends/partials/backendVariables"
import useProjectStore from "@/store/useProjectStore"
import useThemeStore from "@/store/useThemeStore"
import { servingContainers } from "@/utils/livePreview"

interface DeployedVersionProps {
    version: string | null
    canary?: DeployedFrontend["canary"]
    /** Shown when there is no version: the frontend was not deployed, the backend was not reported */
    emptyLabel: string
}

/** A version as deployed, e.g. `1.2.0 · canary 3.0.0 (10%)`, or the empty label when there is none */
export const DeployedVersion: React.FC<DeployedVersionProps> = ({ version, canary, emptyLabel }) => {
    const { t } = useTranslation()
    if (!version) {
        return <span className="italic text-foreground-secondary">{emptyLabel}</span>
    }
    // ON_USER ignores the percentage: the canary goes to the users enrolled on the deployment
    const audience = canary && (canary.type === CanaryType.ON_USER ? t("domains.deployments.canary_enrolled_users") : `${canary.percentage}%`)
    return (
        <span className="font-mono text-xs">
            {version}
            {canary && ` · ${canary.version ? t("domains.deployments.canary", { version: canary.version, audience }) : t("domains.deployments.canary_without_version", { audience })}`}
        </span>
    )
}

/** Name and colour of an environment, with the deployment it serves */
export const EnvironmentHeading: React.FC<{ entry: EnvironmentDeployment }> = ({ entry }) => {
    const { t } = useTranslation()
    const themeStore = useThemeStore()
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 font-medium">
                <ColorSwatch size="sm" color={entry.environment.color} />
                <span className="truncate">{entry.environment.name}</span>
                {entry.environment.isProduction && <Badge className="shrink-0">{t("domains.deployments.production")}</Badge>}
            </span>
            <span className="text-xs font-normal text-foreground-secondary">
                {entry.deployment
                    ? t("domains.deployments.deployment", {
                          deploymentId: entry.deployment.deploymentId,
                          date: format(new Date(entry.deployment.deployedAt), "PPp", { locale: themeStore.getLocale() })
                      })
                    : t("domains.deployments.never_deployed")}
            </span>
        </div>
    )
}

/** Where a frontend is reached in an environment: the URL of each DOCKER serving it, with the parent named when it is not the frontend itself */
const FrontendUrls: React.FC<{ frontend: Frontend; frontends: Frontend[]; origin?: string }> = ({ frontend, frontends, origin }) => {
    const { t } = useTranslation()
    // No link without a domain to expose on, nor for a container exposed on no path: the path alone does not open anything
    const urls = origin ? servingContainers(frontend, frontends).flatMap(container => (container.exposurePath ? [{ container, url: origin + container.exposurePath }] : [])) : []
    if (urls.length === 0) return null
    return (
        <ul className="mt-1 flex flex-col gap-0.5">
            {urls.map(({ container, url }) => (
                <li key={container._id} className="flex min-w-0 flex-col">
                    <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-xs text-primary underline-offset-4 hover:underline">
                        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
                    </a>
                    {container._id !== frontend._id && <span className="text-xs text-foreground-secondary">{t("domains.deployments.served_by", { name: container.name })}</span>}
                </li>
            ))}
        </ul>
    )
}

/** Rows are the frontends, then the backends, of the domain; columns are the environments of the project */
export const DomainDeploymentsSection: React.FC<{ deployments: DomainDeployments; frontends: Frontend[] }> = ({ deployments, frontends }) => {
    const { t } = useTranslation()
    const exposure = useProjectStore(state => state.project?.exposure)
    const projectEnvironments = useProjectEnvironmentsQuery().data
    const originOf = (environmentId: string) => {
        const environment = projectEnvironments?.find(candidate => candidate._id === environmentId)
        return exposure?.domain && environment ? exposedOrigin(exposure, environment) : undefined
    }
    const environments = deployments.environments
    // Every environment lists the same members, in the same order
    const members = [
        ...(environments[0]?.frontends ?? []).map(frontend => ({ ...frontend, kind: "frontend" as const })),
        ...(environments[0]?.backends ?? []).map(backend => ({ ...backend, kind: "backend" as const }))
    ]

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("domains.deployments.section_title")}</CardTitle>
                <CardDescription>{t("domains.deployments.section_description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                {environments.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("domains.deployments.no_environments")}</p>
                ) : members.length === 0 ? (
                    <p className="text-sm text-foreground-secondary">{t("domains.deployments.no_members_short")}</p>
                ) : (
                    <div className="overflow-x-auto rounded-md border border-divider">
                        <Table>
                            <TableHeader>
                                <TableRow className="bg-muted/60 hover:bg-muted/60">
                                    <TableHead>{t("domains.deployments.member")}</TableHead>
                                    {environments.map(entry => (
                                        <TableHead key={entry.environment._id} className="min-w-[12rem] py-2 align-top">
                                            <EnvironmentHeading entry={entry} />
                                        </TableHead>
                                    ))}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {members.map(member => {
                                    const Icon = member.kind === "frontend" ? LayoutDashboard : Server
                                    return (
                                        <TableRow key={`${member.kind}-${member._id}`} className="border-divider align-top hover:bg-primary/5">
                                            <TableCell>
                                                <span className="flex items-center gap-1.5 text-sm">
                                                    <Icon className="size-3.5 shrink-0 text-foreground-secondary" aria-hidden="true" />
                                                    <span className="sr-only">{t(`domains.deployments.${member.kind}`)}</span>
                                                    <Link to={`/${member.kind === "frontend" ? "frontend" : "backend"}/${member._id}`} title={member.slug} className="font-medium hover:underline">
                                                        {member.name}
                                                    </Link>
                                                </span>
                                            </TableCell>
                                            {environments.map(entry => {
                                                const deployed =
                                                    member.kind === "frontend"
                                                        ? entry.frontends.find(frontend => frontend._id === member._id)
                                                        : entry.backends.find(backend => backend._id === member._id)
                                                const frontend = member.kind === "frontend" ? frontends.find(candidate => candidate._id === member._id) : undefined
                                                return (
                                                    <TableCell key={entry.environment._id}>
                                                        <DeployedVersion
                                                            version={deployed?.version ?? null}
                                                            canary={deployed && "canary" in deployed ? deployed.canary : null}
                                                            emptyLabel={t(member.kind === "frontend" ? "domains.deployments.not_deployed" : "domains.deployments.not_reported")}
                                                        />
                                                        {/* Only where it runs: an environment that never got it has nothing at that URL */}
                                                        {frontend && deployed?.version && <FrontendUrls frontend={frontend} frontends={frontends} origin={originOf(entry.environment._id)} />}
                                                    </TableCell>
                                                )
                                            })}
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

export default DomainDeploymentsSection
