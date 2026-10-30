import { MOON_HIT, SHIP_HIT, STATION_HIT } from "./constants"
import type { Body, Frame, Moon, Point, Ship, Station } from "./types"

export const distanceToSegment = (point: Point, from: Point, to: Point) => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const lengthSquared = dx * dx + dy * dy
    const along = lengthSquared ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0
    return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy))
}

/** The nearest of the bodies drawn on the frame `id` within its reach of the point, if any. */
const nearest = <T extends Point & { frame: number }>(point: Point, candidates: T[], id: number, reachOf: (candidate: T) => number) => {
    let best = Infinity
    let found: T | undefined
    for (const candidate of candidates) {
        const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y)
        if (candidate.frame === id && distance <= reachOf(candidate) && distance < best) {
            found = candidate
            best = distance
        }
    }
    return found
}

/** The moon, the station or the ship under the pointer, in graph coordinates, as drawn on the last frame: the nearest, ships first, as they fly over the others. */
export const bodyAt = (point: Point, { id, scale }: Frame, ships: Ship[], stations: Station[], moons: Moon[]): Body | undefined => {
    const shipReach = SHIP_HIT / scale
    const ship = nearest(point, ships, id, () => shipReach)
    if (ship) return { kind: "ship", ship }
    const stationReach = STATION_HIT / scale
    const station = nearest(point, stations, id, () => stationReach)
    if (station) return { kind: "station", station }
    const moon = nearest(point, moons, id, candidate => Math.max(candidate.radius, MOON_HIT / scale))
    return moon && { kind: "moon", moon }
}
