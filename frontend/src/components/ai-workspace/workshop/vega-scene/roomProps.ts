import * as THREE from "three"
import { WALL_MARGIN } from "./constants"
import { box, material } from "./materials"
import { flicker, sparkCloud } from "./sparks"
import type { RoomAnimation } from "./types"

/** The materials the furniture of the room shares */
export interface RoomMaterials {
    frame: THREE.MeshStandardMaterial
    steel: THREE.MeshStandardMaterial
    orange: THREE.MeshStandardMaterial
    charcoal: THREE.MeshStandardMaterial
}

/** Puts an object in the room at a spot, casting shadows unless told otherwise */
export type Place = <T extends THREE.Object3D>(object: T, x: number, y: number, z: number, shadow?: boolean) => T

/** The colours of the LEDs of the rack, parsed once instead of on every frame for each LED */
const LED_ON = new THREE.Color("#4fd1e8")
const LED_GREEN = new THREE.Color("#a6cf7e")
const LED_OFF = new THREE.Color("#16384a")

/** A tool of the workshop, made of a few boxes and cylinders */
const handTool = (kind: "wrench" | "hammer" | "screwdriver" | "pliers", { steel, orange, charcoal }: RoomMaterials) => {
    const tool = new THREE.Group()
    if (kind === "wrench") {
        const shaft = box(0.08, 0.7, 0.04, steel)
        tool.add(shaft)
        const head = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.035, 8, 16, Math.PI * 1.5), steel)
        head.position.y = 0.38
        tool.add(head)
    } else if (kind === "hammer") {
        tool.add(box(0.07, 0.6, 0.05, orange))
        const head = box(0.34, 0.12, 0.1, steel)
        head.position.y = 0.32
        tool.add(head)
    } else if (kind === "screwdriver") {
        const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.28, 10), orange)
        tool.add(grip)
        const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 8), steel)
        blade.position.y = 0.34
        tool.add(blade)
    } else {
        for (const side of [-1, 1]) {
            const arm = box(0.05, 0.5, 0.04, charcoal)
            arm.position.x = side * 0.06
            arm.rotation.z = side * 0.18
            tool.add(arm)
        }
        const jaw = box(0.12, 0.18, 0.05, steel)
        jaw.position.y = 0.32
        tool.add(jaw)
    }
    return tool
}

/** A pegboard of tools, hung between the windows */
export const toolBoard = (materials: RoomMaterials) => {
    const board = new THREE.Group()
    board.add(box(2.6, 1.4, 0.06, "#2f4959"))
    const kinds = ["wrench", "hammer", "screwdriver", "pliers", "wrench", "screwdriver"] as const
    kinds.forEach((kind, index) => {
        const tool = handTool(kind, materials)
        tool.position.set(-1.05 + index * 0.42, -0.15, 0.06)
        tool.rotation.z = index % 2 ? 0.08 : -0.08
        board.add(tool)
    })
    return board
}

/** A workbench with its drawers, its vise and its tools */
export const workbench = (materials: RoomMaterials) => {
    const { frame, steel, orange } = materials
    const bench = new THREE.Group()
    const benchTop = box(2.4, 0.14, 0.95, "#486172")
    benchTop.position.y = 0.95
    bench.add(benchTop)
    for (const [x, z] of [
        [-1.1, -0.38],
        [1.1, -0.38],
        [-1.1, 0.38],
        [1.1, 0.38]
    ]) {
        const leg = box(0.1, 0.9, 0.1, frame)
        leg.position.set(x, 0.45, z)
        bench.add(leg)
    }
    const drawers = box(0.8, 0.6, 0.85, "#233d4d")
    drawers.position.set(0.7, 0.55, 0)
    bench.add(drawers)
    for (const y of [0.42, 0.62, 0.8]) {
        const handle = box(0.3, 0.04, 0.04, orange)
        handle.position.set(0.7, y, 0.45)
        bench.add(handle)
    }
    const vise = box(0.36, 0.28, 0.3, steel)
    vise.position.set(-0.85, 1.16, 0.2)
    bench.add(vise)
    for (const [kind, x, rotation] of [
        ["wrench", -0.2, 1.4],
        ["screwdriver", 0.25, -1.2],
        ["hammer", 0.75, 1.6]
    ] as const) {
        const tool = handTool(kind, materials)
        tool.rotation.set(-Math.PI / 2, 0, rotation)
        tool.position.set(x, 1.05, 0.05)
        bench.add(tool)
    }
    return bench
}

