import { Play } from "lucide-react"
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router-dom"
import { Button } from "@/components/atoms"
import { resourceBrand, resourceTypeGlyph } from "@/components/resource/resourceIcons"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import useIsDark from "@/hooks/useIsDark"
import { cn } from "@/utils/styleUtils"
import { DroneGlyph, ShuttleGlyph, STATUS_DOT_CLASS, StatusLight } from "./MaintenanceBadges"
import { describeCron, type MaintenanceStatus, maintenanceAgentPath, maintenanceStatusOf, useNow } from "./maintenance"

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

/** A backend or a frontend some agent maintains, seen through the window */
interface WorldSpot {
    key: string
    kind: "backend" | "frontend"
    /** Shortened to the room it has in the window */
    label: string
    name: string
    path: string
    x: number
    y: number
    r: number
    hue: string
    showLabel: boolean
}

interface BaySpot {
    agent: MaintenanceAgent
    index: number
    x: number
    y: number
    status: MaintenanceStatus
    /** The keys of the worlds it maintains */
    targets: string[]
    resources: Resource[]
    /** Seconds: each bay breathes out of step with its neighbours */
    phase: number
}

type Hovered = { kind: "bay"; id: string } | { kind: "world"; key: string } | null

interface Hull {
    hull: string
    hullEdge: string
    panel: string
    rivet: string
    recess: [string, string]
    recessEdge: string
    space: [string, string]
    /** The labels, the stars and the stencils, as HSL components */
    ink: string
    starAlpha: number
    frame: string
    frameLight: string
    glassAlpha: number
    metal: [string, string, string]
    visor: string
    hazard: string
    hazardDark: string
    backend: string
    canister: string
    flame: string
    nebulae: [string, string]
    glowAlpha: number
    failed: string
    scheduled: string
    standby: string
}

/**
 * The colours of the station, from the same brand scales of the design system as the sky of the domains:
 * a charcoal hull around deep space in the dark theme, brushed steel around a star chart on paper in the light one.
 */
const HULLS: Record<"dark" | "light", Hull> = {
    dark: {
        hull: "#0C2533",
        hullEdge: "#2F4959", // charcoal-800
        panel: "hsl(203 30% 40% / 0.22)",
        rivet: "#2F4959",
        recess: ["#04121A", "#0A2230"],
        recessEdge: "#1B3647",
        space: ["#020E15", "#07202D"], // charcoal-950
        ink: "38 44% 96%", // foreground (dark)
        starAlpha: 1,
        frame: "#233D4D", // charcoal-900
        frameLight: "#486172", // charcoal-700
        glassAlpha: 0.07,
        metal: ["#E4EFF6", "#B7C7D2", "#637B8B"], // charcoal-100, 300, 600
        visor: "#07202D",
        hazard: "#FCCA46", // sunglow-200
        hazardDark: "#0C2533",
        backend: "162 28% 61%", // zomp-400
        canister: "162 51% 81%", // zomp-200
        flame: "44 97% 63%", // sunglow-200
        nebulae: ["162 28% 61%", "24 99% 59%"], // zomp-400, pumpkin-400
        glowAlpha: 0.5,
        failed: "0 84% 64%",
        scheduled: "91 41% 69%", // olivine-300
        standby: "44 97% 63%" // sunglow-200
    },
    light: {
        hull: "#D0DDE6", // charcoal-200
        hullEdge: "#9BAEBB", // charcoal-400
        panel: "hsl(203 37% 22% / 0.13)",
        rivet: "#9BAEBB",
        recess: ["#E4EFF6", "#F6FBFE"],
        recessEdge: "#B7C7D2", // charcoal-300
        space: ["#EFF8FE", "#E4EFF6"], // charcoal-50, 100
        ink: "203 37% 22%", // charcoal-900
        starAlpha: 0.4,
        frame: "#486172", // charcoal-700
        frameLight: "#8096A4", // charcoal-500
        glassAlpha: 0.45,
        metal: ["#8096A4", "#486172", "#233D4D"], // charcoal-500, 700, 900
        visor: "#07202D",
        hazard: "#D3A312", // sunglow-400
        hazardDark: "#E4EFF6",
        backend: "163 27% 41%", // zomp-600
        canister: "164 33% 31%", // zomp-700
        flame: "45 84% 45%", // sunglow-400
        nebulae: ["162 23% 49%", "26 92% 47%"], // zomp-500, pumpkin-500
        glowAlpha: 0.32,
        failed: "0 72% 45%",
        scheduled: "89 27% 40%", // olivine-600
        standby: "46 92% 30%" // sunglow-600
    }
}
/** pumpkin-400, the primary of the design system */
const FALLBACK_PRIMARY = "24 99% 59%"
/** charcoal-50: the bright core of every world, as in the galaxies */
const STAR_CORE = "204 88% 97%"

