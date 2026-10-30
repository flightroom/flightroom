import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router-dom"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { StatusLight } from "../MaintenanceBadges"
import { maintenanceAgentPath } from "../maintenance"
import { BayArt } from "./BayArt"
import { BayRunButton } from "./BayRunButton"
import { type BaySpot, WINDOW_Y, type WorldSpot } from "./layout"
import { StationWindow } from "./StationWindow"
import { type Hull, statusColorOf } from "./theme"
import { useBayLabels } from "./useBayLabels"

interface CompactStationProps {
    width: number
    windowHeight: number
    id: string
    hull: Hull
    primary: string
    bays: BaySpot[]
    worlds: WorldSpot[]
    active: boolean
    litWorlds: Set<string>
    onRun?: (agent: MaintenanceAgent) => void
}

/** The narrow deck: a strip of window, then a card per bay with its worlds as links. */
export const CompactStation: React.FC<CompactStationProps> = ({ width, windowHeight, id, hull, primary, bays, worlds, active, litWorlds, onRun }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { plateOf, bayLabelOf, worldLabel, bayAriaLabel } = useBayLabels()
    const worldsByKey = new Map(worlds.map(world => [world.key, world]))

    return (
        <>
            <div className="relative" style={{ height: WINDOW_Y + windowHeight + 8 }}>
                <svg width={width} height={WINDOW_Y + windowHeight + 8} className="absolute inset-0 block" aria-hidden="true" focusable="false">
                    <StationWindow windowWidth={width} windowHeight={windowHeight} id={id} hull={hull} worlds={worlds} compact={true} active={active} litWorlds={litWorlds} />
                </svg>
                {worlds.map(world => (
                    <button
                        key={world.key}
                        type="button"
                        className="absolute cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        style={{ left: world.x - world.r - 6, top: world.y - world.r - 6, width: world.r * 2 + 12, height: world.r * 2 + 12 }}
                        aria-label={worldLabel(world)}
                        title={worldLabel(world)}
                        onClick={() => navigate(world.path)}
                    />
                ))}
            </div>
            <ul className="flex flex-col gap-3 px-3">
                {bays.map(bay => (
                    <li key={bay.agent._id} className="flex gap-3 rounded-lg border p-2.5" style={{ borderColor: hull.hullEdge, backgroundColor: hull.recess[0] }}>
                        <svg viewBox="-2 -12 212 196" className="w-24 shrink-0 self-start" aria-hidden="true" focusable="false">
                            <BayArt
                                bay={bay}
                                id={id}
                                hull={hull}
                                primary={primary}
                                statusColor={statusColorOf(bay.status, hull, primary)}
                                plate={plateOf(bay.agent)}
                                bayLabel={bayLabelOf(bay.index)}
                                lit={false}
                            />
                        </svg>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <div className="flex items-start justify-between gap-2">
                                <Link to={maintenanceAgentPath(bay.agent._id)} className="min-w-0 truncate font-semibold underline-offset-4 hover:underline" aria-label={bayAriaLabel(bay)}>
                                    {bay.agent.name}
                                </Link>
                                {onRun && <BayRunButton agent={bay.agent} onRun={onRun} className="shrink-0" />}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <StatusLight status={bay.status} />
                                <span className="font-mono text-xs text-foreground-secondary">{plateOf(bay.agent)}</span>
                            </div>
                            {bay.targets.length > 0 ? (
                                <ul className="flex flex-wrap gap-1.5" aria-label={t("maintenance.targets.title")}>
                                    {bay.targets.map(target => {
                                        const world = worldsByKey.get(target)
                                        if (!world) return null
                                        return (
                                            <li key={target}>
                                                <Link
                                                    to={world.path}
                                                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs hover:border-primary"
                                                >
                                                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${world.hue})` }} aria-hidden="true" />
                                                    <span className="truncate">{world.name}</span>
                                                </Link>
                                            </li>
                                        )
                                    })}
                                </ul>
                            ) : (
                                <span className="text-xs text-foreground-secondary">{t("maintenance.targets.none")}</span>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </>
    )
}
