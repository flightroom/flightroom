import type { TFunction } from "i18next"
import { resourceBrand } from "@/components/resource/resourceIcons"
import type { AiWorkingJob } from "@/hooks/apiClients/useAiJobsApi"
import type { Backend } from "@/hooks/apiClients/useBackendsApi"
import type { DomainLink } from "@/hooks/apiClients/useDomainLinksApi"
import type { Domain } from "@/hooks/apiClients/useDomainsApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { MaintenanceAgent } from "@/hooks/apiClients/useMaintenanceAgentsApi"
import type { Resource } from "@/hooks/apiClients/useResourcesApi"
import { typeLabel, variantLabel } from "@/pages/resources/partials/resources"
import { GOLDEN_ANGLE, MOON_FIRST_ORBIT, MOON_ORBIT_STEP, MOON_SIZE, MOON_SPACING, MOON_SPEED, NO_DOMAIN, RELATION_GAP, SHIP_CAP } from "./constants"
import { brandPath, glyphPath } from "./resourcePaths"
import type { Agent, Galaxy, GalaxyGeometry, LaneLink, Moon, RelationSegment, Ship, StarNode, Station, StationStatus, World } from "./types"

/** A stable spread from an id, so a world, a moon or a ship keeps its place in the orbit across polls. */
export const phaseOf = (id: string) => {
    let hash = 0
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 9973
    return (hash / 9973) * 2 * Math.PI
}

/**
 * The moons of a backend, from the first orbit out: as many on an orbit as fit with room between them,
 * evenly spread, each orbit slower than the one inside it.
 */
const placeMoons = (world: StarNode, attached: Omit<Moon, "world" | "radius" | "orbit" | "phase" | "speed" | "x" | "y" | "frame">[]): Moon[] => {
    const radius = world.radius * MOON_SIZE
    const first = world.radius + radius * MOON_FIRST_ORBIT
    const moons: Moon[] = []
    let orbit = first
    let ring = 0
    let left = attached
    while (left.length) {
        const fits = Math.max(3, Math.floor((2 * Math.PI * orbit) / (radius * MOON_SPACING)))
        const onOrbit = left.slice(0, fits)
        const offset = phaseOf(world.id) + ring * 0.5
        const speed = MOON_SPEED * (first / orbit) ** 1.5
        onOrbit.forEach((moon, index) => {
            moons.push({ ...moon, world, radius, orbit, speed, phase: offset + (index * 2 * Math.PI) / onOrbit.length, x: 0, y: 0, frame: -1 })
        })
        left = left.slice(fits)
        orbit += radius * MOON_ORBIT_STEP
        ring++
    }
    return moons
}

/** Where a station orbits: past the moons, inside the lane of the ships. */
const stationOrbit = (world: StarNode) => world.reach + world.radius * 0.3 + 1

const stationStatus = (agent: MaintenanceAgent): StationStatus => {
    if (agent.lastRun && !agent.lastRun.ok) return "failed"
    return agent.schedule ? "scheduled" : "standby"
}

interface GalaxyMapInput {
    domains: Domain[]
    frontends: Frontend[]
    backends: Backend[]
    resources: Resource[]
    isBackend: boolean
    t: TFunction
    /** The stars of the last layout: a star keeps the place it had before a reload */
    previousNodes: StarNode[]
}

