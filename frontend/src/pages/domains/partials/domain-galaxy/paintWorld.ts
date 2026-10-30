import { DIMMED_ALPHA, MOON_LABEL_ZOOM, SHIP_MAX_SIZE, SHIP_SCREEN_SIZE, STAR_LABEL_ZOOM, STATION_SCREEN_SIZE } from "./constants"
import { paintMoon, paintShip, paintStation } from "./paintBodies"
import { type BodyColors, type Sky, STAR_CORE } from "./sky"
import type { Frame, Moon, Ship, StarNode, Station } from "./types"

interface WorldScene {
    worlds: StarNode[]
    moonsByWorld: Map<string, Moon[]>
    stationsByWorld: Map<string, Station[]>
    ships: Ship[]
    /** The worlds lit by the hover; every other one is dimmed. Null when nothing is hovered */
    neighbourIds: Set<string> | null
    hoveredResourceId: string | null
    primaryHue: string
    reducedMotion: boolean
    font: string
    sky: Sky
    colors: BodyColors
}

/**
 * The painter of every world, for the force-graph to call on each node of each frame: its star and its glow, its
 * canary, its moons and stations, and the ships of the whole map with the first world painted on the frame.
 */
export const createWorldPainter =
    ({ worlds, moonsByWorld, stationsByWorld, ships, neighbourIds, hoveredResourceId, primaryHue, reducedMotion, font, sky, colors }: WorldScene, frameRef: { readonly current: Frame }) =>
    (node: StarNode, ctx: CanvasRenderingContext2D, scale: number) => {
        const x = node.x ?? 0
        const y = node.y ?? 0
        const r = node.radius
        const hue = node.kind === "backend" ? sky.backend : primaryHue
        const highlighted = neighbourIds?.has(node.id) ?? false
        ctx.globalAlpha = neighbourIds && !highlighted ? DIMMED_ALPHA : 1

        const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3)
        glow.addColorStop(0, `hsl(${hue} / ${sky.glowAlpha})`)
        glow.addColorStop(1, `hsl(${hue} / 0)`)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(x, y, r * 3, 0, 2 * Math.PI)
        ctx.fill()

        ctx.fillStyle = `hsl(${hue})`
        ctx.beginPath()
        ctx.arc(x, y, r, 0, 2 * Math.PI)
        ctx.fill()
        ctx.fillStyle = `hsl(${STAR_CORE} / 0.85)`
        ctx.beginPath()
        ctx.arc(x, y, r * 0.4, 0, 2 * Math.PI)
        ctx.fill()

        // The canary is a ring as wide as its share of the traffic, pulsing unless motion is reduced.
        if (node.canary !== undefined) {
            const pulse = reducedMotion ? 1 : (Math.sin(performance.now() / 400) + 1) / 2
            ctx.strokeStyle = `hsl(${sky.canary} / ${0.35 + 0.5 * pulse})`
            ctx.lineWidth = 1.2
            ctx.beginPath()
            ctx.arc(x, y, r + 2.5 + (node.canary / 100) * 5, 0, 2 * Math.PI)
            ctx.stroke()
        }

        // The moons on their faint orbits, then the ships outside them.
        const frame = frameRef.current
        const worldMoons = moonsByWorld.get(node.id)
        const worldStations = stationsByWorld.get(node.id)
        if (worldMoons) {
            ctx.strokeStyle = colors.orbit
            ctx.lineWidth = 1 / scale
            ctx.beginPath()
            let orbit = 0
            for (const moon of worldMoons) {
                if (moon.orbit === orbit) continue
                orbit = moon.orbit
                ctx.moveTo(x + orbit, y)
                ctx.arc(x, y, orbit, 0, 2 * Math.PI)
            }
            ctx.stroke()
            const labelled = scale >= MOON_LABEL_ZOOM
            for (const moon of worldMoons) {
                const selected = moon.resourceId === hoveredResourceId
                paintMoon(ctx, moon, frame.now, scale, colors, sky.space, selected)
                moon.frame = frame.id
                if (labelled || selected) {
                    ctx.textAlign = "center"
                    ctx.textBaseline = "top"
                    ctx.fillStyle = colors.label
                    ctx.font = `${10 / scale}px ${font}`
                    ctx.fillText(moon.name, moon.x, moon.y + moon.radius + 2 / scale)
                }
            }
        }
        if (worldStations) {
            const stationSize = Math.min(STATION_SCREEN_SIZE / scale, r * SHIP_MAX_SIZE)
            for (const station of worldStations) {
                paintStation(ctx, station, frame.now, stationSize, scale, colors, reducedMotion)
                station.frame = frame.id
            }
        }
        if (ships.length > 0 && frame.shipsPainted !== frame.id) {
            frame.shipsPainted = frame.id
            const center = worlds.reduce((sum, world) => ({ x: sum.x + (world.x ?? 0) / worlds.length, y: sum.y + (world.y ?? 0) / worlds.length }), { x: 0, y: 0 })
            const orbit = Math.max(...worlds.map(world => Math.hypot((world.x ?? 0) - center.x, (world.y ?? 0) - center.y) + world.reach)) + Math.max(36, 24 / scale)
            const shipSize = SHIP_SCREEN_SIZE / scale
            for (const ship of ships) {
                ship.orbit = orbit
                paintShip(ctx, ship, center, frame.now, shipSize, scale, colors, reducedMotion)
                ship.frame = frame.id
            }
            const closestX = Math.max(frame.left, Math.min(center.x, frame.right))
            const closestY = Math.max(frame.top, Math.min(center.y, frame.bottom))
            if (!reducedMotion && Math.hypot(closestX - center.x, closestY - center.y) <= orbit + shipSize) frame.motion = true
        }
        // Something turning in view keeps the map redrawing.
        if (!reducedMotion && !frame.motion && (worldMoons || worldStations)) {
            const extent = worldStations ? worldStations[0].orbit + STATION_SCREEN_SIZE / scale : node.reach
            frame.motion = x + extent > frame.left && x - extent < frame.right && y + extent > frame.top && y - extent < frame.bottom
        }

        if (scale >= STAR_LABEL_ZOOM || highlighted) {
            ctx.textAlign = "center"
            ctx.textBaseline = "top"
            ctx.fillStyle = `hsl(${sky.ink} / 0.85)`
            ctx.font = `${11 / scale}px ${font}`
            ctx.fillText(node.name, x, y + node.reach + 3)
        }
        ctx.globalAlpha = 1
    }
