import * as THREE from "three"
import { PERSONAL_SPACE, RETURN_SPEED, ROAM_SPEEDS, WALL_MARGIN } from "./constants"
import type { RoomSize, Vega } from "./types"

// Scratch vectors, reused on every frame instead of allocated for every Vega and every pair of them
const home = new THREE.Vector2()
const way = new THREE.Vector2()
const apart = new THREE.Vector2()

/** A spot of the open deck, clear of the furniture along the walls, and as far as it can be from where the other Vegas are and go */
export const freeSpot = (vega: Vega, vegas: Vega[], { width, depth }: RoomSize) => {
    const taken = vegas.filter(other => other !== vega && other.roam).flatMap(other => [other.roam!.at, other.roam!.target])
    let best = new THREE.Vector2()
    let bestClearance = -1
    for (let attempt = 0; attempt < 12; attempt++) {
        const spot = new THREE.Vector2(THREE.MathUtils.lerp(-width / 2 + 3.6, width / 2 - 2.4, Math.random()), THREE.MathUtils.lerp(-depth / 2 + WALL_MARGIN + 0.8, depth / 2 - 1.6, Math.random()))
        const clearance = Math.min(Infinity, ...taken.map(other => other.distanceTo(spot)))
        if (clearance > PERSONAL_SPACE * 1.5) return spot
        if (clearance > bestClearance) {
            best = spot
            bestClearance = clearance
        }
    }
    return best
}

/** Off duty a Vega roams the open deck, resting a while at every spot; once its work starts again it flies home to its bay */
export const roamAll = (vegas: Vega[], roomSize: RoomSize, time: number, delta: number) => {
    for (const vega of vegas) {
        home.set(vega.root.position.x, vega.root.position.z)
        vega.roam ??= { at: home.clone(), target: home.clone(), pace: 0 }
        const roam = vega.roam
        const speed = ROAM_SPEEDS[vega.worker.mood]
        if (speed === undefined) {
            roam.target.copy(home)
            roam.restUntil = undefined
        }
        way.subVectors(roam.target, roam.at)
        const distance = way.length()
        if (distance < 0.1 && speed !== undefined) {
            roam.restUntil ??= time + 1.5 + Math.random() * 3
            if (time > roam.restUntil) {
                roam.target = freeSpot(vega, vegas, roomSize)
                roam.restUntil = undefined
            }
        }
        // Speeding up off a spot, slowing down onto the next
        const wanted = distance < 0.1 ? 0 : Math.min(speed ?? RETURN_SPEED, distance * 1.5)
        roam.pace += (wanted - roam.pace) * Math.min(1, delta * 3)
        if (distance > 0.001) {
            way.divideScalar(distance)
            roam.at.addScaledVector(way, Math.min(distance, roam.pace * delta))
            if (roam.pace > 0.3) roam.heading = Math.atan2(way.x, way.y)
        }
    }
    // Two Vegas that come too close push each other aside
    for (let index = 0; index < vegas.length; index++) {
        const one = vegas[index]
        for (let next = index + 1; next < vegas.length; next++) {
            const other = vegas[next]
            if (!one.roam || !other.roam) continue
            apart.subVectors(one.roam.at, other.roam.at)
            const distance = apart.length()
            if (distance === 0 || distance >= PERSONAL_SPACE) continue
            apart.multiplyScalar(((PERSONAL_SPACE - distance) / distance) * Math.min(1, delta * 4) * 0.5)
            one.roam.at.add(apart)
            other.roam.at.sub(apart)
        }
    }
}
