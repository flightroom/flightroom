import * as THREE from "three"

/** What a Vega is doing: the pose follows the status of its work and, while it runs, the last tool the agent called. */
export type WorkshopMood = "queued" | "thinking" | "analyzing" | "coding" | "working" | "done" | "applying" | "applied" | "failed" | "parked"

export interface WorkshopWorker {
    id: string
    /** VEGA·NN, from the id: the same work keeps its number and its colours across polls */
    callsign: string
    livery: number
    title: string
    mood: WorkshopMood
    /** Under the title: the status, or what the agent is doing */
    caption: string
}

/** The body colours of the four liveries, light to dark, from the brand scales of the design system: pumpkin, zomp, sunglow, olivine. */
export const LIVERIES = [
    ["#FFA060", "#FE7F2D", "#D9581A"],
    ["#A9DCCB", "#5FAE95", "#367C67"],
    ["#FFE08A", "#FCCA46", "#D3A312"],
    ["#C9E3A8", "#9CC46E", "#6E9A41"]
]

/** The side of the floor plate of a bay */
const TILE = 4.4
const MAX_COLUMNS = 4
/** Room left between the bays and the two walls, for the consoles, the crates and the pipes */
const WALL_MARGIN = 2.4
const OPEN_MARGIN = 1
const WALL_HEIGHT = 5.4
/** The isometric view: from the open corner of the room, a third of the way up */
const AZIMUTH = Math.PI / 4
const ELEVATION = Math.atan(1 / Math.SQRT2)
const CYAN = "#7FE6F5"

/** The light on the console of a bay, by what its Vega is doing */
const CONSOLE_COLORS: Record<WorkshopMood, string> = {
    queued: "#9db2c0",
    thinking: "#4fd1e8",
    analyzing: "#4fd1e8",
    coding: "#4fd1e8",
    working: "#4fd1e8",
    done: "#a6cf7e",
    applying: "#fe7f2d",
    applied: "#a6cf7e",
    failed: "#f26d6d",
    parked: "#486172"
}

/** A move of the moment, on top of the hovering: a slide, a hop, a roll, a lean, a spin */
interface Move {
    x: number
    z: number
    lift: number
    roll: number
    pitch: number
    spin: number
}

const STILL: Move = { x: 0, z: 0, lift: 0, roll: 0, pitch: 0, spin: 0 }

/** How far through a cycle of `period` seconds the time is, from 0 to 1 */
const phaseOf = (time: number, period: number) => (time % period) / period

/**
 * What a Vega does with its body while its work goes on. Writing code it slides between its console and its screen,
 * bouncing as it types; running a script it loops the loop with its wrench; reading the code it circles its pad bent
 * over the magnifying glass; thinking it tilts its head; with a proposal ready it hops and twirls; applying it spirals
 * up; failed, it shudders now and then.
 */
const moveOf = (mood: WorkshopMood, time: number): Move => {
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

interface Vega {
    worker: WorkshopWorker
    root: THREE.Group
    hover: THREE.Group
    bodyMaterial: THREE.MeshStandardMaterial
    base: THREE.Color
    eyes: THREE.Mesh[]
    arcs: THREE.Mesh[]
    eyeMaterial: THREE.MeshBasicMaterial
    fins: { pivot: THREE.Group; side: number }[]
    thruster: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
    glow: THREE.PointLight
    lens: THREE.Group
    working: THREE.Group
    wrench: THREE.Group
    coding: THREE.Group
    codeCanvas: HTMLCanvasElement
    codeTexture: THREE.CanvasTexture
    flame: THREE.Group
    dots: THREE.Mesh[]
    sparks: THREE.Group
    smoke: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[]
    /** Eased lean and heading, which the moves of the moment add to */
    tilt: number
    facing: number
    ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
    screen: THREE.MeshBasicMaterial
    liftoff: number
    /** Whether its plate shows title and caption: written only when it changes */
    expanded?: boolean
    tag: HTMLDivElement
}

const material = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.08, ...extra })

/** A tapered tube from one point to another: the cyan beam a Vega holds its tools with */
const beamBetween = (from: THREE.Vector3, to: THREE.Vector3, radius: number, beamMaterial: THREE.Material) => {
    const direction = new THREE.Vector3().subVectors(to, from)
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 3, direction.length(), 12, 1, true), beamMaterial)
    mesh.position.copy(from).add(direction.clone().multiplyScalar(0.5))
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
    return mesh
}

