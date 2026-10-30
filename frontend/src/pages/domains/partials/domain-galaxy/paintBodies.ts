import { drawRocket } from "@/components/ai-agents/drawRocket"
import { MOON_ICON_PX, MOON_SHADE_PX, SHIP_ORBIT_SPEED, SHIP_TRAIL, STATION_ORBIT_SPEED } from "./constants"
import type { BodyColors } from "./sky"
import type { Moon, Point, Ship, Station } from "./types"

/** One moon at `now` (seconds): a disc in the colour of the moons, its far side in shadow and the icon of its resource once big enough to read. */
export const paintMoon = (ctx: CanvasRenderingContext2D, moon: Moon, now: number, scale: number, colors: BodyColors, space: string, selected: boolean) => {
    const angle = moon.phase + now * moon.speed
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const x = (moon.world.x ?? 0) + cos * moon.orbit
    const y = (moon.world.y ?? 0) + sin * moon.orbit
    const r = moon.radius
    moon.x = x
    moon.y = y

    ctx.fillStyle = colors.moon
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.fill()
    const onScreen = r * scale
    if (onScreen >= MOON_SHADE_PX) {
        ctx.save()
        ctx.clip()
        // Lit by its world: the shadow is on the side away from it.
        ctx.fillStyle = colors.moonShadow
        ctx.beginPath()
        ctx.arc(x + cos * r * 0.8, y + sin * r * 0.8, r, 0, 2 * Math.PI)
        ctx.fill()
        if (onScreen >= MOON_ICON_PX) {
            const side = r * 1.3
            ctx.translate(x - side / 2, y - side / 2)
            ctx.scale(side / 24, side / 24)
            if (moon.brand) {
                ctx.fillStyle = space
                ctx.fill(moon.brand)
            } else {
                ctx.strokeStyle = space
                ctx.lineWidth = 2.25
                ctx.lineCap = "round"
                ctx.lineJoin = "round"
                ctx.stroke(moon.glyph)
            }
        }
        ctx.restore()
    }
    if (selected) {
        ctx.strokeStyle = colors.moonRing
        ctx.lineWidth = 1.2 / scale
        ctx.beginPath()
        ctx.arc(x, y, r + 1.5 / scale, 0, 2 * Math.PI)
        ctx.stroke()
    }
}

/** One ship at `now` (seconds), `size` long: nose along its orbit, a short trail behind it, parked with reduced motion. */
export const paintShip = (ctx: CanvasRenderingContext2D, ship: Ship, center: Point, now: number, size: number, scale: number, colors: BodyColors, reducedMotion: boolean) => {
    const angle = ship.phase + now * SHIP_ORBIT_SPEED
    ship.x = center.x + Math.cos(angle) * ship.orbit
    ship.y = center.y + Math.sin(angle) * ship.orbit
    if (!reducedMotion) {
        // Fading out behind it: a faint stretch, then a brighter one up to the exhaust.
        ctx.lineCap = "round"
        ctx.lineWidth = Math.max(size * 0.14, 1 / scale)
        ctx.strokeStyle = colors.trail[0]
        ctx.beginPath()
        ctx.arc(center.x, center.y, ship.orbit, angle - SHIP_TRAIL, angle - SHIP_TRAIL * 0.45)
        ctx.stroke()
        ctx.strokeStyle = colors.trail[1]
        ctx.beginPath()
        ctx.arc(center.x, center.y, ship.orbit, angle - SHIP_TRAIL * 0.45, angle - size / ship.orbit / 2)
        ctx.stroke()
    }
    // Clockwise on screen: the nose points along the tangent.
    drawRocket(ctx, ship.x, ship.y, angle + Math.PI / 2, size, colors.shipBody, reducedMotion ? colors.parkedRocket : colors.rocket)
}

/**
 * One station at `now` (seconds), `size` wide: a dashed tether down to its world, two solar panels across its
 * orbit and a hub lit by its status, the light breathing unless motion is reduced.
 */
export const paintStation = (ctx: CanvasRenderingContext2D, station: Station, now: number, size: number, scale: number, colors: BodyColors, reducedMotion: boolean) => {
    const wx = station.world.x ?? 0
    const wy = station.world.y ?? 0
    const angle = station.phase + now * STATION_ORBIT_SPEED
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    station.x = wx + cos * station.orbit
    station.y = wy + sin * station.orbit

    ctx.strokeStyle = colors.tether
    ctx.lineWidth = 1 / scale
    ctx.setLineDash([2 / scale, 2 / scale])
    ctx.beginPath()
    ctx.moveTo(wx + cos * station.world.radius, wy + sin * station.world.radius)
    ctx.lineTo(station.x, station.y)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.save()
    ctx.translate(station.x, station.y)
    // The panels lie along the orbit, the hub faces the world
    ctx.rotate(angle + Math.PI / 2)
    const half = size / 2
    ctx.fillStyle = colors.panel
    ctx.fillRect(-half, -size * 0.14, size * 0.3, size * 0.28)
    ctx.fillRect(half - size * 0.3, -size * 0.14, size * 0.3, size * 0.28)
    ctx.strokeStyle = colors.shipBody
    ctx.lineWidth = Math.max(size * 0.07, 0.6 / scale)
    ctx.beginPath()
    ctx.moveTo(-half + size * 0.3, 0)
    ctx.lineTo(half - size * 0.3, 0)
    ctx.stroke()
    ctx.fillStyle = colors.shipBody
    ctx.beginPath()
    ctx.arc(0, 0, size * 0.22, 0, 2 * Math.PI)
    ctx.fill()
    const breath = reducedMotion ? 1 : 0.65 + 0.35 * Math.sin(now * 2.4 + station.phase)
    ctx.globalAlpha *= breath
    ctx.fillStyle = colors.stationLight[station.status]
    ctx.beginPath()
    ctx.arc(0, 0, size * 0.11, 0, 2 * Math.PI)
    ctx.fill()
    ctx.restore()
}
