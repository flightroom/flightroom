export const NO_DOMAIN = "no-domain"

export const GALAXY_PULL = 0.12
export const LANE_DISTANCE = 36
export const BRIDGE_DISTANCE = 260
export const GALAXY_PADDING = 26
export const EMPTY_GALAXY_RADIUS = 40
export const GALAXY_HIT_REACH = 1.6
export const STAR_LABEL_ZOOM = 1.4
export const DIMMED_ALPHA = 0.15
export const FIT_MS = 600
// Room for the halo and the two label lines over the outermost galaxies
export const FIT_PADDING = 110
export const MAX_GALAXY_ZOOM = 4
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** A moon to its world, and the gap between its world and the near end of the first orbit and between two orbits, in moon radii */
export const MOON_SIZE = 0.33
/** How off centre the orbits of the moons are: 0 a circle, 1 no longer closed. Less than the comets, a moon keeps near its world. */
export const MOON_ECCENTRICITY = 0.25
export const MOON_FIRST_ORBIT = 2.4
export const MOON_ORBIT_STEP = 3
/** In moon radii: how close two moons of the same orbit may come, centre to centre */
export const MOON_SPACING = 3.2
/** Radians per second on the first orbit; the outer ones are slower, as the planets around the sun */
export const MOON_SPEED = 0.3
/** On screen, in pixels: the radius from which a moon shows its shadow, then its icon */
export const MOON_SHADE_PX = 3.5
export const MOON_ICON_PX = 5
export const MOON_LABEL_ZOOM = 4.5
/** In screen pixels: how near the pointer must fall to a moon */
export const MOON_HIT = 8
/** A comet to its world, and how far beyond its moons the nearest point of the inner orbit is, in world radii */
export const COMET_SIZE = 0.22
export const COMET_GAP = 0.8
/** In world radii: how much farther out the orbit of the secrets comes nearest than the one of the config maps */
export const COMET_ORBIT_STEP = 0.7
/** How stretched the two orbits are: 0 a circle, 1 no longer closed */
export const COMET_ECCENTRICITY = 0.38
/** Radians between where the two orbits point, so they cross rather than nest */
export const COMET_TILT = (2 * Math.PI) / 3
/** Radians of mean anomaly per second on the orbit of the config maps */
export const COMET_SPEED = 0.35
/** In screen pixels: how near the pointer must fall to a comet */
export const COMET_HIT = 8
/** Ships keep this size on screen, but never get bigger than their world as the map zooms out. */
export const SHIP_SCREEN_SIZE = 16
export const SHIP_MAX_SIZE = 1.2
/** Radians per second around its galaxy on the innermost lane: three times the moons, an agent is busy */
export const SHIP_ORBIT_SPEED = 0.9
/** How much slower each lane is than the one inside it, as the outer planets */
export const SHIP_LANE_SLOWDOWN = 0.15
/** Between the halo of a galaxy and the first lane of its ships, and between two lanes: in graph units, never less than SHIP_LANE_PX on screen */
export const SHIP_LANE_GAP = 14
export const SHIP_LANE_PX = 18
/** How much longer than wide the orbit of each lane is, in turn: never a circle, more and more stretched, short of the neighbouring galaxies */
export const SHIP_LANE_STRETCH = [0.1, 0.2, 0.3]
/** The ships shown per world-equivalent across the galaxy; the others are counted on the first ship's tooltip */
export const SHIP_CAP = 3
/** The length of the trail of a ship along its galactic orbit, in radians */
export const SHIP_TRAIL = 0.5
/** Frames a second while the moons and the ships turn over a settled map: smooth enough for them, half the redraws of the whole map. */
export const MOTION_FPS = 30
/** In screen pixels: how near the pointer must fall to a ship */
export const SHIP_HIT = 14

/** Radians per second: a station keeps nearly still over its world, a ship flies by */
export const STATION_ORBIT_SPEED = 0.12
/** How off centre the orbit of a station is: it swings a little nearer its world and away again */
export const STATION_ECCENTRICITY = 0.2
export const STATION_SCREEN_SIZE = 14
export const STATION_HIT = 12
/** In screen pixels: how near a click must fall to a relation, the size of its arrow, the gap to its way back */
export const RELATION_HIT = 6
export const RELATION_ARROW = 10
export const RELATION_GAP = 6
/** Share of the way from the source where the label of a relation sits */
export const RELATION_LABEL_AT = 0.35
/** The characters of the prompt shown in the tooltip of a ship */
export const PROMPT_EXCERPT = 90
