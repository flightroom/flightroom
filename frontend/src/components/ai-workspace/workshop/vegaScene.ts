import * as THREE from "three"
import { animateDepartures, placeTag, poseVega } from "./vega-scene/animate"
import { type CameraView, frameRoom, sameView } from "./vega-scene/camera"
import { AZIMUTH, ELEVATION, MAX_COLUMNS, OPEN_MARGIN, ROAM_SPEEDS, TILE, WALL_MARGIN } from "./vega-scene/constants"
import { disposeTree } from "./vega-scene/materials"
import { freeSpot, roamAll } from "./vega-scene/roam"
import { buildRoom } from "./vega-scene/room"
import { buildSpace } from "./vega-scene/space"
import type { Departure, Leaving, RoomAnimation, Vega, Wall, WorkshopWorker } from "./vega-scene/types"
import { makeVega } from "./vega-scene/vega"

// Scratch vectors for the width of a bay on screen, reused on every frame
const bayFrom = new THREE.Vector3()
const bayTo = new THREE.Vector3()

/**
 * The 3D workshop of Edit with AI, seen in isometric view: a room floating in space with two walls of windows on the
 * stars, a gantry crane, pipes, crates and fuel canisters, and a bay per work on a grid of deck plates. In each bay a
 * Vega whose pose says what its work is doing, next to a console that lights up with it. While the agent is not on its
 * work, waiting, thinking, with a proposal ready or failed, the Vega roams the open deck. Plain three.js, kept out of
 * React: the component hands it the workers and takes back the one picked.
 */
