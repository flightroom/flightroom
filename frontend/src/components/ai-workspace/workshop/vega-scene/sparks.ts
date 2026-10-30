import * as THREE from "three"

/** A handful of sparks, scattered again every frame they show */
export const sparkCloud = () => {
    const cloud = new THREE.Group()
    const hot = new THREE.MeshBasicMaterial({ color: "#ffe08a" })
    const white = new THREE.MeshBasicMaterial({ color: "#ffffff" })
    for (let index = 0; index < 10; index++) cloud.add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), index % 3 ? hot : white))
    cloud.visible = false
    return cloud
}

export const flicker = (cloud: THREE.Group, on: boolean) => {
    cloud.visible = on
    if (!on) return
    for (const spark of cloud.children) {
        spark.position.set((Math.random() - 0.5) * 0.6, (Math.random() - 0.3) * 0.5, (Math.random() - 0.5) * 0.6)
        spark.scale.setScalar(0.5 + Math.random())
    }
}
