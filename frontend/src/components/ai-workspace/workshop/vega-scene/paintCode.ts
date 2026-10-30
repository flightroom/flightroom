import * as THREE from "three"
import { CYAN } from "./constants"
import type { Vega } from "./types"

const WINDOW_DOTS = ["#fe7f2d", "#fcca46", CYAN]
/** The lines of code on the screen: where they start, how long they get, their colour */
const LINES: [number, number, string][] = [
    [24, 120, "#fe7f2d"],
    [44, 90, CYAN],
    [44, 150, "#f3eee4"],
    [24, 70, CYAN],
    [44, 110, "#f3eee4"]
]

/** The screen a Vega writing code holds up: an editor whose lines type themselves out */
export const paintCode = (vega: Vega, time: number, reducedMotion: boolean) => {
    const context = vega.codeCanvas.getContext("2d")
    if (!context) return
    context.clearRect(0, 0, 256, 170)
    context.fillStyle = "rgba(27, 36, 51, 0.92)"
    context.strokeStyle = "rgba(79, 209, 232, 0.8)"
    context.lineWidth = 4
    context.beginPath()
    context.roundRect(4, 4, 248, 162, 16)
    context.fill()
    context.stroke()
    WINDOW_DOTS.forEach((color, index) => {
        context.fillStyle = color
        context.beginPath()
        context.arc(24 + index * 16, 22, 5, 0, Math.PI * 2)
        context.fill()
    })
    // The lines type themselves out, then the editor starts over
    const typed = reducedMotion ? LINES.length : (time * 1.3) % (LINES.length + 1)
    LINES.forEach(([x, width, color], index) => {
        const share = THREE.MathUtils.clamp(typed - index, 0, 1)
        if (!share) return
        context.fillStyle = color
        context.beginPath()
        context.roundRect(x, 44 + index * 22, width * share, 9, 4.5)
        context.fill()
    })
    vega.codeTexture.needsUpdate = true
}
