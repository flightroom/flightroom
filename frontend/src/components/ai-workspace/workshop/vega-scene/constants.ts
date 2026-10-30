import * as THREE from "three"
import type { WorkshopMood } from "./types"

/** How long a departure lasts, in seconds */
export const DEPARTURE_SECONDS = 1.8

/** The body colours of the four liveries, light to dark, from the brand scales of the design system: pumpkin, zomp, sunglow, olivine. */
export const LIVERIES = [
    ["#FFA060", "#FE7F2D", "#D9581A"],
    ["#A9DCCB", "#5FAE95", "#367C67"],
    ["#FFE08A", "#FCCA46", "#D3A312"],
    ["#C9E3A8", "#9CC46E", "#6E9A41"]
]

/** The side of the floor plate of a bay */
export const TILE = 4.4
export const MAX_COLUMNS = 4
/** Room left between the bays and the two walls, for the consoles, the crates and the pipes */
export const WALL_MARGIN = 2.4
/** The open deck on the two sides toward the camera */
export const OPEN_MARGIN = 4
export const WALL_HEIGHT = 5.4
/** The isometric view: from the open corner of the room, a third of the way up */
export const AZIMUTH = Math.PI / 4
export const ELEVATION = Math.atan(1 / Math.SQRT2)
export const CYAN = "#7FE6F5"

/** The light on the console of a bay, by what its Vega is doing */
const CONSOLE_HEX: Record<WorkshopMood, string> = {
    queued: "#9db2c0",
    thinking: "#4fd1e8",
    analyzing: "#4fd1e8",
    coding: "#4fd1e8",
    working: "#4fd1e8",
    done: "#a6cf7e",
    applying: "#fe7f2d",
    applied: "#a6cf7e",
    failed: "#f26d6d",
    parked: "#486172"
}

/** Parsed once: the loop copies them instead of parsing a hex string for every bay on every frame */
export const CONSOLE_COLORS = Object.fromEntries(Object.entries(CONSOLE_HEX).map(([mood, hex]) => [mood, new THREE.Color(hex)])) as Record<WorkshopMood, THREE.Color>

/** How fast a Vega off duty roams the workshop, in units a second; the ones the agent is working with stay in their bay */
export const ROAM_SPEEDS: Partial<Record<WorkshopMood, number>> = { queued: 1, thinking: 0.8, done: 1.8, failed: 0.5 }
/** How fast a Vega flies back to its bay once its work starts again */
export const RETURN_SPEED = 2.6
/** How close two Vegas fly before they push each other aside */
export const PERSONAL_SPACE = 2.6
/** How high a Vega on its way flies over its usual height: clear of the consoles and the carts of the bays */
export const CRUISE_LIFT = 0.5
