import type { StationStatus } from "./types"

export interface Sky {
    space: string
    /** The labels and the dust of the background */
    ink: string
    dustAlpha: number
    backend: string
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
export const SKIES: Record<"dark" | "light", Sky> = {
    dark: {
        space: "#07202D", // charcoal-950
        ink: "38 44% 96%", // foreground (dark)
        dustAlpha: 1,
        backend: "162 28% 61%", // zomp-400
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
        backend: "163 27% 41%", // zomp-600
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
export const FALLBACK_PRIMARY = "24 99% 59%"
/** charcoal-50: the bright core of every star */
export const STAR_CORE = "204 88% 97%"

/** A fixed sky: seeded, so the stars do not jump around at every mount. */
export const BACKGROUND_STARS = (() => {
    let seed = 7
    const random = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
    }
    return Array.from({ length: 180 }, () => ({ x: random(), y: random(), size: random() < 0.9 ? 1 : 2, alpha: 0.15 + random() * 0.5 }))
})()

/** The colours of the dust, the moons and the ships, built once per theme: they are painted on every frame. */
export const bodyColors = (sky: Sky) => ({
    dust: BACKGROUND_STARS.map(star => `hsl(${sky.ink} / ${star.alpha * sky.dustAlpha})`),
    moon: `hsl(${sky.moon})`,
    moonShadow: `hsl(${sky.moonShadow})`,
    moonRing: `hsl(${sky.ink} / 0.9)`,
    label: `hsl(${sky.ink} / 0.85)`,
    orbit: `hsl(${sky.ink} / ${sky.orbitAlpha})`,
    shipBody: `hsl(${sky.canary})`,
    trail: [`hsl(${sky.canary} / 0.12)`, `hsl(${sky.canary} / 0.4)`],
    rocket: { windowColor: sky.space, flameColor: `hsl(${sky.canary})`, flame: 7 },
    parkedRocket: { windowColor: sky.space, flameColor: `hsl(${sky.canary})`, flame: 3 },
    panel: `hsl(${sky.ink} / 0.55)`,
    tether: `hsl(${sky.ink} / 0.28)`,
    stationLight: { scheduled: `hsl(${sky.backend})`, standby: `hsl(${sky.canary})`, failed: `hsl(${sky.alarm})` } satisfies Record<StationStatus, string>
})
export type BodyColors = ReturnType<typeof bodyColors>
