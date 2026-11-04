import { drawRocket } from "@/components/ai-agents/drawRocket"
import { MOON_ICON_PX, MOON_SHADE_PX, SHIP_LANE_SLOWDOWN, SHIP_ORBIT_SPEED, SHIP_TRAIL, STATION_ORBIT_SPEED } from "./constants"
import type { BodyColors } from "./sky"
import type { Comet, KeplerOrbit, Moon, Point, Ship, StarNode, Station } from "./types"

/** Where a body on an off-centre orbit is from its world at the mean anomaly `mean`: Kepler's equation, solved in a few Newton steps. */
const keplerOffset = (orbit: KeplerOrbit, mean: number): Point => {
    const e = orbit.eccentricity
    let anomaly = mean
    for (let step = 0; step < 4; step++) anomaly -= (anomaly - e * Math.sin(anomaly) - mean) / (1 - e * Math.cos(anomaly))
    const along = orbit.semiMajor * (Math.cos(anomaly) - e)
    const across = orbit.semiMinor * Math.sin(anomaly)
    const cos = Math.cos(orbit.tilt)
    const sin = Math.sin(orbit.tilt)
    return { x: along * cos - across * sin, y: along * sin + across * cos }
}

/** The path of an off-centre orbit around `world`, an ellipse with the world at a focus, to stroke with the caller's style. */
export const traceKeplerOrbit = (ctx: CanvasRenderingContext2D, world: StarNode, orbit: KeplerOrbit) => {
    const focus = orbit.semiMajor * orbit.eccentricity
    const cx = (world.x ?? 0) - focus * Math.cos(orbit.tilt)
    const cy = (world.y ?? 0) - focus * Math.sin(orbit.tilt)
    ctx.moveTo(cx + orbit.semiMajor * Math.cos(orbit.tilt), cy + orbit.semiMajor * Math.sin(orbit.tilt))
    ctx.ellipse(cx, cy, orbit.semiMajor, orbit.semiMinor, orbit.tilt, 0, 2 * Math.PI)
}

/** One moon at `now` (seconds): a disc in the colour of the moons, its far side in shadow and the icon of its resource once big enough to read. */
export const paintMoon = (ctx: CanvasRenderingContext2D, moon: Moon, now: number, scale: number, colors: BodyColors, space: string, selected: boolean) => {
    const offset = keplerOffset(moon, moon.phase + now * moon.speed)
    const distance = Math.hypot(offset.x, offset.y) || 1
    const cos = offset.x / distance
    const sin = offset.y / distance
    const x = (moon.world.x ?? 0) + offset.x
    const y = (moon.world.y ?? 0) + offset.y
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

/** The orbit of a world's config maps or secrets: a faint dashed ellipse with the world at a focus. */
export const paintCometOrbit = (ctx: CanvasRenderingContext2D, comet: Comet, scale: number, colors: BodyColors) => {
    ctx.strokeStyle = colors.comet[comet.kind].orbit
    ctx.lineWidth = 1 / scale
    ctx.setLineDash([3 / scale, 3 / scale])
    ctx.beginPath()
    traceKeplerOrbit(ctx, comet.world, comet)
    ctx.stroke()
    ctx.setLineDash([])
}

/**
 * One comet at `now` (seconds): its tail pointing away from its world, longer the nearer it passes, and its head,
 * a diamond for a config map and a disc for a secret.
 */
export const paintComet = (ctx: CanvasRenderingContext2D, comet: Comet, now: number, scale: number, colors: BodyColors, selected: boolean) => {
    const offset = keplerOffset(comet, comet.phase + now * comet.speed)
    const distance = Math.hypot(offset.x, offset.y) || 1
    const x = (comet.world.x ?? 0) + offset.x
    const y = (comet.world.y ?? 0) + offset.y
    const r = comet.radius
    comet.x = x
    comet.y = y
    const color = colors.comet[comet.kind]

    const tail = r * 5 * ((comet.semiMajor * (1 - comet.eccentricity)) / distance)
    ctx.strokeStyle = color.tail
    ctx.lineCap = "round"
    ctx.lineWidth = r * 1.2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (offset.x / distance) * tail, y + (offset.y / distance) * tail)
    ctx.stroke()

    ctx.fillStyle = color.head
    ctx.beginPath()
    if (comet.kind === "configMap") {
        const side = r * 1.25
        ctx.moveTo(x, y - side)
        ctx.lineTo(x + side, y)
        ctx.lineTo(x, y + side)
        ctx.lineTo(x - side, y)
        ctx.closePath()
    } else ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.fill()
    if (selected) {
        ctx.strokeStyle = colors.moonRing
        ctx.lineWidth = 1.2 / scale
        ctx.beginPath()
        ctx.arc(x, y, r * 1.25 + 1.5 / scale, 0, 2 * Math.PI)
        ctx.stroke()
    }
}

