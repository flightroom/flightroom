import * as THREE from "three"

/** What does not depend on the works: the stars, a planet, the lights, the key light among them */
export const buildSpace = (scene: THREE.Scene, key: THREE.DirectionalLight) => {
    scene.background = new THREE.Color("#030e15")
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
    scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: "#f3eee4", size: 1.4, sizeAttenuation: false })))
    const planet = new THREE.Mesh(new THREE.SphereGeometry(9, 48, 32), new THREE.MeshStandardMaterial({ color: "#5fae95", roughness: 1 }))
    planet.position.set(-70, 18, -90)
    scene.add(planet)
    const moon = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), new THREE.MeshStandardMaterial({ color: "#d0dde6", roughness: 1 }))
    moon.position.set(-52, 30, -80)
    scene.add(moon)

    scene.add(new THREE.HemisphereLight("#cfe8ff", "#0c2533", 1.1))
    key.position.set(18, 26, 14)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0005
    scene.add(key, key.target)
    const rim = new THREE.DirectionalLight("#7fb6ff", 0.8)
    rim.position.set(-20, 12, -24)
    scene.add(rim)
}
