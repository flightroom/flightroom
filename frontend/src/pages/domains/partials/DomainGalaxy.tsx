import { useQuery } from "@tanstack/react-query"
import { Link2, LocateFixed, Rocket, Trash2, Wrench, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import ForceGraph2D, { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { drawRocket } from "@/components/ai-agents/drawRocket"
import useOpenAgentJob from "@/components/ai-agents/useOpenAgentJob"
import { useWorkingAgentJobs } from "@/components/ai-agents/WorkingAgentsIndicator"
import { Badge, Button } from "@/components/atoms"
import { resourceBrand, resourceTypeGlyph } from "@/components/resource/resourceIcons"
import useAiJobsApi, { AiWorkingJob } from "@/hooks/apiClients/useAiJobsApi"
import { DomainLink } from "@/hooks/apiClients/useDomainLinksApi"
import { Domain } from "@/hooks/apiClients/useDomainsApi"
import { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import useMaintenanceAgentsApi, { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import { Service } from "@/hooks/apiClients/useServicesApi"
import { resourcePath, typeLabel, variantLabel } from "@/pages/resources/partials/resources"
import useProjectStore from "@/store/useProjectStore"
import useThemeStore, { ThemeEnum } from "@/store/useThemeStore"

interface DomainGalaxyProps {
    domains: Domain[]
    /** Left out on the map of the backends: only the services are worlds there */
    frontends?: Frontend[]
    services: Service[]
    /** The relations drawn by hand between the domains */
    links: DomainLink[]
    /** A relation drawn from one domain to another, to be confirmed and saved; without it the relations are only shown */
    onLink?: (sourceDomainId: string, targetDomainId: string) => void
    /** A relation the user asked to delete */
    onUnlink?: (link: DomainLink) => void
    /** The resources of the project: drawn as moons of the services shown that attach them */
    resources?: Resource[]
    /** The whole project (the domains page) or its backends only (the services page): it changes the captions, the legend and the hints */
    scope?: "project" | "backend"
}

interface Point {
    x: number
    y: number
}

/** Where a relation was drawn on the last frame, to tell which one a click hits */
interface RelationSegment {
    link: DomainLink
    from: Point
    to: Point
}

/** A frontend or a service: the worlds of the galaxies, the only nodes the forces move */
interface World {
    id: string
    kind: "frontend" | "service"
    name: string
    slug: string
    version?: string
    galaxyId: string
    /** Share of the traffic on the canary, only while one is on */
    canary?: number
    radius: number
    /** How far its moons reach from its centre: its radius when it has none */
    reach: number
}

interface Lane {
    from: string
    to: string
    kind: "relation" | "service"
    /** Between members of two different galaxies */
    bridge: boolean
    /** How much longer the lane is for the moons of its two worlds, so they do not run into each other */
    extent: number
}

interface Galaxy {
    id: string
    name: string
    /** Missing on the galaxy of the members in no domain */
    domainId?: string
    caption: string
    /** Index in the galaxy colours of the sky; missing on the galaxy of the members in no domain */
    paletteIndex?: number
    anchor: { x: number; y: number }
}

type StarNode = NodeObject<World>

/**
 * A resource attached to a service, orbiting it. A resource several services attach is a moon of each
 * of them. Where it was drawn on the last frame is written on it by the painter, never allocated per frame.
 */
interface Moon {
    resourceId: string
    name: string
    /** Its type and variant, for the tooltip */
    label: string
    /** Every service shown that attaches it, its own world included */
    users: string[]
    world: StarNode
    radius: number
    /** Distance from the centre of its world */
    orbit: number
    phase: number
    /** Radians per second */
    speed: number
    /** The logo of its provider or engine, when there is one */
    brand?: Path2D
    /** Otherwise the icon of its type, to stroke */
    glyph: Path2D
    x: number
    y: number
    /** The frame it was last drawn on: a moon not drawn on the last one is not under the pointer */
    frame: number
}

/** An agent at work, orbiting one of the worlds it works on: one ship on each of them. */
interface Ship {
    job: AiWorkingJob
    world: StarNode
    phase: number
    orbit: number
    /** The agents at work on the same world beyond the ones drawn */
    extra: number
    /** Where a click goes when the agent is a change request started on a page, which has no job to open; a job has none. */
    fallbackPath?: string
    x: number
    y: number
    frame: number
}

/** How a maintenance station is lit: on a schedule, waiting for Play, its last run failed */
type StationStatus = "scheduled" | "standby" | "failed"

/**
 * A maintenance agent that looks after one world only, in a slow orbit around it like a station, tethered to it.
 * One that looks after several worlds is in the maintenance room only: it belongs to none of them.
 */
interface Station {
    agent: MaintenanceAgent
    world: StarNode
    status: StationStatus
    phase: number
    orbit: number
    x: number
    y: number
    frame: number
}

/** What the pointer is on besides the worlds, the force-graph only knows its nodes */
type Body = { kind: "moon"; moon: Moon } | { kind: "ship"; ship: Ship } | { kind: "station"; station: Station }
type Hovered = Point & ({ kind: "world"; node: StarNode } | Body)

type LaneLink = LinkObject<World, Lane>

/** The d3 forces force-graph creates, only as far as they are tuned here */
interface LinkForce {
    distance(accessor: (link: LaneLink) => number): LinkForce
    strength(accessor: (link: LaneLink) => number): LinkForce
}
interface ChargeForce {
    strength(accessor: (node: StarNode) => number): ChargeForce
    distanceMax(value: number): ChargeForce
}

const NO_DOMAIN = "no-domain"
/** The same empty lists at every render: a new one would lay the whole map out again */
const NO_FRONTENDS: Frontend[] = []
const NO_RESOURCES: Resource[] = []
const NO_AGENTS: MaintenanceAgent[] = []

/** The logos of the resources, parsed once: a moon is painted on every frame */
const brandPaths = new Map<string, Path2D>()
const brandPath = (path: string) => {
    let parsed = brandPaths.get(path)
    if (!parsed) {
        parsed = new Path2D(path)
        brandPaths.set(path, parsed)
    }
    return parsed
}

/**
 * The lucide icon of a resource type as one path to stroke: lucide-react exports only the components, so it
 * is read from the markup of the same icons, the few kinds of elements they use.
 */
const glyphPaths = new Map<string, Path2D>()
const glyphPath = (type: string) => {
    let parsed = glyphPaths.get(type)
    if (parsed) return parsed
    parsed = new Path2D()
    for (const [, tag, attributes] of resourceTypeGlyph(type).matchAll(/<(\w+)([^>]*)\/>/g)) {
        const values = new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))
        const n = (name: string) => Number(values.get(name) ?? 0)
        if (tag === "path") parsed.addPath(new Path2D(values.get("d")))
        else if (tag === "circle") {
            parsed.moveTo(n("cx") + n("r"), n("cy"))
            parsed.arc(n("cx"), n("cy"), n("r"), 0, 2 * Math.PI)
        } else if (tag === "ellipse") {
            parsed.moveTo(n("cx") + n("rx"), n("cy"))
            parsed.ellipse(n("cx"), n("cy"), n("rx"), n("ry"), 0, 0, 2 * Math.PI)
        } else if (tag === "rect") parsed.roundRect(n("x"), n("y"), n("width"), n("height"), n("rx"))
    }
    glyphPaths.set(type, parsed)
    return parsed
}

interface Sky {
    space: string
    /** The labels and the dust of the background */
    ink: string
    dustAlpha: number
    service: string
    moon: string
    /** The far side of a moon, away from its world */
    moonShadow: string
    orbitAlpha: number
    canary: string
    bridge: string
    /** The light of a maintenance station whose last run failed */
    alarm: string
    noDomain: string
    galaxies: string[]
    /** At the centre of a galaxy halo and at 60% of its radius */
    haloAlpha: [number, number]
    glowAlpha: number
}

/**
 * Colours as HSL components, so each use can add its own alpha, taken from the brand scales of the
 * design system. The dark theme is deep space on charcoal, the light one a star chart on paper,
 * with darker steps of the same scales to hold the contrast.
 */
const SKIES: Record<"dark" | "light", Sky> = {
    dark: {
        space: "#07202D", // charcoal-950
        ink: "38 44% 96%", // foreground (dark)
        dustAlpha: 1,
        service: "162 28% 61%", // zomp-400
        moon: "162 51% 81%", // zomp-200
        moonShadow: "203 37% 10% / 0.45",
        orbitAlpha: 0.16,
        canary: "44 97% 63%", // sunglow-200
        bridge: "91 41% 69%", // olivine-300
        alarm: "0 84% 67%", // destructive (dark)
        noDomain: "203 17% 57%", // charcoal-500
        // zomp-400, pumpkin-400, olivine-400, sunglow-200, zomp-200, pumpkin-300
        galaxies: ["162 28% 61%", "24 99% 59%", "90 34% 63%", "44 97% 63%", "162 51% 81%", "21 98% 76%"],
        haloAlpha: [0.32, 0.12],
        glowAlpha: 0.45
    },
    light: {
        space: "#EFF8FE", // charcoal-50
        ink: "203 37% 22%", // charcoal-900
        dustAlpha: 0.35,
        service: "163 27% 41%", // zomp-600
        moon: "164 33% 31%", // zomp-700
        moonShadow: "203 37% 12% / 0.35",
        orbitAlpha: 0.22,
        canary: "46 92% 30%", // sunglow-600
        bridge: "89 27% 40%", // olivine-600
        alarm: "0 72% 45%", // destructive
        noDomain: "204 17% 47%", // charcoal-600
        // zomp-500, pumpkin-500, olivine-500, sunglow-400, zomp-700, pumpkin-700
        galaxies: ["162 23% 49%", "26 92% 47%", "90 24% 50%", "45 84% 45%", "164 33% 31%", "26 96% 30%"],
        haloAlpha: [0.2, 0.07],
        glowAlpha: 0.3
    }
}
/** pumpkin-400, the primary of the design system */
const FALLBACK_PRIMARY = "24 99% 59%"
/** charcoal-50: the bright core of every star */
const STAR_CORE = "204 88% 97%"

const GALAXY_PULL = 0.12
const LANE_DISTANCE = 36
const BRIDGE_DISTANCE = 260
const GALAXY_PADDING = 26
const EMPTY_GALAXY_RADIUS = 40
const GALAXY_HIT_REACH = 1.6
const STAR_LABEL_ZOOM = 1.4
const DIMMED_ALPHA = 0.15
const FIT_MS = 600
// Room for the halo and the two label lines over the outermost galaxies
const FIT_PADDING = 110
const MAX_GALAXY_ZOOM = 4
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** A moon to its world, and the gap between its world and the first orbit and between two orbits, in moon radii */
const MOON_SIZE = 0.33
const MOON_FIRST_ORBIT = 2.4
const MOON_ORBIT_STEP = 3
/** In moon radii: how close two moons of the same orbit may come, centre to centre */
const MOON_SPACING = 3.2
/** Radians per second on the first orbit; the outer ones are slower, as the planets around the sun */
const MOON_SPEED = 0.3
/** On screen, in pixels: the radius from which a moon shows its shadow, then its icon */
const MOON_SHADE_PX = 3.5
const MOON_ICON_PX = 5
const MOON_LABEL_ZOOM = 4.5
/** In screen pixels: how near the pointer must fall to a moon */
const MOON_HIT = 8
/** Ships keep this size on screen, but never get bigger than their world as the map zooms out. */
const SHIP_SCREEN_SIZE = 16
const SHIP_MAX_SIZE = 1.2
/** Radians per second around a world: three times the moons, an agent is busy */
const SHIP_ORBIT_SPEED = 0.9
/** The ships drawn around one world; the others are only counted in the tooltip */
const SHIP_CAP = 3
/** The length of the trail of a ship along its orbit, in radians */
const SHIP_TRAIL = 0.5
/** Frames a second while the moons and the ships turn over a settled map: smooth enough for them, half the redraws of the whole map. */
const MOTION_FPS = 30
/** In screen pixels: how near the pointer must fall to a ship */
const SHIP_HIT = 14

/** Radians per second: a station keeps nearly still over its world, a ship flies by */
const STATION_ORBIT_SPEED = 0.12
const STATION_SCREEN_SIZE = 14
const STATION_HIT = 12
/** In screen pixels: how near a click must fall to a relation, the size of its arrow, the gap to its way back */
const RELATION_HIT = 6
const RELATION_ARROW = 10
const RELATION_GAP = 6
/** Share of the way from the source where the label of a relation sits */
const RELATION_LABEL_AT = 0.35
/** The characters of the prompt shown in the tooltip of a ship */
const PROMPT_EXCERPT = 90

const distanceToSegment = (point: Point, from: Point, to: Point) => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const lengthSquared = dx * dx + dy * dy
    const along = lengthSquared ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0
    return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy))
}

