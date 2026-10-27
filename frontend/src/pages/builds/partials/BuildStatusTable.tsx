import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Layers, LayoutDashboard, Server } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { BuildUnavailableReason, ComponentBuildStatus, ProjectBuildStatus } from "@/hooks/apiClients/useBuildsApi"
import useDomainsApi, { Domain } from "@/hooks/apiClients/useDomainsApi"
import useProjectStore from "@/store/useProjectStore"
import { cn } from "@/utils/styleUtils"
import BuildRunList, { BuildComponentKind } from "./BuildRunList"
import BuildStatusBadge from "./BuildStatusBadge"
import ProviderRunLink from "./ProviderRunLink"

interface BuildStatusTableProps {
    data: ProjectBuildStatus
}

/** One row of the table: a frontend or a backend. */
interface BuildStatusRow extends ComponentBuildStatus {
    kind: BuildComponentKind
    id: string
}

/** Frontends and backends share one id space only once the kind is part of the key. */
const rowKey = (row: BuildStatusRow) => `${row.kind}-${row.id}`

interface DomainGroup {
    /** Undefined for the components of no domain, or of one deleted since */
    domain?: Domain
    rows: BuildStatusRow[]
}

/** The rows by functional domain: the domains by name, the components of none last */
const groupByDomain = (rows: BuildStatusRow[], domains: Domain[]): DomainGroup[] => {
    const domainById = new Map(domains.map(domain => [domain._id, domain]))
    const groups = new Map<string | undefined, DomainGroup>()
    for (const row of rows) {
        const domain = row.domainId ? domainById.get(row.domainId) : undefined
        if (!groups.has(domain?._id)) groups.set(domain?._id, { domain, rows: [] })
        groups.get(domain?._id)!.rows.push(row)
    }
    return [...groups.values()].sort((a, b) => Number(!a.domain) - Number(!b.domain) || (a.domain?.name ?? "").localeCompare(b.domain?.name ?? ""))
}

const KindBadge: React.FC<{ kind: BuildComponentKind }> = ({ kind }) => {
    const { t } = useTranslation()
    const Icon = kind === BuildComponentKind.BACKEND ? Server : LayoutDashboard
    return (
        <Badge variant="outline">
            <Icon className="size-3.5 shrink-0" />
            <span>{t(`builds.kind.${kind}`)}</span>
        </Badge>
    )
}

const BuildStatusTable: React.FC<BuildStatusTableProps> = ({ data }) => {
    const { t } = useTranslation()
    const [expandedKeys, setExpandedKeys] = useState<string[]>([])
    const projectId = useProjectStore(state => state.project?._id)
    const domainsApi = useDomainsApi()

    const toggleExpanded = (key: string) => {
        setExpandedKeys(current => (current.includes(key) ? current.filter(expandedKey => expandedKey !== key) : [...current, key]))
    }

    // Frontends and backends in one alphabetical list: the kind is shown by its badge.
    const rows: BuildStatusRow[] = [
        ...(data.frontends || []).map(({ frontendId, ...row }) => ({ ...row, kind: BuildComponentKind.FRONTEND, id: frontendId })),
        ...(data.backends || []).map(({ backendId, ...row }) => ({ ...row, kind: BuildComponentKind.BACKEND, id: backendId }))
    ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    const inSomeDomain = rows.some(row => row.domainId)
    const domainsQuery = useQuery({ queryKey: ["domains", projectId], queryFn: domainsApi.getAll, enabled: !!projectId && inSomeDomain })
    const groups = groupByDomain(rows, domainsQuery.data ?? [])
    // Without any domain a heading would only repeat "without a domain": the table stays one list
    const showDomains = groups.some(group => group.domain)
    // Header cells: expander, name, type, last build, tag of that build.
    const columnCount = 5

    const renderLastBuild = (row: BuildStatusRow) => {
        if (row.unavailableReason) {
            return <span className="text-sm text-foreground-secondary">{t(`builds.unavailable.${row.unavailableReason}`)}</span>
        }
        const lastBuild = row.builds[0]
        if (!lastBuild) {
            return <span className="text-sm text-foreground-secondary">{t("builds.table.no_runs")}</span>
        }
        return (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <BuildStatusBadge status={lastBuild.status} />
                {lastBuild.url && <ProviderRunLink url={lastBuild.url} provider={row.provider} />}
            </div>
        )
    }

    return (
        <Table framed scroll="x">
            <TableHeader>
                <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>{t("builds.table.name")}</TableHead>
                    <TableHead>{t("builds.table.kind")}</TableHead>
                    <TableHead>{t("builds.table.last_build")}</TableHead>
                    <TableHead>{t("builds.table.build_ref")}</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {groups.flatMap(group => [
                    showDomains && (
                        <TableRow key={`domain-${group.domain?._id ?? "none"}`} className="bg-muted hover:bg-muted">
                            <TableCell colSpan={columnCount}>
                                <span className="flex items-center gap-2 font-semibold">
                                    <Layers className="size-4 text-foreground-secondary" aria-hidden="true" />
                                    {group.domain ? (
                                        <Link to={`/domain/${group.domain._id}`} className="underline-offset-4 hover:underline">
                                            {group.domain.name}
                                        </Link>
                                    ) : (
                                        <span className="text-foreground-secondary">{t("builds.table.no_domain")}</span>
                                    )}
                                </span>
                            </TableCell>
                        </TableRow>
                    ),
                    ...group.rows.flatMap(row => {
                        const key = rowKey(row)
                        const isExpanded = expandedKeys.includes(key)
                        const lastBuild = row.builds[0]

                        return [
                            <TableRow key={key}>
                                <TableCell>
                                    <button
                                        type="button"
                                        onClick={() => toggleExpanded(key)}
                                        aria-expanded={isExpanded}
                                        aria-label={t(isExpanded ? "builds.table.collapse_history" : "builds.table.expand_history", { name: row.name })}
                                        className="p-1"
                                    >
                                        {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                                    </button>
                                </TableCell>
                                <TableCell>
                                    <div className="flex flex-col">
                                        <span className="font-medium">{row.name}</span>
                                        <span className="text-xs text-foreground-secondary font-mono">{row.slug}</span>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <KindBadge kind={row.kind} />
                                </TableCell>
                                <TableCell>{renderLastBuild(row)}</TableCell>
                                <TableCell>{lastBuild?.ref ? <span className="font-mono text-sm">{lastBuild.ref}</span> : <span className="text-foreground-secondary">—</span>}</TableCell>
                            </TableRow>,
                            isExpanded && (
                                <TableRow key={`${key}-history`} className={cn("bg-primary/5")}>
                                    <TableCell colSpan={columnCount}>
                                        <div className="flex flex-col gap-3 py-2">
                                            {row.repositoryName && <p className="text-sm text-foreground-secondary">{t("builds.table.repository", { name: row.repositoryName })}</p>}
                                            {row.unavailableReason === BuildUnavailableReason.PROVIDER_ERROR ? (
                                                <p className="text-sm">{t("builds.unavailable.PROVIDER_ERROR")}</p>
                                            ) : (
                                                <BuildRunList runs={row.builds} kind={row.kind} componentId={row.id} componentName={row.name} provider={row.provider} />
                                            )}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            )
                        ]
                    })
                ])}
            </TableBody>
        </Table>
    )
}

export default BuildStatusTable