/** The galaxies, their worlds and the lanes between them, the moons of every world. */
export const buildGalaxyMap = ({ domains, frontends, backends, resources, isBackend, t, previousNodes }: GalaxyMapInput) => {
    const domainIds = new Set(domains.map(domain => domain._id))
    const galaxyOf = (domainId?: string | null) => (domainId && domainIds.has(domainId) ? domainId : NO_DOMAIN)

    const members = [
        ...frontends.map(mfe => ({
            id: mfe._id!,
            kind: "frontend" as const,
            name: mfe.name,
            slug: mfe.slug,
            version: mfe.version,
            galaxyId: galaxyOf(mfe.domainId),
            canary: mfe.canary?.enabled ? mfe.canary.percentage : undefined
        })),
        ...backends.map(backend => ({
            id: backend._id!,
            kind: "backend" as const,
            name: backend.name,
            slug: backend.slug,
            version: backend.version,
            galaxyId: galaxyOf(backend.domainId),
            canary: undefined
        }))
    ]
    const galaxyById = new Map(members.map(member => [member.id, member.galaxyId]))

    // A resource is drawn only as a moon of the backends shown that attach it, of each of them.
    const attachedBy = new Map<string, Resource[]>()
    const usersOf = new Map<string, string[]>()
    for (const resource of resources) {
        if (!resource._id) continue
        const users = backends.filter(backend => backend._id && backend.resourceIds?.includes(resource._id!)).map(backend => backend._id!)
        usersOf.set(resource._id, users)
        for (const id of users) attachedBy.set(id, [...(attachedBy.get(id) ?? []), resource])
    }

    // Links to something that is not on the map are left out: there is no world to draw them to.
    const lanes = [
        ...frontends.flatMap(mfe => (mfe.parentIds ?? []).filter(parentId => galaxyById.has(parentId)).map(parentId => ({ from: parentId, to: mfe._id!, kind: "relation" as const }))),
        ...frontends.flatMap(mfe => (mfe.backendIds ?? []).filter(backendId => galaxyById.has(backendId)).map(backendId => ({ from: mfe._id!, to: backendId, kind: "backend" as const })))
    ]

    // The attached resources make a world bigger, as the links do: its moons stay in proportion.
    const degree = new Map<string, number>()
    for (const lane of lanes) {
        degree.set(lane.from, (degree.get(lane.from) ?? 0) + 1)
        degree.set(lane.to, (degree.get(lane.to) ?? 0) + 1)
    }
    for (const [id, attached] of attachedBy) degree.set(id, (degree.get(id) ?? 0) + attached.length)

    const countIn = (galaxyId: string, kind: World["kind"]) => members.filter(member => member.galaxyId === galaxyId && member.kind === kind).length
    const caption = (galaxyId: string) =>
        isBackend
            ? t("domains.backend_count", { count: countIn(galaxyId, "backend") })
            : `${t("domains.frontend_count", { count: countIn(galaxyId, "frontend") })} · ${t("domains.backend_count", { count: countIn(galaxyId, "backend") })}`
    const galaxyList = [
        ...domains.map((domain, index) => ({ id: domain._id, name: domain.name, domainId: domain._id, caption: caption(domain._id), paletteIndex: index })),
        ...(members.some(member => member.galaxyId === NO_DOMAIN) ? [{ id: NO_DOMAIN, name: t("domains.no_domain"), caption: caption(NO_DOMAIN) }] : [])
    ]

    // A star keeps the place it had before a reload; a new one starts on a spiral around its galaxy.
    const previous = new Map(previousNodes.map(node => [node.id, node]))
    const moonsByWorld = new Map<string, Moon[]>()
    const nodes: StarNode[] = members.map(member => {
        const before = previous.get(member.id)
        const radius = 3 + Math.sqrt(degree.get(member.id) ?? 0) * 1.6
        const node: StarNode = { ...member, radius, reach: radius, x: before?.x, y: before?.y }
        const attached = (attachedBy.get(member.id) ?? []).map(resource => ({
            resourceId: resource._id!,
            name: resource.name,
            label: [typeLabel(t, resource.type), variantLabel(t, resource.type, resource.variant)].filter((label, at, all) => label && all.indexOf(label) === at).join(" · "),
            users: usersOf.get(resource._id!) ?? [],
            brand: (path => (path ? brandPath(path) : undefined))(resourceBrand(resource)?.path),
            glyph: glyphPath(resource.type)
        }))
        if (attached.length) {
            const worldMoons = placeMoons(node, attached)
            const outermost = worldMoons[worldMoons.length - 1]
            node.reach = outermost.orbit + outermost.radius
            moonsByWorld.set(member.id, worldMoons)
        }
        return node
    })

    // The galaxies sit on a ring, far enough apart for the biggest one, moons included, to keep clear of its neighbours.
    const biggest = Math.max(1, ...galaxyList.map(galaxy => members.filter(member => member.galaxyId === galaxy.id).length))
    const widest = Math.max(0, ...nodes.map(node => node.reach - node.radius))
    const spacing = 150 + 24 * Math.sqrt(biggest) + 2 * widest
    const ringRadius = galaxyList.length > 1 ? spacing / (2 * Math.sin(Math.PI / galaxyList.length)) : 0
    const galaxies: Galaxy[] = galaxyList.map((galaxy, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / galaxyList.length
        return { ...galaxy, anchor: { x: ringRadius * Math.cos(angle), y: ringRadius * Math.sin(angle) } }
    })
    const anchors = new Map(galaxies.map(galaxy => [galaxy.id, galaxy.anchor]))
    const placedAt = new Map<string, number>()
    for (const node of nodes) {
        const index = placedAt.get(node.galaxyId) ?? 0
        placedAt.set(node.galaxyId, index + 1)
        const anchor = anchors.get(node.galaxyId)!
        node.x ??= anchor.x + 14 * Math.sqrt(index + 1) * Math.cos(index * GOLDEN_ANGLE)
        node.y ??= anchor.y + 14 * Math.sqrt(index + 1) * Math.sin(index * GOLDEN_ANGLE)
    }

    const byId = new Map(nodes.map(node => [node.id, node]))
    const extentOf = (id: string) => {
        const node = byId.get(id)
        return node ? node.reach - node.radius : 0
    }
    const membersByGalaxy = new Map(galaxies.map(galaxy => [galaxy.id, nodes.filter(node => node.galaxyId === galaxy.id)]))
    return {
        galaxies,
        membersByGalaxy,
        moonsByWorld,
        moons: [...moonsByWorld.values()].flat(),
        graphData: {
            nodes,
            links: lanes.map<LaneLink>(lane => ({
                ...lane,
                bridge: galaxyById.get(lane.from) !== galaxyById.get(lane.to),
                extent: extentOf(lane.from) + extentOf(lane.to),
                source: lane.from,
                target: lane.to
            }))
        }
    }
}

