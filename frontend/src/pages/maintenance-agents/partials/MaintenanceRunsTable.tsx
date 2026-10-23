import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyStateRow, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/atoms"
import type { EnvironmentDTO } from "@/hooks/apiClients/useEnvironmentsApi"
import type { MaintenanceRun } from "@/hooks/apiClients/useMaintenanceAgentsApi"

/** The last runs of an agent, newest first: where it was started, by what, and whether Argo CD took it */
export const MaintenanceRunsTable: React.FC<{ runs: MaintenanceRun[]; environments: EnvironmentDTO[] }> = ({ runs, environments }) => {
    const { t } = useTranslation()
    const environmentName = (id: string) => environments.find(environment => environment._id === id)?.name ?? "—"

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("maintenance.runs.title")}</CardTitle>
                <CardDescription>{t("maintenance.runs.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                <div className="overflow-x-auto rounded-lg border-2 border-border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-muted/60 hover:bg-muted/60">
                                <TableHead>{t("maintenance.runs.date")}</TableHead>
                                <TableHead>{t("maintenance.runs.environment")}</TableHead>
                                <TableHead>{t("maintenance.runs.trigger")}</TableHead>
                                <TableHead>{t("maintenance.runs.status")}</TableHead>
                                <TableHead>{t("maintenance.runs.error")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {runs.length > 0 ? (
                                runs.map(run => (
                                    <TableRow key={run._id} className="border-divider hover:bg-primary/5">
                                        <TableCell className="whitespace-nowrap">{new Date(run.createdAt).toLocaleString()}</TableCell>
                                        <TableCell>
                                            <Badge variant="outline">{environmentName(run.environmentId)}</Badge>
                                        </TableCell>
                                        <TableCell className="text-foreground-secondary">{t(`maintenance.runs.trigger_${run.trigger}`)}</TableCell>
                                        <TableCell>
                                            <Badge variant={run.status === "failed" ? "destructive" : "success"}>{t(`maintenance.runs.status_${run.status}`)}</Badge>
                                        </TableCell>
                                        <TableCell className="max-w-[28rem] truncate text-xs text-foreground-secondary" title={run.error}>
                                            {run.error ?? "—"}
                                        </TableCell>
                                    </TableRow>
                                ))
                            ) : (
                                <EmptyStateRow colSpan={5}>{t("maintenance.runs.empty")}</EmptyStateRow>
                            )}
                        </TableBody>
                    </Table>
                </div>
            </CardContent>
        </Card>
    )
}

export default MaintenanceRunsTable
