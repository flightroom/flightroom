import { Rocket, Wrench } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import type { Agent, Station } from "./types"

interface GalaxyBodyListsProps {
    agents: Agent[]
    stations: Station[]
    onOpenAgent: (agent: Agent) => void
}

/** Hidden until one of its entries has the focus */
const LIST_CLASS_NAME =
    "sr-only focus-within:not-sr-only focus-within:absolute focus-within:bottom-14 focus-within:left-3 focus-within:z-20 focus-within:flex focus-within:max-w-sm focus-within:flex-col focus-within:gap-1 focus-within:rounded-md focus-within:border focus-within:border-border focus-within:bg-card focus-within:p-2 focus-within:shadow-md"

/** The ships and the stations for the keyboard and screen readers: hidden until one of them has the focus, same action as a click. */
const GalaxyBodyLists: React.FC<GalaxyBodyListsProps> = ({ agents, stations, onOpenAgent }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    return (
        <>
            {agents.length > 0 && (
                <ul aria-label={t("domains.galaxy.agents_list")} className={LIST_CLASS_NAME}>
                    {agents.map(agent => (
                        <li key={agent.jobId}>
                            <Button variant="ghost" size="sm" className="max-w-full justify-start" onClick={() => onOpenAgent(agent)}>
                                <Rocket aria-hidden="true" />
                                <span className="truncate">{t("domains.galaxy.open_agent", { names: agent.names })}</span>
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {stations.length > 0 && (
                <ul aria-label={t("domains.galaxy.stations_list")} className={LIST_CLASS_NAME}>
                    {stations.map(station => (
                        <li key={`${station.agent._id}-${station.world.id}`}>
                            <Button variant="ghost" size="sm" className="max-w-full justify-start" onClick={() => navigate(`/maintenance-agent/${station.agent._id}`)}>
                                <Wrench aria-hidden="true" />
                                <span className="truncate">{t("domains.galaxy.open_station", { name: station.agent.name, world: station.world.name })}</span>
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </>
    )
}

export default GalaxyBodyLists
