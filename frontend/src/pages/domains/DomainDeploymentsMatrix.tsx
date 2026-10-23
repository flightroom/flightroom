import { EmptyState, SearchInput, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, LayoutDashboard, Rocket, SearchX, Server } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { ApiStatusHandler } from "@/components/organisms"
import SinglePageLayout from "@/components/SinglePageLayout"
import useDomainDeploymentsApi, { DomainDeployments, EnvironmentDeployment } from "@/hooks/apiClients/useDomainDeploymentsApi"
import useProjectStore from "@/store/useProjectStore"
import { DeployedVersion, EnvironmentHeading } from "./partials/DomainDeploymentsSection"

/** The frontend, then the backend, of one domain in one environment, as `slug version` lines */
const MatrixCell: React.FC<{ entry: EnvironmentDeployment }> = ({ entry }) => {
    const { t } = useTranslation()
    const lines = [...entry.frontends.map(frontend => ({ ...frontend, kind: "frontend" as const })), ...entry.backends.map(backend => ({ ...backend, canary: null, kind: "backend" as const }))]
    return (
        <ul className="flex flex-col gap-1">
            {lines.map(line => {
                const Icon = line.kind === "frontend" ? LayoutDashboard : Server
                const label = t(`domains.deployments.${line.kind}`)
                return (
                    <li key={`${line.kind}-${line._id}`} className="flex items-center gap-1.5 whitespace-nowrap text-sm">
                        <Icon className="size-3.5 shrink-0 text-foreground-secondary" aria-hidden="true" />
                        <span className="sr-only">{label}</span>
                        <span title={line.name}>{line.slug}</span>
                        <DeployedVersion
                            version={line.version}
                            canary={line.canary}
                            emptyLabel={t(line.kind === "frontend" ? "domains.deployments.not_deployed" : "domains.deployments.not_reported")}
                        />
                    </li>
                )
            })}
        </ul>
    )
}

const matches = (term: string, ...values: (string | undefined)[]) => values.some(value => value?.toLowerCase().includes(term))

/**
 * The rows whose domain or one of its members matches the term. A row kept for its domain shows every member;
 * one kept for its members shows only those that match.
 */
const filterRows = (rows: DomainDeployments[], term: string): DomainDeployments[] => {
    if (!term) return rows
    return rows.flatMap(row => {
        if (row.domain && matches(term, row.domain.name, row.domain.slug)) return [row]
        const environments = row.environments.map(entry => ({
            ...entry,
            frontends: entry.frontends.filter(frontend => matches(term, frontend.name, frontend.slug)),
            backends: entry.backends.filter(backend => matches(term, backend.name, backend.slug))
        }))
        return environments.some(entry => entry.frontends.length > 0 || entry.backends.length > 0) ? [{ ...row, environments }] : []
    })
}

/** Rows are the domains of the project, then the members in no domain; columns are its environments */
const DomainDeploymentsMatrix = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const domainDeploymentsApi = useDomainDeploymentsApi()
    const matrixQuery = useQuery({
        queryKey: ["domain-deployments-matrix", projectId],
        queryFn: domainDeploymentsApi.getByProject,
        enabled: !!projectId
    })
    const [searchTerm, setSearchTerm] = useState("")

    const allRows = matrixQuery.data ?? []
    // Every row has the same environments, in the same order
    const environments = allRows[0]?.environments ?? []
    const term = searchTerm.trim().toLowerCase()
    const rows = useMemo(() => filterRows(matrixQuery.data ?? [], term), [matrixQuery.data, term])

    return (
        <SinglePageLayout
            title={t("domains.deployments.matrix_title")}
            description={t("domains.deployments.matrix_description")}
            lrContainerClassname="items-end"
            left={
                <div className="flex min-w-0 flex-[1_1_280px] flex-col items-start gap-2">
                    <Button variant="ghost" size="sm" onClick={() => navigate("/domains")}>
                        <ArrowLeft />
                        {t("domains.deployments.back")}
                    </Button>
                    {allRows.length > 0 && environments.length > 0 && (
                        <SearchInput
                            className="w-full max-w-sm"
                            placeholder={t("domains.deployments.search_placeholder")}
                            value={searchTerm}
                            onValueChange={setSearchTerm}
                            onClear={() => setSearchTerm("")}
                            clearLabel={t("domains.clear_search")}
                        />
                    )}
                </div>
            }
        >
            <ApiStatusHandler queries={[matrixQuery]}>
                {allRows.length === 0 || environments.length === 0 ? (
                    <EmptyState
                        variant="outlined"
                        size="lg"
                        tone="primary"
                        icon={<Rocket />}
                        title={t("domains.deployments.matrix_empty_title")}
                        description={environments.length === 0 && allRows.length > 0 ? t("domains.deployments.no_environments") : t("domains.deployments.matrix_empty_description")}
                    />
                ) : rows.length === 0 ? (
                    <EmptyState
                        variant="outlined"
                        size="lg"
                        tone="primary"
                        icon={<SearchX />}
                        title={t("domains.deployments.no_results_title")}
                        description={t("domains.deployments.no_results_description", {
                            searchTerm: searchTerm.trim()
                        })}
                    />
                ) : (
                    <div className="overflow-x-auto rounded-md border border-divider">
                        <Table>
                            <TableHeader>
                                <TableRow className="bg-muted/60 hover:bg-muted/60">
                                    <TableHead>{t("domains.deployments.domain")}</TableHead>
                                    {environments.map(entry => (
                                        <TableHead key={entry.environment._id} className="min-w-[14rem] py-2 align-top">
                                            <EnvironmentHeading entry={entry} />
                                        </TableHead>
                                    ))}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map(row => (
                                    <TableRow key={row.domain?._id ?? "no-domain"} className="border-divider align-top hover:bg-primary/5">
                                        <TableCell className="font-medium">
                                            {row.domain ? (
                                                <Link to={`/domain/${row.domain._id}`} className="hover:underline">
                                                    {row.domain.name}
                                                </Link>
                                            ) : (
                                                <span className="italic">{t("domains.no_domain")}</span>
                                            )}
                                        </TableCell>
                                        {row.environments.map(entry => (
                                            <TableCell key={entry.environment._id}>
                                                {entry.frontends.length === 0 && entry.backends.length === 0 ? (
                                                    <span className="text-sm text-foreground-secondary">{t("domains.deployments.no_members_short")}</span>
                                                ) : (
                                                    <MatrixCell entry={entry} />
                                                )}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </ApiStatusHandler>
        </SinglePageLayout>
    )
}

export default DomainDeploymentsMatrix
