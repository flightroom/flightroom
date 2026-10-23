import { Info, Settings } from "lucide-react"
import { useTranslation } from "react-i18next"
import WorkspaceHeader from "@/components/ai-workspace/WorkspaceHeader"
import { Badge } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import TemplateRepositoryLink from "@/components/TemplateRepositoryLink"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { KindBadge, ScheduleLabel } from "./MaintenanceBadges"
import { MAINTENANCE_LIST_PATH, maintenanceAgentPath } from "./maintenance"

interface MaintenanceAgentHeaderProps {
    agent: MaintenanceAgent
    /** The screens of an agent: its overview and its settings */
    active: "overview" | "settings"
    actions?: React.ReactNode
}

export const MaintenanceAgentHeader: React.FC<MaintenanceAgentHeaderProps> = ({ agent, active, actions }) => {
    const { t } = useTranslation()

    return (
        <WorkspaceHeader
            back={{ to: MAINTENANCE_LIST_PATH, label: t("maintenance.back") }}
            title={agent.name}
            pageTitle={t(active === "overview" ? "maintenance.nav_overview" : "maintenance.nav_settings")}
            meta={
                <>
                    <span className="font-mono">{agent.slug}</span>
                    <KindBadge kind={agent.kind} />
                    <ScheduleLabel agent={agent} />
                    {agent.version && <Badge variant="outline">{t("backends.version_short", { version: agent.version })}</Badge>}
                    <RepositoryLink repository={agent.codeRepository} />
                    <TemplateRepositoryLink slug={agent.template} />
                </>
            }
            navLabel={t("maintenance.nav_label")}
            tabs={[
                { to: maintenanceAgentPath(agent._id), label: t("maintenance.nav_overview"), icon: Info, end: true },
                { to: `${maintenanceAgentPath(agent._id)}/settings`, label: t("maintenance.nav_settings"), icon: Settings }
            ]}
            actions={actions}
        />
    )
}

export default MaintenanceAgentHeader
