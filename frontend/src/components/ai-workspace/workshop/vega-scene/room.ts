import * as THREE from "three"
import { WALL_HEIGHT, WALL_MARGIN } from "./constants"
import { box, deckPlates, hazard, material } from "./materials"
import { type Place, placeSideWallProps, type RoomMaterials, serverRack, shelves, toolBoard, weldingArm, workbench } from "./roomProps"
import type { RoomAnimation, Wall } from "./types"

/** Two walls of windows on the stars: a frame, mullions, and glass the stars shine through */
const wall = (length: number, along: "x" | "z", frame: THREE.Material, glass: THREE.Material) => {
    const group = new THREE.Group()
    const piece = (w: number, h: number, y: number, offset: number) => {
        const mesh = box(along === "x" ? w : 0.35, h, along === "x" ? 0.35 : w, frame)
        mesh.position.set(along === "x" ? offset : 0, y, along === "x" ? 0 : offset)
        group.add(mesh)
    }
    piece(length, 1.3, 0.65, 0)
    piece(length, 0.9, WALL_HEIGHT - 0.45, 0)
    const panes = Math.max(2, Math.round(length / 3))
    for (let index = 0; index <= panes; index++) piece(0.3, WALL_HEIGHT, WALL_HEIGHT / 2, -length / 2 + (length / panes) * index)
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(length, WALL_HEIGHT - 2.2), glass)
    pane.position.y = 1.3 + (WALL_HEIGHT - 2.2) / 2
    if (along === "z") pane.rotation.y = Math.PI / 2
    group.add(pane)
    // A strip of orange service light along the top
    const light = new THREE.Mesh(new THREE.BoxGeometry(along === "x" ? length : 0.08, 0.08, along === "x" ? 0.08 : length), new THREE.MeshBasicMaterial({ color: "#fe7f2d" }))
    light.position.set(along === "x" ? 0 : 0.2, WALL_HEIGHT - 0.95, along === "x" ? 0.2 : 0)
    group.add(light)
    return group
}

/** The pipes of a wall on their brackets, and pegboards of tools between the windows */
const furnish = (group: THREE.Group, length: number, along: "x" | "z", inward: number, materials: RoomMaterials, pipe: THREE.Material, accentPipe: THREE.Material) => {
    for (const [y, used] of [
        [1.6, pipe],
        [1.95, accentPipe]
    ] as const) {
        const run = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, length, 14), used)
        if (along === "x") run.rotation.z = Math.PI / 2
        else run.rotation.x = Math.PI / 2
        run.position.set(along === "x" ? 0 : inward * 0.4, y, along === "x" ? inward * 0.4 : 0)
        group.add(run)
    }
    for (let offset = -length / 2 + 1.5; offset < length / 2; offset += 2.5) {
        const bracket = box(along === "x" ? 0.12 : 0.3, 0.7, along === "x" ? 0.3 : 0.12, materials.frame)
        bracket.position.set(along === "x" ? offset : inward * 0.3, 1.75, along === "x" ? inward * 0.3 : offset)
        group.add(bracket)
    }
    for (let offset = -length / 2 + 3; offset < length / 2 - 1.5; offset += 6) {
        const board = toolBoard(materials)
        board.position.set(along === "x" ? offset : inward * 0.24, 3.2, along === "x" ? inward * 0.24 : offset)
        board.rotation.y = along === "x" ? (inward > 0 ? 0 : Math.PI) : inward > 0 ? Math.PI / 2 : -Math.PI / 2
        group.add(board)
    }
}

