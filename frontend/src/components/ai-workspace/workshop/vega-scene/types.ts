import type * as THREE from "three"

/** What a Vega is doing: the pose follows the status of its work and, while it runs, the last tool the agent called. */
export type WorkshopMood = "queued" | "thinking" | "analyzing" | "coding" | "working" | "done" | "applying" | "applied" | "failed" | "parked"

export interface WorkshopWorker {
    id: string
    /** VEGA·NN, from the id: the same work keeps its number and its colours across polls */
    callsign: string
    livery: number
    title: string
    mood: WorkshopMood
    /** Under the title: the status, or what the agent is doing */
    caption: string
}

/** How a Vega leaves the workshop: off with its rocket once its work is applied, fading away once it is discarded */
export type Departure = "launch" | "fade"

/** A move of the moment, on top of the hovering: a slide, a hop, a roll, a lean, a spin */
export interface Move {
    x: number
    z: number
    lift: number
    roll: number
    pitch: number
    spin: number
}

export interface RoomSize {
    width: number
    depth: number
}

/** A wall of the room, and the way it faces: only the ones behind the room stand */
export interface Wall {
    group: THREE.Group
    normal: THREE.Vector3
}

/** What moves in the room by itself: the LEDs of the rack, the welding arm */
export type RoomAnimation = (time: number, motion: number) => void

export interface Vega {
    worker: WorkshopWorker
    root: THREE.Group
    hover: THREE.Group
    bodyMaterial: THREE.MeshStandardMaterial
    base: THREE.Color
    eyes: THREE.Mesh[]
    arcs: THREE.Mesh[]
    eyeMaterial: THREE.MeshBasicMaterial
    fins: { pivot: THREE.Group; side: number }[]
    thruster: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    glow: THREE.PointLight
    lens: THREE.Group
    working: THREE.Group
    wrench: THREE.Group
    coding: THREE.Group
    codeCanvas: HTMLCanvasElement
    codeTexture: THREE.CanvasTexture
    flame: THREE.Group
    dots: THREE.Mesh[]
    sparks: THREE.Group
    smoke: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[]
    /** Eased lean and heading, which the moves of the moment add to */
    tilt: number
    facing: number
    ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
    screen: THREE.MeshBasicMaterial
    liftoff: number
    /** Where it is on the deck, where it flies to, how fast and which way it goes: unset with reduced motion, when it never leaves its bay */
    roam?: { at: THREE.Vector2; target: THREE.Vector2; pace: number; heading?: number; restUntil?: number }
    /** Whether its plate shows title and caption: written only when it changes */
    expanded?: boolean
    tag: HTMLDivElement
}

/** A Vega on its way out, removed once its departure is over */
export interface Leaving {
    vega: Vega
    departure: Departure
    since: number
}