/** A texture drawn once on a canvas, repeated over a surface */
const canvasTexture = (size: number, draw: (context: CanvasRenderingContext2D) => void, repeat: [number, number] = [1, 1]) => {
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext("2d")
    if (context) draw(context)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(...repeat)
    texture.anisotropy = 4
    return texture
}

/** The deck plates: a seam on two sides and a rivet in each corner, as the maintenance bays draw them */
const deckPlates = (repeat: [number, number]) =>
    canvasTexture(
        256,
        context => {
            context.fillStyle = "#143546"
            context.fillRect(0, 0, 256, 256)
            context.fillStyle = "#183c4f"
            context.fillRect(6, 6, 244, 244)
            context.strokeStyle = "#0a2230"
            context.lineWidth = 6
            context.strokeRect(3, 3, 250, 250)
            context.fillStyle = "#2f4959"
            for (const [x, y] of [
                [20, 20],
                [236, 20],
                [20, 236],
                [236, 236]
            ]) {
                context.beginPath()
                context.arc(x, y, 5, 0, Math.PI * 2)
                context.fill()
            }
        },
        repeat
    )

/** Yellow and charcoal stripes, where the drones must not go */
const hazard = (repeat: [number, number]) =>
    canvasTexture(
        128,
        context => {
            context.fillStyle = "#0c2533"
            context.fillRect(0, 0, 128, 128)
            context.fillStyle = "#fcca46"
            for (let x = -128; x < 256; x += 64) {
                context.beginPath()
                context.moveTo(x, 128)
                context.lineTo(x + 32, 128)
                context.lineTo(x + 160, 0)
                context.lineTo(x + 128, 0)
                context.closePath()
                context.fill()
            }
        },
        repeat
    )