/** The ellipse a ship flies on this frame: centred on the halo of its galaxies, `a` along its tilt, `b` across it. */
export type ShipOrbit = Point & { a: number; b: number }

/** The point of the orbit at the parametric `angle`, turned by the tilt of the ship. */
const orbitPoint = (ship: Ship, orbit: ShipOrbit, angle: number): Point => {
    const along = orbit.a * Math.cos(angle)
    const across = orbit.b * Math.sin(angle)
    const cos = Math.cos(ship.tilt)
    const sin = Math.sin(ship.tilt)
    return { x: orbit.x + along * cos - across * sin, y: orbit.y + along * sin + across * cos }
}

const TRAIL_STEPS = 8

/** A stretch of the orbit between two parametric angles, as a few straight steps: canvas has no arc of a turned ellipse by angle. */
const strokeOrbit = (ctx: CanvasRenderingContext2D, ship: Ship, orbit: ShipOrbit, from: number, to: number) => {
    ctx.beginPath()
    for (let step = 0; step <= TRAIL_STEPS; step++) {
        const point = orbitPoint(ship, orbit, from + ((to - from) * step) / TRAIL_STEPS)
        if (step === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
    }
    ctx.stroke()
}

/** One ship at `now` (seconds), `size` long, on its own lane around its galaxies: nose along its orbit, a short trail behind it, parked with reduced motion. */
export const paintShip = (ctx: CanvasRenderingContext2D, ship: Ship, orbit: ShipOrbit, now: number, size: number, scale: number, colors: BodyColors, reducedMotion: boolean) => {
    const angle = ship.phase + (ship.direction * now * SHIP_ORBIT_SPEED) / (1 + SHIP_LANE_SLOWDOWN * ship.lane)
    const position = orbitPoint(ship, orbit, angle)
    ship.x = position.x
    ship.y = position.y
    if (!reducedMotion) {
        // Fading out behind it: a faint stretch, then a brighter one up to the exhaust.
        const back = -ship.direction
        ctx.lineCap = "round"
        ctx.lineWidth = Math.max(size * 0.14, 1 / scale)
        ctx.strokeStyle = colors.trail[0]
        strokeOrbit(ctx, ship, orbit, angle + back * SHIP_TRAIL, angle + back * SHIP_TRAIL * 0.45)
        ctx.strokeStyle = colors.trail[1]
        strokeOrbit(ctx, ship, orbit, angle + back * SHIP_TRAIL * 0.45, angle + (back * size) / orbit.b / 2)
    }
    // The nose points the way it flies: along the tangent of the ellipse, turned with it.
    const tangentX = -orbit.a * Math.sin(angle) * ship.direction
    const tangentY = orbit.b * Math.cos(angle) * ship.direction
    const cos = Math.cos(ship.tilt)
    const sin = Math.sin(ship.tilt)
    const heading = Math.atan2(tangentX * sin + tangentY * cos, tangentX * cos - tangentY * sin)
    drawRocket(ctx, ship.x, ship.y, heading, size, colors.shipBody, reducedMotion ? colors.parkedRocket : colors.rocket)
}

/**
 * One station at `now` (seconds), `size` wide: a dashed tether down to its world, two solar panels across its
 * orbit and a hub lit by its status, the light breathing unless motion is reduced.
 */
export const paintStation = (ctx: CanvasRenderingContext2D, station: Station, now: number, size: number, scale: number, colors: BodyColors, reducedMotion: boolean) => {
    const wx = station.world.x ?? 0
    const wy = station.world.y ?? 0
    const offset = keplerOffset(station, station.phase + now * STATION_ORBIT_SPEED)
    const distance = Math.hypot(offset.x, offset.y) || 1
    const cos = offset.x / distance
    const sin = offset.y / distance
    // The hub faces its world wherever the orbit takes it.
    const angle = Math.atan2(sin, cos)
    station.x = wx + offset.x
    station.y = wy + offset.y

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
