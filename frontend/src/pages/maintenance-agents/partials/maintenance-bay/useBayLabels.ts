import { useTranslation } from "react-i18next"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { describeCron } from "../maintenance"
import type { BaySpot, WorldSpot } from "./layout"

/** The words of the deck: the clock plate of a bay, its number, and what the controls announce. */
export const useBayLabels = () => {
    const { t, i18n } = useTranslation()

    const plateOf = (agent: MaintenanceAgent) => (agent.schedule?.trim() ? (describeCron(agent.schedule, t, i18n.language, true) ?? agent.schedule.trim()) : t("maintenance.schedule.short.manual"))
    const bayLabelOf = (index: number) => t("maintenance.bay.number", { number: String(index + 1).padStart(2, "0") })
    const worldLabel = (world: WorldSpot) => t(`maintenance.bay.open_${world.kind}`, { name: world.name })
    const bayAriaLabel = (bay: BaySpot) =>
        t("maintenance.bay.open_agent", {
            name: bay.agent.name,
            kind: t(`maintenance.kind.${bay.agent.kind}`),
            status: t(`maintenance.status.${bay.status}`),
            schedule: plateOf(bay.agent)
        })

    return { plateOf, bayLabelOf, worldLabel, bayAriaLabel }
}