/** The agents on the map: a job on worlds that are not shown (another domain filtered out) has no ship. */
export const placeShips = (workingJobs: AiWorkingJob[], worldNodes: StarNode[]) => {
    const nodes = new Map(worldNodes.map(node => [node.id, node]))
    const agents: Agent[] = []
    const activeShips: Ship[] = []
    for (const job of workingJobs) {
        const worlds = job.componentIds.flatMap(id => nodes.get(id) ?? [])
        if (!worlds.length) continue
        // A job the user cannot open says so, rather than landing on a page that knows nothing of it.
        const fallbackPath = job.kind === "request" ? `/${worlds[0].kind}/${worlds[0].id}?change=${job.jobId}` : undefined
        agents.push({ jobId: job.jobId, names: worlds.map(world => world.name).join(", "), fallbackPath })
        activeShips.push({ job, worlds, world: worlds[0], phase: phaseOf(job.jobId), orbit: 0, extra: 0, fallbackPath, x: 0, y: 0, frame: -1 })
    }
    activeShips.sort((a, b) => a.job.jobId.localeCompare(b.job.jobId))
    const ships = activeShips.slice(0, worldNodes.length * SHIP_CAP)
    if (ships[0]) ships[0].extra = activeShips.length - ships.length
    return { ships, agents }
}

/** The maintenance agents that look after one world only, among those on the map: a station each, spread around it. */
export const placeStations = (maintenanceAgents: MaintenanceAgent[], worldNodes: StarNode[]) => {
    const nodes = new Map(worldNodes.map(node => [node.id, node]))
    const byWorld = new Map<string, MaintenanceAgent[]>()
    for (const agent of maintenanceAgents) {
        const targets = [...(agent.backendIds ?? []), ...(agent.frontendIds ?? [])]
        if (targets.length !== 1 || !nodes.has(targets[0])) continue
        byWorld.set(targets[0], [...(byWorld.get(targets[0]) ?? []), agent])
    }
    const stationsByWorld = new Map<string, Station[]>()
    for (const [worldId, agents] of byWorld) {
        const world = nodes.get(worldId)!
        const start = phaseOf(`${worldId}-stations`)
        stationsByWorld.set(
            worldId,
            agents.map((agent, index) => ({
                agent,
                world,
                status: stationStatus(agent),
                phase: start + (index * 2 * Math.PI) / agents.length,
                orbit: stationOrbit(world),
                x: 0,
                y: 0,
                frame: -1
            }))
        )
    }
    return { stations: [...stationsByWorld.values()].flat(), stationsByWorld }
}

/** Where each relation runs: from halo to halo, unless the two galaxies overlap, and beside its way back if there is one. */
export const layoutRelations = (links: DomainLink[], geometry: Map<string, GalaxyGeometry>, scale: number): RelationSegment[] => {
    const ways = new Set(links.map(link => `${link.sourceDomainId}>${link.targetDomainId}`))
    return links.flatMap(link => {
        const source = geometry.get(link.sourceDomainId)
        const target = geometry.get(link.targetDomainId)
        if (!source || !target) return []
        const length = Math.hypot(target.x - source.x, target.y - source.y) || 1
        const ux = (target.x - source.x) / length
        const uy = (target.y - source.y) / length
        const shift = ways.has(`${link.targetDomainId}>${link.sourceDomainId}`) ? RELATION_GAP / scale : 0
        const sourceEdge = length > source.r + target.r ? source.r : 0
        const targetEdge = length > source.r + target.r ? target.r : 0
        return [
            {
                link,
                from: { x: source.x + ux * sourceEdge - uy * shift, y: source.y + uy * sourceEdge + ux * shift },
                to: { x: target.x - ux * targetEdge - uy * shift, y: target.y - uy * targetEdge + ux * shift }
            }
        ]
    })
}
