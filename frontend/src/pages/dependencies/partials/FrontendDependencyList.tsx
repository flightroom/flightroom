import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Card, CardContent, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { AlertTriangle, GitBranch } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import { Dependency, DependencyKind, DependencyUpdateStatus, FrontendDependencies } from "@/hooks/apiClients/useDependenciesApi"
import DependencyStatusBadge from "./DependencyStatusBadge"

const KIND_ORDER: DependencyKind[] = [DependencyKind.PROD, DependencyKind.PEER, DependencyKind.DEV, DependencyKind.OPTIONAL]

export const isOutdated = (dependency: Dependency): boolean =>
    dependency.status === DependencyUpdateStatus.PATCH_BEHIND || dependency.status === DependencyUpdateStatus.MINOR_BEHIND || dependency.status === DependencyUpdateStatus.MAJOR_BEHIND

export interface FrontendDependencyListProps {
    frontends: FrontendDependencies[]
    onlyOutdated: boolean
}

export const FrontendDependencyList: React.FC<FrontendDependencyListProps> = ({ frontends, onlyOutdated }) => {
    const { t } = useTranslation()

    if (frontends.length === 0) {
        return (
            <Card>
                <CardContent className="p-0">
                    <EmptyState size="sm" description={t("dependencies.no_frontends")} />
                </CardContent>
            </Card>
        )
    }

    return (
        <Accordion type="single" collapsible>
            {frontends.map(frontend => {
                const dependencies = (onlyOutdated ? frontend.dependencies.filter(isOutdated) : frontend.dependencies)
                    .slice()
                    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))

                const outdatedCount = frontend.dependencies.filter(isOutdated).length

                return (
                    <AccordionItem key={frontend.frontendId} value={frontend.frontendId}>
                        <AccordionTrigger>
                            <div className="flex flex-wrap items-center gap-2 text-left">
                                <h3 className="font-medium">{frontend.name}</h3>
                                <span className="text-sm text-foreground-secondary font-normal">
                                    {frontend.repositoryName}
                                    {frontend.branch ? ` @ ${frontend.branch}` : ""}
                                </span>
                                {frontend.branch && frontend.branch !== frontend.defaultBranch && (
                                    <Badge variant="accent">
                                        <GitBranch className="w-3 h-3" />
                                        {t("dependencies.branch_not_default")}
                                    </Badge>
                                )}
                                {frontend.error ? (
                                    <Badge variant="destructive">
                                        <AlertTriangle className="w-3 h-3" />
                                        {t("dependencies.scan_failed")}
                                    </Badge>
                                ) : (
                                    <>
                                        <Badge variant="outline">{t("dependencies.dependencies_count", { count: frontend.dependencies.length })}</Badge>
                                        {outdatedCount > 0 && <Badge variant="accent">{t("dependencies.outdated_count", { count: outdatedCount })}</Badge>}
                                    </>
                                )}
                            </div>
                        </AccordionTrigger>
                        <AccordionContent>
                            {frontend.error ? (
                                <p className="text-destructive-active text-sm">{frontend.error}</p>
                            ) : dependencies.length === 0 ? (
                                <EmptyState size="sm" description={onlyOutdated ? t("dependencies.all_up_to_date") : t("dependencies.no_dependencies")} />
                            ) : (
                                <Table framed scroll="x">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t("dependencies.package")}</TableHead>
                                            <TableHead>{t("dependencies.kind")}</TableHead>
                                            <TableHead>{t("dependencies.declared_range")}</TableHead>
                                            <TableHead>{t("dependencies.latest_version")}</TableHead>
                                            <TableHead>{t("dependencies.status_column")}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {dependencies.map(dependency => (
                                            <TableRow key={`${dependency.kind}-${dependency.name}`}>
                                                <TableCell className="font-medium">
                                                    <div className="flex items-center gap-2">
                                                        {dependency.name}
                                                        {dependency.deprecated && <Badge variant="destructive">{t("dependencies.deprecated")}</Badge>}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{t(`dependencies.kinds.${dependency.kind}`)}</Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <code className="text-sm">{dependency.range}</code>
                                                </TableCell>
                                                <TableCell>{dependency.latestVersion || "-"}</TableCell>
                                                <TableCell>
                                                    <DependencyStatusBadge status={dependency.status} />
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </AccordionContent>
                    </AccordionItem>
                )
            })}
        </Accordion>
    )
}

export default FrontendDependencyList
