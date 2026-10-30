import { Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { cn } from "@/utils/styleUtils"

/** Play on a bay, for the deck and the compact cards alike */
export const BayRunButton: React.FC<{ agent: MaintenanceAgent; onRun: (agent: MaintenanceAgent) => void; className?: string }> = ({ agent, onRun, className }) => {
    const { t } = useTranslation()
    return (
        <Button
            variant="primary"
            size="icon-sm"
            className={cn("rounded-full shadow-md", className)}
            aria-label={t("maintenance.run.action_named", { name: agent.name })}
            title={t("maintenance.run.action_named", { name: agent.name })}
            onClick={() => onRun(agent)}
        >
            <Play />
        </Button>
    )
}
