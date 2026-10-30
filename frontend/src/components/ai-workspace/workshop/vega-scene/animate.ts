import * as THREE from "three"
import { CONSOLE_COLORS, CRUISE_LIFT, CYAN, DEPARTURE_SECONDS } from "./constants"
import { moveOf, STILL } from "./moves"
import { paintCode } from "./paintCode"
import { flicker } from "./sparks"
import type { Leaving, Vega } from "./types"

// Parsed once: the loop copies them instead of parsing a hex string for every Vega on every frame
const DIMMED = new THREE.Color("#5b6a73")
const EYE_ON = new THREE.Color(CYAN)
const EYE_FAILED = new THREE.Color("#a68a3a")
const EYE_RESTING = new THREE.Color("#4f8f9a")
const RING_SELECTED = new THREE.Color("#fe7f2d")
const RING_IDLE = new THREE.Color("#fcca46")

/** How high a Vega on its way flies over its usual height */
export const cruiseOf = (vega: Vega) => (vega.roam ? Math.min(1, vega.roam.pace) * CRUISE_LIFT : 0)

/** Moves the Vegas on their way out, removing the ones whose departure is over: hands back the ones still leaving */
export const animateDepartures = (leaving: Leaving[], time: number, remove: (vega: Vega) => void) =>
    leaving.filter(({ vega, departure, since }) => {
        const progress = (time - since) / DEPARTURE_SECONDS
        if (progress >= 1) {
            remove(vega)
            return false
        }
        if (departure === "launch") {
            // Up and away, spinning, its flame on
            vega.flame.visible = true
            vega.flame.scale.y = 1.2 + Math.sin(time * 40) * 0.15
            vega.glow.intensity = 5
            vega.hover.position.y = 1.75 + progress * progress * 14
            vega.hover.rotation.y += 0.25
        } else {
            // Down onto its pad and smaller, until nothing is left
            vega.hover.position.y = 1.75 - progress * 1.2
            vega.hover.scale.setScalar(Math.max(0.01, 1 - progress))
            vega.bodyMaterial.color.lerp(DIMMED, 0.1)
        }
        return true
    })

interface PoseContext {
    time: number
    /** 0 with reduced motion, 1 otherwise */
    motion: number
    reducedMotion: boolean
    /** Where the camera stands round the room: a Vega at rest faces it */
    azimuth: number
}

