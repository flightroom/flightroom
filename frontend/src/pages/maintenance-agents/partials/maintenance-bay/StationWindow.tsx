import { Fragment, memo } from "react"
import { useTranslation } from "react-i18next"
import { DIMMED_WORLD, PAD, WINDOW_STARS, WINDOW_Y, type WorldSpot } from "./layout"
import { type Hull, STAR_CORE } from "./theme"

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

/** The 160 stars of the window: memoized on its box and the hull, so a hover does not redraw them. */
const StarField: React.FC<{ x: number; w: number; windowHeight: number; hull: Hull }> = memo(({ x, w, windowHeight, hull }) => (
    <>
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
    </>
))

interface StationWindowProps {
    windowWidth: number
    windowHeight: number
    id: string
    hull: Hull
    worlds: WorldSpot[]
    compact: boolean
    active: boolean
    litWorlds: Set<string>
}

/** The window: deep space (or the star chart), the worlds, the frame bolted to the hull */
export const StationWindow: React.FC<StationWindowProps> = ({ windowWidth, windowHeight, id, hull, worlds, compact, active, litWorlds }) => {
    const { t } = useTranslation()
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
                <StarField x={x} w={w} windowHeight={windowHeight} hull={hull} />
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