const PAD = 20
const WINDOW_Y = 20
const WINDOW_HEIGHT = { deck: 196, single: 150 }
const STRIP_HEIGHT = 96
/** Under the window, the rail the beams cross before reaching the bays */
const RAIL_GAP = 48
const BAY_W = 208
/** The art of a bay, then its name and its line of details */
const BAY_ART_H = 186
const BAY_H = 236
const GAP_X = 18
const GAP_Y = 34
/** Below it the deck turns into a list of cards: the bays, the beams and the labels would not fit */
const COMPACT_WIDTH = 640
/** Canisters drawn by a bay; beyond them a "+N" tag */
const CANISTER_SLOTS = [22, 40, 154, 172]
const DIMMED_BAY = 0.38
const DIMMED_WORLD = 0.28

const readPrimaryHue = () => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || FALLBACK_PRIMARY

/** A fixed sky: seeded, so the stars do not jump around at every mount. */
const WINDOW_STARS = (() => {
    let seed = 11
    const random = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
    }
    return Array.from({ length: 160 }, (_, index) => ({
        x: random(),
        y: random(),
        r: random() < 0.88 ? 0.7 : 1.3,
        alpha: 0.2 + random() * 0.6,
        twinkle: index % 9 === 0,
        delay: random() * 4
    }))
})()

/** A stable spread from an id, so a bay keeps its rhythm across polls. */
const phaseOf = (id: string) => {
    let hash = 0
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
    return (hash / 9973) * 4
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text)

const ANIMATIONS = `
@media (prefers-reduced-motion: no-preference) {
    .mb-bob { animation: mb-bob 3.6s ease-in-out infinite; }
    .mb-thrust { animation: mb-thrust 0.9s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 50% 0; }
    .mb-tether { animation: mb-tether 1.1s linear infinite; }
    .mb-beam { animation: mb-beam 1.6s linear infinite; }
    .mb-twinkle { animation: mb-twinkle 4s ease-in-out infinite; }
    .mb-pulse { animation: mb-pulse 1.8s ease-out infinite; transform-box: fill-box; transform-origin: center; }
    .mb-scan { animation: mb-scan 5s ease-in-out infinite; }
    .mb-flame { animation: mb-flame 0.16s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 100% 50%; }
    .mb-breathe { animation: mb-breathe 6s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
}
@keyframes mb-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes mb-thrust { from { opacity: 0.55; transform: scaleY(0.8); } to { opacity: 1; transform: scaleY(1.12); } }
@keyframes mb-tether { to { stroke-dashoffset: -20; } }
@keyframes mb-beam { to { stroke-dashoffset: -18; } }
@keyframes mb-twinkle { 0%, 100% { opacity: 0.15; } 50% { opacity: 1; } }
@keyframes mb-pulse { from { opacity: 0.85; transform: scale(1); } to { opacity: 0; transform: scale(2.8); } }
@keyframes mb-scan { 0%, 100% { transform: translateX(-7px); } 50% { transform: translateX(7px); } }
@keyframes mb-flame { from { opacity: 0.8; transform: scaleX(0.82); } to { opacity: 1; transform: scaleX(1.08); } }
@keyframes mb-breathe { 0%, 100% { opacity: 0.8; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
.mb-fade { transition: opacity 200ms ease, stroke-width 200ms ease; }
`

