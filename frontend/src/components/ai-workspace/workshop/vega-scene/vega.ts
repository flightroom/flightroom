import * as THREE from "three"
import { makeBay } from "./bay"
import { CYAN, LIVERIES } from "./constants"
import { beamBetween, material } from "./materials"
import { sparkCloud } from "./sparks"
import type { Vega, WorkshopWorker } from "./types"

/**
 * A Vega in its bay, born facing the camera, and its plate in the container: the caller puts its root among the bays.
 * The tools it holds, the flame, the thinking dots and the smoke are all there, hidden until its mood shows them.
 */
export const makeVega = (worker: WorkshopWorker, azimuth: number, container: HTMLElement): Vega => {
    const colors = LIVERIES[worker.livery % LIVERIES.length]
    const root = new THREE.Group()
    root.userData.workerId = worker.id
    const { ring, screen } = makeBay(root)
    const hover = new THREE.Group()
    hover.position.y = 1.75
    // Born facing the camera: from behind, turning round would take a while
    hover.rotation.y = azimuth
    root.add(hover)

    const bodyMaterial = material(colors[1])
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), bodyMaterial)
    body.scale.set(1.15, 1, 1)
    body.castShadow = true
    hover.add(body)
    const shine = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: colors[0], transparent: true, opacity: 0.35 }))
    shine.scale.set(0.45, 0.16, 0.3)
    shine.position.set(-0.1, 0.82, 0.25)
    hover.add(shine)
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.62, 40, 24), material("#1b2433", { roughness: 0.18, metalness: 0.35 }))
    visor.scale.set(1.08, 0.86, 0.5)
    visor.position.set(-0.04, 0.02, 0.74)
    hover.add(visor)

    const eyeMaterial = new THREE.MeshBasicMaterial({ color: CYAN })
    const eyes = [-0.19, 0.17].map(x => {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 12), eyeMaterial)
        eye.position.set(x, 0.03, 1.04)
        hover.add(eye)
        return eye
    })
    const arcs = [-0.19, 0.17].map(x => {
        const arc = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.026, 8, 20, Math.PI), eyeMaterial)
        arc.position.set(x, 0, 1.05)
        hover.add(arc)
        return arc
    })

    const finMaterial = material("#f3eee6", { roughness: 0.55 })
    const fins = [-1, 1].map(side => {
        const pivot = new THREE.Group()
        pivot.position.set(side * 0.98, -0.02, -0.05)
        // Short enough to stay inside its bay, next to the fins of the neighbours
        const fin = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), finMaterial)
        fin.scale.set(0.42, 0.09, 0.26)
        fin.position.x = side * 0.36
        fin.castShadow = true
        pivot.add(fin)
        hover.add(pivot)
        return { pivot, side }
    })
    const thruster = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 12), new THREE.MeshBasicMaterial({ color: "#c9f6ff", transparent: true, opacity: 0.9 }))
    thruster.scale.set(1, 0.45, 1)
    thruster.position.y = -0.98
    hover.add(thruster)
    const glow = new THREE.PointLight("#4fd1e8", 2, 3.5)
    glow.position.y = -1.2
    hover.add(glow)

    // The tools, each held by the cyan beam: it has no hands
    const beamMaterial = new THREE.MeshBasicMaterial({ color: "#4fd1e8", transparent: true, opacity: 0.28, depthWrite: false })
    const lens = new THREE.Group()
    lens.add(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 12, 40), material("#f3eee6")))
    lens.add(new THREE.Mesh(new THREE.CircleGeometry(0.29, 32), new THREE.MeshBasicMaterial({ color: "#4fd1e8", transparent: true, opacity: 0.22 })))
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.5, 12), material("#1b2433"))
    handle.position.set(0.33, -0.33, 0)
    handle.rotation.z = Math.PI / 4
    lens.add(handle)
    lens.position.set(0.17, 0.03, 1.32)
    hover.add(lens)

    const steel = material("#c7d0d9", { metalness: 0.7, roughness: 0.3 })
    const wrench = new THREE.Group()
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 12), steel)
    shaft.rotation.z = Math.PI / 2
    wrench.add(shaft)
    const jaw = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.06, 10, 24, Math.PI * 1.55), steel)
    jaw.position.x = -0.55
    jaw.rotation.z = Math.PI * 0.22
    wrench.add(jaw)
    const wrenchAt = new THREE.Vector3(1.45, 1.05, 0.5)
    wrench.position.copy(wrenchAt)
    const working = new THREE.Group()
    working.add(wrench, beamBetween(new THREE.Vector3(0.45, 0.3, 0.95), wrenchAt, 0.03, beamMaterial))
    hover.add(working)

    const codeCanvas = document.createElement("canvas")
    codeCanvas.width = 256
    codeCanvas.height = 170
    const codeTexture = new THREE.CanvasTexture(codeCanvas)
    codeTexture.colorSpace = THREE.SRGBColorSpace
    const display = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.8), new THREE.MeshBasicMaterial({ map: codeTexture, transparent: true, side: THREE.DoubleSide }))
    display.position.set(1.5, 1.25, 0.3)
    display.rotation.y = -0.45
    const coding = new THREE.Group()
    coding.add(display, beamBetween(new THREE.Vector3(0.45, 0.3, 0.95), new THREE.Vector3(1.25, 1, 0.45), 0.03, beamMaterial))
    hover.add(coding)

    const flame = new THREE.Group()
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.1, 20), new THREE.MeshBasicMaterial({ color: "#fe7f2d", transparent: true, opacity: 0.85 }))
    outer.rotation.x = Math.PI
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.7, 16), new THREE.MeshBasicMaterial({ color: "#c9f6ff" }))
    inner.rotation.x = Math.PI
    inner.position.y = 0.15
    flame.add(outer, inner)
    flame.position.y = -1.6
    hover.add(flame)

    const dots = [0, 1, 2].map(index => {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), eyeMaterial)
        dot.position.set((index - 1) * 0.22, 1.35, 0.2)
        hover.add(dot)
        return dot
    })
    // Sparks where the wrench bites, smoke over a Vega that failed
    const sparks = sparkCloud()
    sparks.position.set(wrenchAt.x - 0.55, wrenchAt.y, wrenchAt.z)
    working.add(sparks)
    const smoke = [0, 1, 2].map(() => {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), new THREE.MeshBasicMaterial({ color: "#6f8899", transparent: true, opacity: 0.5, depthWrite: false }))
        hover.add(puff)
        return puff
    })

    const tag = document.createElement("div")
    tag.className = "pointer-events-none absolute left-0 top-0 flex -translate-x-1/2 -translate-y-full flex-col items-center gap-0.5 text-center text-xs text-[#f3eee4]"
    const name = document.createElement("strong")
    name.className = "max-w-full truncate rounded-md border border-[#2f4959] bg-[#04121a]/80 px-2 py-0.5 font-mono font-medium"
    const caption = document.createElement("span")
    caption.className = "max-w-full truncate rounded bg-[#04121a]/60 px-1.5 text-[#9db2c0]"
    tag.append(name, caption)
    container.appendChild(tag)

    return {
        worker,
        root,
        hover,
        bodyMaterial,
        base: new THREE.Color(colors[1]),
        eyes,
        arcs,
        eyeMaterial,
        fins,
        thruster,
        glow,
        lens,
        working,
        wrench,
        coding,
        codeCanvas,
        codeTexture,
        flame,
        dots,
        sparks,
        smoke,
        tilt: 0,
        facing: azimuth,
        ring,
        screen,
        liftoff: 0,
        tag
    }
}