/** Where each relation runs: from halo to halo, unless the two galaxies overlap, and beside its way back if there is one. */
const layoutRelations = (links: DomainLink[], geometry: Map<string, Point & { r: number }>, scale: number): RelationSegment[] => {
    const ways = new Set(links.map(link => `${link.sourceDomainId}>${link.targetDomainId}`))
    return links.flatMap(link => {
        const source = geometry.get(link.sourceDomainId)
        const target = geometry.get(link.targetDomainId)
        if (!source || !target) return []
        const length = Math.hypot(target.x - source.x, target.y - source.y) || 1
        const ux = (target.x - source.x) / length
        const uy = (target.y - source.y) / length
        const shift = ways.has(`${link.targetDomainId}>${link.sourceDomainId}`) ? RELATION_GAP / scale : 0
        const sourceEdge = length > source.r + target.r ? source.r : 0
        const targetEdge = length > source.r + target.r ? target.r : 0
        return [
            {
                link,
                from: { x: source.x + ux * sourceEdge - uy * shift, y: source.y + uy * sourceEdge + ux * shift },
                to: { x: target.x - ux * targetEdge - uy * shift, y: target.y - uy * targetEdge + ux * shift }
            }
        ]
    })
}

/**
 * A relation between two galaxies: a thick line with an arrow at the target and its label in a pill
 * nearer the source, so the labels of a relation and of its way back do not cover each other.
 */
const paintRelation = (
    ctx: CanvasRenderingContext2D,
    { from, to, label, selected, scale, font, sky }: { from: Point; to: Point; label?: string; selected: boolean; scale: number; font: string; sky: Sky }
) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
    const ux = (to.x - from.x) / length
    const uy = (to.y - from.y) / length
    const color = `hsl(${sky.ink} / ${selected ? 0.95 : 0.55})`
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = (selected ? 3.5 : 2.5) / scale
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()

    const arrow = RELATION_ARROW / scale
    ctx.beginPath()
    ctx.moveTo(to.x, to.y)
    ctx.lineTo(to.x - ux * arrow - uy * arrow * 0.5, to.y - uy * arrow + ux * arrow * 0.5)
    ctx.lineTo(to.x - ux * arrow + uy * arrow * 0.5, to.y - uy * arrow - ux * arrow * 0.5)
    ctx.closePath()
    ctx.fill()

    if (!label) return
    ctx.font = `500 ${11 / scale}px ${font}`
    const width = ctx.measureText(label).width + 12 / scale
    const height = 18 / scale
    const x = from.x + (to.x - from.x) * RELATION_LABEL_AT
    const y = from.y + (to.y - from.y) * RELATION_LABEL_AT
    ctx.fillStyle = sky.space
    ctx.strokeStyle = `hsl(${sky.ink} / ${selected ? 0.8 : 0.3})`
    ctx.lineWidth = 1 / scale
    ctx.beginPath()
    ctx.roundRect(x - width / 2, y - height / 2, width, height, height / 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = `hsl(${sky.ink} / 0.9)`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(label, x, y)
}

/** A fixed sky: seeded, so the stars do not jump around at every mount. */
const BACKGROUND_STARS = (() => {
    let seed = 7
    const random = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
    }
    return Array.from({ length: 180 }, () => ({ x: random(), y: random(), size: random() < 0.9 ? 1 : 2, alpha: 0.15 + random() * 0.5 }))
})()

/** A stable spread from an id, so a world, a moon or a ship keeps its place in the orbit across polls. */
const phaseOf = (id: string) => {
    let hash = 0
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
    return (hash / 9973) * 2 * Math.PI
}

/**
 * The moons of a service, from the first orbit out: as many on an orbit as fit with room between them,
 * evenly spread, each orbit slower than the one inside it.
 */
const placeMoons = (world: StarNode, attached: Omit<Moon, "world" | "radius" | "orbit" | "phase" | "speed" | "x" | "y" | "frame">[]): Moon[] => {
    const radius = world.radius * MOON_SIZE
    const first = world.radius + radius * MOON_FIRST_ORBIT
    const moons: Moon[] = []
    let orbit = first
    let ring = 0
    let left = attached
    while (left.length) {
        const fits = Math.max(3, Math.floor((2 * Math.PI * orbit) / (radius * MOON_SPACING)))
        const onOrbit = left.slice(0, fits)
        const offset = phaseOf(world.id) + ring * 0.5
        const speed = MOON_SPEED * (first / orbit) ** 1.5
        onOrbit.forEach((moon, index) => {
            moons.push({ ...moon, world, radius, orbit, speed, phase: offset + (index * 2 * Math.PI) / onOrbit.length, x: 0, y: 0, frame: -1 })
        })
        left = left.slice(fits)
        orbit += radius * MOON_ORBIT_STEP
        ring++
    }
    return moons
}

