import * as THREE from "three"

export const material = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.08, ...extra })

/** A box of the room: in the material given, or in a rough metal of the colour given */
export const box = (w: number, h: number, d: number, color: THREE.ColorRepresentation | THREE.Material) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), color instanceof THREE.Material ? color : material(color, { roughness: 0.7, metalness: 0.3 }))

/** A tapered tube from one point to another: the cyan beam a Vega holds its tools with */
export const beamBetween = (from: THREE.Vector3, to: THREE.Vector3, radius: number, beamMaterial: THREE.Material) => {
    const direction = new THREE.Vector3().subVectors(to, from)
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 3, direction.length(), 12, 1, true), beamMaterial)
    mesh.position.copy(from).add(direction.clone().multiplyScalar(0.5))
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
    return mesh
}

/** A texture drawn once on a canvas, repeated over a surface */
const canvasTexture = (size: number, draw: (context: CanvasRenderingContext2D) => void, repeat: [number, number]) => {
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
export const deckPlates = (repeat: [number, number]) =>
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
export const hazard = (repeat: [number, number]) =>
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

/** Frees the geometries, the materials and their textures of every mesh and point cloud under `root` */
export const disposeTree = (root: THREE.Object3D) => {
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