/** A gantry crane along the back wall, its trolley running up and down with a hook */
const gantryCrane = (crane: THREE.Group, width: number, left: number, frame: THREE.Material) => {
    const rail = box(width, 0.3, 0.5, frame)
    rail.position.set(0, WALL_HEIGHT + 0.15, 0.77)
    crane.add(rail)
    for (let x = left + 1; x < width / 2; x += 4) {
        const arm = box(0.25, 0.25, 0.9, frame)
        arm.position.set(x, WALL_HEIGHT - 0.1, 0.47)
        crane.add(arm)
    }
    const trolley = new THREE.Group()
    trolley.add(box(0.9, 0.4, 0.8, "#fcca46"))
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2, 6), material("#9db2c0"))
    cable.position.y = -1.2
    trolley.add(cable)
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.06, 8, 16, Math.PI * 1.4), material("#c7d0d9", { metalness: 0.8 }))
    hook.position.y = -2.4
    trolley.add(hook)
    trolley.position.set(0, WALL_HEIGHT - 0.15, 1.07)
    crane.add(trolley)
    return trolley
}

/**
 * The floor, the walls and the furniture, sized to the grid of bays the works need. Sizes the shadow of the key light to
 * the room, and hands back what the loop moves: the walls it hides, the trolley of the crane and the room's animations.
 */
