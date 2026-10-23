import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@flightroom/design-system"
import { Cog, Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Badge, Button } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { KindBadge, ScheduleLabel, StatusLight } from "./MaintenanceBadges"
import { maintenanceAgentPath, maintenanceStatusOf, useNow } from "./maintenance"

interface MaintenanceAgentsViewProps {
    agents: MaintenanceAgent[]
    /** Play on an agent; without it (a viewer) there is none */
    onRun?: (agent: MaintenanceAgent) => void
}

export const MaintenanceAgentsGrid: React.FC<MaintenanceAgentsViewProps> = ({ agents, onRun }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const now = useNow()

    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
            {agents.map(agent => (
                <Card key={agent._id} className="flex h-full cursor-pointer flex-col transition-colors duration-200 hover:border-primary" onClick={() => navigate(maintenanceAgentPath(agent._id))}>
                    <CardHeader className="flex-row items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <CardTitle className="mb-0 truncate" title={agent.name}>
                                {agent.name}
                            </CardTitle>
                            <p className="truncate text-sm text-foreground-secondary" title={agent.slug}>
                                {agent.slug}
                            </p>
                        </div>
                        {agent.version && <Badge className="shrink-0">{agent.version}</Badge>}
                    </CardHeader>
                    <CardContent className="flex flex-grow flex-col items-start gap-3 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-3">
                            <KindBadge kind={agent.kind} />
                            <StatusLight status={maintenanceStatusOf(agent, now)} />
                        </div>
                        <ScheduleLabel agent={agent} withCron={false} />
                        <p className="text-foreground-secondary">
                            {t("maintenance.targets.summary", {
                                backends: t("maintenance.targets.backends_count", { count: agent.backendIds.length }),
                                frontends: t("maintenance.targets.frontends_count", { count: agent.frontendIds.length })
                            })}
                        </p>
                        <RepositoryLink repository={agent.codeRepository} />
                    </CardContent>
                    <CardFooter className="gap-2 border-t border-divider pt-3">
                        {/* Its click reaches the card, which opens: the button keeps the card reachable from the keyboard */}
                        <Button variant="secondary" size="sm" className="flex-1">
                            <Cog />
                            {t("maintenance.list.open")}
                        </Button>
                        {onRun && (
                            <Button
                                variant="primary"
                                size="sm"
                                className="flex-1"
                                aria-label={t("maintenance.run.action_named", { name: agent.name })}
                                onClick={event => {
                                    event.stopPropagation()
                                    onRun(agent)
                                }}
                            >
                                <Play />
                                {t("maintenance.run.action")}
                            </Button>
                        )}
                    </CardFooter>
                </Card>
            ))}
        </div>
    )
}

export default MaintenanceAgentsGrid
