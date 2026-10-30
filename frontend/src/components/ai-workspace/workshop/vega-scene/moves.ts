import type { Move, WorkshopMood } from "./types"

export const STILL: Move = { x: 0, z: 0, lift: 0, roll: 0, pitch: 0, spin: 0 }

/** How far through a cycle of `period` seconds the time is, from 0 to 1 */
const phaseOf = (time: number, period: number) => (time % period) / period

/**
 * What a Vega does with its body while its work goes on. Writing code it slides between its console and its screen,
 * bouncing as it types; running a script it loops the loop with its wrench; reading the code it circles its pad bent
 * over the magnifying glass; thinking it tilts its head; with a proposal ready it hops and twirls; applying it spirals
 * up; failed, it shudders now and then.
 */
export const moveOf = (mood: WorkshopMood, time: number): Move => {
    switch (mood) {
        case "coding":
            return { ...STILL, x: Math.sin(time * 0.6) * 0.5, lift: Math.abs(Math.sin(time * 9)) * 0.07, pitch: 0.14 }
        case "working": {
            const phase = phaseOf(time, 4)
            return { ...STILL, lift: Math.sin(time * 3) * 0.05, roll: phase > 0.75 ? ((phase - 0.75) / 0.25) * Math.PI * 2 : 0 }
        }
        case "analyzing":
            return { ...STILL, x: Math.cos(time * 0.7) * 0.6, z: Math.sin(time * 0.7) * 0.6, pitch: 0.28, spin: Math.sin(time * 0.7) * 0.4 }
        case "thinking":
            return { ...STILL, lift: Math.sin(time * 0.8) * 0.1, roll: Math.sin(time * 1.2) * 0.16 }
        case "done":
        case "applied": {
            const phase = phaseOf(time, mood === "done" ? 3 : 5)
            const hop = phase < 0.2 ? phase / 0.2 : 0
            return { ...STILL, lift: Math.sin(hop * Math.PI) * 0.6, spin: hop * Math.PI * 2 }
        }
        case "applying":
            return { ...STILL, x: Math.cos(time * 3) * 0.3, z: Math.sin(time * 3) * 0.3, spin: time * 4 }
        case "failed":
            return phaseOf(time, 5) < 0.15 ? { ...STILL, x: Math.sin(time * 40) * 0.05, roll: Math.sin(time * 35) * 0.05 } : STILL
        default:
            return STILL
    }
}
