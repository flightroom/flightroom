import * as THREE from "three"
import { WALL_HEIGHT } from "./constants"
import type { RoomSize, Wall } from "./types"

/** Where the camera stands and what it frames: the frame only has to be worked out again when one of these changes */
export interface CameraView {
    azimuth: number
    elevation: number
    zoom: number
    aspect: number
    roomSize: RoomSize
}

const CENTER = new THREE.Vector3(0, 1.4, 0)
// Scratch vectors, reused instead of allocated on every framing
const direction = new THREE.Vector3()
const corner = new THREE.Vector3()

export const sameView = (one: CameraView, other: CameraView) =>
    one.azimuth === other.azimuth && one.elevation === other.elevation && one.zoom === other.zoom && one.aspect === other.aspect && one.roomSize === other.roomSize

/** The orthographic frame around the whole room, walls and hull included, whatever way the camera turned */
export const frameRoom = (camera: THREE.OrthographicCamera, walls: Wall[], { azimuth, elevation, zoom, aspect, roomSize }: CameraView) => {
    direction.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation))
    // Only the walls behind the room stand: the ones between it and the camera would hide the bays
    for (const { group, normal } of walls) group.visible = normal.x * direction.x + normal.z * direction.z < 0.05
    camera.position.copy(CENTER).addScaledVector(direction, 80)
    camera.lookAt(CENTER)
    camera.updateMatrixWorld()
    const { width, depth } = roomSize
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const x of [-width / 2, width / 2])
        for (const y of [-2.6, WALL_HEIGHT + 0.5])
            for (const z of [-depth / 2, depth / 2]) {
                corner.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
                minX = Math.min(minX, corner.x)
                maxX = Math.max(maxX, corner.x)
                minY = Math.min(minY, corner.y)
                maxY = Math.max(maxY, corner.y)
            }
    // Room on top for the plates over the back row
    maxY += 1.2
    const halfHeight = (Math.max((maxY - minY) / 2, (maxX - minX) / 2 / aspect) * 1.04) / zoom
    const middleY = (maxY + minY) / 2
    const middleX = (maxX + minX) / 2
    camera.left = middleX - halfHeight * aspect
    camera.right = middleX + halfHeight * aspect
    camera.top = middleY + halfHeight
    camera.bottom = middleY - halfHeight
    camera.updateProjectionMatrix()
}
