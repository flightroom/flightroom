import { memo } from "react"
import { resourceBrand, resourceTypeGlyph } from "@/components/resource/resourceIcons"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import { type BaySpot, CANISTER_SLOTS, truncate } from "./layout"
import type { Hull } from "./theme"

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

/**
 * One bay of the deck, 208 wide, drawn from its own origin: the deck translates it, a compact card draws it alone.
 * Memoized: every prop is a string, a boolean or stable across hovers, so lighting one bay does not redraw the others.
 */
export const BayArt: React.FC<BayArtProps> = memo(({ bay, id, hull, primary, statusColor, plate, bayLabel, lit }) => {
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
})
