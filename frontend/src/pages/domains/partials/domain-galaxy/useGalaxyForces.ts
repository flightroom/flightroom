import { type RefObject, useEffect } from "react"
import type { ForceGraphMethods } from "react-force-graph-2d"
import { BRIDGE_DISTANCE, GALAXY_PULL, LANE_DISTANCE } from "./constants"
import type { ChargeForce, Galaxy, LaneLink, LinkForce, StarNode } from "./types"

/**
 * Tunes the forces of the layout for the galaxies, and lays the map out again whenever they change.
 * The graph is only rendered once the container has a size, and the forces need it in place.
 */
const useGalaxyForces = (graphRef: RefObject<ForceGraphMethods<StarNode, LaneLink> | undefined>, galaxies: Galaxy[], isGraphMounted: boolean, engineStoppedRef: RefObject<boolean>) => {
    useEffect(() => {
        const graph = graphRef.current
        if (!isGraphMounted || !graph) return
        const anchors = new Map(galaxies.map(galaxy => [galaxy.id, galaxy.anchor]))
        let nodes: StarNode[] = []
        // Pulls every star towards the centre of its galaxy, so the domains hold together as clusters.
        const galaxyForce = Object.assign(
            (alpha: number) => {
                for (const node of nodes) {
                    const anchor = anchors.get(node.galaxyId)
                    if (!anchor) continue
                    node.vx = (node.vx ?? 0) + (anchor.x - (node.x ?? 0)) * GALAXY_PULL * alpha
                    node.vy = (node.vy ?? 0) + (anchor.y - (node.y ?? 0)) * GALAXY_PULL * alpha
                }
            },
            { initialize: (initialNodes: StarNode[]) => (nodes = initialNodes) }
        )
        graph.d3Force("galaxy", galaxyForce)
        graph.d3Force("center", null)
        // A bridge barely pulls, or two linked domains would merge into one galaxy. Moons make a lane longer.
        const linkForce = graph.d3Force("link") as unknown as LinkForce | undefined
        linkForce?.distance(link => (link.bridge ? BRIDGE_DISTANCE : LANE_DISTANCE + link.extent)).strength(link => (link.bridge ? 0.01 : 0.25))
        // A world with moons keeps the others further off, so two systems do not overlap.
        const chargeForce = graph.d3Force("charge") as unknown as ChargeForce | undefined
        chargeForce?.strength(node => -45 - 4 * (node.reach - node.radius)).distanceMax(220)
        engineStoppedRef.current = false
        graph.d3ReheatSimulation()
    }, [graphRef, galaxies, isGraphMounted, engineStoppedRef])
}

export default useGalaxyForces
