import type { Hull } from "./theme"

/** The gradients and patterns of the station, once per instance: the cards of the compact deck reference them too. */
export const StationDefs: React.FC<{ id: string; hull: Hull; primary: string; isDark: boolean }> = ({ id, hull, primary, isDark }) => (
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
