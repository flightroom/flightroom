import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { KindBadge, ScheduleLabel, StatusLight } from "./MaintenanceBadges"
import { maintenanceAgentPath, maintenanceStatusOf, useNow } from "./maintenance"

export const MaintenanceAgentsTable: React.FC<{ agents: MaintenanceAgent[]; onRun?: (agent: MaintenanceAgent) => void }> = ({ agents, onRun }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const now = useNow()

    return (
        <div className="overflow-x-auto rounded-lg border-2 border-border bg-card">
            <Table>
                <TableHeader>
                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                        <TableHead>{t("common.name")}</TableHead>
                        <TableHead>{t("maintenance.kind.label")}</TableHead>
                        <TableHead>{t("maintenance.schedule.label")}</TableHead>
                        <TableHead>{t("maintenance.status.label")}</TableHead>
                        <TableHead>{t("maintenance.targets.title")}</TableHead>
                        <TableHead>{t("maintenance.runs.last_run")}</TableHead>
                        <TableHead>{t("services.latest_version")}</TableHead>
                        {onRun && <TableHead className="text-right">{t("common.actions")}</TableHead>}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {agents.map(agent => (
                        <TableRow key={agent._id} className="cursor-pointer border-divider hover:bg-primary/5" onClick={() => navigate(maintenanceAgentPath(agent._id))}>
                            <TableCell className="max-w-[16rem] font-medium">
                                <span className="block truncate" title={agent.name}>
                                    {agent.name}
                                </span>
                                <span className="block truncate text-xs font-normal text-foreground-secondary">{agent.slug}</span>
                            </TableCell>
                            <TableCell>
                                <KindBadge kind={agent.kind} />
                            </TableCell>
                            <TableCell className="max-w-[16rem]">
                                <ScheduleLabel agent={agent} withCron={false} />
                            </TableCell>
                            <TableCell>
                                <StatusLight status={maintenanceStatusOf(agent, now)} />
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-foreground-secondary">{agent.serviceIds.length + agent.frontendIds.length}</TableCell>
                            <TableCell className="whitespace-nowrap text-foreground-secondary">{agent.lastRun ? new Date(agent.lastRun.at).toLocaleString() : "—"}</TableCell>
                            <TableCell>{agent.version ? <Badge>{agent.version}</Badge> : <span className="text-foreground-secondary">—</span>}</TableCell>
                            {onRun && (
                                <TableCell className="text-right">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        aria-label={t("maintenance.run.action_named", { name: agent.name })}
                                        onClick={event => {
                                            event.stopPropagation()
                                            onRun(agent)
                                        }}
                                    >
                                        <Play />
                                        {t("maintenance.run.action")}
                                    </Button>
                                </TableCell>
                            )}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )
}

export default MaintenanceAgentsTable