/** Shelves of spare parts */
export const shelves = ({ frame, steel, orange, charcoal }: RoomMaterials) => {
    const group = new THREE.Group()
    for (const x of [-0.9, 0.9]) {
        const upright = box(0.08, 2.8, 0.6, frame)
        upright.position.set(x, 1.4, 0)
        group.add(upright)
    }
    const parts = [orange, steel, material("#8eb8a9"), material("#fcca46"), charcoal]
    for (const [level, y] of [0.5, 1.4, 2.3].entries()) {
        const board = box(1.9, 0.07, 0.6, "#2f4959")
        board.position.y = y
        group.add(board)
        for (let slot = 0; slot < 4; slot++) {
            const used = parts[(level * 2 + slot) % parts.length]
            const part = slot % 2 ? new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.32, 12), used) : box(0.32, 0.26, 0.32, used)
            part.position.set(-0.65 + slot * 0.43, y + 0.18, 0)
            group.add(part)
        }
    }
    return group
}

/** A server rack, its LEDs blinking */
export const serverRack = () => {
    const rack = new THREE.Group()
    rack.add(box(1, 2.6, 0.8, "#0f2633"))
    rack.children[0].position.y = 1.3
    const leds: THREE.MeshBasicMaterial[] = []
    for (let row = 0; row < 8; row++) {
        const unit = box(0.86, 0.22, 0.04, "#233d4d")
        unit.position.set(0, 0.35 + row * 0.29, 0.41)
        rack.add(unit)
        for (let column = 0; column < 3; column++) {
            const led = new THREE.MeshBasicMaterial({ color: "#4fd1e8" })
            leds.push(led)
            const dot = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), led)
            dot.position.set(0.25 + column * 0.1, 0.35 + row * 0.29, 0.44)
            rack.add(dot)
        }
    }
    const animate: RoomAnimation = time => {
        leds.forEach((led, index) => {
            const on = Math.sin(time * (2 + (index % 5)) + index * 1.7) > 0.1
            led.color.copy(on ? (index % 7 === 0 ? LED_GREEN : LED_ON) : LED_OFF)
        })
    }
    return { rack, animate }
}

/** A welding arm, turning to its work and spitting sparks */
export const weldingArm = ({ steel, orange }: RoomMaterials) => {
    const arm = new THREE.Group()
    const armBase = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.4, 20), orange)
    armBase.position.y = 0.2
    arm.add(armBase)
    const shoulder = new THREE.Group()
    shoulder.position.y = 0.4
    arm.add(shoulder)
    const upper = box(0.26, 1.5, 0.26, orange)
    upper.position.y = 0.75
    shoulder.add(upper)
    const elbow = new THREE.Group()
    elbow.position.y = 1.5
    shoulder.add(elbow)
    const fore = box(0.2, 1.1, 0.2, "#fcca46")
    fore.position.y = 0.55
    elbow.add(fore)
    const torch = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 10), steel)
    torch.position.y = 1.2
    torch.rotation.x = Math.PI
    elbow.add(torch)
    const arcLight = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: "#c9f6ff" }))
    arcLight.position.y = 1.05
    elbow.add(arcLight)
    const sparks = sparkCloud()
    sparks.position.y = 1.05
    elbow.add(sparks)
    const animate: RoomAnimation = (time, motion) => {
        shoulder.rotation.y = Math.sin(time * 0.6) * 0.9 * motion
        shoulder.rotation.z = 0.35 + Math.sin(time * 0.9) * 0.15 * motion
        elbow.rotation.z = 1.4 + Math.sin(time * 1.3) * 0.25 * motion
        const welding = Math.sin(time * 1.3) > 0.2
        arcLight.visible = welding
        flicker(sparks, welding && motion > 0)
    }
    return { arm, animate }
}

/** Along the side wall: barrels, traffic cones, a spare Vega shell on its stand */
export const placeSideWallProps = (place: Place, { frame, orange, charcoal }: RoomMaterials, left: number, back: number, depth: number) => {
    for (const [index, z] of [back + WALL_MARGIN + 1, back + WALL_MARGIN + 1.8].entries()) {
        const barrel = new THREE.Group()
        barrel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.2, 20), index ? material("#5fae95") : orange))
        for (const y of [-0.35, 0.35]) {
            const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 24), charcoal)
            hoop.rotation.x = Math.PI / 2
            hoop.position.y = y
            barrel.add(hoop)
        }
        place(barrel, left + 0.9, 0.6, z)
    }
    for (const [x, z] of [
        [left + 1.9, depth / 2 - 0.8],
        [left + 2.4, depth / 2 - 1.3],
        [left + 2.9, depth / 2 - 0.7]
    ]) {
        const cone = new THREE.Group()
        cone.add(new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 16), orange))
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.1, 16), material("#f3eee4"))
        band.position.y = 0.05
        cone.add(band)
        const foot = box(0.5, 0.06, 0.5, charcoal)
        foot.position.y = -0.28
        cone.add(foot)
        place(cone, x, 0.33, z)
    }
    const spare = new THREE.Group()
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.3, 1, 12), frame)
    stand.position.y = 0.5
    spare.add(stand)
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.75, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.62), material("#fe7f2d", { side: THREE.DoubleSide }))
    shell.position.y = 1.55
    shell.rotation.z = 0.5
    spare.add(shell)
    place(spare, left + 1, 0, back + WALL_MARGIN + 3.2)
}