/**
 * The 3D workshop of Edit with AI, seen in isometric view: a room floating in space with two walls of windows on the
 * stars, a gantry crane, pipes, crates and fuel canisters, and a bay per work on a grid of deck plates. In each bay a
 * Vega whose pose says what its work is doing, next to a console that lights up with it. Plain three.js, kept out of
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
    private trolley?: THREE.Group
    private walls: { group: THREE.Group; normal: THREE.Vector3 }[] = []
    private vegas: Vega[] = []
    private selectedId?: string
    private hoveredId?: string
    /** What moves in the room by itself: the LEDs of the rack, the welding arm */
    private animations: ((time: number, motion: number) => void)[] = []
    private frame = 0
    private visible = true
    /** Where the camera stands: all the way round, from low over the deck to almost overhead, and how close */
    private azimuth = AZIMUTH
    private elevation = ELEVATION
    private zoom = 1
    private drag?: { x: number; y: number; azimuth: number; elevation: number; moved: boolean }

    constructor(
        private readonly container: HTMLElement,
        private readonly onPick: (id: string) => void
    ) {
        // Throws without WebGL: the component catches it and says so
        this.renderer = new THREE.WebGLRenderer({ antialias: true })
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        this.renderer.shadowMap.enabled = true
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
        this.renderer.domElement.style.display = "block"
        this.renderer.domElement.setAttribute("aria-hidden", "true")
        container.prepend(this.renderer.domElement)
        this.buildSpace()
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

    setWorkers(workers: WorkshopWorker[]) {
        const known = new Map(this.vegas.map(vega => [vega.worker.id, vega]))
        const next = workers.map(worker => {
            const vega = known.get(worker.id)
            if (vega && vega.worker.livery === worker.livery) {
                vega.worker = worker
                known.delete(worker.id)
                return vega
            }
            return this.makeVega(worker)
        })
        for (const gone of known.values()) this.removeVega(gone)
        this.vegas = next
        // The loop writes the plates again with the new title and caption
        for (const vega of this.vegas) vega.expanded = undefined
        this.layout()
    }

    setSelected(id?: string) {
        this.selectedId = id
    }

    dispose() {
        cancelAnimationFrame(this.frame)
        this.resizeObserver.disconnect()
        this.intersectionObserver.disconnect()
        this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown)
        this.renderer.domElement.removeEventListener("wheel", this.wheel)
        window.removeEventListener("pointermove", this.pointerMove)
        window.removeEventListener("pointerup", this.pointerUp)
        for (const vega of this.vegas) vega.tag.remove()
        VegaScene.disposeTree(this.scene)
        this.renderer.dispose()
        this.renderer.domElement.remove()
    }

    private static disposeTree(root: THREE.Object3D) {
        root.traverse(object => {
            if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
                object.geometry.dispose()
                const materials = Array.isArray(object.material) ? object.material : [object.material]
                for (const used of materials) {
                    if ("map" in used && used.map instanceof THREE.Texture) used.map.dispose()
                    used.dispose()
                }
            }
        })
    }

    /** What does not depend on the works: the stars, a planet, the lights */
    private buildSpace() {
        this.scene.background = new THREE.Color("#030e15")
        let seed = 7
        const random = () => {
            seed = (seed * 16807) % 2147483647
            return seed / 2147483647
        }
        const stars: number[] = []
        for (let index = 0; index < 1400; index++) {
            const theta = random() * Math.PI * 2
            const phi = Math.acos(random() * 2 - 1)
            stars.push(140 * Math.sin(phi) * Math.cos(theta), 140 * Math.cos(phi), 140 * Math.sin(phi) * Math.sin(theta))
        }
        const starGeometry = new THREE.BufferGeometry()
        starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(stars, 3))
        this.scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: "#f3eee4", size: 1.4, sizeAttenuation: false })))
        const planet = new THREE.Mesh(new THREE.SphereGeometry(9, 48, 32), new THREE.MeshStandardMaterial({ color: "#5fae95", roughness: 1 }))
        planet.position.set(-70, 18, -90)
        this.scene.add(planet)
        const moon = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), new THREE.MeshStandardMaterial({ color: "#d0dde6", roughness: 1 }))
        moon.position.set(-52, 30, -80)
        this.scene.add(moon)

        this.scene.add(new THREE.HemisphereLight("#cfe8ff", "#0c2533", 1.1))
        this.key.position.set(18, 26, 14)
        this.key.castShadow = true
        this.key.shadow.mapSize.set(2048, 2048)
        this.key.shadow.bias = -0.0005
        this.scene.add(this.key, this.key.target)
        const rim = new THREE.DirectionalLight("#7fb6ff", 0.8)
        rim.position.set(-20, 12, -24)
        this.scene.add(rim)
    }

    /** The floor, the walls and the furniture, sized to the grid of bays the works need */
    private buildRoom(width: number, depth: number) {
        this.scene.remove(this.room)
        VegaScene.disposeTree(this.room)
        this.animations = []
        this.room = new THREE.Group()
        this.scene.add(this.room)
        const add = <T extends THREE.Object3D>(object: T, x: number, y: number, z: number, shadow = true) => {
            object.position.set(x, y, z)
            object.traverse(child => {
                if (child instanceof THREE.Mesh) {
                    child.castShadow = shadow
                    child.receiveShadow = true
                }
            })
            this.room.add(object)
            return object
        }
        const box = (w: number, h: number, d: number, color: THREE.ColorRepresentation | THREE.Material) =>
            new THREE.Mesh(new THREE.BoxGeometry(w, h, d), color instanceof THREE.Material ? color : material(color, { roughness: 0.7, metalness: 0.3 }))
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

        // Two walls of windows on the stars: a frame, mullions, and glass the stars shine through
        const frame = material("#233d4d", { roughness: 0.6, metalness: 0.45 })
        const glass = new THREE.MeshBasicMaterial({ color: "#4fd1e8", transparent: true, opacity: 0.08, depthWrite: false })
        const wall = (length: number, along: "x" | "z") => {
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
        // The tools of the workshop, made of a few boxes and cylinders each
        const steel = material("#c7d0d9", { metalness: 0.75, roughness: 0.3 })
        const orange = material("#fe7f2d", { roughness: 0.5 })
        const charcoal = material("#1b2433", { roughness: 0.6 })
        const handTool = (kind: "wrench" | "hammer" | "screwdriver" | "pliers") => {
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
        const toolBoard = () => {
            const board = new THREE.Group()
            board.add(box(2.6, 1.4, 0.06, "#2f4959"))
            const kinds = ["wrench", "hammer", "screwdriver", "pliers", "wrench", "screwdriver"] as const
            kinds.forEach((kind, index) => {
                const tool = handTool(kind)
                tool.position.set(-1.05 + index * 0.42, -0.15, 0.06)
                tool.rotation.z = index % 2 ? 0.08 : -0.08
                board.add(tool)
            })
            return board
        }

        // A wall on every side, with its pipes on brackets: the loop shows the two behind the room, whichever way the camera turns
        const pipe = material("#486172", { metalness: 0.7, roughness: 0.35 })
        const accentPipe = material("#fe7f2d", { metalness: 0.4, roughness: 0.5 })
        const furnish = (group: THREE.Group, length: number, along: "x" | "z", inward: number) => {
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
                const bracket = box(along === "x" ? 0.12 : 0.3, 0.7, along === "x" ? 0.3 : 0.12, frame)
                bracket.position.set(along === "x" ? offset : inward * 0.3, 1.75, along === "x" ? inward * 0.3 : offset)
                group.add(bracket)
            }
            // Pegboards of tools between the windows
            for (let offset = -length / 2 + 3; offset < length / 2 - 1.5; offset += 6) {
                const board = toolBoard()
                board.position.set(along === "x" ? offset : inward * 0.24, 3.2, along === "x" ? inward * 0.24 : offset)
                board.rotation.y = along === "x" ? (inward > 0 ? 0 : Math.PI) : inward > 0 ? Math.PI / 2 : -Math.PI / 2
                group.add(board)
            }
        }
        this.walls = (
            [
                [width, "x", 0, back - 0.17, new THREE.Vector3(0, 0, -1)],
                [width, "x", 0, depth / 2 + 0.17, new THREE.Vector3(0, 0, 1)],
                [depth + 0.7, "z", left - 0.17, 0, new THREE.Vector3(-1, 0, 0)],
                [depth + 0.7, "z", width / 2 + 0.17, 0, new THREE.Vector3(1, 0, 0)]
            ] as const
        ).map(([length, along, x, z, normal]) => {
            const group = wall(length, along)
            furnish(group, length, along, -(along === "x" ? normal.z : normal.x))
            add(group, x, 0, z)
            return { group, normal }
        })

        // A gantry crane along the back wall, its trolley running up and down with a hook
        const crane = this.walls[0].group
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
        this.trolley = trolley

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
        const workbench = new THREE.Group()
        const benchTop = box(2.4, 0.14, 0.95, "#486172")
        benchTop.position.y = 0.95
        workbench.add(benchTop)
        for (const [x, z] of [
            [-1.1, -0.38],
            [1.1, -0.38],
            [-1.1, 0.38],
            [1.1, 0.38]
        ]) {
            const leg = box(0.1, 0.9, 0.1, frame)
            leg.position.set(x, 0.45, z)
            workbench.add(leg)
        }
        const drawers = box(0.8, 0.6, 0.85, "#233d4d")
        drawers.position.set(0.7, 0.55, 0)
        workbench.add(drawers)
        for (const y of [0.42, 0.62, 0.8]) {
            const handle = box(0.3, 0.04, 0.04, orange)
            handle.position.set(0.7, y, 0.45)
            workbench.add(handle)
        }
        const vise = box(0.36, 0.28, 0.3, steel)
        vise.position.set(-0.85, 1.16, 0.2)
        workbench.add(vise)
        for (const [kind, x, rotation] of [
            ["wrench", -0.2, 1.4],
            ["screwdriver", 0.25, -1.2],
            ["hammer", 0.75, 1.6]
        ] as const) {
            const tool = handTool(kind)
            tool.rotation.set(-Math.PI / 2, 0, rotation)
            tool.position.set(x, 1.05, 0.05)
            workbench.add(tool)
        }
        add(workbench, left + WALL_MARGIN + 2.2, 0, stripZ)

        const shelves = new THREE.Group()
        for (const x of [-0.9, 0.9]) {
            const upright = box(0.08, 2.8, 0.6, frame)
            upright.position.set(x, 1.4, 0)
            shelves.add(upright)
        }
        const parts = [orange, steel, material("#8eb8a9"), material("#fcca46"), charcoal]
        for (const [level, y] of [0.5, 1.4, 2.3].entries()) {
            const board = box(1.9, 0.07, 0.6, "#2f4959")
            board.position.y = y
            shelves.add(board)
            for (let slot = 0; slot < 4; slot++) {
                const used = parts[(level * 2 + slot) % parts.length]
                const part = slot % 2 ? new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.32, 12), used) : box(0.32, 0.26, 0.32, used)
                part.position.set(-0.65 + slot * 0.43, y + 0.18, 0)
                shelves.add(part)
            }
        }
        add(shelves, right - 4.4, 0, stripZ)

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
        add(rack, right - 1.6, 0, stripZ)
        this.animations.push(time => {
            leds.forEach((led, index) => {
                const on = Math.sin(time * (2 + (index % 5)) + index * 1.7) > 0.1
                led.color.set(on ? (index % 7 === 0 ? "#a6cf7e" : "#4fd1e8") : "#16384a")
            })
        })

        // A welding arm in the back corner, turning to its work and spitting sparks
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
        const sparks = this.sparkCloud()
        sparks.position.y = 1.05
        elbow.add(sparks)
        add(arm, right - 0.9, 0, back + 3.4)
        this.animations.push((time, motion) => {
            shoulder.rotation.y = Math.sin(time * 0.6) * 0.9 * motion
            shoulder.rotation.z = 0.35 + Math.sin(time * 0.9) * 0.15 * motion
            elbow.rotation.z = 1.4 + Math.sin(time * 1.3) * 0.25 * motion
            const welding = Math.sin(time * 1.3) > 0.2
            arcLight.visible = welding
            this.flicker(sparks, welding && motion > 0)
        })

        // Along the side wall: barrels, traffic cones, a spare Vega shell on its stand
        for (const [index, z] of [back + WALL_MARGIN + 1, back + WALL_MARGIN + 1.8].entries()) {
            const barrel = new THREE.Group()
            barrel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.2, 20), index ? material("#5fae95") : orange))
            for (const y of [-0.35, 0.35]) {
                const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.03, 6, 24), charcoal)
                hoop.rotation.x = Math.PI / 2
                hoop.position.y = y
                barrel.add(hoop)
            }
            add(barrel, left + 0.9, 0.6, z)
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
            add(cone, x, 0.33, z)
        }
        const spare = new THREE.Group()
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.3, 1, 12), frame)
        stand.position.y = 0.5
        spare.add(stand)
        const shell = new THREE.Mesh(new THREE.SphereGeometry(0.75, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.62), material("#fe7f2d", { side: THREE.DoubleSide }))
        shell.position.y = 1.55
        shell.rotation.z = 0.5
        spare.add(shell)
        add(spare, left + 1, 0, back + WALL_MARGIN + 3.2)

        this.key.shadow.camera.left = -Math.max(width, depth)
        this.key.shadow.camera.right = Math.max(width, depth)
        this.key.shadow.camera.top = Math.max(width, depth)
        this.key.shadow.camera.bottom = -Math.max(width, depth)
        this.key.shadow.camera.updateProjectionMatrix()
    }

    /** A bay: its deck plate with the marks of the pad, the pad, and a console that lights up with its Vega */
    private makeBay(root: THREE.Group) {
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

    /** A handful of sparks, scattered again every frame they show */
    private sparkCloud() {
        const cloud = new THREE.Group()
        const hot = new THREE.MeshBasicMaterial({ color: "#ffe08a" })
        const white = new THREE.MeshBasicMaterial({ color: "#ffffff" })
        for (let index = 0; index < 10; index++) cloud.add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), index % 3 ? hot : white))
        cloud.visible = false
        return cloud
    }

    private flicker(cloud: THREE.Group, on: boolean) {
        cloud.visible = on
        if (!on) return
        for (const spark of cloud.children) {
            spark.position.set((Math.random() - 0.5) * 0.6, (Math.random() - 0.3) * 0.5, (Math.random() - 0.5) * 0.6)
            spark.scale.setScalar(0.5 + Math.random())
        }
    }

    private makeVega(worker: WorkshopWorker): Vega {
        const colors = LIVERIES[worker.livery % LIVERIES.length]
        const root = new THREE.Group()
        root.userData.workerId = worker.id
        const { ring, screen } = this.makeBay(root)
        const hover = new THREE.Group()
        hover.position.y = 1.75
        // Born facing the camera: from behind, turning round would take a while
        hover.rotation.y = this.azimuth
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
        const sparks = this.sparkCloud()
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
        this.container.appendChild(tag)

        this.bays.add(root)
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
            facing: this.azimuth,
            ring,
            screen,
            liftoff: 0,
            tag
        }
    }

    private removeVega(vega: Vega) {
        this.bays.remove(vega.root)
        vega.tag.remove()
        VegaScene.disposeTree(vega.root)
    }

    /** The grid of bays, at most four to a row, and a room around it that fits them */
    private layout() {
        const columns = Math.min(MAX_COLUMNS, Math.max(3, this.vegas.length))
        const rows = Math.max(1, Math.ceil(this.vegas.length / columns))
        const width = WALL_MARGIN + columns * TILE + OPEN_MARGIN
        const depth = WALL_MARGIN + rows * TILE + OPEN_MARGIN
        if (width !== this.roomSize.width || depth !== this.roomSize.depth) {
            this.roomSize = { width, depth }
            this.buildRoom(width, depth)
        }
        this.vegas.forEach((vega, index) => {
            const column = index % columns
            const row = Math.floor(index / columns)
            vega.root.position.set(-width / 2 + WALL_MARGIN + TILE * (column + 0.5), 0, -depth / 2 + WALL_MARGIN + TILE * (row + 0.5))
        })
        this.resize()
    }

    private resize() {
        const width = this.container.clientWidth
        const height = this.container.clientHeight
        if (!width || !height) return
        this.renderer.setSize(width, height, false)
        this.fit()
    }

    /** The orthographic frame around the whole room, walls and hull included, whatever way the camera turned */
    private fit() {
        const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight)
        const direction = new THREE.Vector3(Math.sin(this.azimuth) * Math.cos(this.elevation), Math.sin(this.elevation), Math.cos(this.azimuth) * Math.cos(this.elevation))
        // Only the walls behind the room stand: the ones between it and the camera would hide the bays
        for (const { group, normal } of this.walls) group.visible = normal.x * direction.x + normal.z * direction.z < 0.05
        const center = new THREE.Vector3(0, 1.4, 0)
        this.camera.position.copy(center).addScaledVector(direction, 80)
        this.camera.lookAt(center)
        this.camera.updateMatrixWorld()
        const { width, depth } = this.roomSize
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        const corner = new THREE.Vector3()
        for (const x of [-width / 2, width / 2])
            for (const y of [-2.6, WALL_HEIGHT + 0.5])
                for (const z of [-depth / 2, depth / 2]) {
                    corner.set(x, y, z).applyMatrix4(this.camera.matrixWorldInverse)
                    minX = Math.min(minX, corner.x)
                    maxX = Math.max(maxX, corner.x)
                    minY = Math.min(minY, corner.y)
                    maxY = Math.max(maxY, corner.y)
                }
        // Room on top for the plates over the back row
        maxY += 1.2
        const halfHeight = (Math.max((maxY - minY) / 2, (maxX - minX) / 2 / aspect) * 1.04) / this.zoom
        const middleY = (maxY + minY) / 2
        const middleX = (maxX + minX) / 2
        this.camera.left = middleX - halfHeight * aspect
        this.camera.right = middleX + halfHeight * aspect
        this.camera.top = middleY + halfHeight
        this.camera.bottom = middleY - halfHeight
        this.camera.updateProjectionMatrix()
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

    private drawCode(vega: Vega, time: number) {
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
        ;["#fe7f2d", "#fcca46", CYAN].forEach((color, index) => {
            context.fillStyle = color
            context.beginPath()
            context.arc(24 + index * 16, 22, 5, 0, Math.PI * 2)
            context.fill()
        })
        const lines: [number, number, string][] = [
            [24, 120, "#fe7f2d"],
            [44, 90, CYAN],
            [44, 150, "#f3eee4"],
            [24, 70, CYAN],
            [44, 110, "#f3eee4"]
        ]
        // The lines type themselves out, then the editor starts over
        const typed = this.reducedMotion ? lines.length : (time * 1.3) % (lines.length + 1)
        lines.forEach(([x, width, color], index) => {
            const share = THREE.MathUtils.clamp(typed - index, 0, 1)
            if (!share) return
            context.fillStyle = color
            context.beginPath()
            context.roundRect(x, 44 + index * 22, width * share, 9, 4.5)
            context.fill()
        })
        vega.codeTexture.needsUpdate = true
    }

    private loop = () => {
        this.frame = requestAnimationFrame(this.loop)
        if (!this.visible || document.hidden) return
        const time = this.clock.getElapsedTime()
        const motion = this.reducedMotion ? 0 : 1
        this.fit()
        if (this.trolley) this.trolley.position.x = Math.sin(time * 0.25) * (this.roomSize.width / 2 - 2) * motion
        for (const animate of this.animations) animate(time, motion)

        const width = this.container.clientWidth
        const height = this.container.clientHeight
        const projected = new THREE.Vector3()
        const from = new THREE.Vector3(0, 0, 0).project(this.camera)
        const to = new THREE.Vector3(TILE, 0, 0).project(this.camera)
        const bayWidth = Math.hypot((to.x - from.x) * width, (to.y - from.y) * height) / 2
        this.vegas.forEach((vega, index) => {
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
            vega.hover.position.y += (baseY + vega.liftoff * 1.6 + bob + move.lift - vega.hover.position.y) * 0.18
            vega.hover.position.x += (move.x - vega.hover.position.x) * 0.12
            vega.hover.position.z += (move.z - vega.hover.position.z) * 0.12
            const tilt = failed ? -0.32 : Math.sin(time * 0.9 + index) * 0.04 * motion
            vega.tilt += (tilt - vega.tilt) * 0.08
            vega.hover.rotation.z = vega.tilt + move.roll
            vega.hover.rotation.x += (move.pitch - vega.hover.rotation.x) * 0.1
            // Facing the camera, turned a little toward the tool it holds
            const facing = this.azimuth + (busy ? 0.25 : 0)
            // The shortest way round, so a Vega never spins a whole turn when the camera crosses a full circle
            vega.facing += Math.atan2(Math.sin(facing - vega.facing), Math.cos(facing - vega.facing)) * 0.06
            vega.hover.rotation.y = vega.facing + move.spin
            this.flicker(vega.sparks, mood === "working" && motion > 0)
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

            vega.bodyMaterial.color.lerp(failed || mood === "parked" ? new THREE.Color("#5b6a73") : vega.base, 0.06)
            const blink = !this.reducedMotion && (time + index * 1.3) % 4.5 < 0.12
            vega.eyes.forEach((eye, eyeIndex) => {
                eye.visible = !happy
                const big = mood === "analyzing" && eyeIndex === 1 ? 1.35 : 1
                eye.scale.set(big, blink ? 0.15 : busy ? 0.75 : 1.6 * big, 0.5)
            })
            for (const arc of vega.arcs) arc.visible = happy
            vega.eyeMaterial.color.set(failed ? "#a68a3a" : resting ? "#4f8f9a" : CYAN)
            vega.thruster.material.opacity = failed ? 0.15 : resting ? 0.35 : 0.9
            vega.glow.intensity = failed ? 0.2 : launching ? 5 : 2
            vega.screen.color.set(CONSOLE_COLORS[mood])

            vega.lens.visible = mood === "analyzing"
            vega.lens.position.x = 0.17 + Math.sin(time * 1.4) * 0.06 * motion
            vega.working.visible = mood === "working"
            vega.wrench.rotation.z = Math.sin(time * 6) * 0.35 * motion
            vega.coding.visible = mood === "coding"
            if (vega.coding.visible) this.drawCode(vega, time)
            vega.flame.visible = launching
            vega.flame.scale.y = 1 + Math.sin(time * 40) * 0.12 * motion
            vega.dots.forEach((dot, dotIndex) => {
                dot.visible = mood === "thinking"
                dot.position.y = 1.35 + Math.max(0, Math.sin(time * 5 - dotIndex * 0.7)) * 0.12 * motion
            })

            const selected = vega.worker.id === this.selectedId
            vega.ring.material.color.set(selected ? "#fe7f2d" : "#fcca46")
            vega.ring.scale.setScalar(selected ? 1.12 : 1)

            // Over the head of the Vega, as wide as its bay: the plates of neighbours never overlap
            projected.set(vega.root.position.x, 3.9, vega.root.position.z).project(this.camera)
            vega.tag.style.left = `${(projected.x * 0.5 + 0.5) * width}px`
            vega.tag.style.top = `${(-projected.y * 0.5 + 0.5) * height}px`
            vega.tag.style.maxWidth = `${Math.max(96, bayWidth * 1.6)}px`
            // Only the selected Vega and the one under the pointer show their title and what they do: the rest, their callsign
            const expanded = selected || vega.worker.id === this.hoveredId
            if (vega.expanded !== expanded) {
                vega.expanded = expanded
                vega.tag.style.zIndex = expanded ? "1" : ""
                vega.tag.querySelector("strong")!.textContent = expanded ? `${vega.worker.callsign} · ${vega.worker.title}` : vega.worker.callsign
                const caption = vega.tag.querySelector("span")!
                caption.textContent = vega.worker.caption
                caption.hidden = !expanded
            }
        })
        this.renderer.render(this.scene, this.camera)
    }
}
