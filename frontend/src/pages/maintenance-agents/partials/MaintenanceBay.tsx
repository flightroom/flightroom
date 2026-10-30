import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import useIsDark from "@/hooks/useIsDark"
import { useNow } from "./maintenance"
import { BayLegend } from "./maintenance-bay/BayLegend"
import { CompactStation } from "./maintenance-bay/CompactStation"
import { COMPACT_WIDTH, type Hovered, layoutStation, litOf, STRIP_HEIGHT, WINDOW_HEIGHT } from "./maintenance-bay/layout"
import { StationDeck } from "./maintenance-bay/StationDeck"
import { StationDefs } from "./maintenance-bay/StationDefs"
import { ANIMATIONS, HULLS, readPrimaryHue } from "./maintenance-bay/theme"

interface MaintenanceBayProps {
    agents: MaintenanceAgent[]
    backends: Backend[]
    frontends: Frontend[]
    /** The resources of the project: the ones an agent attaches stand next to its bay as canisters */
    resources?: Resource[]
    /** Play on a bay; without it (a viewer) the bays have no Play button */
    onRun?: (agent: MaintenanceAgent) => void
    /** The whole deck (the list) or the bay of one agent (its page): a lower window, no hint */
    variant?: "deck" | "single"
}

/** One empty list for every render, so a missing `resources` does not defeat the memoized layout */
const NO_RESOURCES: Resource[] = []

/**
 * The maintenance bay of the station: through the long window, the worlds the agents maintain (the backends
 * and the frontends, as the galaxies draw them); below, a deck with a bay per agent. An always-on container is a
 * drone on its powered tether, a job a shuttle docked under a crane. A beam runs from each bay to each world it
 * maintains, the resources it attaches stand next to it as canisters, its light says how it runs.
 */
const MaintenanceBay: React.FC<MaintenanceBayProps> = ({ agents, backends, frontends, resources = NO_RESOURCES, onRun, variant = "deck" }) => {
    const { t } = useTranslation()
    const containerRef = useRef<HTMLDivElement>(null)
    const [width, setWidth] = useState(0)
    const [hovered, setHovered] = useState<Hovered>(null)
    const [primary] = useState(readPrimaryHue)
    const isDark = useIsDark()
    const hull = HULLS[isDark ? "dark" : "light"]
    const now = useNow()
    const id = `mb${useId().replace(/[^a-zA-Z0-9]/g, "")}`
    const compact = width > 0 && width < COMPACT_WIDTH
    const windowHeight = compact ? STRIP_HEIGHT : WINDOW_HEIGHT[variant]

    // Measured before the first paint, so the deck is laid out at once; then followed as the page resizes
    useLayoutEffect(() => {
        const element = containerRef.current
        if (!element) return
        setWidth(Math.floor(element.getBoundingClientRect().width))
        const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
        observer.observe(element)
        return () => observer.disconnect()
    }, [])

    const { bays, worlds, height, deckTop } = useMemo(
        () => layoutStation({ agents, backends, frontends, resources, width, now, windowHeight, compact, hull, primary }),
        [agents, backends, frontends, resources, width, now, windowHeight, compact, hull, primary]
    )
    const { litBays, litWorlds, active } = litOf(hovered, bays)

    return (
        <div
            ref={containerRef}
            className="relative flex flex-col gap-3 overflow-hidden rounded-lg border-2 border-border pb-3"
            style={{ backgroundColor: hull.hull }}
            onMouseLeave={() => setHovered(null)}
        >
            <style>{ANIMATIONS}</style>
            <p className="sr-only">{t("maintenance.bay.summary", { count: agents.length, worlds: worlds.length })}</p>
            {/* The gradients the deck and the compact cards share */}
            <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
                <StationDefs id={id} hull={hull} primary={primary} isDark={isDark} />
            </svg>

            {width > 0 && !compact && (
                <StationDeck
                    width={width}
                    height={height}
                    deckTop={deckTop}
                    windowHeight={windowHeight}
                    id={id}
                    hull={hull}
                    primary={primary}
                    bays={bays}
                    worlds={worlds}
                    active={active}
                    litBays={litBays}
                    litWorlds={litWorlds}
                    setHovered={setHovered}
                    onRun={onRun}
                />
            )}

            {width > 0 && compact && (
                <CompactStation width={width} windowHeight={windowHeight} id={id} hull={hull} primary={primary} bays={bays} worlds={worlds} active={active} litWorlds={litWorlds} onRun={onRun} />
            )}

            {width === 0 && <div className="min-h-[420px]" />}

            <div className="flex flex-wrap items-end justify-between gap-3 px-3">
                <BayLegend compact={compact} />
                {variant === "deck" && !compact && (
                    <p className="max-w-sm rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground-secondary shadow-sm">{t("maintenance.bay.hint")}</p>
                )}
            </div>
        </div>
    )
}

export default MaintenanceBay