/** Where a ship orbits: outside the moons of its world, or just outside the world when it has none. */
const shipOrbit = (world: StarNode) => world.reach + world.radius * 0.55 + 1.5

/** Where a station orbits: past the moons, inside the lane of the ships. */
const stationOrbit = (world: StarNode) => world.reach + world.radius * 0.3 + 1

const stationStatus = (agent: MaintenanceAgent): StationStatus => {
    if (agent.lastRun && !agent.lastRun.ok) return "failed"
    return agent.schedule ? "scheduled" : "standby"
}

/** The colours of the moons and the ships, built once per theme: they are painted on every frame. */
const bodyColors = (sky: Sky) => ({
    moon: `hsl(${sky.moon})`,
    moonShadow: `hsl(${sky.moonShadow})`,
    moonRing: `hsl(${sky.ink} / 0.9)`,
    label: `hsl(${sky.ink} / 0.85)`,
    orbit: `hsl(${sky.ink} / ${sky.orbitAlpha})`,
    shipBody: `hsl(${sky.ink})`,
    trail: [`hsl(${sky.canary} / 0.12)`, `hsl(${sky.canary} / 0.4)`],
    rocket: { windowColor: sky.space, flameColor: `hsl(${sky.canary})`, flame: 7 },
    parkedRocket: { windowColor: sky.space, flameColor: `hsl(${sky.canary})`, flame: 3 },
    panel: `hsl(${sky.ink} / 0.55)`,
    tether: `hsl(${sky.ink} / 0.28)`,
    stationLight: { scheduled: `hsl(${sky.service})`, standby: `hsl(${sky.canary})`, failed: `hsl(${sky.alarm})` } satisfies Record<StationStatus, string>
})
type BodyColors = ReturnType<typeof bodyColors>

/** One moon at `now` (seconds): a disc in the colour of the moons, its far side in shadow and the icon of its resource once big enough to read. */
const paintMoon = (ctx: CanvasRenderingContext2D, moon: Moon, now: number, scale: number, colors: BodyColors, space: string, selected: boolean) => {
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
const paintShip = (ctx: CanvasRenderingContext2D, ship: Ship, now: number, size: number, scale: number, colors: BodyColors, reducedMotion: boolean) => {
    const wx = ship.world.x ?? 0
    const wy = ship.world.y ?? 0
    const angle = ship.phase + now * SHIP_ORBIT_SPEED
    ship.x = wx + Math.cos(angle) * ship.orbit
    ship.y = wy + Math.sin(angle) * ship.orbit
    if (!reducedMotion) {
        // Fading out behind it: a faint stretch, then a brighter one up to the exhaust.
        ctx.lineCap = "round"
        ctx.lineWidth = Math.max(size * 0.14, 1 / scale)
        ctx.strokeStyle = colors.trail[0]
        ctx.beginPath()
        ctx.arc(wx, wy, ship.orbit, angle - SHIP_TRAIL, angle - SHIP_TRAIL * 0.45)
        ctx.stroke()
        ctx.strokeStyle = colors.trail[1]
        ctx.beginPath()
        ctx.arc(wx, wy, ship.orbit, angle - SHIP_TRAIL * 0.45, angle - size / ship.orbit / 2)
        ctx.stroke()
    }
    // Clockwise on screen: the nose points along the tangent.
    drawRocket(ctx, ship.x, ship.y, angle + Math.PI / 2, size, colors.shipBody, reducedMotion ? colors.parkedRocket : colors.rocket)
}

/**
 * One station at `now` (seconds), `size` wide: a dashed tether down to its world, two solar panels across its
 * orbit and a hub lit by its status, the light breathing unless motion is reduced.
 */
const paintStation = (ctx: CanvasRenderingContext2D, station: Station, now: number, size: number, scale: number, colors: BodyColors, reducedMotion: boolean) => {
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

/** A station as the legend shows it: the shape paintStation draws on the canvas. */
const StationGlyph: React.FC = () => (
    <svg viewBox="-12 -6 24 12" className="h-2.5 w-5 text-foreground" aria-hidden="true">
        <rect x="-12" y="-3.5" width="7" height="7" rx="0.5" fill="currentColor" opacity="0.55" />
        <rect x="5" y="-3.5" width="7" height="7" rx="0.5" fill="currentColor" opacity="0.55" />
        <path d="M-5 0 H5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="0" cy="0" r="5" fill="currentColor" />
        <circle cx="0" cy="0" r="2.4" className="fill-zomp-400 dark:fill-zomp-200" />
    </svg>
)

/** The rocket of the ships, as the legend shows it: the shape drawRocket paints on the canvas. */
const ShipGlyph: React.FC = () => (
    <svg viewBox="-20 -16 40 32" className="h-2.5 w-3.5 -rotate-45 text-foreground" aria-hidden="true">
        <path d="M-14 -6 L-19 0 L-14 6 Z" className="fill-sunglow-600 dark:fill-sunglow-200" />
        <path d="M-10 -7 L-18 -15 L-4 -7 Z M-10 7 L-18 15 L-4 7 Z" fill="currentColor" />
        <ellipse cx="0" cy="0" rx="18" ry="9" fill="currentColor" />
        <circle cx="6" cy="0" r="4" className="fill-card" />
    </svg>
)

const promptExcerpt = (prompt: string) => {
    const line = prompt.trim().split("\n")[0]
    return line.length > PROMPT_EXCERPT ? `${line.slice(0, PROMPT_EXCERPT - 1).trimEnd()}…` : line
}

const readPrimaryHue = () => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || FALLBACK_PRIMARY
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)"

/** The theme the app is shown in, resolving the system one and following it when it changes. */
const useIsDark = () => {
    const theme = useThemeStore(state => state.theme)
    const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK_SCHEME_QUERY).matches)
    useEffect(() => {
        const query = window.matchMedia(DARK_SCHEME_QUERY)
        const onChange = () => setSystemDark(query.matches)
        query.addEventListener("change", onChange)
        return () => query.removeEventListener("change", onChange)
    }, [])
    return theme === ThemeEnum.DARK || (theme === ThemeEnum.SYSTEM && systemDark)
}

/**
 * The whole project as a sky: every domain a galaxy, its frontends and services the worlds in it,
 * members in no domain in a grey nebula. The resources a service attaches are its moons, an agent at
 * work on a world a ship orbiting it. Links across two domains are drawn as bridges between the
 * galaxies, the ones the domain diagram has to leave out.
 */
