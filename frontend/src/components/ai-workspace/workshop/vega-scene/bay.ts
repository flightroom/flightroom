import * as THREE from "three"
import { TILE } from "./constants"
import { material } from "./materials"

/** A bay: its deck plate with the marks of the pad, the pad, and a console that lights up with its Vega */
export const makeBay = (root: THREE.Group) => {
    const outline = new THREE.MeshBasicMaterial({ color: "#2f4959" })
    for (const [w, d, x, z] of [
        [TILE - 0.5, 0.06, 0, -(TILE - 0.5) / 2],
        [TILE - 0.5, 0.06, 0, (TILE - 0.5) / 2],
        [0.06, TILE - 0.5, -(TILE - 0.5) / 2, 0],
        [0.06, TILE - 0.5, (TILE - 0.5) / 2, 0]
    ]) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), outline)
        line.position.set(x, 0.01, z)
        root.add(line)
    }
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.45, 0.24, 6), material("#2f4959", { roughness: 0.55, metalness: 0.5 }))
    pad.position.y = 0.12
    pad.receiveShadow = true
    pad.castShadow = true
    root.add(pad)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.05, 8, 6), new THREE.MeshBasicMaterial({ color: "#fcca46" }))
    ring.rotation.x = Math.PI / 2
    ring.rotation.z = Math.PI / 6
    ring.position.y = 0.26
    root.add(ring)

    // The console at the back corner of the bay, its screen in the colour of the Vega's state
    const console = new THREE.Group()
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1, 0.5), material("#233d4d", { metalness: 0.4, roughness: 0.6 }))
    base.position.y = 0.5
    base.castShadow = true
    console.add(base)
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.08, 0.6), material("#2f4959"))
    top.position.set(0, 1.05, 0.04)
    top.rotation.x = 0.5
    console.add(top)
    const screen = new THREE.MeshBasicMaterial({ color: "#4fd1e8" })
    const display = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.38), screen)
    display.position.set(0, 1.1, 0.08)
    display.rotation.x = -Math.PI / 2 + 0.5
    console.add(display)
    console.position.set(-TILE / 2 + 0.75, 0, -TILE / 2 + 0.6)
    console.rotation.y = Math.PI / 4
    root.add(console)

    // A tool cart at the other back corner: drawers, wheels, a wrench and a can of oil on top
    const cart = new THREE.Group()
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.55), material("#233d4d", { metalness: 0.4, roughness: 0.55 }))
    chest.position.y = 0.55
    chest.castShadow = true
    cart.add(chest)
    const handleMaterial = material("#fe7f2d")
    for (const y of [0.35, 0.58, 0.8]) {
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.04), handleMaterial)
        handle.position.set(0, y, 0.29)
        cart.add(handle)
    }
    for (const [x, z] of [
        [-0.33, -0.2],
        [0.33, -0.2],
        [-0.33, 0.2],
        [0.33, 0.2]
    ]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 10), material("#1b2433"))
        wheel.rotation.x = Math.PI / 2
        wheel.position.set(x, 0.08, z)
        cart.add(wheel)
    }
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.26, 12), material("#5fae95"))
    can.position.set(0.22, 1.08, 0)
    cart.add(can)
    const spanner = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.07), material("#c7d0d9", { metalness: 0.75, roughness: 0.3 }))
    spanner.position.set(-0.12, 0.97, 0.05)
    spanner.rotation.y = 0.4
    cart.add(spanner)
    cart.position.set(TILE / 2 - 0.75, 0, -TILE / 2 + 0.6)
    cart.rotation.y = -Math.PI / 4
    root.add(cart)
    return { ring, screen }
}