export const buildRoom = (key: THREE.DirectionalLight, width: number, depth: number) => {
    const room = new THREE.Group()
    const animations: RoomAnimation[] = []
    const add: Place = (object, x, y, z, shadow = true) => {
        object.position.set(x, y, z)
        object.traverse(child => {
            if (child instanceof THREE.Mesh) {
                child.castShadow = shadow
                child.receiveShadow = true
            }
        })
        room.add(object)
        return object
    }
    const left = -width / 2
    const back = -depth / 2

    // The deck, floating in space on a thick hull with thrusters underneath
    const deck = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, depth), [
        material("#0c2533"),
        material("#0c2533"),
        new THREE.MeshStandardMaterial({ map: deckPlates([width / 2.2, depth / 2.2]), roughness: 0.75, metalness: 0.25 }),
        material("#0c2533"),
        material("#0c2533"),
        material("#0c2533")
    ])
    add(deck, 0, -0.25, 0, false)
    add(box(width - 0.6, 1.4, depth - 0.6, "#081b25"), 0, -1.2, 0, false)
    for (const [x, z] of [
        [-width / 3, -depth / 3],
        [width / 3, -depth / 3],
        [-width / 3, depth / 3],
        [width / 3, depth / 3]
    ]) {
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 0.5, 20), material("#2f4959", { metalness: 0.6 })), x, -2.1, z, false)
        add(new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 10), new THREE.MeshBasicMaterial({ color: "#4fd1e8", transparent: true, opacity: 0.7 })), x, -2.45, z, false)
    }
    // Hazard trims and a cyan light along every edge of the deck
    const stripes = new THREE.MeshStandardMaterial({ map: hazard([width / 1.2, 1]), roughness: 0.8 })
    const sideStripes = new THREE.MeshStandardMaterial({ map: hazard([depth / 1.2, 1]), roughness: 0.8 })
    const strip = new THREE.MeshBasicMaterial({ color: "#4fd1e8" })
    for (const sign of [-1, 1]) {
        add(box(width, 0.16, 0.5, stripes), 0, 0.02, sign * (depth / 2 - 0.25), false)
        const side = add(box(depth, 0.16, 0.5, sideStripes), sign * (width / 2 - 0.25), 0.02, 0, false)
        side.rotation.y = Math.PI / 2
        add(box(width, 0.06, 0.06, strip), 0, -0.45, sign * (depth / 2 + 0.02), false)
        add(box(0.06, 0.06, depth, strip), sign * (width / 2 + 0.02), -0.45, 0, false)
    }

    // Created in this order so that the materials keep their ids, which three.js sorts the opaque draws by
    const frame = material("#233d4d", { roughness: 0.6, metalness: 0.45 })
    const glass = new THREE.MeshBasicMaterial({ color: "#4fd1e8", transparent: true, opacity: 0.08, depthWrite: false })
    const materials: RoomMaterials = {
        frame,
        steel: material("#c7d0d9", { metalness: 0.75, roughness: 0.3 }),
        orange: material("#fe7f2d", { roughness: 0.5 }),
        charcoal: material("#1b2433", { roughness: 0.6 })
    }
    const pipe = material("#486172", { metalness: 0.7, roughness: 0.35 })
    const accentPipe = material("#fe7f2d", { metalness: 0.4, roughness: 0.5 })

    // A wall on every side, with its pipes on brackets: the loop shows the two behind the room, whichever way the camera turns
    const walls: Wall[] = (
        [
            [width, "x", 0, back - 0.17, new THREE.Vector3(0, 0, -1)],
            [width, "x", 0, depth / 2 + 0.17, new THREE.Vector3(0, 0, 1)],
            [depth + 0.7, "z", left - 0.17, 0, new THREE.Vector3(-1, 0, 0)],
            [depth + 0.7, "z", width / 2 + 0.17, 0, new THREE.Vector3(1, 0, 0)]
        ] as const
    ).map(([length, along, x, z, normal]) => {
        const group = wall(length, along, frame, glass)
        furnish(group, length, along, -(along === "x" ? normal.z : normal.x), materials, pipe, accentPipe)
        add(group, x, 0, z)
        return { group, normal }
    })

    const trolley = gantryCrane(walls[0].group, width, left, frame)

    // Crates in the back corner, fuel canisters along the side wall, a cable on the floor
    const crate = (size: number, x: number, y: number, z: number, color: string) => {
        const group = new THREE.Group()
        group.add(box(size, size, size, color))
        const band = box(size + 0.02, size * 0.18, size + 0.02, new THREE.MeshStandardMaterial({ map: hazard([2, 0.4]), roughness: 0.8 }))
        group.add(band)
        add(group, x, y + size / 2, z)
    }
    crate(1.2, left + 1, 0, back + 1, "#2f4959")
    crate(0.9, left + 2.2, 0, back + 0.85, "#233d4d")
    crate(0.8, left + 1.05, 1.2, back + 1.05, "#486172")
    const canister = material("#8eb8a9", { roughness: 0.5 })
    for (let index = 0; index < 3; index++) {
        const z = depth / 2 - 1.2 - index * 0.75
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.95, 18), canister), left + 0.75, 0.48, z)
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.16, 12), material("#2f4959")), left + 0.75, 1.02, z)
    }
    const cablePath = new THREE.CatmullRomCurve3([
        new THREE.Vector3(left + 0.4, 0.05, back + 2.6),
        new THREE.Vector3(left + 1.6, 0.05, back + 2.2),
        new THREE.Vector3(left + 1.4, 0.05, back + 3.6),
        new THREE.Vector3(left + 2.4, 0.05, back + 4.2)
    ])
    add(new THREE.Mesh(new THREE.TubeGeometry(cablePath, 40, 0.06, 8), material("#1b2433")), 0, 0, 0)

    // Along the back wall: a workbench with its vise and tools, shelves of spare parts, a server rack, a welding arm
    const right = width / 2
    const stripZ = back + WALL_MARGIN / 2
    add(workbench(materials), left + WALL_MARGIN + 2.2, 0, stripZ)
    add(shelves(materials), right - 4.4, 0, stripZ)
    const rack = serverRack()
    add(rack.rack, right - 1.6, 0, stripZ)
    animations.push(rack.animate)
    const arm = weldingArm(materials)
    add(arm.arm, right - 0.9, 0, back + 3.4)
    animations.push(arm.animate)

    placeSideWallProps(add, materials, left, back, depth)

    key.shadow.camera.left = -Math.max(width, depth)
    key.shadow.camera.right = Math.max(width, depth)
    key.shadow.camera.top = Math.max(width, depth)
    key.shadow.camera.bottom = -Math.max(width, depth)
    key.shadow.camera.updateProjectionMatrix()

    return { room, walls, trolley, animations }
}