/** The gradients and patterns of the station, once per instance: the cards of the compact deck reference them too. */
const StationDefs: React.FC<{ id: string; hull: Hull; primary: string; isDark: boolean }> = ({ id, hull, primary, isDark }) => (
    <defs>
        {(["backend", "frontend"] as const).map(kind => (
            <radialGradient key={kind} id={`${id}-glow-${kind}`}>
                <stop offset="0.3" stopColor={`hsl(${kind === "backend" ? hull.backend : primary} / ${hull.glowAlpha})`} />
                <stop offset="1" stopColor={`hsl(${kind === "backend" ? hull.backend : primary} / 0)`} />
            </radialGradient>
        ))}
        {/* Lit from the upper left: a soft highlight, the far side in shadow */}
        <radialGradient id={`${id}-shade`} cx="0.36" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#ffffff" stopOpacity={0.32} />
            <stop offset="0.45" stopColor="#ffffff" stopOpacity={0} />
            <stop offset="1" stopColor="#000000" stopOpacity={isDark ? 0.5 : 0.32} />
        </radialGradient>
        <linearGradient id={`${id}-space`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={hull.space[0]} />
            <stop offset="1" stopColor={hull.space[1]} />
        </linearGradient>
        <linearGradient id={`${id}-recess`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={hull.recess[0]} />
            <stop offset="1" stopColor={hull.recess[1]} />
        </linearGradient>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={hull.metal[0]} />
            <stop offset="0.55" stopColor={hull.metal[1]} />
            <stop offset="1" stopColor={hull.metal[2]} />
        </linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity={0} />
            <stop offset="0.5" stopColor="#ffffff" stopOpacity={hull.glassAlpha} />
            <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </linearGradient>
        <radialGradient id={`${id}-thrust`} cx="0.5" cy="0" r="1">
            <stop offset="0" stopColor={`hsl(${hull.flame})`} stopOpacity={0.95} />
            <stop offset="0.4" stopColor={`hsl(${primary})`} stopOpacity={0.55} />
            <stop offset="1" stopColor={`hsl(${primary})`} stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${id}-flame`} cx="1" cy="0.5" r="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.3" stopColor={`hsl(${hull.flame})`} />
            <stop offset="1" stopColor={`hsl(${primary})`} stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${id}-pool`}>
            <stop offset="0" stopColor={`hsl(${primary})`} stopOpacity={isDark ? 0.45 : 0.3} />
            <stop offset="1" stopColor={`hsl(${primary})`} stopOpacity={0} />
        </radialGradient>
        {hull.nebulae.map((hue, index) => (
            <radialGradient key={hue} id={`${id}-nebula-${index}`}>
                <stop offset="0" stopColor={`hsl(${hue})`} stopOpacity={isDark ? 0.2 : 0.14} />
                <stop offset="1" stopColor={`hsl(${hue})`} stopOpacity={0} />
            </radialGradient>
        ))}
        <pattern id={`${id}-hazard`} width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="10" height="10" fill={hull.hazardDark} />
            <rect width="5" height="10" fill={hull.hazard} />
        </pattern>
        {/* Hull plates: a seam on two sides and a rivet in each corner */}
        <pattern id={`${id}-panels`} width="112" height="72" patternUnits="userSpaceOnUse">
            <path d="M0 0.5H112M0.5 0V72" stroke={hull.panel} strokeWidth="1" fill="none" />
            <circle cx="5" cy="5" r="1.3" fill={hull.rivet} />
            <circle cx="107" cy="5" r="1.3" fill={hull.rivet} />
            <circle cx="5" cy="67" r="1.3" fill={hull.rivet} />
            <circle cx="107" cy="67" r="1.3" fill={hull.rivet} />
        </pattern>
    </defs>
)

/** A world as the galaxies draw it: its glow, its disc with a bright core, lit from one side. */
const WorldArt: React.FC<{ world: WorldSpot; id: string; hull: Hull; opacity: number; lit: boolean }> = ({ world, id, hull, opacity, lit }) => (
    <g className="mb-fade" opacity={opacity}>
        <circle className="mb-breathe" cx={world.x} cy={world.y} r={world.r * 2.9} fill={`url(#${id}-glow-${world.kind})`} />
        <circle cx={world.x} cy={world.y} r={world.r} fill={`hsl(${world.hue})`} />
        <circle cx={world.x} cy={world.y} r={world.r * 0.4} fill={`hsl(${STAR_CORE} / 0.8)`} />
        <circle cx={world.x} cy={world.y} r={world.r} fill={`url(#${id}-shade)`} />
        {lit && <circle cx={world.x} cy={world.y} r={world.r + 4} fill="none" stroke={`hsl(${hull.ink} / 0.85)`} strokeWidth="1.2" strokeDasharray="2 3" />}
        {(world.showLabel || lit) && (
            <text
                x={world.x}
                y={world.y - world.r - 9}
                textAnchor="middle"
                fontSize="11"
                fontWeight={lit ? 600 : 500}
                fill={`hsl(${hull.ink} / 0.9)`}
                stroke={hull.space[1]}
                strokeWidth="3"
                paintOrder="stroke"
            >
                {world.label}
            </text>
        )}
    </g>
)

/** A resource as a fuel canister: its brand or the icon of its type on the label band. */
const Canister: React.FC<{ resource?: Resource; extra?: number; x: number; hull: Hull }> = ({ resource, extra, x, hull }) => {
    const brand = resource ? resourceBrand(resource) : undefined
    return (
        <g>
            {resource && <title>{resource.name}</title>}
            <rect x={x + 3} y={139} width={8} height={4} rx={1.2} fill={hull.frameLight} />
            <rect x={x} y={142} width={14} height={22} rx={3.5} fill={`hsl(${hull.canister})`} />
            <path d={`M${x + 7} 142 h3.5 a3.5 3.5 0 0 1 3.5 3.5 v15 a3.5 3.5 0 0 1 -3.5 3.5 h-3.5 Z`} fill="#000" opacity={0.14} />
            <rect x={x} y={146} width={14} height={1.6} fill="#000" opacity={0.22} />
            <rect x={x} y={159} width={14} height={1.6} fill="#000" opacity={0.22} />
            {extra !== undefined ? (
                <text x={x + 7} y={156.5} textAnchor="middle" fontSize="7.5" fontWeight={700} fill={hull.visor}>
                    +{extra}
                </text>
            ) : brand ? (
                <path d={brand.path} transform={`translate(${x + 2.5} 148.5) scale(${9 / 24})`} fill={hull.visor} />
            ) : (
                resource && (
                    <g
                        transform={`translate(${x + 2.5} 148.5) scale(${9 / 24})`}
                        fill="none"
                        stroke={hull.visor}
                        strokeWidth={2.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        // The markup of a lucide icon, the same the galaxy strokes on its moons
                        dangerouslySetInnerHTML={{ __html: resourceTypeGlyph(resource.type) }}
                    />
                )
            )}
        </g>
    )
}

/** The always-on container: a drone hovering on its powered tether, thrusters glowing, its eye scanning. */
const Drone: React.FC<{ id: string; hull: Hull; primary: string; phase: number; busy: boolean }> = ({ id, hull, primary, phase, busy }) => (
    <g>
        <ellipse className="mb-breathe" cx={104} cy={163} rx={44} ry={5} fill={`url(#${id}-pool)`} style={{ animationDelay: `-${phase}s` }} />
        {/* The tether from the ceiling socket, the energy running down it */}
        <path d="M104 30 C 92 46, 116 60, 104 78" fill="none" stroke={hull.metal[2]} strokeWidth={3.2} strokeLinecap="round" />
        <path
            className="mb-tether"
            d="M104 30 C 92 46, 116 60, 104 78"
            fill="none"
            stroke={`hsl(${primary})`}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeDasharray="2 8"
            style={{ animationDelay: `-${phase}s` }}
        />
        <g transform="translate(104 96)">
            <g className="mb-bob" style={{ animationDelay: `-${phase}s` }}>
                {[-38, 38].map(x => (
                    <ellipse key={x} className="mb-thrust" cx={x} cy={22} rx={busy ? 7.5 : 6} ry={busy ? 14 : 10} fill={`url(#${id}-thrust)`} style={{ animationDelay: `-${phase / 3}s` }} />
                ))}
                <path d="M-36 6 H36" stroke={hull.metal[2]} strokeWidth={3.5} strokeLinecap="round" />
                {[-38, 38].map(x => (
                    <g key={x}>
                        <ellipse cx={x} cy={7} rx={11} ry={7.5} fill={`url(#${id}-metal)`} />
                        <ellipse cx={x} cy={12.5} rx={7} ry={2} fill={hull.visor} opacity={0.75} />
                    </g>
                ))}
                {/* The manipulator arms, folded under the body */}
                <path d="M-9 19 l-7 9 l4 6 M9 19 l7 9 l-4 6" fill="none" stroke={hull.metal[2]} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
                <rect x={-6} y={-24} width={12} height={8} rx={2} fill={hull.metal[2]} />
                <rect x={-25} y={-18} width={50} height={40} rx={15} fill={`url(#${id}-metal)`} />
                <path d="M-18 -13 Q 0 -19 18 -13" fill="none" stroke="#ffffff" strokeOpacity={0.35} strokeWidth={2} strokeLinecap="round" />
                <rect x={-18} y={-7} width={36} height={14} rx={7} fill={hull.visor} />
                <g className="mb-scan" style={{ animationDelay: `-${phase}s` }}>
                    <circle cx={0} cy={0} r={8} fill={`hsl(${primary} / 0.28)`} />
                    <circle cx={0} cy={0} r={3.6} fill={`hsl(${primary})`} />
                    <circle cx={-1.2} cy={-1.2} r={1.1} fill="#ffffff" opacity={0.9} />
                </g>
                <rect x={-14} y={13} width={28} height={2.4} rx={1.2} fill={`hsl(${primary})`} opacity={0.7} />
            </g>
        </g>
    </g>
)

/** The job: a shuttle docked on its cradle under the crane hook, engines cold until it runs. */
const Shuttle: React.FC<{ id: string; hull: Hull; primary: string; busy: boolean }> = ({ id, hull, primary, busy }) => (
    <g>
        {/* The crane: its trolley on the ceiling beam, the cable and the hook holding the shuttle */}
        <rect x={90} y={30} width={28} height={8} rx={2} fill={hull.metal[2]} />
        <circle cx={96} cy={39} r={2.2} fill={hull.frameLight} />
        <circle cx={112} cy={39} r={2.2} fill={hull.frameLight} />
        <path d="M102 40 V82 M106 40 V82" stroke={hull.metal[2]} strokeWidth={1.4} />
        <rect x={97} y={80} width={14} height={9} rx={2.5} fill={hull.frameLight} />
        <path d="M104 89 v5 a4.5 4.5 0 1 0 4.5 4.5" fill="none" stroke={hull.metal[1]} strokeWidth={2.6} strokeLinecap="round" />
        {/* The cradle */}
        {[80, 128].map(x => (
            <g key={x}>
                <rect x={x - 4} y={144} width={8} height={20} fill={hull.frame} />
                <rect x={x - 11} y={141} width={22} height={5} rx={2} fill={hull.frameLight} />
            </g>
        ))}
        <g transform="translate(106 122)">
            {busy && <ellipse className="mb-flame" cx={-70} cy={0} rx={16} ry={7} fill={`url(#${id}-flame)`} />}
            <path d="M-30 -14 L-50 -30 L-14 -17 Z M-30 14 L-50 30 L-14 17 Z" fill={hull.metal[2]} />
            <path d="M-48 -8 L-58 -11 L-58 11 L-48 8 Z" fill={hull.metal[2]} />
            <ellipse cx={-58} cy={0} rx={2} ry={10} fill={busy ? `hsl(${hull.flame})` : hull.visor} />
            <path d="M-48 0 C -48 -15 -20 -21 10 -21 C 34 -21 49 -11 56 0 C 49 11 34 21 10 21 C -20 21 -48 15 -48 0 Z" fill={`url(#${id}-metal)`} />
            <path d="M-46 4 C -40 15 -18 21 10 21 C 34 21 49 11 56 0 C 30 6 -10 8 -46 4 Z" fill="#000000" opacity={0.16} />
            <rect x={-22} y={-2.5} width={36} height={5} rx={2.5} fill={`hsl(${primary})`} />
            <path d="M22 -9 C 32 -10 41 -6 46 -1 C 40 1 30 2 22 1 Z" fill={hull.visor} />
            <path d="M26 -6.5 C 31 -7 35 -5.5 38 -3.5" fill="none" stroke="#ffffff" strokeOpacity={0.7} strokeWidth={1.2} strokeLinecap="round" />
            {/* The lifting eye the hook goes through */}
            <circle cx={-2} cy={-23} r={3.2} fill="none" stroke={hull.metal[2]} strokeWidth={2} />
        </g>
    </g>
)

interface BayArtProps {
    bay: BaySpot
    id: string
    hull: Hull
    primary: string
    statusColor: string
    /** The schedule in its short form, or manual */
    plate: string
    bayLabel: string
    lit: boolean
}

/** One bay of the deck, 208 wide, drawn from its own origin: the deck translates it, a compact card draws it alone. */
const BayArt: React.FC<BayArtProps> = ({ bay, id, hull, primary, statusColor, plate, bayLabel, lit }) => {
    const { agent, status, resources, phase } = bay
    const busy = status === "recent"
    const plateText = truncate(plate, 16)
    const plateWidth = Math.min(116, 26 + plateText.length * 5.4)
    const shown = resources.length > CANISTER_SLOTS.length ? resources.slice(0, CANISTER_SLOTS.length - 1) : resources
    const extra = resources.length - shown.length

    return (
        <g>
            {/* The uplink the beams leave from */}
            <path d="M104 10 V-5" stroke={hull.frameLight} strokeWidth={2} />
            <circle cx={104} cy={-6} r={3} fill={lit ? `hsl(${primary})` : hull.frameLight} className="mb-fade" />
            <rect x={4} y={10} width={200} height={170} rx={14} fill={`url(#${id}-recess)`} stroke={lit ? `hsl(${primary} / 0.7)` : hull.recessEdge} strokeWidth={lit ? 1.6 : 1} />
            {/* Pillars, ceiling beam and floor, striped where the drones must not go */}
            <rect x={10} y={30} width={9} height={134} fill={hull.frame} />
            <rect x={189} y={30} width={9} height={134} fill={hull.frame} />
            <rect x={10} y={128} width={9} height={36} fill={`url(#${id}-hazard)`} opacity={0.75} />
            <rect x={189} y={128} width={9} height={36} fill={`url(#${id}-hazard)`} opacity={0.75} />
            <path d="M4 24 Q4 10 18 10 H190 Q204 10 204 24 V32 H4 Z" fill={hull.frame} />
            <circle cx={12} cy={27} r={1.4} fill={hull.frameLight} />
            <circle cx={196} cy={27} r={1.4} fill={hull.frameLight} />
            <rect x={4} y={164} width={200} height={16} rx={3} fill={hull.frame} />
            <rect x={20} y={164} width={168} height={4} fill={`url(#${id}-hazard)`} opacity={0.85} />

            {agent.kind === "job" ? <Shuttle id={id} hull={hull} primary={primary} busy={busy} /> : <Drone id={id} hull={hull} primary={primary} phase={phase} busy={busy} />}

            {shown.map((resource, index) => (
                <Canister key={resource._id} resource={resource} x={CANISTER_SLOTS[index]} hull={hull} />
            ))}
            {extra > 0 && <Canister extra={extra} x={CANISTER_SLOTS[CANISTER_SLOTS.length - 1]} hull={hull} />}

            {/* Status light and bay number on the left of the beam, the clock plate on its right */}
            {busy && <circle className="mb-pulse" cx={22} cy={21} r={4} fill={`hsl(${statusColor})`} />}
            <circle cx={22} cy={21} r={9} fill={`hsl(${statusColor} / 0.22)`} />
            <circle cx={22} cy={21} r={4} fill={`hsl(${statusColor})`} />
            <text x={32} y={24.5} fontSize="8.5" fontWeight={600} letterSpacing="0.6" fill="#EFF8FE" fillOpacity={0.72} className="font-mono">
                {bayLabel}
            </text>
            <g transform={`translate(${198 - plateWidth} 13)`}>
                <title>{plate}</title>
                <rect width={plateWidth} height={16} rx={4} fill={hull.visor} stroke={hull.frameLight} strokeWidth={0.8} />
                <circle cx={10} cy={8} r={4.2} fill="none" stroke={`hsl(${statusColor})`} strokeWidth={1.2} />
                <path d="M10 5.4 V8 L11.8 9.2" fill="none" stroke={`hsl(${statusColor})`} strokeWidth={1.1} strokeLinecap="round" />
                <text x={19} y={11.4} fontSize="9" fill="#EFF8FE" className="font-mono">
                    {plateText}
                </text>
            </g>
        </g>
    )
}

/**
 * The maintenance bay of the station: through the long window, the worlds the agents maintain (the backends
 * and the frontends, as the galaxies draw them); below, a deck with a bay per agent. An always-on container is a
 * drone on its powered tether, a job a shuttle docked under a crane. A beam runs from each bay to each world it
 * maintains, the resources it attaches stand next to it as canisters, its light says how it runs.
 */
export const MaintenanceBay: React.FC<MaintenanceBayProps> = ({ agents, backends, frontends, resources = [], onRun, variant = "deck" }) => {
    const { t, i18n } = useTranslation()
    const navigate = useNavigate()
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

    const statusColor = (status: MaintenanceStatus) => (status === "recent" ? primary : hull[status])

    const layout = useMemo(() => {
        const backendsById = new Map(backends.map(backend => [backend._id!, backend]))
        const frontendsById = new Map(frontends.map(frontend => [frontend._id!, frontend]))
        const resourcesById = new Map(resources.map(resource => [resource._id!, resource]))

        // The bays, row by row, each row centred on the deck
        const columns = Math.max(1, Math.floor((width - 2 * PAD + GAP_X) / (BAY_W + GAP_X)))
        const deckTop = WINDOW_Y + windowHeight + RAIL_GAP
        const bays: BaySpot[] = agents.map((agent, index) => {
            const row = Math.floor(index / columns)
            const inRow = Math.min(columns, agents.length - row * columns)
            const left = (width - (inRow * BAY_W + (inRow - 1) * GAP_X)) / 2
            return {
                agent,
                index,
                x: left + (index % columns) * (BAY_W + GAP_X),
                y: deckTop + row * (BAY_H + GAP_Y),
                status: maintenanceStatusOf(agent, now),
                targets: [
                    ...agent.backendIds.filter(target => backendsById.has(target)).map(target => `backend:${target}`),
                    ...agent.frontendIds.filter(target => frontendsById.has(target)).map(target => `frontend:${target}`)
                ],
                resources: agent.resourceIds.flatMap(resourceId => resourcesById.get(resourceId) ?? []),
                phase: phaseOf(agent._id)
            }
        })
        const rows = Math.ceil(agents.length / columns)
        const height = deckTop + rows * BAY_H + Math.max(0, rows - 1) * GAP_Y + PAD

        // The worlds over the bays that maintain them, so the beams cross as little as they can
        const users = new Map<string, number[]>()
        for (const bay of bays) {
            for (const target of bay.targets) users.set(target, [...(users.get(target) ?? []), bay.x + BAY_W / 2])
        }
        const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
        const keys = [...users.keys()].sort((a, b) => average(users.get(a)!) - average(users.get(b)!))
        const inner = width - 2 * PAD - 48
        const spacing = keys.length ? inner / keys.length : inner
        const baseRadius = compact ? 6 : Math.max(7, Math.min(13, spacing * 0.15))
        const worlds: WorldSpot[] = keys.map((key, index) => {
            const [kind, targetId] = key.split(":") as ["backend" | "frontend", string]
            const member = kind === "backend" ? backendsById.get(targetId)! : frontendsById.get(targetId)!
            return {
                key,
                kind,
                label: truncate(member.name, Math.max(6, Math.floor(spacing / 6.6))),
                name: member.name,
                path: kind === "backend" ? `/backend/${targetId}` : `/frontend/${targetId}`,
                x: PAD + 24 + spacing * (index + 0.5),
                y: compact ? WINDOW_Y + windowHeight / 2 + (index % 2 ? -10 : 10) : WINDOW_Y + windowHeight * 0.6 + (index % 2 ? -14 : 12),
                r: baseRadius + Math.min(4, users.get(key)!.length - 1) * (compact ? 0.6 : 1.3),
                hue: kind === "backend" ? hull.backend : primary,
                showLabel: !compact && spacing >= 70
            }
        })
        return { bays, worlds, height, deckTop }
    }, [agents, backends, frontends, resources, width, now, windowHeight, compact, hull, primary])

    const { bays, worlds, height, deckTop } = layout
    const worldsByKey = new Map(worlds.map(world => [world.key, world]))

    // What the pointer or the focus is on lights up with what it is tied to; the rest dims.
    const litBays = new Set<string>()
    const litWorlds = new Set<string>()
    if (hovered?.kind === "bay") {
        litBays.add(hovered.id)
        for (const target of bays.find(bay => bay.agent._id === hovered.id)?.targets ?? []) litWorlds.add(target)
    } else if (hovered?.kind === "world") {
        litWorlds.add(hovered.key)
        for (const bay of bays) if (bay.targets.includes(hovered.key)) litBays.add(bay.agent._id)
    }
    const active = hovered !== null

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

    /** The window: deep space (or the star chart), the worlds, the frame bolted to the hull */
    const renderWindow = (windowWidth: number) => {
        const x = PAD
        const w = windowWidth - 2 * PAD
        // The window panes: evenly spread, each moved to the gap between two worlds so no label is cut
        const gaps = worlds.slice(1).map((world, index) => (world.x + worlds[index].x) / 2)
        const count = Math.max(0, Math.floor(w / 280))
        const mullions = [
            ...new Set(
                Array.from({ length: count }, (_, index) => {
                    const ideal = x + (w * (index + 1)) / (count + 1)
                    return gaps.length ? gaps.reduce((best, gap) => (Math.abs(gap - ideal) < Math.abs(best - ideal) ? gap : best)) : ideal
                })
            )
        ]
        return (
            <g>
                <clipPath id={`${id}-pane`}>
                    <rect x={x} y={WINDOW_Y} width={w} height={windowHeight} rx={16} />
                </clipPath>
                <g clipPath={`url(#${id}-pane)`}>
                    <rect x={x} y={WINDOW_Y} width={w} height={windowHeight} fill={`url(#${id}-space)`} />
                    <ellipse cx={x + w * 0.22} cy={WINDOW_Y + windowHeight * 0.4} rx={w * 0.28} ry={windowHeight * 0.9} fill={`url(#${id}-nebula-0)`} />
                    <ellipse cx={x + w * 0.8} cy={WINDOW_Y + windowHeight * 0.65} rx={w * 0.25} ry={windowHeight * 0.8} fill={`url(#${id}-nebula-1)`} />
                    {WINDOW_STARS.map((star, index) => (
                        <circle
                            key={index}
                            className={star.twinkle ? "mb-twinkle" : undefined}
                            style={star.twinkle ? { animationDelay: `-${star.delay}s` } : undefined}
                            cx={x + star.x * w}
                            cy={WINDOW_Y + star.y * windowHeight}
                            r={star.r}
                            fill={`hsl(${hull.ink} / ${star.alpha * hull.starAlpha})`}
                        />
                    ))}
                    {worlds.map(world => (
                        <WorldArt key={world.key} world={world} id={id} hull={hull} opacity={!active || litWorlds.has(world.key) ? 1 : DIMMED_WORLD} lit={litWorlds.has(world.key) && active} />
                    ))}
                    {mullions.map(mullion => (
                        <rect key={mullion} x={mullion - 2.5} y={WINDOW_Y} width={5} height={windowHeight} fill={hull.frame} opacity={0.85} />
                    ))}
                    <path
                        d={`M${x + w * 0.08} ${WINDOW_Y} L${x + w * 0.2} ${WINDOW_Y} L${x + w * 0.1} ${WINDOW_Y + windowHeight} L${x - w * 0.02} ${WINDOW_Y + windowHeight} Z`}
                        fill={`url(#${id}-glass)`}
                    />
                    <path
                        d={`M${x + w * 0.24} ${WINDOW_Y} L${x + w * 0.27} ${WINDOW_Y} L${x + w * 0.17} ${WINDOW_Y + windowHeight} L${x + w * 0.14} ${WINDOW_Y + windowHeight} Z`}
                        fill={`url(#${id}-glass)`}
                    />
                    {worlds.length === 0 && (
                        <text x={x + w / 2} y={WINDOW_Y + windowHeight / 2 + 4} textAnchor="middle" fontSize="12" fill={`hsl(${hull.ink} / 0.6)`}>
                            {t("maintenance.bay.no_worlds")}
                        </text>
                    )}
                    {!compact && (
                        <text x={x + 18} y={WINDOW_Y + 22} fontSize="10" fontWeight={600} letterSpacing="1.6" fill={`hsl(${hull.ink} / 0.55)`}>
                            {t("maintenance.bay.window_caption", { count: worlds.length }).toUpperCase()}
                        </text>
                    )}
                </g>
                <rect x={x} y={WINDOW_Y} width={w} height={windowHeight} rx={16} fill="none" stroke={hull.frame} strokeWidth={10} />
                <rect x={x + 5} y={WINDOW_Y + 5} width={w - 10} height={windowHeight - 10} rx={12} fill="none" stroke={hull.frameLight} strokeOpacity={0.6} strokeWidth={1} />
                {Array.from({ length: Math.floor(w / 56) }, (_, index) => {
                    const boltX = x + 28 + index * 56
                    return (
                        <Fragment key={index}>
                            <circle cx={boltX} cy={WINDOW_Y} r={1.7} fill={hull.frameLight} />
                            <circle cx={boltX} cy={WINDOW_Y + windowHeight} r={1.7} fill={hull.frameLight} />
                        </Fragment>
                    )
                })}
            </g>
        )
    }

    const legend = (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-card-foreground shadow-sm">
            <span className="flex items-center gap-1.5">
                <DroneGlyph />
                {t("maintenance.bay.legend_container")}
            </span>
            <span className="flex items-center gap-1.5">
                <ShuttleGlyph />
                {t("maintenance.bay.legend_job")}
            </span>
            {(["scheduled", "standby", "failed", "recent"] as const).map(status => (
                <span key={status} className="flex items-center gap-1.5">
                    <span className={cn("size-2.5 rounded-full", STATUS_DOT_CLASS[status])} aria-hidden="true" />
                    {t(`maintenance.bay.legend_${status}`)}
                </span>
            ))}
            {!compact && (
                <span className="flex items-center gap-1.5">
                    <svg viewBox="0 0 18 4" className="h-1 w-4.5" aria-hidden="true">
                        <path d="M0 2H18" className="stroke-zomp-600 dark:stroke-zomp-400" strokeWidth="2" strokeDasharray="3 3" />
                    </svg>
                    {t("maintenance.bay.legend_beam")}
                </span>
            )}
            <span className="flex items-center gap-1.5">
                <span className="h-3.5 w-2 rounded-[3px] bg-zomp-700 dark:bg-zomp-200" aria-hidden="true" />
                {t("maintenance.bay.legend_canister")}
            </span>
        </div>
    )

    const runButton = (agent: MaintenanceAgent, className?: string) =>
        onRun && (
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
                <div className="relative" style={{ height }}>
                    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 block" aria-hidden="true" focusable="false">
                        <rect width={width} height={height} fill={`url(#${id}-panels)`} />
                        {renderWindow(width)}
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
                                        statusColor={statusColor(bay.status)}
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
                                    {runButton(bay.agent)}
                                </div>
                            )}
                        </Fragment>
                    ))}
                    {agents.length === 0 && (
                        <p className="absolute inset-x-0 text-center text-sm text-foreground-secondary" style={{ top: deckTop + 20 }}>
                            {t("maintenance.bay.empty_deck")}
                        </p>
                    )}
                </div>
            )}

            {width > 0 && compact && (
                <>
                    <div className="relative" style={{ height: WINDOW_Y + windowHeight + 8 }}>
                        <svg width={width} height={WINDOW_Y + windowHeight + 8} className="absolute inset-0 block" aria-hidden="true" focusable="false">
                            {renderWindow(width)}
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
                                        statusColor={statusColor(bay.status)}
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
                                        {runButton(bay.agent, "shrink-0")}
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
            )}

            {width === 0 && <div className="min-h-[420px]" />}

            <div className="flex flex-wrap items-end justify-between gap-3 px-3">
                {legend}
                {variant === "deck" && !compact && (
                    <p className="max-w-sm rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground-secondary shadow-sm">{t("maintenance.bay.hint")}</p>
                )}
            </div>
        </div>
    )
}

export default MaintenanceBay
