import { Fragment } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import { maintenanceAgentPath } from "../maintenance"
import { BayArt } from "./BayArt"
import { BayRunButton } from "./BayRunButton"
import { BAY_ART_H, BAY_H, BAY_W, type BaySpot, DIMMED_BAY, type Hovered, PAD, truncate, WINDOW_Y, type WorldSpot } from "./layout"
import { StationWindow } from "./StationWindow"
import { type Hull, statusColorOf } from "./theme"
import { useBayLabels } from "./useBayLabels"

interface StationDeckProps {
    width: number
    height: number
    deckTop: number
    windowHeight: number
    id: string
    hull: Hull
    primary: string
    bays: BaySpot[]
    worlds: WorldSpot[]
    active: boolean
    litBays: Set<string>
    litWorlds: Set<string>
    setHovered: (hovered: Hovered) => void
    onRun?: (agent: MaintenanceAgent) => void
}

/** The wide deck: the window, the rail, the beams and the bays drawn in one picture, with buttons laid over it. */
export const StationDeck: React.FC<StationDeckProps> = ({ width, height, deckTop, windowHeight, id, hull, primary, bays, worlds, active, litBays, litWorlds, setHovered, onRun }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { plateOf, bayLabelOf, worldLabel, bayAriaLabel } = useBayLabels()
    const worldsByKey = new Map(worlds.map(world => [world.key, world]))

    return (
        <div className="relative" style={{ height }}>
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 block" aria-hidden="true" focusable="false">
                <rect width={width} height={height} fill={`url(#${id}-panels)`} />
                <StationWindow windowWidth={width} windowHeight={windowHeight} id={id} hull={hull} worlds={worlds} compact={false} active={active} litWorlds={litWorlds} />
                {/* The rail under the window, the beams cross it */}
                <rect x={PAD} y={WINDOW_Y + windowHeight + 16} width={width - 2 * PAD} height={8} rx={2} fill={hull.frame} />
                <rect x={PAD} y={WINDOW_Y + windowHeight + 24} width={width - 2 * PAD} height={3} fill={`url(#${id}-hazard)`} opacity={0.55} />
                {/* The beams, behind the bays: from each uplink up through the window to each world it maintains */}
                {bays.flatMap(bay =>
                    bay.targets.map(target => {
                        const world = worldsByKey.get(target)
                        if (!world) return null
                        const lit = active && litBays.has(bay.agent._id) && litWorlds.has(target)
                        const sx = bay.x + BAY_W / 2
                        const sy = bay.y - 6
                        const ey = world.y + world.r + 3
                        const lift = Math.min(90, (sy - ey) * 0.45)
                        return (
                            <g key={`${bay.agent._id}-${target}`}>
                                <path
                                    className="mb-beam mb-fade"
                                    d={`M${sx} ${sy} C ${sx} ${sy - lift}, ${world.x} ${ey + lift}, ${world.x} ${ey}`}
                                    fill="none"
                                    stroke={`hsl(${world.hue})`}
                                    strokeWidth={lit ? 2.2 : 1.3}
                                    strokeDasharray="3 6"
                                    strokeLinecap="round"
                                    opacity={lit ? 0.95 : active ? 0.06 : 0.36}
                                    style={{ animationDelay: `-${bay.phase}s` }}
                                />
                                {lit && <circle cx={world.x} cy={ey} r={2.4} fill={`hsl(${world.hue})`} />}
                            </g>
                        )
                    })
                )}
                {bays.map(bay => {
                    const lit = active && litBays.has(bay.agent._id)
                    return (
                        <g key={bay.agent._id} transform={`translate(${bay.x} ${bay.y})`} className="mb-fade" opacity={!active || lit ? 1 : DIMMED_BAY}>
                            <BayArt
                                bay={bay}
                                id={id}
                                hull={hull}
                                primary={primary}
                                statusColor={statusColorOf(bay.status, hull, primary)}
                                plate={plateOf(bay.agent)}
                                bayLabel={bayLabelOf(bay.index)}
                                lit={lit}
                            />
                            <text x={6} y={BAY_ART_H + 22} fontSize="13.5" fontWeight={600} fill={`hsl(${hull.ink})`}>
                                {truncate(bay.agent.name, onRun ? 22 : 26)}
                            </text>
                            <text x={6} y={BAY_ART_H + 40} fontSize="11" fill={`hsl(${hull.ink} / 0.62)`}>
                                {`${t(`maintenance.kind.${bay.agent.kind}`)} · ${t("maintenance.bay.targets", { count: bay.targets.length })}`}
                            </text>
                        </g>
                    )
                })}
            </svg>

            {/* The same deck for the pointer, the keyboard and the screen readers */}
            {worlds.map(world => (
                <button
                    key={world.key}
                    type="button"
                    className="absolute cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    style={{ left: world.x - world.r - 8, top: world.y - world.r - 8, width: world.r * 2 + 16, height: world.r * 2 + 16 }}
                    aria-label={worldLabel(world)}
                    title={worldLabel(world)}
                    onMouseEnter={() => setHovered({ kind: "world", key: world.key })}
                    onFocus={() => setHovered({ kind: "world", key: world.key })}
                    onBlur={() => setHovered(null)}
                    onClick={() => navigate(world.path)}
                />
            ))}
            {bays.map(bay => (
                <Fragment key={bay.agent._id}>
                    <button
                        type="button"
                        className="absolute cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        style={{ left: bay.x, top: bay.y - 12, width: BAY_W, height: BAY_H + 12 }}
                        aria-label={bayAriaLabel(bay)}
                        onMouseEnter={() => setHovered({ kind: "bay", id: bay.agent._id })}
                        onFocus={() => setHovered({ kind: "bay", id: bay.agent._id })}
                        onBlur={() => setHovered(null)}
                        onClick={() => navigate(maintenanceAgentPath(bay.agent._id))}
                    />
                    {onRun && (
                        <div className="absolute" style={{ left: bay.x + BAY_W - 34, top: bay.y + BAY_ART_H + 8 }} onMouseEnter={() => setHovered({ kind: "bay", id: bay.agent._id })}>
                            <BayRunButton agent={bay.agent} onRun={onRun} />
                        </div>
                    )}
                </Fragment>
            ))}
            {bays.length === 0 && (
                <p className="absolute inset-x-0 text-center text-sm text-foreground-secondary" style={{ top: deckTop + 20 }}>
                    {t("maintenance.bay.empty_deck")}
                </p>
            )}
        </div>
    )
}