export const DomainGalaxy: React.FC<DomainGalaxyProps> = ({ domains, frontends = NO_FRONTENDS, services, links, onLink, onUnlink, resources = NO_RESOURCES, scope = "project" }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const graphRef = useRef<ForceGraphMethods<StarNode, LaneLink>>(undefined)
    const containerRef = useRef<HTMLDivElement>(null)
    const previousNodesRef = useRef<StarNode[]>([])
    const geometryRef = useRef(new Map<string, { x: number; y: number; r: number }>())
    const fittedRef = useRef(false)
    const isBackend = scope === "backend"

    const [size, setSize] = useState({ width: 0, height: 0 })
    const [hovered, setHovered] = useState<Hovered | null>(null)
    const [focusedGalaxyId, setFocusedGalaxyId] = useState<string | null>(null)
    // Drawing a relation: the mode is on, then the domain it starts from is picked, then the one it goes to.
    const [linking, setLinking] = useState(false)
    const [linkSourceId, setLinkSourceId] = useState<string | null>(null)
    const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null)
    const pointerRef = useRef<Point | null>(null)
    // The world the force-graph has under the pointer, also while a moon or a ship takes the hover from it.
    const worldUnderPointerRef = useRef<StarNode | null>(null)
    const relationSegmentsRef = useRef<RelationSegment[]>([])
    // The frame being painted: its clock, its zoom, what of the map it shows and whether anything turning is in it.
    const frameRef = useRef({ id: 0, now: 0, scale: 1, left: 0, top: 0, right: 0, bottom: 0, motion: false })
    const workingJobs = useWorkingAgentJobs()
    const openAgentJob = useOpenAgentJob()
    const aiJobsApi = useAiJobsApi()
    const maintenanceAgentsApi = useMaintenanceAgentsApi()
    const projectId = useProjectStore(state => state.project?._id)
    const { data: maintenanceAgents = NO_AGENTS } = useQuery({
        queryKey: ["maintenance-agents", projectId],
        queryFn: () => maintenanceAgentsApi.getAll(),
        enabled: Boolean(projectId),
        staleTime: 60_000
    })
    const [primaryHue] = useState(readPrimaryHue)
    const [reducedMotion] = useState(prefersReducedMotion)
    const [font] = useState(() => getComputedStyle(document.body).fontFamily)
    const sky = SKIES[useIsDark() ? "dark" : "light"]
    const colors = useMemo(() => bodyColors(sky), [sky])

    useEffect(() => {
        const element = containerRef.current
        if (!element) return
        const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
        observer.observe(element)
        return () => observer.disconnect()
    }, [])

    const { galaxies, graphData, membersByGalaxy, moons, moonsByWorld } = useMemo(() => {
        const domainIds = new Set(domains.map(domain => domain._id))
        const galaxyOf = (domainId?: string | null) => (domainId && domainIds.has(domainId) ? domainId : NO_DOMAIN)

        const members = [
            ...frontends.map(mfe => ({
                id: mfe._id!,
                kind: "frontend" as const,
                name: mfe.name,
                slug: mfe.slug,
                version: mfe.version,
                galaxyId: galaxyOf(mfe.domainId),
                canary: mfe.canary?.enabled ? mfe.canary.percentage : undefined
            })),
            ...services.map(service => ({
                id: service._id!,
                kind: "service" as const,
                name: service.name,
                slug: service.slug,
                version: service.version,
                galaxyId: galaxyOf(service.domainId),
                canary: undefined
            }))
        ]
        const galaxyById = new Map(members.map(member => [member.id, member.galaxyId]))

        // A resource is drawn only as a moon of the services shown that attach it, of each of them.
        const attachedBy = new Map<string, Resource[]>()
        const usersOf = new Map<string, string[]>()
        for (const resource of resources) {
            if (!resource._id) continue
            const users = services.filter(service => service._id && service.resourceIds?.includes(resource._id!)).map(service => service._id!)
            usersOf.set(resource._id, users)
            for (const id of users) attachedBy.set(id, [...(attachedBy.get(id) ?? []), resource])
        }

        // Links to something that is not on the map are left out: there is no world to draw them to.
        const lanes = [
            ...frontends.flatMap(mfe => (mfe.parentIds ?? []).filter(parentId => galaxyById.has(parentId)).map(parentId => ({ from: parentId, to: mfe._id!, kind: "relation" as const }))),
            ...frontends.flatMap(mfe => (mfe.serviceIds ?? []).filter(serviceId => galaxyById.has(serviceId)).map(serviceId => ({ from: mfe._id!, to: serviceId, kind: "service" as const })))
        ]

        // The attached resources make a world bigger, as the links do: its moons stay in proportion.
        const degree = new Map<string, number>()
        for (const lane of lanes) {
            degree.set(lane.from, (degree.get(lane.from) ?? 0) + 1)
            degree.set(lane.to, (degree.get(lane.to) ?? 0) + 1)
        }
        for (const [id, attached] of attachedBy) degree.set(id, (degree.get(id) ?? 0) + attached.length)

        const countIn = (galaxyId: string, kind: World["kind"]) => members.filter(member => member.galaxyId === galaxyId && member.kind === kind).length
        const caption = (galaxyId: string) =>
            isBackend
                ? t("domains.backend_count", { count: countIn(galaxyId, "service") })
                : `${t("domains.frontend_count", { count: countIn(galaxyId, "frontend") })} · ${t("domains.backend_count", { count: countIn(galaxyId, "service") })}`
        const galaxyList = [
            ...domains.map((domain, index) => ({ id: domain._id, name: domain.name, domainId: domain._id, caption: caption(domain._id), paletteIndex: index })),
            ...(members.some(member => member.galaxyId === NO_DOMAIN) ? [{ id: NO_DOMAIN, name: t("domains.no_domain"), caption: caption(NO_DOMAIN) }] : [])
        ]

        // A star keeps the place it had before a reload; a new one starts on a spiral around its galaxy.
        const previous = new Map(previousNodesRef.current.map(node => [node.id, node]))
        const placed = new Map<string, number>()
        const moonsByWorld = new Map<string, Moon[]>()
        const nodes: StarNode[] = members.map(member => {
            const index = placed.get(member.galaxyId) ?? 0
            placed.set(member.galaxyId, index + 1)
            const before = previous.get(member.id)
            const radius = 3 + Math.sqrt(degree.get(member.id) ?? 0) * 1.6
            const node: StarNode = { ...member, radius, reach: radius, x: before?.x, y: before?.y }
            const attached = (attachedBy.get(member.id) ?? []).map(resource => ({
                resourceId: resource._id!,
                name: resource.name,
                label: [typeLabel(t, resource.type), variantLabel(t, resource.type, resource.variant)].filter((label, at, all) => label && all.indexOf(label) === at).join(" · "),
                users: usersOf.get(resource._id!) ?? [],
                brand: (path => (path ? brandPath(path) : undefined))(resourceBrand(resource)?.path),
                glyph: glyphPath(resource.type)
            }))
            if (attached.length) {
                const worldMoons = placeMoons(node, attached)
                const outermost = worldMoons[worldMoons.length - 1]
                node.reach = outermost.orbit + outermost.radius
                moonsByWorld.set(member.id, worldMoons)
            }
            return node
        })

        // The galaxies sit on a ring, far enough apart for the biggest one, moons included, to keep clear of its neighbours.
        const biggest = Math.max(1, ...galaxyList.map(galaxy => members.filter(member => member.galaxyId === galaxy.id).length))
        const widest = Math.max(0, ...nodes.map(node => node.reach - node.radius))
        const spacing = 150 + 24 * Math.sqrt(biggest) + 2 * widest
        const ringRadius = galaxyList.length > 1 ? spacing / (2 * Math.sin(Math.PI / galaxyList.length)) : 0
        const galaxies: Galaxy[] = galaxyList.map((galaxy, index) => {
            const angle = -Math.PI / 2 + (index * 2 * Math.PI) / galaxyList.length
            return { ...galaxy, anchor: { x: ringRadius * Math.cos(angle), y: ringRadius * Math.sin(angle) } }
        })
        const anchors = new Map(galaxies.map(galaxy => [galaxy.id, galaxy.anchor]))
        const placedAt = new Map<string, number>()
        for (const node of nodes) {
            const index = placedAt.get(node.galaxyId) ?? 0
            placedAt.set(node.galaxyId, index + 1)
            const anchor = anchors.get(node.galaxyId)!
            node.x ??= anchor.x + 14 * Math.sqrt(index + 1) * Math.cos(index * GOLDEN_ANGLE)
            node.y ??= anchor.y + 14 * Math.sqrt(index + 1) * Math.sin(index * GOLDEN_ANGLE)
        }

        const byId = new Map(nodes.map(node => [node.id, node]))
        const extentOf = (id: string) => {
            const node = byId.get(id)
            return node ? node.reach - node.radius : 0
        }
        const membersByGalaxy = new Map(galaxies.map(galaxy => [galaxy.id, nodes.filter(node => node.galaxyId === galaxy.id)]))
        return {
            galaxies,
            membersByGalaxy,
            moonsByWorld,
            moons: [...moonsByWorld.values()].flat(),
            graphData: {
                nodes,
                links: lanes.map<LaneLink>(lane => ({
                    ...lane,
                    bridge: galaxyById.get(lane.from) !== galaxyById.get(lane.to),
                    extent: extentOf(lane.from) + extentOf(lane.to),
                    source: lane.from,
                    target: lane.to
                }))
            }
        }
    }, [domains, frontends, services, resources, isBackend, t])

    useEffect(() => {
        previousNodesRef.current = graphData.nodes
    }, [graphData])

    // The agents on the map: a job on worlds that are not shown (another domain filtered out) has no ship.
    const { ships, shipsByWorld, agents } = useMemo(() => {
        const nodes = new Map(graphData.nodes.map(node => [node.id, node]))
        const jobsByWorld = new Map<string, AiWorkingJob[]>()
        const agents: { jobId: string; names: string; fallbackPath?: string }[] = []
        // A job the user cannot open says so, rather than landing on a page that knows nothing of it.
        const fallbackPath = (job: AiWorkingJob, world: StarNode) => (job.kind === "request" ? `/${world.kind}/${world.id}?change=${job.jobId}` : undefined)
        for (const job of workingJobs) {
            const worlds = job.componentIds.flatMap(id => nodes.get(id) ?? [])
            if (!worlds.length) continue
            agents.push({ jobId: job.jobId, names: worlds.map(world => world.name).join(", "), fallbackPath: fallbackPath(job, worlds[0]) })
            for (const world of worlds) jobsByWorld.set(world.id, [...(jobsByWorld.get(world.id) ?? []), job])
        }
        const shipsByWorld = new Map<string, Ship[]>()
        for (const [worldId, jobs] of jobsByWorld) {
            const world = nodes.get(worldId)!
            // Sorted, so the ships keep their places in the orbit across polls.
            const flying = [...jobs].sort((a, b) => a.jobId.localeCompare(b.jobId)).slice(0, SHIP_CAP)
            const start = phaseOf(`${worldId}-ships`)
            shipsByWorld.set(
                worldId,
                flying.map((job, index) => ({
                    job,
                    world,
                    phase: start + (index * 2 * Math.PI) / flying.length,
                    orbit: shipOrbit(world),
                    extra: jobs.length - flying.length,
                    fallbackPath: fallbackPath(job, world),
                    x: 0,
                    y: 0,
                    frame: -1
                }))
            )
        }
        return { ships: [...shipsByWorld.values()].flat(), shipsByWorld, agents }
    }, [workingJobs, graphData])

    // The maintenance agents that look after one world only, among those on the map: a station each, spread around it.
    const { stations, stationsByWorld } = useMemo(() => {
        const nodes = new Map(graphData.nodes.map(node => [node.id, node]))
        const byWorld = new Map<string, MaintenanceAgent[]>()
        for (const agent of maintenanceAgents) {
            const targets = [...(agent.serviceIds ?? []), ...(agent.frontendIds ?? [])]
            if (targets.length !== 1 || !nodes.has(targets[0])) continue
            byWorld.set(targets[0], [...(byWorld.get(targets[0]) ?? []), agent])
        }
        const stationsByWorld = new Map<string, Station[]>()
        for (const [worldId, agents] of byWorld) {
            const world = nodes.get(worldId)!
            const start = phaseOf(`${worldId}-stations`)
            stationsByWorld.set(
                worldId,
                agents.map((agent, index) => ({
                    agent,
                    world,
                    status: stationStatus(agent),
                    phase: start + (index * 2 * Math.PI) / agents.length,
                    orbit: stationOrbit(world),
                    x: 0,
                    y: 0,
                    frame: -1
                }))
            )
        }
        return { stations: [...stationsByWorld.values()].flat(), stationsByWorld }
    }, [maintenanceAgents, graphData])

    // The graph is only rendered once the container has a size, and the forces need it in place.
    const isGraphMounted = size.width > 0

    // The moons and the ships keep the map redrawing on its own, but only while one of them is in view:
    // once the layout has settled, at MOTION_FPS rather than the screen's rate.
    const [motionOnScreen, setMotionOnScreen] = useState(false)
    const motionOnScreenRef = useRef(false)
    const turning = !reducedMotion && motionOnScreen && (moons.length > 0 || ships.length > 0 || stations.length > 0)
    const throttled = turning && !linkSourceId
    const throttledRef = useRef(false)
    // Whether the layout has settled: until it has, every frame also moves the stars, and none is skipped.
    const engineStoppedRef = useRef(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: new data is what restarts the layout.
    useEffect(() => {
        engineStoppedRef.current = false
    }, [graphData])

    useEffect(() => {
        throttledRef.current = throttled
        if (!throttled || !isGraphMounted) return
        // Each tick draws one frame: the frame pauses the loop right after (see onRenderFramePost).
        const interval = setInterval(() => graphRef.current?.resumeAnimation(), 1000 / MOTION_FPS)
        return () => {
            clearInterval(interval)
            throttledRef.current = false
            // Unmounted, the ref is already gone: nothing is restarted on a canvas no longer shown.
            graphRef.current?.resumeAnimation()
        }
    }, [throttled, isGraphMounted])

    const hasBridges = graphData.links.some(link => link.bridge)
    const animated = !reducedMotion && (hasBridges || turning || graphData.nodes.some(node => node.canary !== undefined))

    useEffect(() => {
        const graph = graphRef.current
        if (!isGraphMounted || !graph) return
        const anchors = new Map(galaxies.map(galaxy => [galaxy.id, galaxy.anchor]))
        let nodes: StarNode[] = []
        // Pulls every star towards the centre of its galaxy, so the domains hold together as clusters.
        const galaxyForce = Object.assign(
            (alpha: number) => {
                for (const node of nodes) {
                    const anchor = anchors.get(node.galaxyId)
                    if (!anchor) continue
                    node.vx = (node.vx ?? 0) + (anchor.x - (node.x ?? 0)) * GALAXY_PULL * alpha
                    node.vy = (node.vy ?? 0) + (anchor.y - (node.y ?? 0)) * GALAXY_PULL * alpha
                }
            },
            { initialize: (initialNodes: StarNode[]) => (nodes = initialNodes) }
        )
        graph.d3Force("galaxy", galaxyForce)
        graph.d3Force("center", null)
        // A bridge barely pulls, or two linked domains would merge into one galaxy. Moons make a lane longer.
        const linkForce = graph.d3Force("link") as unknown as LinkForce | undefined
        linkForce?.distance(link => (link.bridge ? BRIDGE_DISTANCE : LANE_DISTANCE + link.extent)).strength(link => (link.bridge ? 0.01 : 0.25))
        // A world with moons keeps the others further off, so two systems do not overlap.
        const chargeForce = graph.d3Force("charge") as unknown as ChargeForce | undefined
        chargeForce?.strength(node => -45 - 4 * (node.reach - node.radius)).distanceMax(220)
        engineStoppedRef.current = false
        graph.d3ReheatSimulation()
    }, [galaxies, isGraphMounted])

    const hoveredResourceId = hovered?.kind === "moon" ? hovered.moon.resourceId : null
    // What lights up with the hover: a world and its neighbours, every world a resource orbits, the world of a ship.
    const neighbourIds = useMemo(() => {
        if (!hovered) return null
        if (hovered.kind === "moon") return new Set(hovered.moon.users)
        if (hovered.kind === "ship") return new Set([hovered.ship.world.id])
        if (hovered.kind === "station") return new Set([hovered.station.world.id])
        const ids = new Set([hovered.node.id])
        for (const link of graphData.links) {
            if (link.from === hovered.node.id) ids.add(link.to)
            if (link.to === hovered.node.id) ids.add(link.from)
        }
        return ids
    }, [hovered, graphData])

    const fitAll = useCallback(() => {
        setFocusedGalaxyId(null)
        if (graphData.nodes.length) graphRef.current?.zoomToFit(FIT_MS, FIT_PADDING)
    }, [graphData])

    const onEngineStop = useCallback(() => {
        engineStoppedRef.current = true
        if (fittedRef.current) return
        fittedRef.current = true
        fitAll()
    }, [fitAll])

    const onRenderFramePre = useCallback(
        (ctx: CanvasRenderingContext2D, scale: number) => {
            // What of the map this frame shows, in graph units, for the moons and ships to tell whether they are in view.
            const frame = frameRef.current
            const transform = ctx.getTransform()
            frame.id++
            frame.now = reducedMotion ? 0 : performance.now() / 1000
            frame.scale = scale
            frame.left = -transform.e / transform.a
            frame.top = -transform.f / transform.d
            frame.right = (ctx.canvas.width - transform.e) / transform.a
            frame.bottom = (ctx.canvas.height - transform.f) / transform.d
            frame.motion = false

            // The sky is drawn in screen pixels, so it stays put while the map pans and zooms.
            ctx.save()
            ctx.setTransform(1, 0, 0, 1, 0, 0)
            const ratio = window.devicePixelRatio || 1
            for (const star of BACKGROUND_STARS) {
                ctx.fillStyle = `hsl(${sky.ink} / ${star.alpha * sky.dustAlpha})`
                ctx.fillRect(star.x * ctx.canvas.width, star.y * ctx.canvas.height, star.size * ratio, star.size * ratio)
            }
            ctx.restore()

            const geometry = new Map<string, { x: number; y: number; r: number }>()
            for (const galaxy of galaxies) {
                const members = membersByGalaxy.get(galaxy.id) ?? []
                const x = members.length ? members.reduce((sum, node) => sum + (node.x ?? 0), 0) / members.length : galaxy.anchor.x
                const y = members.length ? members.reduce((sum, node) => sum + (node.y ?? 0), 0) / members.length : galaxy.anchor.y
                const r = members.length ? Math.max(...members.map(node => Math.hypot((node.x ?? 0) - x, (node.y ?? 0) - y) + node.reach)) + GALAXY_PADDING : EMPTY_GALAXY_RADIUS
                geometry.set(galaxy.id, { x, y, r })

                const hue = galaxy.paletteIndex === undefined ? sky.noDomain : sky.galaxies[galaxy.paletteIndex % sky.galaxies.length]
                const halo = ctx.createRadialGradient(x, y, 0, x, y, r)
                halo.addColorStop(0, `hsl(${hue} / ${sky.haloAlpha[0]})`)
                halo.addColorStop(0.6, `hsl(${hue} / ${sky.haloAlpha[1]})`)
                halo.addColorStop(1, `hsl(${hue} / 0)`)
                ctx.fillStyle = halo
                ctx.beginPath()
                ctx.arc(x, y, r, 0, 2 * Math.PI)
                ctx.fill()

                // A solid ring on the galaxy flown to or picked as the start of a relation, a dashed one on the
                // nebula and, while a relation is drawn, on every galaxy it can reach.
                const isPicked = galaxy.id === focusedGalaxyId || galaxy.id === linkSourceId
                if (isPicked || !galaxy.domainId || linking) {
                    ctx.strokeStyle = `hsl(${hue} / ${isPicked ? 0.8 : 0.4})`
                    ctx.lineWidth = (isPicked ? 1.5 : 1) / scale
                    ctx.setLineDash(isPicked ? [] : [4 / scale, 4 / scale])
                    ctx.stroke()
                    ctx.setLineDash([])
                }

                // Labels keep the same size on screen at every zoom.
                ctx.textAlign = "center"
                ctx.textBaseline = "bottom"
                ctx.fillStyle = `hsl(${sky.ink} / 0.9)`
                ctx.font = `600 ${14 / scale}px ${font}`
                ctx.fillText(galaxy.name, x, y - r - 18 / scale)
                ctx.fillStyle = `hsl(${sky.ink} / 0.6)`
                ctx.font = `${11 / scale}px ${font}`
                ctx.fillText(galaxy.caption, x, y - r - 4 / scale)
            }
            geometryRef.current = geometry

            const segments = layoutRelations(links, geometry, scale)
            for (const { link, from, to } of segments) {
                paintRelation(ctx, { from, to, label: link.label, selected: link._id === selectedLinkId, scale, font, sky })
            }
            relationSegmentsRef.current = segments

            const source = linkSourceId ? geometry.get(linkSourceId) : undefined
            if (source && pointerRef.current) {
                ctx.strokeStyle = `hsl(${sky.ink} / 0.7)`
                ctx.lineWidth = 2 / scale
                ctx.setLineDash([6 / scale, 4 / scale])
                ctx.beginPath()
                ctx.moveTo(source.x, source.y)
                ctx.lineTo(pointerRef.current.x, pointerRef.current.y)
                ctx.stroke()
                ctx.setLineDash([])
            }
        },
        [galaxies, membersByGalaxy, focusedGalaxyId, font, sky, links, selectedLinkId, linking, linkSourceId, reducedMotion]
    )

    const onRenderFramePost = useCallback(() => {
        // Throttled: the loop schedules its next frame after this callback, so it is cancelled once this frame is over.
        if (throttledRef.current && engineStoppedRef.current) queueMicrotask(() => graphRef.current?.pauseAnimation())
        // A moon or a ship coming into view, or the last one leaving it, turns the redrawing on its own on or off.
        const { motion } = frameRef.current
        if (motion !== motionOnScreenRef.current) {
            motionOnScreenRef.current = motion
            setMotionOnScreen(motion)
        }
    }, [])

    /** The moon, the station or the ship under the pointer, in graph coordinates, as drawn on the last frame: the nearest, ships first, as they fly over the others. */
    const bodyAt = useCallback(
        (point: Point): Body | undefined => {
            const { id, scale } = frameRef.current
            let best = Infinity
            let ship: Ship | undefined
            const shipReach = SHIP_HIT / scale
            for (const candidate of ships) {
                const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y)
                if (candidate.frame === id && distance <= shipReach && distance < best) {
                    ship = candidate
                    best = distance
                }
            }
            if (ship) return { kind: "ship", ship }
            let station: Station | undefined
            const stationReach = STATION_HIT / scale
            for (const candidate of stations) {
                const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y)
                if (candidate.frame === id && distance <= stationReach && distance < best) {
                    station = candidate
                    best = distance
                }
            }
            if (station) return { kind: "station", station }
            let moon: Moon | undefined
            for (const candidate of moons) {
                const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y)
                if (candidate.frame === id && distance <= Math.max(candidate.radius, MOON_HIT / scale) && distance < best) {
                    moon = candidate
                    best = distance
                }
            }
            return moon && { kind: "moon", moon }
        },
        [ships, stations, moons]
    )

    const paintStar = useCallback(
        (node: StarNode, ctx: CanvasRenderingContext2D, scale: number) => {
            const x = node.x ?? 0
            const y = node.y ?? 0
            const r = node.radius
            const hue = node.kind === "service" ? sky.service : primaryHue
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
            const worldShips = shipsByWorld.get(node.id)
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
            if (worldShips) {
                const shipSize = Math.min(SHIP_SCREEN_SIZE / scale, r * SHIP_MAX_SIZE)
                for (const ship of worldShips) {
                    paintShip(ctx, ship, frame.now, shipSize, scale, colors, reducedMotion)
                    ship.frame = frame.id
                }
            }
            // Something turning in view keeps the map redrawing.
            if (!reducedMotion && !frame.motion && (worldMoons || worldShips || worldStations)) {
                const extent = worldShips ? worldShips[0].orbit + SHIP_SCREEN_SIZE / scale : worldStations ? worldStations[0].orbit + STATION_SCREEN_SIZE / scale : node.reach
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
        },
        [primaryHue, neighbourIds, reducedMotion, font, sky, colors, moonsByWorld, shipsByWorld, stationsByWorld, hoveredResourceId]
    )

    const paintPointerArea = useCallback((node: StarNode, color: string, ctx: CanvasRenderingContext2D) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(node.x ?? 0, node.y ?? 0, node.radius + 2, 0, 2 * Math.PI)
        ctx.fill()
    }, [])

    const laneHue = useCallback((link: LaneLink) => (link.bridge ? sky.bridge : link.kind === "service" ? sky.service : primaryHue), [primaryHue, sky])
    const isLit = useCallback((link: LaneLink) => hovered?.kind === "world" && (link.from === hovered.node.id || link.to === hovered.node.id), [hovered])

    const linkColor = useCallback(
        (link: LaneLink) => {
            const alpha = neighbourIds ? (isLit(link) ? 0.95 : 0.06) : link.bridge ? 0.75 : link.kind === "relation" ? 0.4 : 0.35
            return `hsl(${laneHue(link)} / ${alpha})`
        },
        [neighbourIds, isLit, laneHue]
    )

    // A moon or a ship keeps the hover while the pointer is on it, over the world the force-graph reports.
    const onNodeHover = useCallback((node: StarNode | null) => {
        worldUnderPointerRef.current = node
        const graph = graphRef.current
        if (!node || !graph) return setHovered(previous => (previous?.kind === "world" ? null : previous))
        const position = graph.graph2ScreenCoords(node.x ?? 0, node.y ?? 0)
        setHovered(previous => (previous && previous.kind !== "world" ? previous : { kind: "world", node, x: position.x, y: position.y }))
    }, [])

    const stopLinking = useCallback(() => {
        setLinking(false)
        setLinkSourceId(null)
        pointerRef.current = null
    }, [])

    const startLinking = () => {
        setSelectedLinkId(null)
        setLinking(true)
    }

    useEffect(() => {
        if (!linking) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") stopLinking()
        }
        window.addEventListener("keydown", onKeyDown)
        return () => window.removeEventListener("keydown", onKeyDown)
    }, [linking, stopLinking])

    // While a relation is drawn a click picks a domain: the first one it starts from, the second one it goes to.
    const pickForLink = useCallback(
        (galaxy: Galaxy | undefined) => {
            // Empty space, the nebula of the members in no domain or the same domain again: start over
            if (!galaxy?.domainId || galaxy.domainId === linkSourceId) return setLinkSourceId(null)
            if (!linkSourceId) return setLinkSourceId(galaxy.domainId)
            onLink?.(linkSourceId, galaxy.domainId)
            stopLinking()
        },
        [linkSourceId, onLink, stopLinking]
    )

    /** A click on a moon opens its resource, on a station its maintenance agent, on a ship the work of its agent; false when it fell on none. */
    const openBody = useCallback(
        (point: Point) => {
            const body = bodyAt(point)
            if (body?.kind === "ship") openAgentJob(body.ship.job.jobId, body.ship.fallbackPath)
            if (body?.kind === "moon") navigate(resourcePath(body.moon.resourceId))
            if (body?.kind === "station") navigate(`/maintenance-agent/${body.station.agent._id}`)
            return Boolean(body)
        },
        [bodyAt, openAgentJob, navigate]
    )

    const onNodeClick = useCallback(
        (node: StarNode, event: MouseEvent) => {
            if (linking) return pickForLink(galaxies.find(galaxy => galaxy.id === node.galaxyId))
            // A ship or a moon drawn over a world: the click is for it.
            const graph = graphRef.current
            if (graph && openBody(graph.screen2GraphCoords(event.offsetX, event.offsetY))) return
            navigate(node.kind === "service" ? `/service/${node.id}` : `/frontend/${node.id}`)
        },
        [linking, pickForLink, galaxies, navigate, openBody]
    )

    // A first click on a galaxy flies to it, a second one opens the domain; a click on empty space shows everything again.
    const onBackgroundClick = useCallback(
        (event: MouseEvent) => {
            const graph = graphRef.current
            if (!graph) return
            const point = graph.screen2GraphCoords(event.offsetX, event.offsetY)
            // The nearest galaxy, reached also a little beyond its halo, where its labels are.
            const distance = (galaxy: Galaxy) => {
                const geometry = geometryRef.current.get(galaxy.id)
                return geometry ? Math.hypot(point.x - geometry.x, point.y - geometry.y) / (geometry.r * GALAXY_HIT_REACH) : Infinity
            }
            const hit = galaxies.filter(galaxy => distance(galaxy) <= 1).sort((a, b) => distance(a) - distance(b))[0]
            if (linking) return pickForLink(hit)
            if (openBody(point)) return
            // A relation is thin and runs between the halos, so it is looked for before the galaxies. Only shown, it cannot be picked.
            const reach = RELATION_HIT / graph.zoom()
            const relation = onUnlink && relationSegmentsRef.current.find(segment => distanceToSegment(point, segment.from, segment.to) <= reach)
            setSelectedLinkId(relation ? relation.link._id : null)
            if (relation) return
            if (!hit) return fitAll()
            // On the map of the backends a second click opens the service nearest to it, not the domain:
            // a click on the name of a world, just outside its star, is for that service.
            if (hit.id === focusedGalaxyId && isBackend) {
                const nearest = (membersByGalaxy.get(hit.id) ?? [])
                    .map(node => ({ node, distance: Math.hypot(point.x - (node.x ?? 0), point.y - (node.y ?? 0)) }))
                    .sort((a, b) => a.distance - b.distance)[0]
                if (nearest) navigate(`/service/${nearest.node.id}`)
                return
            }
            if (hit.id === focusedGalaxyId && hit.domainId) return navigate(`/domain/${hit.domainId}`)
            const geometry = geometryRef.current.get(hit.id)!
            setFocusedGalaxyId(hit.id)
            graph.centerAt(geometry.x, geometry.y, FIT_MS)
            graph.zoom(Math.min(MAX_GALAXY_ZOOM, Math.min(size.width, size.height) / (2.6 * geometry.r)), FIT_MS)
        },
        [galaxies, membersByGalaxy, isBackend, focusedGalaxyId, fitAll, navigate, size, linking, pickForLink, openBody, onUnlink]
    )

    // The dashed line of a relation being drawn follows the pointer; otherwise the pointer looks for a moon or a ship,
    // which the force-graph does not know about.
    const onMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
        const graph = graphRef.current
        if (!graph) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const point = graph.screen2GraphCoords(event.clientX - bounds.left - event.currentTarget.clientLeft, event.clientY - bounds.top - event.currentTarget.clientTop)
        if (linkSourceId) {
            pointerRef.current = point
            return
        }
        if (linking) return
        const body = bodyAt(point)
        setHovered(previous => {
            if (body) {
                const same =
                    (previous?.kind === "moon" && body.kind === "moon" && previous.moon === body.moon) ||
                    (previous?.kind === "ship" && body.kind === "ship" && previous.ship === body.ship) ||
                    (previous?.kind === "station" && body.kind === "station" && previous.station === body.station)
                if (same) return previous
                const at = body.kind === "moon" ? body.moon : body.kind === "ship" ? body.ship : body.station
                const position = graph.graph2ScreenCoords(at.x, at.y)
                return { ...body, x: position.x, y: position.y }
            }
            if (!previous || previous.kind === "world") return previous
            // Off a moon or a ship and back on the world under it.
            const world = worldUnderPointerRef.current
            if (!world) return null
            const position = graph.graph2ScreenCoords(world.x ?? 0, world.y ?? 0)
            return { kind: "world", node: world, x: position.x, y: position.y }
        })
    }

    // The prompt of the agent under the pointer, asked for only then: the working list says on what an agent works, not what it does.
    const hoveredJobId = hovered?.kind === "ship" && hovered.ship.job.kind === "job" ? hovered.ship.job.jobId : undefined
    const hoveredJobQuery = useQuery({
        queryKey: ["ai-job", hoveredJobId],
        queryFn: () => aiJobsApi.get(hoveredJobId!, { silent: true }),
        enabled: Boolean(hoveredJobId),
        retry: false,
        staleTime: 60_000
    })

    const hoveredGalaxy = hovered?.kind === "world" ? galaxies.find(galaxy => galaxy.id === hovered.node.galaxyId) : undefined
    const nameOf = (id: string) => graphData.nodes.find(node => node.id === id)?.name ?? ""
    const selectedLink = links.find(link => link._id === selectedLinkId)
    const domainName = (domainId: string) => galaxies.find(galaxy => galaxy.id === domainId)?.name ?? ""
    let linkingHint = t("domains.galaxy.link_pick_source")
    if (linkSourceId) linkingHint = t("domains.galaxy.link_pick_target", { source: domainName(linkSourceId) })

    const renderTooltip = (target: Hovered) => {
        if (target.kind === "moon") {
            const others = target.moon.users.filter(id => id !== target.moon.world.id).map(nameOf)
            return (
                <>
                    <span className="block truncate text-sm font-semibold text-card-foreground">{target.moon.name}</span>
                    <div className="text-foreground-secondary">{target.moon.label}</div>
                    <div className="mt-1 text-foreground-secondary">
                        {t("domains.galaxy.kind_resource")} · {t("domains.galaxy.moon_of", { name: target.moon.world.name })}
                    </div>
                    {others.length > 0 && <div className="mt-1 font-medium text-card-foreground">{t("domains.galaxy.moon_shared", { names: others.join(", ") })}</div>}
                </>
            )
        }
        if (target.kind === "station") {
            const { agent } = target.station
            return (
                <>
                    <span className="block truncate text-sm font-semibold text-card-foreground">{agent.name}</span>
                    <div className="text-foreground-secondary">
                        {t(agent.kind === "container" ? "domains.galaxy.station_container" : "domains.galaxy.station_job")} ·{" "}
                        {agent.schedule ? t("domains.galaxy.station_scheduled", { schedule: agent.schedule }) : t("domains.galaxy.station_standby")}
                    </div>
                    <div className="mt-1 text-foreground-secondary">{t("domains.galaxy.station_of", { name: target.station.world.name })}</div>
                    {target.station.status === "failed" && <div className="mt-1 font-medium text-destructive">{t("domains.galaxy.station_failed")}</div>}
                </>
            )
        }
        if (target.kind === "ship") {
            const prompt = hoveredJobQuery.data?.prompt
            let title = t("domains.galaxy.legend_agent")
            if (target.ship.job.kind === "request") title = t("domains.galaxy.ship_request")
            else if (prompt) title = t("domains.galaxy.ship_job", { prompt: promptExcerpt(prompt) })
            return (
                <>
                    <span className="block text-sm font-semibold text-card-foreground">{title}</span>
                    <div className="mt-1 text-foreground-secondary">{target.ship.world.name}</div>
                    {target.ship.extra > 0 && <div className="mt-1 font-medium text-primary-strong">{t("domains.galaxy.ship_more", { count: target.ship.extra })}</div>}
                </>
            )
        }
        return (
            <>
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-card-foreground">{target.node.name}</span>
                    {target.node.version && <Badge variant="outline">{target.node.version}</Badge>}
                </div>
                <div className="text-foreground-secondary">{target.node.slug}</div>
                <div className="mt-1 text-foreground-secondary">
                    {t(target.node.kind === "service" ? "domains.galaxy.kind_service" : "domains.galaxy.kind_frontend")}
                    {hoveredGalaxy && ` · ${hoveredGalaxy.name}`}
                </div>
                {target.node.canary !== undefined && <div className="mt-1 font-medium text-warning">{t("domains.galaxy.canary", { percentage: target.node.canary })}</div>}
            </>
        )
    }

    return (
        <div
            ref={containerRef}
            className={`relative h-[calc(100vh-300px)] min-h-[420px] overflow-hidden rounded-lg border-2 border-border ${linking ? "[&_canvas]:!cursor-crosshair" : ""}`}
            style={{ backgroundColor: sky.space }}
            onMouseLeave={() => setHovered(null)}
            onMouseMove={onMouseMove}
        >
            <p className="sr-only">
                {isBackend ? t("domains.galaxy.summary_backend") : t("domains.galaxy.summary", { count: graphData.links.filter(link => link.bridge).length })}
                {agents.length > 0 && ` ${t("domains.galaxy.agents_summary", { count: agents.length })}`}
            </p>
            {/* The ships for the keyboard and screen readers: hidden until one of them has the focus, same action as a click. */}
            {agents.length > 0 && (
                <ul
                    aria-label={t("domains.galaxy.agents_list")}
                    className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:bottom-14 focus-within:left-3 focus-within:z-20 focus-within:flex focus-within:max-w-sm focus-within:flex-col focus-within:gap-1 focus-within:rounded-md focus-within:border focus-within:border-border focus-within:bg-card focus-within:p-2 focus-within:shadow-md"
                >
                    {agents.map(agent => (
                        <li key={agent.jobId}>
                            <Button variant="ghost" size="sm" className="max-w-full justify-start" onClick={() => openAgentJob(agent.jobId, agent.fallbackPath)}>
                                <Rocket aria-hidden="true" />
                                <span className="truncate">{t("domains.galaxy.open_agent", { names: agent.names })}</span>
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {/* The stations for the keyboard and screen readers, as the ships */}
            {stations.length > 0 && (
                <ul
                    aria-label={t("domains.galaxy.stations_list")}
                    className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:bottom-14 focus-within:left-3 focus-within:z-20 focus-within:flex focus-within:max-w-sm focus-within:flex-col focus-within:gap-1 focus-within:rounded-md focus-within:border focus-within:border-border focus-within:bg-card focus-within:p-2 focus-within:shadow-md"
                >
                    {stations.map(station => (
                        <li key={`${station.agent._id}-${station.world.id}`}>
                            <Button variant="ghost" size="sm" className="max-w-full justify-start" onClick={() => navigate(`/maintenance-agent/${station.agent._id}`)}>
                                <Wrench aria-hidden="true" />
                                <span className="truncate">{t("domains.galaxy.open_station", { name: station.agent.name, world: station.world.name })}</span>
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {isGraphMounted && (
                <ForceGraph2D<StarNode, LaneLink>
                    ref={graphRef}
                    width={size.width}
                    height={size.height}
                    graphData={graphData}
                    backgroundColor={sky.space}
                    nodeCanvasObject={paintStar}
                    nodePointerAreaPaint={paintPointerArea}
                    linkColor={linkColor}
                    linkWidth={link => (isLit(link) ? 1.6 : link.bridge ? 1.4 : 0.8)}
                    linkLineDash={link => (link.kind === "service" ? [3, 2] : null)}
                    linkCurvature={link => (link.bridge ? 0.15 : 0)}
                    linkDirectionalParticles={link => (!reducedMotion && (link.bridge || isLit(link)) ? 2 : 0)}
                    linkDirectionalParticleSpeed={0.005}
                    linkDirectionalParticleWidth={2.2}
                    linkDirectionalParticleColor={link => `hsl(${laneHue(link)})`}
                    onRenderFramePre={onRenderFramePre}
                    onRenderFramePost={onRenderFramePost}
                    onNodeHover={onNodeHover}
                    onNodeClick={onNodeClick}
                    onBackgroundClick={onBackgroundClick}
                    onEngineStop={onEngineStop}
                    // The tooltip is placed in screen pixels, so it would drift away from its star.
                    onZoom={() => setHovered(null)}
                    enableNodeDrag={false}
                    autoPauseRedraw={!animated && !linkSourceId}
                    warmupTicks={reducedMotion ? 300 : 0}
                    cooldownTicks={reducedMotion ? 0 : Infinity}
                    cooldownTime={4000}
                    minZoom={0.2}
                    maxZoom={8}
                />
            )}

            <div className="pointer-events-none absolute top-3 left-3 flex flex-wrap items-center gap-4 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium shadow-sm">
                {!isBackend && (
                    <span className="flex items-center gap-1.5">
                        <span className="size-2.5 rounded-full bg-primary" aria-hidden="true" />
                        {t("domains.detail.frontend_title")}
                    </span>
                )}
                <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-zomp-600 dark:bg-zomp-400" aria-hidden="true" />
                    {t("domains.detail.backend_title")}
                </span>
                {moons.length > 0 && (
                    <span className="flex items-center gap-1.5">
                        {/* A moon on its orbit, as on the map */}
                        <span className="relative size-3.5 rounded-full border border-foreground/30" aria-hidden="true">
                            <span className="absolute -top-[3px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-zomp-700 dark:bg-zomp-200" />
                        </span>
                        {t("domains.galaxy.legend_moon")}
                    </span>
                )}
                {!isBackend && (
                    <>
                        <span className="flex items-center gap-1.5">
                            <span className="size-3 rounded-full border-2 border-sunglow-600 dark:border-sunglow-200" aria-hidden="true" />
                            {t("domains.galaxy.legend_canary")}
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="h-0.5 w-4 rounded-full bg-olivine-600 dark:bg-olivine-300" aria-hidden="true" />
                            {t("domains.galaxy.legend_bridge")}
                        </span>
                    </>
                )}
                {/* Without the tool to draw them, the relations are in the legend only when there are some */}
                {(onLink || links.length > 0) && (
                    <span className="flex items-center gap-1.5">
                        <span className="h-1 w-4 rounded-full bg-foreground/60" aria-hidden="true" />
                        {t("domains.galaxy.legend_relation")}
                    </span>
                )}
                {stations.length > 0 && (
                    <span className="flex items-center gap-1.5">
                        <StationGlyph />
                        {t("domains.galaxy.legend_station")}
                    </span>
                )}
                {ships.length > 0 && (
                    <span className="flex items-center gap-1.5">
                        <ShipGlyph />
                        {t("domains.galaxy.legend_agent")}
                    </span>
                )}
            </div>
            <div className="absolute top-3 right-3 flex items-center gap-2">
                {onLink && (
                    <Button
                        variant={linking ? "primary" : "secondary"}
                        size="sm"
                        aria-pressed={linking}
                        disabled={domains.length < 2}
                        onClick={linking ? stopLinking : startLinking}
                        dataTestId="domain-galaxy-link"
                    >
                        <Link2 />
                        {t("domains.galaxy.link_action")}
                    </Button>
                )}
                <Button variant="secondary" size="icon" aria-label={t("domains.galaxy.recenter")} title={t("domains.galaxy.recenter")} onClick={fitAll}>
                    <LocateFixed />
                </Button>
            </div>
            <p
                className={`pointer-events-none absolute right-3 bottom-3 max-w-sm rounded-md border bg-card px-3 py-2 text-xs shadow-sm ${linking ? "border-primary font-medium text-card-foreground" : "border-border text-foreground-secondary"}`}
                aria-live="polite"
            >
                {linking ? linkingHint : t(isBackend ? "domains.galaxy.hint_backend" : "domains.galaxy.hint")}
            </p>

            {selectedLink && onUnlink && (
                <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3 rounded-md border border-border bg-card py-1.5 pr-1.5 pl-3 text-sm shadow-md">
                    <span className="font-medium text-card-foreground">
                        {domainName(selectedLink.sourceDomainId)} → {domainName(selectedLink.targetDomainId)}
                    </span>
                    {selectedLink.label && <span className="text-foreground-secondary">{selectedLink.label}</span>}
                    <Button variant="ghost" size="icon" aria-label={t("domains.galaxy.link_delete")} title={t("domains.galaxy.link_delete")} onClick={() => onUnlink(selectedLink)}>
                        <Trash2 className="text-destructive" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={t("domains.galaxy.link_close")} title={t("domains.galaxy.link_close")} onClick={() => setSelectedLinkId(null)}>
                        <X />
                    </Button>
                </div>
            )}

            {hovered && (
                <div
                    className="pointer-events-none absolute z-10 min-w-48 max-w-72 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md"
                    // Below a world and its glow, below a moon and its label
                    style={{ left: hovered.x, top: hovered.y + (hovered.kind === "world" ? hovered.node.radius * 2 + 16 : 28) }}
                >
                    {renderTooltip(hovered)}
                </div>
            )}
        </div>
    )
}

export default DomainGalaxy