/** The pose of a Vega on this frame, eased toward what its mood asks: its body, its eyes, its tools, its bay */
export const poseVega = (vega: Vega, index: number, selected: boolean, { time, motion, reducedMotion, azimuth }: PoseContext) => {
    const mood = vega.worker.mood
    const launching = mood === "applying"
    const failed = mood === "failed"
    const resting = mood === "queued" || mood === "parked"
    const happy = mood === "done" || mood === "applied"
    const busy = mood === "coding" || mood === "working"

    const move = motion ? moveOf(mood, time + index * 1.7) : STILL
    vega.liftoff += ((launching ? 1 : 0) - vega.liftoff) * 0.04
    const baseY = resting ? 1.2 : failed ? 1.1 : 1.75
    const bob = Math.sin(time * (launching ? 9 : 1.7) + index) * (launching ? 0.05 : 0.09) * motion
    const roam = vega.roam
    const cruise = cruiseOf(vega)
    vega.hover.position.y += (baseY + vega.liftoff * 1.6 + bob + cruise + move.lift - vega.hover.position.y) * 0.18
    // Where it roams on the deck, from its bay
    const awayX = roam ? roam.at.x - vega.root.position.x : 0
    const awayZ = roam ? roam.at.y - vega.root.position.z : 0
    vega.hover.position.x += (awayX + move.x - vega.hover.position.x) * 0.12
    vega.hover.position.z += (awayZ + move.z - vega.hover.position.z) * 0.12
    const tilt = failed ? -0.32 : Math.sin(time * 0.9 + index) * 0.04 * motion
    vega.tilt += (tilt - vega.tilt) * 0.08
    vega.hover.rotation.z = vega.tilt + move.roll
    vega.hover.rotation.x += (move.pitch - vega.hover.rotation.x) * 0.1
    // Facing where it flies to, and once there the camera, turned a little toward the tool it holds
    const facing = roam && roam.pace > 0.3 && roam.heading !== undefined ? roam.heading : azimuth + (busy ? 0.25 : 0)
    // The shortest way round, so a Vega never spins a whole turn when the camera crosses a full circle
    vega.facing += Math.atan2(Math.sin(facing - vega.facing), Math.cos(facing - vega.facing)) * 0.06
    vega.hover.rotation.y = vega.facing + move.spin
    flicker(vega.sparks, mood === "working" && motion > 0)
    vega.smoke.forEach((puff, puffIndex) => {
        const rise = (time * 0.45 + puffIndex / 3) % 1
        puff.visible = failed
        puff.position.set(Math.sin(rise * 5 + puffIndex) * 0.2, 1 + rise * 1.6, -0.2)
        puff.scale.setScalar(0.6 + rise * 1.4)
        puff.material.opacity = 0.55 * (1 - rise) * (motion || 0.4)
    })
    for (const { pivot, side } of vega.fins) {
        const flap = failed || resting ? -0.15 : Math.sin(time * (launching ? 22 : 4) + index) * (launching ? 0.35 : 0.16) * motion
        pivot.rotation.z = side * (0.28 + flap)
    }

    vega.bodyMaterial.color.lerp(failed || mood === "parked" ? DIMMED : vega.base, 0.06)
    const blink = !reducedMotion && (time + index * 1.3) % 4.5 < 0.12
    vega.eyes.forEach((eye, eyeIndex) => {
        eye.visible = !happy
        const big = mood === "analyzing" && eyeIndex === 1 ? 1.35 : 1
        eye.scale.set(big, blink ? 0.15 : busy ? 0.75 : 1.6 * big, 0.5)
    })
    for (const arc of vega.arcs) arc.visible = happy
    vega.eyeMaterial.color.copy(failed ? EYE_FAILED : resting ? EYE_RESTING : EYE_ON)
    vega.thruster.material.opacity = failed ? 0.15 : resting ? 0.35 : 0.9
    vega.glow.intensity = failed ? 0.2 : launching ? 5 : 2
    vega.screen.color.copy(CONSOLE_COLORS[mood])

    vega.lens.visible = mood === "analyzing"
    vega.lens.position.x = 0.17 + Math.sin(time * 1.4) * 0.06 * motion
    vega.working.visible = mood === "working"
    vega.wrench.rotation.z = Math.sin(time * 6) * 0.35 * motion
    vega.coding.visible = mood === "coding"
    if (vega.coding.visible) paintCode(vega, time, reducedMotion)
    vega.flame.visible = launching
    vega.flame.scale.y = 1 + Math.sin(time * 40) * 0.12 * motion
    vega.dots.forEach((dot, dotIndex) => {
        dot.visible = mood === "thinking"
        dot.position.y = 1.35 + Math.max(0, Math.sin(time * 5 - dotIndex * 0.7)) * 0.12 * motion
    })

    vega.ring.material.color.copy(selected ? RING_SELECTED : RING_IDLE)
    vega.ring.scale.setScalar(selected ? 1.12 : 1)
}

// A scratch vector, reused for every plate on every frame
const projected = new THREE.Vector3()

/**
 * The plate over the head of the Vega wherever it roams, as wide as a bay. Only the selected Vega and the one under the
 * pointer show their title and what they do: the rest, their callsign.
 */
export const placeTag = (vega: Vega, camera: THREE.Camera, width: number, height: number, bayWidth: number, expanded: boolean) => {
    projected.set(vega.root.position.x + vega.hover.position.x, 3.9 + cruiseOf(vega), vega.root.position.z + vega.hover.position.z).project(camera)
    vega.tag.style.left = `${(projected.x * 0.5 + 0.5) * width}px`
    vega.tag.style.top = `${(-projected.y * 0.5 + 0.5) * height}px`
    vega.tag.style.maxWidth = `${Math.max(96, bayWidth * 1.6)}px`
    if (vega.expanded !== expanded) {
        vega.expanded = expanded
        vega.tag.style.zIndex = expanded ? "1" : ""
        vega.tag.querySelector("strong")!.textContent = expanded ? `${vega.worker.callsign} · ${vega.worker.title}` : vega.worker.callsign
        const caption = vega.tag.querySelector("span")!
        caption.textContent = vega.worker.caption
        caption.hidden = !expanded
    }
}
