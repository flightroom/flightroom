import type { LinkObject, NodeObject } from "react-force-graph-2d"
import type { AiWorkingJob } from "@/hooks/apiClients/useAiJobsApi"
import type { DomainLink } from "@/hooks/apiClients/useDomainLinksApi"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import type { VariableMapKind } from "@/hooks/apiClients/useVariableMapsApi"

export interface Point {
    x: number
    y: number
}

/** Where a relation was drawn on the last frame, to tell which one a click hits */
export interface RelationSegment {
    link: DomainLink
    from: Point
    to: Point
}

/** A frontend or a backend: the worlds of the galaxies, the only nodes the forces move */
export interface World {
    id: string
    kind: "frontend" | "backend"
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

export interface Lane {
    from: string
    to: string
    kind: "relation" | "backend"
    /** Between members of two different galaxies */
    bridge: boolean
    /** How much longer the lane is for the moons of its two worlds, so they do not run into each other */
    extent: number
}

export interface Galaxy {
    id: string
    name: string
    /** Missing on the galaxy of the members in no domain */
    domainId?: string
    caption: string
    /** Index in the galaxy colours of the sky; missing on the galaxy of the members in no domain */
    paletteIndex?: number
    anchor: { x: number; y: number }
}

export type StarNode = NodeObject<World>

/** Where a galaxy was drawn on the last frame: the centre of its halo and its radius */
export type GalaxyGeometry = Point & { r: number }

/** An orbit around a world, off centre as Kepler's: an ellipse with the world at a focus, turned by `tilt`. */
export interface KeplerOrbit {
    /** Half the long axis of the orbit */
    semiMajor: number
    semiMinor: number
    /** 0 a circle, 1 no longer closed */
    eccentricity: number
    /** Where the near end of the orbit points from its world, in radians */
    tilt: number
}

/**
 * A resource attached to a backend, orbiting it off centre. A resource several backends attach is a moon of each
 * of them. Where it was drawn on the last frame is written on it by the painter, never allocated per frame.
 */
export interface Moon extends KeplerOrbit {
    resourceId: string
    name: string
    /** Its type and variant, for the tooltip */
    label: string
    /** Every backend shown that attaches it, its own world included */
    users: string[]
    world: StarNode
    radius: number
    /** Its mean anomaly at time zero */
    phase: number
    /** Radians of mean anomaly per second */
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

/**
 * A config map or a secret a world receives, a comet on one of the two eccentric orbits of that world: the config
 * maps on one, the secrets on the other, each an ellipse with the world at a focus. A map several worlds receive
 * is a comet of each of them. Where it was drawn on the last frame is written on it by the painter.
 */
export interface Comet extends KeplerOrbit {
    mapId: string
    kind: VariableMapKind
    name: string
    /** How many keys it holds, for the tooltip */
    keys: number
    /** Every world shown that receives it, its own included */
    users: string[]
    world: StarNode
    radius: number
    /** Its mean anomaly at time zero */
    phase: number
    /** Radians of mean anomaly per second: fast near its world, slow far out */
    speed: number
    x: number
    y: number
    frame: number
}

/** An agent at work, shown as one ship flying around the galaxies of the worlds it works on. */
export interface Ship {
    job: AiWorkingJob
    worlds: StarNode[]
    world: StarNode
    /** The galaxies of its worlds, sorted: its orbit goes around their halos, its domain alone when they are all in one */
    galaxyIds: string[]
    phase: number
    /**
     * Its place among the ships around the same galaxies, from the inside out: each one a lane of its own, farther
     * out, stretched and turned another way than the one inside it, and flown the other way round every other lane.
     */
    lane: number
    /** Where the long axis of its orbit points, in radians */
    tilt: number
    /** 1 clockwise on screen, -1 the other way round */
    direction: 1 | -1
    /** The agents at work on the same world beyond the ones drawn */
    extra: number
    /** Where a click goes when the agent is a change request started on a page, which has no job to open; a job has none. */
    fallbackPath?: string
    x: number
    y: number
    frame: number
}

/** An agent at work as the keyboard and screen readers reach it: one entry per job, whatever the ships drawn */
export interface Agent {
    jobId: string
    names: string
    fallbackPath?: string
}

/** How a maintenance station is lit: on a schedule, waiting for Play, its last run failed */
export type StationStatus = "scheduled" | "standby" | "failed"

/**
 * A maintenance agent that looks after one world only, in a slow orbit off centre around it like a station, tethered
 * to it. One that looks after several worlds is in the maintenance room only: it belongs to none of them.
 */
export interface Station extends KeplerOrbit {
    agent: MaintenanceAgent
    world: StarNode
    status: StationStatus
    /** Its mean anomaly at time zero */
    phase: number
    x: number
    y: number
    frame: number
}

/** What the pointer is on besides the worlds, the force-graph only knows its nodes */
export type Body = { kind: "moon"; moon: Moon } | { kind: "comet"; comet: Comet } | { kind: "ship"; ship: Ship } | { kind: "station"; station: Station }
export type Hovered = Point & ({ kind: "world"; node: StarNode } | Body)

export type LaneLink = LinkObject<World, Lane>

/** The d3 forces force-graph creates, only as far as they are tuned here */
export interface LinkForce {
    distance(accessor: (link: LaneLink) => number): LinkForce
    strength(accessor: (link: LaneLink) => number): LinkForce
}
export interface ChargeForce {
    strength(accessor: (node: StarNode) => number): ChargeForce
    distanceMax(value: number): ChargeForce
}

/** The frame being painted: its clock, its zoom, what of the map it shows and whether anything turning is in it. */
export interface Frame {
    id: number
    now: number
    scale: number
    left: number
    top: number
    right: number
    bottom: number
    motion: boolean
    shipsPainted: number
}