export class VegaScene {
    private readonly renderer: THREE.WebGLRenderer
    private readonly scene = new THREE.Scene()
    private readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400)
    private readonly clock = new THREE.Clock()
    private readonly raycaster = new THREE.Raycaster()
    private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    private readonly bays = new THREE.Group()
    private readonly key = new THREE.DirectionalLight("#fff4e6", 2.4)
    private readonly resizeObserver: ResizeObserver
    private readonly intersectionObserver: IntersectionObserver
    private room = new THREE.Group()
    private roomSize = { width: 0, depth: 0 }
    /** Built with the room, which the constructor lays out before the first frame */
    private trolley!: THREE.Group
    private walls: Wall[] = []
    private vegas: Vega[] = []
    /** The Vegas on their way out, removed once their departure is over */
    private leaving: Leaving[] = []
    private selectedId?: string
    private hoveredId?: string
    /** What moves in the room by itself: the LEDs of the rack, the welding arm */
    private animations: RoomAnimation[] = []
    private frame = 0
    /** The time of the last frame drawn: the Vegas on their way move by how long it has been */
    private lastTime = 0
    private visible = true
    /** Where the camera stands: all the way round, from low over the deck to almost overhead, and how close */
    private azimuth = AZIMUTH
    private elevation = ELEVATION
    private zoom = 1
    private drag?: { x: number; y: number; azimuth: number; elevation: number; moved: boolean }
    /** The view the camera was last framed for: framed again only once the camera turns, zooms, or the room or the box changes */
    private framed?: CameraView
    private disposed = false

    constructor(
        private readonly container: HTMLElement,
        private readonly onPick: (id: string) => void
    ) {
        // Throws without WebGL: the component catches it and says so
        this.renderer = new THREE.WebGLRenderer({ antialias: true })
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        this.renderer.shadowMap.enabled = true
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
        // As big as the box it sits in: the drawing buffer is larger on a retina screen, and left to itself the canvas would show at that size
        Object.assign(this.renderer.domElement.style, { display: "block", width: "100%", height: "100%" })
        this.renderer.domElement.setAttribute("aria-hidden", "true")
        container.prepend(this.renderer.domElement)
        buildSpace(this.scene, this.key)
        this.scene.add(this.room, this.bays)
        this.layout()

        // The camera turns on both axes: a touch on the room drags it instead of scrolling the page
        this.renderer.domElement.style.touchAction = "none"
        this.renderer.domElement.addEventListener("pointerdown", this.pointerDown)
        this.renderer.domElement.addEventListener("wheel", this.wheel, { passive: false })
        window.addEventListener("pointermove", this.pointerMove)
        window.addEventListener("pointerup", this.pointerUp)
        this.resizeObserver = new ResizeObserver(() => this.resize())
        this.resizeObserver.observe(container)
        // Nothing is drawn while the workshop is out of sight or the tab hidden
        this.intersectionObserver = new IntersectionObserver(entries => {
            this.visible = entries[0]?.isIntersecting ?? true
        })
        this.intersectionObserver.observe(container)
        this.resize()
        this.loop()
    }

    /** The works in the workshop now; the Vegas of the others leave as their departure says, fading away when it says nothing */
    setWorkers(workers: WorkshopWorker[], departures: Record<string, Departure> = {}) {
        const known = new Map(this.vegas.map(vega => [vega.worker.id, vega]))
        const next = workers.map(worker => {
            const vega = known.get(worker.id)
            if (vega && vega.worker.livery === worker.livery) {
                vega.worker = worker
                known.delete(worker.id)
                return vega
            }
            const made = makeVega(worker, this.azimuth, this.container)
            this.bays.add(made.root)
            return made
        })
        for (const gone of known.values()) {
            gone.tag.remove()
            if (this.reducedMotion) this.removeVega(gone)
            else this.leaving.push({ vega: gone, departure: departures[gone.worker.id] ?? "fade", since: this.clock.getElapsedTime() })
        }
        this.vegas = next
        // The loop writes the plates again with the new title and caption
        for (const vega of this.vegas) vega.expanded = undefined
        this.layout()
    }

    setSelected(id?: string) {
        this.selectedId = id
    }

    dispose() {
        // A second call would lose a context already lost
        if (this.disposed) return
        this.disposed = true
        cancelAnimationFrame(this.frame)
        this.resizeObserver.disconnect()
        this.intersectionObserver.disconnect()
        this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown)
        this.renderer.domElement.removeEventListener("wheel", this.wheel)
        window.removeEventListener("pointermove", this.pointerMove)
        window.removeEventListener("pointerup", this.pointerUp)
        for (const vega of this.vegas) vega.tag.remove()
        disposeTree(this.scene)
        // The shadow map of the key light is a render target of its own, which disposing the renderer leaves on the GPU
        this.key.dispose()
        this.renderer.dispose()
        // Give the WebGL context back now rather than whenever it is collected: browsers keep only a few alive at once
        this.renderer.forceContextLoss()
        this.renderer.domElement.remove()
    }

    private removeVega(vega: Vega) {
        this.bays.remove(vega.root)
        vega.tag.remove()
        disposeTree(vega.root)
    }

    /** The grid of bays, four to a row, and a room around it that fits them with an open deck to roam: past four Vegas it grows a row */
    private layout() {
        const columns = MAX_COLUMNS
        const rows = Math.max(1, Math.ceil(this.vegas.length / columns))
        const width = WALL_MARGIN + columns * TILE + OPEN_MARGIN
        const depth = WALL_MARGIN + rows * TILE + OPEN_MARGIN
        const resized = width !== this.roomSize.width || depth !== this.roomSize.depth
        if (resized) {
            this.roomSize = { width, depth }
            this.scene.remove(this.room)
            disposeTree(this.room)
            const room = buildRoom(this.key, width, depth)
            this.room = room.room
            this.scene.add(this.room)
            this.walls = room.walls
            this.trolley = room.trolley
            this.animations = room.animations
            // New walls: frame the camera again and set which of them stand
            this.framed = undefined
        }
        this.vegas.forEach((vega, index) => {
            const column = index % columns
            const row = Math.floor(index / columns)
            vega.root.position.set(-width / 2 + WALL_MARGIN + TILE * (column + 0.5), 0, -depth / 2 + WALL_MARGIN + TILE * (row + 0.5))
        })
        // In a room grown or shrunk, the Vegas on their way pick a spot of the new deck
        if (resized)
            for (const vega of this.vegas)
                if (vega.roam && ROAM_SPEEDS[vega.worker.mood] !== undefined) {
                    vega.roam.target = freeSpot(vega, this.vegas, this.roomSize)
                    vega.roam.restUntil = undefined
                }
        this.resize()
    }

    private resize() {
        const width = this.container.clientWidth
        const height = this.container.clientHeight
        if (!width || !height) return
        this.renderer.setSize(width, height, false)
        this.fit()
    }

    /** Frames the room again, only when the view changed since the last time */
    private fit() {
        const view: CameraView = {
            azimuth: this.azimuth,
            elevation: this.elevation,
            zoom: this.zoom,
            aspect: this.container.clientWidth / Math.max(1, this.container.clientHeight),
            roomSize: this.roomSize
        }
        if (this.framed && sameView(this.framed, view)) return
        // A copy of the room size: a size changed in place still frames the camera again
        this.framed = { ...view, roomSize: { ...view.roomSize } }
        frameRoom(this.camera, this.walls, view)
    }

    private pointerDown = (event: PointerEvent) => {
        this.drag = { x: event.clientX, y: event.clientY, azimuth: this.azimuth, elevation: this.elevation, moved: false }
        this.renderer.domElement.setPointerCapture(event.pointerId)
    }

    /** Sideways turns the room all the way round, up and down tilts the camera */
    private pointerMove = (event: PointerEvent) => {
        if (!this.drag) {
            if (event.target !== this.renderer.domElement) {
                this.hoveredId = undefined
                return
            }
            this.hoveredId = this.workerAt(event)
            this.renderer.domElement.style.cursor = this.hoveredId ? "pointer" : ""
            return
        }
        const dx = event.clientX - this.drag.x
        const dy = event.clientY - this.drag.y
        if (Math.hypot(dx, dy) > 4) this.drag.moved = true
        this.azimuth = this.drag.azimuth - dx / 220
        this.elevation = THREE.MathUtils.clamp(this.drag.elevation + dy / 300, 0.18, 1.35)
    }

    /** A pinch on a trackpad, or the wheel with Ctrl or Cmd, zooms; the plain wheel still scrolls the page */
    private wheel = (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(-event.deltaY / 300), 0.7, 3)
    }

    /** A click that did not turn the camera opens the work of the Vega under it */
    private pointerUp = (event: PointerEvent) => {
        const drag = this.drag
        this.drag = undefined
        if (!drag || drag.moved || event.target !== this.renderer.domElement) return
        const id = this.workerAt(event)
        if (id) this.onPick(id)
    }

    /** The work of the Vega or the bay under the pointer, if any */
    private workerAt(event: PointerEvent): string | undefined {
        const rect = this.renderer.domElement.getBoundingClientRect()
        const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
        this.raycaster.setFromCamera(pointer, this.camera)
        const hit = this.raycaster.intersectObjects(this.bays.children, true)[0]
        let object: THREE.Object3D | null = hit?.object ?? null
        while (object && !object.userData.workerId) object = object.parent
        return object?.userData.workerId as string | undefined
    }

    private loop = () => {
        this.frame = requestAnimationFrame(this.loop)
        if (!this.visible || document.hidden) return
        const time = this.clock.getElapsedTime()
        const motion = this.reducedMotion ? 0 : 1
        // Never a long leap: back from a hidden tab the Vegas go on from where they were
        const delta = Math.min(0.1, time - this.lastTime)
        this.lastTime = time
        if (motion) roamAll(this.vegas, this.roomSize, time, delta)
        this.fit()
        this.trolley.position.x = Math.sin(time * 0.25) * (this.roomSize.width / 2 - 2) * motion
        for (const animate of this.animations) animate(time, motion)

        const width = this.container.clientWidth
        const height = this.container.clientHeight
        const from = bayFrom.set(0, 0, 0).project(this.camera)
        const to = bayTo.set(TILE, 0, 0).project(this.camera)
        const bayWidth = Math.hypot((to.x - from.x) * width, (to.y - from.y) * height) / 2
        this.leaving = animateDepartures(this.leaving, time, vega => this.removeVega(vega))
        const pose = { time, motion, reducedMotion: this.reducedMotion, azimuth: this.azimuth }
        this.vegas.forEach((vega, index) => {
            const selected = vega.worker.id === this.selectedId
            poseVega(vega, index, selected, pose)
            placeTag(vega, this.camera, width, height, bayWidth, selected || vega.worker.id === this.hoveredId)
        })
        this.renderer.render(this.scene, this.camera)
    }
}
